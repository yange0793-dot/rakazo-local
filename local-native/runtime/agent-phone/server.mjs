import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { PhoneStore } from "./store.mjs";
import { createCodexAdapter } from "./codex.mjs";
import { createClaudeAdapter } from "./claude.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.AGENT_PHONE_DATA_DIR || path.join(root, "data");
const port = Number(process.env.AGENT_PHONE_PORT || 18779);
const origin = `http://127.0.0.1:${port}`;
fs.mkdirSync(data, { recursive: true, mode: 0o700 });
const tokenFile = path.join(data, "token");
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = fs.readFileSync(tokenFile, "utf8").trim();
const configFile = path.join(root, "config.json");
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
const store = new PhoneStore({
  directory: path.join(data, "sessions"),
  adapters: {
    codex: (options) => createCodexAdapter({
      ...config.codex, ...options, model: options.model ?? config.codex?.model,
    }),
    claude: createClaudeAdapter,
  },
});
const subscribers = new Set();
const sessionId = z.string().uuid().describe("Conversation ID returned by phone_start or phone_list.");
const requestId = z.string().min(1).optional().describe("Stable unique operation key. Reuse only for the identical operation.");
const expectedTurnId = z.string().min(1).optional().describe("Reject if the current turn/input does not match this previously inspected ID.");
const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

function createServer() {
  const server = new McpServer({ name: "agent-phone", version: "0.1.0" });
  const register = (name, description, schema, run, readOnly = false) => server.registerTool(name, {
    description, inputSchema: schema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true },
  }, async (args, ctx) => reply(await run(args, ctx)));
  register("phone_start",
    "Call the user's actual local Codex or Claude Code to do a task. Returns immediately with a persistent conversation ID and live monitor URL. Both use the user's model/configuration and full permissions. Send the task, required output path and acceptance criteria; no permission question is needed. Use phone_read with its returned cursor to follow live text/tool progress until complete. Use phone_send anytime, including while working. If background work is requested, retain the ID for later follow-up.",
    z.object({
      agent: z.enum(["codex", "claude"]), cwd: z.string().describe("Existing absolute working directory."),
      message: z.string().min(1), title: z.string().optional(), model: z.string().optional(),
      requestId, operationKey: requestId,
    }), async (args) => ({ ...await store.start(args), monitorUrl: origin }));
  register("phone_send",
    "Send another message to the SAME Codex/Claude conversation. Works during execution and after completion. Codex steers the active turn; Claude acknowledges and handles queued input at a safe boundary. Never create a new conversation just to follow up. No manual approval is required.",
    z.object({
      sessionId, message: z.string().min(1).optional(), requestId, operationKey: requestId, expectedTurnId,
      inputRequestId: z.string().optional().describe("Original live Codex input request ID; answer that question instead of sending a new turn."),
      answers: z.record(z.string(), z.object({ answers: z.array(z.string()) })).optional(),
    }),
    ({ sessionId, message, requestId, ...options }) => store.send(sessionId, message, requestId, options));
  register("phone_read",
    "Monitor a conversation's live progress, tool activity, replies, results and errors. Pass the last cursor to receive only new events. waitMs keeps this call open until new progress arrives; returns after at most 25 seconds. Continue reading while running, or report the ID when the user wants it left in the background. An idle result means the turn finished but this conversation is still available for more messages.",
    z.object({ sessionId, after: z.number().int().min(0).default(0), waitMs: z.number().int().min(0).max(25000).default(20000), limit: z.number().int().min(1).max(500).default(100) }),
    ({ sessionId, after, waitMs, limit }, ctx) => store.watch(sessionId, after, waitMs, limit, ctx.mcpReq.signal), true);
  register("phone_list", "List the persistent Codex and Claude conversations, current states, native session IDs and last results. The service remains available when a Rakazo turn ends.",
    z.object({}), () => ({ sessions: store.list(), monitorUrl: origin }), true);
  register("phone_inspect",
    "Read protocol capabilities or durable operation facts without connecting to an agent. With no ID returns capabilities; by requestId/operationKey finds a launch even if its response was lost. Unknown IDs return found:false. A registered/dispatching/local queued operation is not native acceptance; unknown operations are never automatically replayed.",
    z.object({ sessionId: sessionId.optional(), requestId, operationKey: requestId, agent: z.enum(["codex", "claude"]).optional() }),
    (args) => store.inspect(args), true);
  register("phone_stop", "Interrupt the active work in this conversation. Keep the conversation and its history available for a later phone_send. Check phone_read for the confirmed state.",
    z.object({ sessionId, requestId, operationKey: requestId, expectedTurnId,
      targetRequestId: z.string().optional().describe("The start/send operation to stop. requestId is the stop operation's own key.") }),
    ({ sessionId, ...options }) => store.stop(sessionId, options));
  return server;
}

const mcp = toNodeHandler(createMcpHandler(createServer));
const tokenBytes = Buffer.from(token);
const sameToken = (value) => {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value);
  return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
};
const bearer = (req) => sameToken(req.headers.authorization?.replace(/^Bearer /, ""));
const cookie = (req) => sameToken(/(?:^|;\s*)agent_phone=([^;]+)/.exec(req.headers.cookie || "")?.[1]);
function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return size ? JSON.parse(Buffer.concat(chunks, size).toString("utf8")) : {};
}
function staticFile(res, file, type) {
  const input = fs.createReadStream(file);
  input.once("open", () => {
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    input.pipe(res);
  });
  input.once("error", () => {
    if (!res.headersSent) json(res, { error: "Monitor asset unavailable" }, 500);
    else res.destroy();
  });
  res.once("close", () => input.destroy());
}

const server = http.createServer(async (req, res) => {
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, { error: "Invalid host" }, 403);
    if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, { error: "Cross-origin access refused" }, 403);
    if (req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Cross-site access refused" }, 403);
    const url = new URL(req.url, origin);
    if (url.pathname === "/health") return json(res, { ok: true, service: "agent-phone", sessions: store.sessions.size });
    if (url.pathname === "/mcp") {
      if (!bearer(req)) return json(res, { error: "Authentication required" }, 401);
      return await mcp(req, res);
    }
    if (url.pathname === "/" && req.method === "GET") {
      res.setHeader("set-cookie", `agent_phone=${token}; HttpOnly; SameSite=Strict; Path=/`);
      return staticFile(res, path.join(root, "public/index.html"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/app.js") return staticFile(res, path.join(root, "public/app.js"), "text/javascript; charset=utf-8");
    if (url.pathname === "/style.css") return staticFile(res, path.join(root, "public/style.css"), "text/css; charset=utf-8");
    if (url.pathname === "/lucide.js") return staticFile(res, path.join(root, "node_modules/lucide/dist/umd/lucide.js"), "text/javascript; charset=utf-8");
    if (!bearer(req) && !cookie(req)) return json(res, { error: "Open the monitor page first" }, 401);
    if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, { sessions: store.list() });
    if (req.method === "GET" && (url.pathname === "/api/inspect" || url.pathname === "/api/operations")) {
      return json(res, store.inspect(Object.fromEntries(url.searchParams)));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/operations/")) {
      return json(res, store.inspect({ requestId: decodeURIComponent(url.pathname.slice("/api/operations/".length)) }));
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("event: ready\ndata: {}\n\n");
      subscribers.add(res);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
      req.on("close", () => { clearInterval(heartbeat); subscribers.delete(res); });
      res.on("error", () => { clearInterval(heartbeat); subscribers.delete(res); });
      return;
    }
    if (url.pathname === "/api/start" && req.method === "POST") return json(res, await store.start(await body(req)));
    const match = /^\/api\/sessions\/([a-f0-9-]+)\/(read|send|stop|inspect)$/.exec(url.pathname);
    if (match) {
      const [, id, action] = match;
      if (action === "inspect" && req.method === "GET") return json(res, store.inspect({ ...Object.fromEntries(url.searchParams), sessionId: id }));
      if (action === "read" && req.method === "GET") return json(res, await store.read(id, Number(url.searchParams.get("after") || 0), 500));
      if (action === "send" && req.method === "POST") {
        const input = await body(req);
        return json(res, await store.send(id, input.message, input.requestId, input));
      }
      if (action === "stop" && req.method === "POST") return json(res, await store.stop(id, await body(req)));
    }
    json(res, { error: "Not found" }, 404);
  } catch (error) {
    if (!res.headersSent) json(res, {
      error: error.message, ...(error.code ? { code: error.code } : {}),
      ...(error.operation ? { operation: error.operation } : {}),
    }, error.code === "turn_mismatch" || error.code === "operation_conflict" ? 409 : 400);
    else res.end();
  }
});
store.on("event", (event) => {
  for (const res of subscribers) {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Agent phone listening on ${origin}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
  for (const res of subscribers) res.end();
  subscribers.clear();
  server.close();
  await store.close();
  process.exit(0);
});
