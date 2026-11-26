import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { createCodexAdapter } from "./codex.mjs";

function fakeServer(t, { onRequest, resumedTurn } = {}) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const requests = [];
  const kills = [];
  let exited = false;
  let turnCounter = 0;
  let spawnArgs;
  let buffer = "";
  const server = {
    child, requests, kills,
    get spawnArgs() { return spawnArgs; },
    respond(id, result) { child.stdout.write(`${JSON.stringify({ id, result })}\n`); },
    reject(id, message) {
      child.stdout.write(`${JSON.stringify({ id, error: { code: -32600, message } })}\n`);
    },
    notify(method, params = {}) {
      child.stdout.write(`${JSON.stringify({ method, params: { threadId: "thread-1", ...params } })}\n`);
    },
    request(id, method, params = {}) {
      child.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
    },
    complete(id, status = "completed", items = [], extra = {}) {
      server.notify("turn/completed", { turn: { id, status, items, ...extra } });
    },
    exit(code = 0) {
      if (exited) return;
      exited = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", code, null);
    },
  };
  child.kill = (signal) => { kills.push(signal); server.exit(); return true; };
  child.stdin.on("finish", () => server.exit());
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      requests.push(message);
      if (!message.method || message.id == null) continue;
      if (onRequest?.(message, server)) continue;
      if (message.method === "initialize") server.respond(message.id, {});
      else if (message.method === "thread/start" || message.method === "thread/resume") {
        server.respond(message.id, {
          thread: { id: "thread-1", status: { type: resumedTurn ? "active" : "idle" }, turns: [] },
        });
      } else if (message.method === "thread/turns/list") {
        server.respond(message.id, { data: resumedTurn ? [resumedTurn] : [] });
      } else if (message.method === "turn/start") {
        const turn = { id: `turn-${++turnCounter}`, status: "inProgress", items: [] };
        server.notify("turn/started", { turn });
        server.respond(message.id, { turn });
      } else if (message.method === "turn/steer") {
        server.respond(message.id, { turnId: message.params.expectedTurnId });
      } else if (message.method === "turn/interrupt") {
        server.respond(message.id, {});
        server.complete(message.params.turnId, "interrupted");
      } else throw new Error(`Unexpected RPC: ${message.method}`);
    }
  });
  t.mock.method(childProcess, "spawn", (...args) => { spawnArgs = args; return child; });
  return server;
}

async function open(t, options = {}, serverOptions = {}) {
  const server = fakeServer(t, serverOptions);
  const events = [];
  const adapter = await createCodexAdapter({
    cwd: "/workspace/project", onEvent: (event) => events.push(event), ...options,
  });
  t.after(() => adapter.close());
  return { adapter, server, events };
}

test("initializes a dedicated process and preserves inherited model and native settings", async (t) => {
  const { server, events } = await open(t, { env: { AGENT_TEST_VALUE: "present" } });
  assert.equal(server.spawnArgs[0], "codex");
  assert.deepEqual(server.spawnArgs[1], ["app-server", "--listen", "stdio://"]);
  assert.equal(server.spawnArgs[2].env.AGENT_TEST_VALUE, "present");
  assert.equal(server.spawnArgs[2].env.PATH, process.env.PATH);
  assert.equal(server.spawnArgs[2].shell, false);
  assert.deepEqual(server.requests.map((message) => message.method), [
    "initialize", "initialized", "thread/start",
  ]);
  assert.deepEqual(server.requests[2].params, {
    cwd: "/workspace/project", approvalPolicy: "never", sandbox: "danger-full-access",
    config: { web_search: "disabled" },
  });
  assert.deepEqual(events.map((event) => event.status), ["connecting", "idle"]);
  assert.equal(events.at(-1).nativeSessionId, "thread-1");
  assert.equal(events.at(-1).connected, true);
});

for (const resume of [false, true]) test(`service connection overrides the native provider on ${resume ? "resume" : "start"}`, async (t) => {
  const config = {
    web_search: "live",
    model_reasoning_effort: "medium",
    features: { default_mode_request_user_input: true },
    model_providers: {
      local_router: { name: "Local router", base_url: "http://127.0.0.1:8787/v1", wire_api: "responses" },
    },
  };
  const { server } = await open(t, {
    model: "route/model", modelProvider: "local_router", config,
    ...(resume ? { nativeSessionId: "thread-1" } : {}),
  });
  const request = server.requests.find((message) => message.method === (resume ? "thread/resume" : "thread/start"));
  assert.equal(request.params.model, "route/model");
  assert.equal(request.params.modelProvider, "local_router");
  assert.deepEqual(request.params.config, { ...config, web_search: "disabled" });
  assert.equal(request.params.approvalPolicy, "never");
});

test("concurrent sends start once, then steer with the active turn id; completion stays reusable", async (t) => {
  const { adapter, server, events } = await open(t, { model: "inherited-explicit-model" });
  const results = await Promise.all([adapter.send("first"), adapter.send("additional")]);
  assert.deepEqual(results.map(({ delivery, nativeSessionId }) => ({ delivery, nativeSessionId })), [
    { delivery: "started", nativeSessionId: "thread-1" },
    { delivery: "steered", nativeSessionId: "thread-1" },
  ]);
  assert.ok(results.every((receipt) => receipt.state === "running" && receipt.turnId === "turn-1"));
  const commands = server.requests.filter((message) => message.method?.startsWith("turn/"));
  assert.deepEqual(commands.map((message) => message.method), ["turn/start", "turn/steer"]);
  assert.equal(commands[1].params.expectedTurnId, "turn-1");
  assert.equal(commands[1].params.input[0].text, "additional");
  assert.equal(server.requests[2].params.model, "inherited-explicit-model");
  assert.deepEqual(commands[0].params.sandboxPolicy, { type: "dangerFullAccess" });
  server.complete("turn-1");
  await tick();
  assert.equal(events.at(-1).status, "idle");
  assert.equal((await adapter.send("next")).delivery, "started");
  assert.equal(server.kills.length, 0);
});

test("streams text and tools, emits the final answer once and preserves unknown cost", async (t) => {
  const { adapter, server, events } = await open(t);
  await adapter.send("work");
  const turnId = "turn-1";
  server.notify("item/completed", {
    turnId, item: { type: "agentMessage", id: "intro", phase: "commentary", text: "Working." },
  });
  server.notify("item/started", {
    turnId, item: { type: "commandExecution", id: "tool-1", command: "pwd", status: "inProgress" },
  });
  server.notify("item/commandExecution/outputDelta", { turnId, itemId: "tool-1", delta: "/workspace\n" });
  server.notify("item/completed", {
    turnId, item: { type: "commandExecution", id: "tool-1", command: "pwd", status: "completed", exitCode: 0 },
  });
  server.notify("item/agentMessage/delta", { turnId, itemId: "answer", delta: "All " });
  server.notify("item/agentMessage/delta", { turnId, itemId: "answer", delta: "done." });
  server.notify("thread/tokenUsage/updated", {
    turnId, tokenUsage: { last: { inputTokens: 8 }, total: { inputTokens: 20 } },
  });
  const answer = { type: "agentMessage", id: "answer", phase: "final_answer", text: "All done." };
  server.notify("item/completed", { turnId, item: answer });
  server.complete(turnId, "completed", [answer]);
  server.complete(turnId, "completed", [answer]);
  await tick();
  assert.deepEqual(events.filter((event) => event.type === "text").map((event) => event.text), [
    "Working.", "All ", "done.",
  ]);
  assert.deepEqual(events.filter((event) => event.type === "tool").map((event) => event.status), [
    "running", "running", "completed",
  ]);
  const result = events.filter((event) => event.type === "result");
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "All done.");
  assert.equal(result[0].usage.costUsd, null);
  assert.equal(result[0].usage.total.inputTokens, 20);
});

test("a terminal notification before the start ACK does not resurrect a running turn", async (t) => {
  const { adapter, server, events } = await open(t, {}, {
    onRequest(message, mock) {
      if (message.method !== "turn/start") return false;
      const turn = { id: `fast-${message.id}`, status: "inProgress", items: [] };
      mock.notify("turn/started", { turn });
      mock.complete(turn.id, "completed", [
        { type: "agentMessage", id: "answer", text: "ready" },
      ]);
      mock.respond(message.id, { turn });
      return true;
    },
  });
  await adapter.send("fast");
  await adapter.send("again");
  assert.equal(server.requests.filter((message) => message.method === "turn/steer").length, 0);
  assert.equal(events.filter((event) => event.type === "result").length, 2);
  assert.equal(events.at(-1).status, "idle");
});

test("server requests with colliding IDs are not mistaken for responses; asks remain unanswered", async (t) => {
  const { adapter, server, events } = await open(t, {}, {
    onRequest(message, mock) {
      if (message.method !== "turn/start") return false;
      mock.request(message.id, "item/commandExecution/requestApproval", { threadId: "thread-1" });
      mock.respond(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
      return true;
    },
  });
  await adapter.send("work");
  const start = server.requests.find((message) => message.method === "turn/start");
  assert.deepEqual(server.requests.find((message) => message.id === start.id && !message.method).result, {
    decision: "accept",
  });
  server.request("ask-1", "item/tool/requestUserInput", {
    threadId: "thread-1", turnId: "turn-1", itemId: "ask-tool",
    isBlocking: true, questions: [{ id: "choice", header: "Choice", question: "Which file?" }],
  });
  await tick();
  assert.equal(events.at(-1).status, "waiting_input");
  assert.equal(events.at(-1).requestId, "ask-1");
  assert.equal(server.requests.some((message) => message.id === "ask-1"), false);
  await adapter.stop();
  assert.equal(events.at(-1).status, "stopped");
  assert.equal(events.some((event) => event.type === "result"), false);
});

test("resume queries the existing active turn before steering and does not start another task", async (t) => {
  const { adapter, server } = await open(t, { nativeSessionId: "thread-1" }, {
    resumedTurn: { id: "existing-turn", status: "inProgress", items: [] },
  });
  assert.equal((await adapter.send("update")).delivery, "steered");
  assert.equal(server.requests.some((message) => message.method === "thread/start"), false);
  assert.equal(server.requests.some((message) => message.method === "turn/start"), false);
  assert.equal(server.requests.at(-1).params.expectedTurnId, "existing-turn");
  await adapter.stop();
  assert.equal(server.kills.length, 0);
});

test("idle resume ignores a historical turn/started before the next send", async (t) => {
  const { adapter, server, events } = await open(t, { nativeSessionId: "thread-1" });
  server.notify("turn/started", {
    turn: { id: "old-completed-turn", status: "inProgress", items: [] },
  });
  await tick();
  assert.equal(events.at(-1).status, "idle");
  assert.equal((await adapter.send("new work")).delivery, "started");
  server.complete("turn-1", "completed", [
    { type: "agentMessage", id: "answer", text: "RECONNECT_OK", phase: "final_answer" },
  ]);
  await tick();
  assert.equal(events.findLast((event) => event.type === "result").text, "RECONNECT_OK");
  assert.equal(events.at(-1).status, "idle");
});

test("historical turn replay during a resumed start cannot capture the new turn", async (t) => {
  const oldTurn = { id: "old-completed-turn", status: "inProgress", items: [] };
  const newTurn = { id: "actual-new-turn", status: "inProgress", items: [] };
  const { adapter, server, events } = await open(t, { nativeSessionId: "thread-1" }, {
    onRequest(message, mock) {
      if (message.method !== "turn/start") return false;
      mock.notify("turn/started", { turn: oldTurn });
      mock.notify("turn/started", { turn: newTurn });
      mock.notify("item/started", {
        turnId: newTurn.id,
        item: { type: "commandExecution", id: "new-tool", command: "pwd", status: "inProgress" },
      });
      mock.notify("item/agentMessage/delta", {
        turnId: newTurn.id, itemId: "new-answer", delta: "RECONNECT_OK",
      });
      mock.respond(message.id, { turn: newTurn });
      return true;
    },
  });
  assert.equal((await adapter.send("new work")).delivery, "started");
  assert.equal(events.some((event) => event.type === "tool" && event.itemId === "new-tool"), true);
  assert.equal(events.some((event) => event.type === "text" && event.text === "RECONNECT_OK"), true);
  server.notify("turn/started", { turn: oldTurn });
  assert.equal((await adapter.send("additional")).delivery, "steered");
  assert.equal(server.requests.at(-1).params.expectedTurnId, newTurn.id);
  server.complete(newTurn.id, "completed", [
    { type: "agentMessage", id: "new-answer", text: "RECONNECT_OK", phase: "final_answer" },
  ]);
  await tick();
  assert.equal(events.findLast((event) => event.type === "result").text, "RECONNECT_OK");
  assert.equal(events.some((event) => event.type === "status" && event.turnId === oldTurn.id), false);
  assert.equal(events.at(-1).status, "idle");
});

test("native retries remain active; failed and interrupted turns never emit successful results", async (t) => {
  const { adapter, server, events } = await open(t);
  await adapter.send("work");
  server.notify("error", { turnId: "turn-1", willRetry: true, error: { message: "retrying" } });
  await tick();
  assert.equal((await adapter.send("more")).delivery, "steered");
  server.complete("turn-1", "failed", [], { error: { message: "upstream failed" } });
  await tick();
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.some((event) => event.type === "result"), false);
  await adapter.send("new task");
  await adapter.stop();
  assert.equal(events.at(-1).status, "stopped");
  assert.equal(events.some((event) => event.type === "result"), false);
});

test("a rejected steer is surfaced without replaying it as a new turn", async (t) => {
  const { adapter, server } = await open(t, {}, {
    onRequest(message, mock) {
      if (message.method !== "turn/steer") return false;
      mock.reject(message.id, "active turn does not match expectedTurnId");
      return true;
    },
  });
  await adapter.send("work");
  await assert.rejects(adapter.send("update"), /expectedTurnId/);
  assert.equal(server.requests.filter((message) => message.method === "turn/start").length, 1);
});

test("stop waits for the terminal notification, then the same adapter can send again", async (t) => {
  const { adapter, server, events } = await open(t, {}, {
    onRequest(message, mock) {
      if (message.method !== "turn/interrupt") return false;
      mock.respond(message.id, {});
      return true;
    },
  });
  await adapter.send("work");
  let settled = false;
  const stopping = adapter.stop().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(events.at(-1).status, "stopping");
  server.complete("turn-1", "interrupted");
  await stopping;
  assert.equal(events.at(-1).status, "stopped");
  assert.equal((await adapter.send("continue")).delivery, "started");
});

test("lost start ACK blocks another send without repeating the original input", async (t) => {
  const { adapter, server, events } = await open(t, {}, {
    onRequest: (message) => message.method === "turn/start",
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sending = adapter.send("work");
  const rejected = assert.rejects(sending, /acknowledgement timed out/);
  await tick();
  t.mock.timers.tick(30_000);
  await rejected;
  await assert.rejects(adapter.send("again"), /unconfirmed/);
  assert.equal(server.requests.filter((message) => message.method === "turn/start").length, 1);
  assert.equal(events.some((event) => event.deliveryUnknown === true), true);
});

test("completion racing an interrupt rejection remains confirmed stopped", async (t) => {
  const { adapter, server, events } = await open(t, {}, {
    onRequest(message, mock) {
      if (message.method !== "turn/interrupt") return false;
      mock.complete(message.params.turnId, "interrupted");
      mock.reject(message.id, "turn is no longer active");
      return true;
    },
  });
  await adapter.send("work");
  await adapter.stop();
  assert.equal(events.at(-1).status, "stopped");
  assert.equal(server.requests.filter((message) => message.method === "turn/interrupt").length, 1);
});

test("owned process exit rejects pending sends and close is idempotent", async (t) => {
  const { adapter, server, events } = await open(t, {}, {
    onRequest(message, mock) {
      if (message.method !== "turn/start") return false;
      mock.exit(7);
      return true;
    },
  });
  await assert.rejects(adapter.send("work"), /exited/);
  await assert.rejects(adapter.send("again"), /exited/);
  const failed = events.findLast((event) => event.type === "status" && event.status === "failed");
  assert.equal(failed.connected, false);
  assert.equal(failed.deliveryUnknown, true);
  assert.equal(failed.nativeSessionId, "thread-1");
  await Promise.all([adapter.close(), adapter.close()]);
  assert.equal(server.kills.length, 0);
});

test("idle process exit tells the host to rebuild without reporting unknown delivery", async (t) => {
  const { server, events } = await open(t);
  server.exit();
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.at(-1).connected, false);
  assert.equal(events.at(-1).deliveryUnknown, false);
  assert.equal(events.at(-1).nativeSessionId, "thread-1");
});

test("operation receipts bind steering and terminal events to the native turn", async (t) => {
  const { adapter, server, events } = await open(t);
  const first = await adapter.send("work", { operationKey: "launch" });
  await adapter.send("change", { operationKey: "update", expectedTurnId: first.turnId });
  server.complete(first.turnId);
  const terminal = events.filter((event) => event.type === "operation" && event.state === "completed");
  assert.deepEqual(terminal.map((event) => event.operationKey), ["launch", "update"]);
  assert.ok(terminal.every((event) => event.turnId === first.turnId && event.turnIdSource === "native"));
  await adapter.send("next", { operationKey: "new-turn" });
  const count = server.requests.filter((request) => request.method === "turn/interrupt").length;
  await assert.rejects(adapter.stop({ expectedTurnId: first.turnId }), /does not match/);
  assert.equal(server.requests.filter((request) => request.method === "turn/interrupt").length, count);
});

test("input answers resolve the original native request without a new turn", async (t) => {
  const { adapter, server, events } = await open(t);
  const first = await adapter.send("work", { operationKey: "launch" });
  server.request("question-1", "item/tool/requestUserInput", {
    threadId: "thread-1", turnId: first.turnId,
    questions: [{ id: "file", question: "Which file?" }],
  });
  let settled = false;
  const response = adapter.respondInput({
    inputRequestId: "question-1", expectedTurnId: first.turnId, operationKey: "answer",
    answers: { file: { answers: ["report.csv"] } },
  }).then((reply) => { settled = true; return reply; });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(server.requests.find((request) => request.id === "question-1").result, {
    answers: { file: { answers: ["report.csv"] } },
  });
  assert.equal(server.requests.filter((request) => request.method === "turn/start").length, 1);
  server.notify("serverRequest/resolved", { requestId: "question-1" });
  const reply = await response;
  assert.equal(reply.state, "completed");
  assert.equal(reply.proof, "server_request_resolved");
  assert.equal(reply.turnId, first.turnId);
  assert.equal(events.findLast((event) => event.operationKey === "answer").state, "completed");
  await assert.rejects(adapter.respondInput({
    inputRequestId: "question-1", operationKey: "another", answers: {},
  }), /unavailable/);
});

test("input response reports transport loss without claiming acceptance or resending", async (t) => {
  const { adapter, server } = await open(t);
  const first = await adapter.send("work");
  server.request("question-1", "item/tool/requestUserInput", {
    threadId: "thread-1", turnId: first.turnId,
    questions: [{ id: "file", question: "Which file?" }],
  });
  const response = adapter.respondInput({
    inputRequestId: "question-1", expectedTurnId: first.turnId, operationKey: "answer",
    answers: { file: { answers: ["report.csv"] } },
  });
  server.exit(2);
  const reply = await response;
  assert.equal(reply.state, "unknown");
  assert.equal(reply.proof, "native_transport_lost");
  assert.equal(server.requests.filter((request) => request.id === "question-1").length, 1);
});

test("input response keeps the written receipt unconfirmed when resolution is absent", async (t) => {
  const { adapter, server } = await open(t);
  const first = await adapter.send("work");
  server.request("question-1", "item/tool/requestUserInput", {
    threadId: "thread-1", turnId: first.turnId,
    questions: [{ id: "file", question: "Which file?" }],
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = adapter.respondInput({
    inputRequestId: "question-1", expectedTurnId: first.turnId, operationKey: "answer",
    answers: { file: { answers: ["report.csv"] } },
  });
  t.mock.timers.tick(10_000);
  const reply = await response;
  assert.equal(reply.state, "dispatching");
  assert.equal(reply.proof, "input_response_written_without_native_ack");
  assert.equal(server.requests.filter((request) => request.id === "question-1").length, 1);
  t.mock.timers.reset();
});

test("transport loss preserves uncertainty for an acknowledged operation", async (t) => {
  const { adapter, server, events } = await open(t);
  await adapter.send("work", { operationKey: "accepted-work" });
  server.exit(2);
  await tick();
  const states = events.filter((event) => event.operationKey === "accepted-work").map((event) => event.state);
  assert.deepEqual(states, ["running", "unknown"]);
  await adapter.close();
  assert.equal(events.findLast((event) => event.operationKey === "accepted-work").state, "unknown");
  assert.equal(events.some((event) => event.operationKey === "accepted-work" && event.state === "cancelled"), false);
});
