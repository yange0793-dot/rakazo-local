import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("HTTP and MCP expose read-only operation lookup without starting a native client", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phone-http-"));
  const id = "22e038c9-33c5-47de-bf4d-2e5ca9ad5506";
  const timestamp = new Date().toISOString();
  fs.mkdirSync(path.join(directory, "sessions"));
  fs.writeFileSync(path.join(directory, "sessions/sessions.json"), JSON.stringify([{
    id, agent: "codex", cwd: directory, title: "persisted fixture",
    requestId: "lost/launch", sentRequestIds: ["lost/launch", "old-send"],
    status: "interrupted", cursor: 0, createdAt: timestamp, updatedAt: timestamp,
  }]));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, AGENT_PHONE_DATA_DIR: directory, AGENT_PHONE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      await closed;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Isolated phone server did not become ready.")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Agent phone listening")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Isolated server exited ${code}.`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(directory, "token"), "utf8").trim();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async (url) => {
    const response = await fetch(`${origin}${url}`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const capabilities = await get("/api/inspect");
  assert.equal(capabilities.protocolVersion, 1);
  assert.equal(capabilities.capabilities.operationLookup, true);
  assert.equal((await get("/api/operations?requestId=missing")).found, false);
  const found = await get("/api/operations/lost%2Flaunch");
  assert.equal(found.session.id, id);
  assert.equal(found.operation.state, "unknown");
  assert.equal((await get(`/api/sessions/${id}/inspect`)).operations.length, 2);
  assert.equal((await get("/api/inspect?agent=claude")).capabilities.inputResponse, false);
  const repeated = await fetch(`${origin}/api/start`, {
    method: "POST", headers, body: JSON.stringify({
      agent: "codex", cwd: directory, message: "must not replay", requestId: "lost/launch",
    }),
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).operation.state, "unknown");
  const unauthenticated = await fetch(`${origin}/api/inspect`);
  assert.equal(unauthenticated.status, 401);

  let rpcId = 0;
  let mcpSession;
  async function rpc(method, params) {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { ...headers, accept: "application/json, text/event-stream",
        ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
    const text = await response.text();
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(text)];
    const message = messages.find((entry) => entry.id === rpcId);
    assert.equal(message.error, undefined);
    return message.result;
  }
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "phone-contract-test", version: "1" } });
  const listed = await rpc("tools/list", {});
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.ok(["phone_start", "phone_send", "phone_read", "phone_list", "phone_stop", "phone_inspect"].every((name) => tools.has(name)));
  assert.ok(tools.get("phone_stop").inputSchema.properties.expectedTurnId);
  assert.ok(tools.get("phone_send").inputSchema.properties.inputRequestId);
  const inspection = await rpc("tools/call", { name: "phone_inspect", arguments: { requestId: "lost/launch" } });
  assert.equal(inspection.structuredContent.operation.state, "unknown");
  const discovery = await rpc("tools/call", { name: "phone_inspect", arguments: {} });
  assert.equal(discovery.structuredContent.protocolVersion, 1);
  assert.equal((await get("/api/sessions")).sessions.length, 1);
});
