import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentRunModel, AgentRuntime } from "@rakazo/adapter-kit";
import type { ModelConnectInput } from "@rakazo/contracts";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { FILE_DELIVERY_PLAYBOOKS } from "../../../adapters/src/fixtures/work-improvement.js";
import type { LearningStreamReport } from "../evals/learning-stream.js";
import {
  createLearningStreamManifest,
  LEARNING_STREAM_DEFAULT_SEED,
  listLearningStreamTasks,
  runLearningStream,
} from "../evals/learning-stream.js";
import type { EvalPricing } from "../evals/measurement.js";
import { validatePricing } from "../evals/measurement.js";

type JsonObject = Record<string, unknown>;
type FixtureRequest = {
  model?: string;
  messages?: Array<JsonObject>;
  tools?: Array<JsonObject>;
};
type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const DEFAULT_OUTPUT = "test-report/learning-stream/report.json";
const MAX_CONNECTION_FILE_BYTES = 64 * 1024;
const MAX_FIXTURE_REQUEST_BYTES = 2 * 1024 * 1024;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) =>
      object(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
}

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_FIXTURE_REQUEST_BYTES) {
        reject(new Error("Fixture request exceeded its size limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function unescapePromptData(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function tagValue(prompt: string, tag: string): unknown {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const start = prompt.indexOf(startTag);
  const end = prompt.indexOf(endTag, start + startTag.length);
  if (start < 0 || end < 0) return undefined;
  try {
    return JSON.parse(unescapePromptData(prompt.slice(start + startTag.length, end)));
  } catch {
    return undefined;
  }
}

function playbookFromSystem(system: string): JsonObject {
  const marker = system.lastIndexOf('{"playbook":');
  if (marker < 0) throw new Error("Work-improvement playbook was not present");
  const parsed: unknown = JSON.parse(system.slice(marker));
  if (!object(parsed) || !object(parsed.playbook))
    throw new Error("Work-improvement playbook was invalid");
  return parsed.playbook;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outputFromObservedTools(messages: JsonObject[], strict: boolean): JsonObject {
  const calls = new Map<string, { name: string; args: JsonObject }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const raw of message.tool_calls) {
      if (!object(raw) || typeof raw.id !== "string" || !object(raw.function)) continue;
      const fn = raw.function;
      if (typeof fn.name !== "string" || typeof fn.arguments !== "string") continue;
      try {
        const args: unknown = JSON.parse(fn.arguments);
        if (object(args)) calls.set(raw.id, { name: fn.name, args });
      } catch {
        /* Invalid tool requests remain absent from the observed evidence. */
      }
    }
  }
  const files = new Map<string, string>();
  let listedFiles: Array<{ path: string; sha256: string }> = [];
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
    const call = calls.get(message.tool_call_id);
    if (!call || typeof message.content !== "string") continue;
    let result: unknown;
    try {
      result = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!object(result)) continue;
    if (call.name === "read_file" && typeof call.args.path === "string") {
      if (typeof result.content === "string") files.set(call.args.path, result.content);
    }
    if (call.name === "list_files" && Array.isArray(result.files)) {
      listedFiles = result.files.flatMap((entry) =>
        object(entry) &&
        typeof entry.path === "string" &&
        typeof entry.sha256 === "string" &&
        entry.kind === "file"
          ? [{ path: entry.path, sha256: entry.sha256 }]
          : [],
      );
    }
  }

  const request = JSON.parse(files.get("request.json") ?? "null") as {
    projectId: string;
    packageId: string;
    runtimeAllowlist: string[];
  } | null;
  const manifest = JSON.parse(files.get("manifest.json") ?? "null") as {
    packageId: string;
    files: Array<{ path: string; sha256: string }>;
  } | null;
  const inventory = JSON.parse(files.get("installed-files.json") ?? "null") as {
    complete: boolean;
  } | null;
  const selection = JSON.parse(files.get("selection-receipt.json") ?? "null") as {
    packageId: string;
    status: string;
  } | null;
  const upload = JSON.parse(files.get("upload-receipt.json") ?? "null") as {
    packageId: string;
    status: string;
  } | null;
  if (!request || !manifest || !inventory || !selection || !upload)
    throw new Error("Synthetic task evidence was incomplete");

  const installed = listedFiles.flatMap((entry) => {
    if (!entry.path.startsWith("installed/")) return [];
    return [{ path: entry.path.slice("installed/".length), sha256: entry.sha256 }];
  });
  const actualByPath = new Map(installed.map((entry) => [entry.path, entry.sha256]));
  const missing = manifest.files
    .filter((entry) => !actualByPath.has(entry.path))
    .map((entry) => entry.path)
    .sort();
  const mismatched = manifest.files
    .filter(
      (entry) => actualByPath.has(entry.path) && actualByPath.get(entry.path) !== entry.sha256,
    )
    .map((entry) => entry.path)
    .sort();
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  const unexpected: string[] = [];
  const excluded: string[] = [];
  for (const entry of installed) {
    if (manifestPaths.has(entry.path)) continue;
    if (request.runtimeAllowlist.includes(entry.path)) excluded.push(entry.path);
    else unexpected.push(entry.path);
  }
  const observations = {
    missing_files: missing,
    unexpected_files: unexpected.sort(),
    hash_mismatches: mismatched,
    excluded_runtime_files: excluded.sort(),
  };
  if (
    request.projectId !== "project-temporal-example" ||
    manifest.packageId !== request.packageId
  ) {
    return {
      schemaVersion: "work-improvement.output.v1",
      outcome: "out_of_scope",
      checks: {
        installation: "not_applicable",
        directory: "not_applicable",
        upload: "not_applicable",
      },
      observations: {
        missing_files: [],
        unexpected_files: [],
        hash_mismatches: [],
        excluded_runtime_files: [],
      },
    };
  }
  const directory =
    strict && !inventory.complete ? "unknown" : strict && unexpected.length ? "fail" : "pass";
  const uploadCheck = strict
    ? upload.packageId === request.packageId && upload.status === "completed"
      ? "pass"
      : "unknown"
    : upload.packageId === request.packageId &&
        (upload.status === "completed" || selection.status === "selected")
      ? "pass"
      : "unknown";
  const checks = {
    installation: missing.length || mismatched.length ? "fail" : "pass",
    directory,
    upload: uploadCheck,
  };
  const values = Object.values(checks);
  return {
    schemaVersion: "work-improvement.output.v1",
    outcome: values.includes("fail")
      ? "failed"
      : values.includes("unknown")
        ? "unknown"
        : "complete",
    checks,
    observations,
  };
}

function fixtureReply(body: FixtureRequest, requestNumber: number) {
  const messages = body.messages ?? [];
  const system = messageText(messages.find((message) => message.role === "system")?.content);
  const userPrompt = messages
    .filter((message) => message.role === "user")
    .map((message) => messageText(message.content))
    .join("\n");
  const toolResultsPresent = messages.some((message) => message.role === "tool");
  let content: string | undefined;
  let toolCalls: ToolCall[] | undefined;
  if ((body.tools?.length ?? 0) > 0 && !toolResultsPresent) {
    toolCalls = [
      { name: "list_files", path: "" },
      { name: "list_files", path: "installed" },
      { name: "read_file", path: "request.json" },
      { name: "read_file", path: "manifest.json" },
      { name: "read_file", path: "installed-files.json" },
      { name: "read_file", path: "selection-receipt.json" },
      { name: "read_file", path: "upload-receipt.json" },
    ].map((call, index) => ({
      id: `fixture-${requestNumber}-${index + 1}`,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify({ path: call.path }),
      },
    }));
  } else if ((body.tools?.length ?? 0) > 0) {
    const playbook = playbookFromSystem(system);
    const instructions = Array.isArray(playbook.steps) ? playbook.steps.join("\n") : "";
    const strict = instructions.includes("compare the entire path set");
    content = JSON.stringify(outputFromObservedTools(messages, strict));
  } else if (system.includes("Compose one improved supported SkillPlaybook")) {
    const input: unknown = JSON.parse(userPrompt);
    if (!object(input) || !object(input.proposed))
      throw new Error("Synthetic composition request was malformed");
    content = JSON.stringify({ kind: "compose", playbook: input.proposed });
  } else {
    const feedback = tagValue(userPrompt, "user_feedback");
    if (!object(feedback) || typeof feedback.text !== "string")
      throw new Error("Synthetic proposal feedback was malformed");
    content = JSON.stringify({
      kind: "candidate",
      quote: feedback.text,
      playbook: FILE_DELIVERY_PLAYBOOKS.candidate.playbook,
    });
  }
  return {
    id: `fixture-request-${requestNumber}`,
    content,
    toolCalls,
    promptTokens: Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4)),
    completionTokens: Math.max(
      1,
      Math.ceil(Buffer.byteLength(content ?? JSON.stringify(toolCalls)) / 4),
    ),
  };
}

export function startLearningStreamFixtureServer() {
  let requestCount = 0;
  const observedPrompts: string[] = [];
  const inboundHeaderReceipts: LearningStreamReport["outboundHeaderReceipts"] = [];
  const observedServiceTiers: Array<string | null> = [];
  const fixtureErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const bodyText = await readRequest(request);
      const body: unknown = JSON.parse(bodyText);
      if (!object(body)) throw new Error("Invalid synthetic model request");
      requestCount += 1;
      const headers = new Headers(
        Object.entries(request.headers).flatMap(([name, value]) =>
          typeof value === "string"
            ? [[name, value]]
            : Array.isArray(value)
              ? value.map((entry) => [name, entry] as [string, string])
              : [],
        ),
      );
      const requestId = `fixture-request-${requestCount}`;
      observedPrompts.push(JSON.stringify(body.messages ?? []));
      const requestedServiceTier = body.service_tier === "priority" ? ("priority" as const) : null;
      observedServiceTiers.push(typeof body.service_tier === "string" ? body.service_tier : null);
      const reply = fixtureReply(body as FixtureRequest, requestCount);
      inboundHeaderReceipts.push({
        request: requestCount,
        headerNames: [...headers.keys()].sort(),
        userAgent: headers.get("user-agent"),
        originator: headers.get("originator"),
        app: headers.get("x-app"),
        authorizationPresent: Boolean(headers.get("authorization") || headers.get("x-api-key")),
        status: 200,
        providerRequestIdSha256: sha256(requestId),
        transportError: null,
        requestedServiceTier,
        serviceTierApplied: requestedServiceTier !== null,
        terminalStatus: reply.toolCalls ? "tool_calls" : "stop",
        tokenUsage: {
          inputTokens: reply.promptTokens,
          outputTokens: reply.completionTokens,
          totalTokens: reply.promptTokens + reply.completionTokens,
        },
        returnedServiceTier: requestedServiceTier ?? "default",
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": reply.id,
      });
      const choice = reply.toolCalls
        ? {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: reply.toolCalls.map((call, index) => ({ ...call, index })),
            },
            finish_reason: "tool_calls",
          }
        : {
            index: 0,
            delta: { role: "assistant", content: reply.content },
            finish_reason: "stop",
          };
      response.write(
        `data: ${JSON.stringify({
          id: reply.id,
          object: "chat.completion.chunk",
          created: 0,
          model: "learning-stream-offline-v1",
          service_tier: requestedServiceTier ?? "default",
          choices: [choice],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: reply.id,
          object: "chat.completion.chunk",
          created: 0,
          model: "learning-stream-offline-v1",
          service_tier: requestedServiceTier ?? "default",
          choices: [],
          usage: {
            prompt_tokens: reply.promptTokens,
            completion_tokens: reply.completionTokens,
            total_tokens: reply.promptTokens + reply.completionTokens,
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : "fixture_error");
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  return {
    server,
    observedPrompts,
    inboundHeaderReceipts,
    observedServiceTiers,
    fixtureErrors,
    get requestCount() {
      return requestCount;
    },
  };
}

function currentHeaderValues(headers: HeadersInit | undefined) {
  const parsed = new Headers(headers);
  return {
    headerNames: [...parsed.keys()].map((name) => name.toLowerCase()).sort(),
    userAgent: parsed.get("user-agent"),
    originator: parsed.get("originator"),
    app: parsed.get("x-app"),
    authorizationPresent: Boolean(parsed.get("authorization") || parsed.get("x-api-key")),
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function responseUsage(value: unknown) {
  if (!object(value)) return null;
  const inputTokens = tokenCount(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = tokenCount(value.output_tokens ?? value.completion_tokens);
  const totalTokens = tokenCount(value.total_tokens);
  return inputTokens === null && outputTokens === null && totalTokens === null
    ? null
    : { inputTokens, outputTokens, totalTokens };
}

function responseObservations(body: string) {
  const events: Array<{ name: string | null; value: unknown }> = [];
  let eventName: string | null = null;
  let data: string[] = [];
  const flush = () => {
    if (data.length) {
      const text = data.join("\n");
      if (text !== "[DONE]") {
        try {
          events.push({ name: eventName, value: JSON.parse(text) as unknown });
        } catch {
          // Non-JSON event payloads carry no structured receipt fields.
        }
      }
    }
    eventName = null;
    data = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (!line) {
      flush();
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();
  if (!events.length) {
    try {
      events.push({ name: null, value: JSON.parse(body) as unknown });
    } catch {
      // Some providers return non-JSON error bodies.
    }
  }

  let terminalStatus: string | null = null;
  let tokenUsage: LearningStreamReport["outboundHeaderReceipts"][number]["tokenUsage"] = null;
  let returnedServiceTier: string | null = null;
  for (const event of events) {
    if (!object(event.value)) continue;
    const value = event.value;
    const choice =
      Array.isArray(value.choices) && object(value.choices[0]) ? value.choices[0] : undefined;
    const response = object(value.response) ? value.response : undefined;
    const delta = object(value.delta) ? value.delta : undefined;
    const status =
      (choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null) ??
      (response && typeof response.status === "string" ? response.status : null) ??
      (typeof delta?.stop_reason === "string" ? delta.stop_reason : null) ??
      (typeof value.stop_reason === "string" ? value.stop_reason : null) ??
      (event.name === "message_stop" || value.type === "message_stop"
        ? "message_stop"
        : event.name === "response.completed" || value.type === "response.completed"
          ? "completed"
          : event.name === "response.failed" || value.type === "response.failed"
            ? "failed"
            : event.name === "response.incomplete" || value.type === "response.incomplete"
              ? "incomplete"
              : null);
    if (status) terminalStatus = status;
    const observedUsage =
      responseUsage(value.usage) ??
      responseUsage(response?.usage) ??
      responseUsage(object(value.message) ? value.message.usage : undefined);
    if (observedUsage) tokenUsage = observedUsage;
    const serviceTier = value.service_tier ?? response?.service_tier;
    if (typeof serviceTier === "string") returnedServiceTier = serviceTier;
  }
  return { terminalStatus, tokenUsage, returnedServiceTier };
}

async function injectServiceTier(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  serviceTier: "priority",
): Promise<[RequestInfo | URL, RequestInit | undefined]> {
  const inheritedRequest = init?.body === undefined && input instanceof Request;
  const body = inheritedRequest ? await input.clone().text() : init?.body;
  if (typeof body !== "string") throw new Error("The model request cannot carry service_tier.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("The model request cannot carry service_tier.");
  }
  if (!object(parsed)) throw new Error("The model request cannot carry service_tier.");
  const updatedBody = JSON.stringify({ ...parsed, service_tier: serviceTier });
  if (inheritedRequest) {
    return [new Request(input, { body: updatedBody, headers: input.headers }), undefined];
  }
  return [input, { ...init, body: updatedBody }];
}

function observedModelFetch(
  upstream: typeof fetch,
  receipts: LearningStreamReport["outboundHeaderReceipts"],
  requestedServiceTier?: "priority",
  pendingObservations = new Set<Promise<void>>(),
): typeof fetch {
  return async (input, init) => {
    const identity = currentHeaderValues(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const receipt: LearningStreamReport["outboundHeaderReceipts"][number] = {
      request: receipts.length + 1,
      ...identity,
      status: null,
      providerRequestIdSha256: null,
      transportError: null,
      requestedServiceTier: requestedServiceTier ?? null,
      serviceTierApplied: false,
      terminalStatus: null,
      tokenUsage: null,
      returnedServiceTier: null,
    };
    receipts.push(receipt);
    try {
      const [requestInput, requestInit] = requestedServiceTier
        ? await injectServiceTier(input, init, requestedServiceTier)
        : [input, init];
      receipt.serviceTierApplied = requestedServiceTier !== undefined;
      const response = await upstream(requestInput, requestInit);
      receipt.status = response.status;
      const requestId =
        response.headers.get("x-request-id") ??
        response.headers.get("request-id") ??
        response.headers.get("x-generation-id");
      receipt.providerRequestIdSha256 = requestId ? sha256(requestId) : null;
      const observation = response
        .clone()
        .text()
        .then((body) => {
          Object.assign(receipt, responseObservations(body));
        })
        .catch(() => {});
      pendingObservations.add(observation);
      void observation.then(() => pendingObservations.delete(observation));
      return response;
    } catch (error) {
      receipt.transportError = error instanceof Error ? error.name : "TransportError";
      throw error;
    }
  };
}

function integer(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error(`${name} must be between 1 and ${max}.`);
  return parsed;
}

export function learningStreamModelFromConnection(connection: ModelConnectInput): AgentRunModel {
  return {
    provider: connection.provider,
    id: connection.modelId!,
    apiKey: connection.apiKey,
    accountId: connection.accountId,
    gatewayId: connection.gatewayId,
    baseUrl: connection.baseUrl,
    apiProtocol: connection.apiProtocol,
    headers: connection.headers,
    allowPrivateEndpoint: true,
    reasoning: connection.reasoning,
    reasoningCapabilities: connection.reasoningCapabilities,
    acceptsImages: connection.supportsImages,
    maxImagesPerPrompt: connection.maxImagesPerPrompt ?? undefined,
    contextWindow: connection.contextWindow,
    maxTokens: connection.maxTokens ?? undefined,
    thinkingLevel: connection.thinkingLevel,
  };
}

function codeRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function workingDiffHash(): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const command = {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    };
    const hash = createHash("sha256").update(
      execFileSync("git", ["diff", "--binary", "HEAD"], command),
    );
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      ...command,
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => /\.(?:ts|tsx|json)$/.test(file) && /^(?:packages|apps)\//.test(file))
      .sort();
    for (const file of untracked) hash.update(file).update(readFileSync(path.join(root, file)));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function readJsonFile(file: string, maxBytes: number): unknown {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) throw new Error("A required evaluation input file was not found.");
  const bytes = readFileSync(resolved);
  if (bytes.byteLength > maxBytes)
    throw new Error("An evaluation input file exceeded its size limit.");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("An evaluation input file must contain valid JSON.");
  }
}

function writeReport(file: string, report: LearningStreamReport) {
  const output = path.resolve(file);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${output}.tmp`, output);
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local fixture endpoint failed to start.");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      seed: { type: "string", default: String(LEARNING_STREAM_DEFAULT_SEED) },
      "train-count": { type: "string", default: "3" },
      "selection-count": { type: "string", default: "2" },
      "holdout-count": { type: "string", default: "3" },
      connection: { type: "string" },
      pricing: { type: "string" },
      "spend-cap-usd": { type: "string" },
      "service-tier": { type: "string" },
      output: { type: "string", default: DEFAULT_OUTPUT },
    },
  });
  if (values.seed !== undefined && !/^\d+$/.test(values.seed))
    throw new Error("--seed must be an unsigned 32-bit integer.");
  const seed = Number(values.seed ?? LEARNING_STREAM_DEFAULT_SEED);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error("--seed must be an unsigned 32-bit integer.");
  const trainCount = integer(values["train-count"], 3, "--train-count", 30);
  const selectionCount = integer(values["selection-count"], 2, "--selection-count", 30);
  const holdoutCount = integer(values["holdout-count"], 3, "--holdout-count", 30);
  if (values["service-tier"] !== undefined && values["service-tier"] !== "priority")
    throw new Error("--service-tier supports only priority.");
  const serviceTier = values["service-tier"] === "priority" ? "priority" : undefined;
  if (serviceTier && !values.live) throw new Error("--service-tier requires --live.");
  const manifest = createLearningStreamManifest({
    seed,
    trainCount,
    selectionCount,
    holdoutCount,
  });
  if (values.list) {
    for (const task of listLearningStreamTasks({
      seed,
      trainCount,
      selectionCount,
      holdoutCount,
    }))
      console.log(`${task.id}\t${task.split}\t${task.logicalTime}\t${task.inputSha256}`);
    return;
  }
  if (trainCount < 3)
    throw new Error(
      "The learning run requires at least three training tasks for frozen/accumulating comparison.",
    );
  if (manifest.orderedTasks.length > 36) throw new Error("The generated task stream is too large.");

  loadRootEnv();
  let model: AgentRunModel;
  let pricing: EvalPricing | undefined;
  let spendCapUsd: number | undefined;
  let route: string;
  let runtime: AgentRuntime;
  let fixtureServer: ReturnType<typeof startLearningStreamFixtureServer> | undefined;
  const outboundHeaderReceipts: LearningStreamReport["outboundHeaderReceipts"] = [];
  const pendingObservations = new Set<Promise<void>>();
  const [{ PiAgentRuntime }, { dispatcherFetch }] = await Promise.all([
    import("../../../adapters/src/pi-runtime.js"),
    import("../../../adapters/src/undici-fetch.js"),
  ]);
  if (values.live) {
    if (!values.connection)
      throw new Error("--live requires --connection; no model calls were made.");
    const connectionValue = readJsonFile(values.connection, MAX_CONNECTION_FILE_BYTES);
    const parsedConnection = ModelConnectInputSchema.safeParse(connectionValue);
    if (!parsedConnection.success || !parsedConnection.data.modelId?.trim())
      throw new Error(
        "The model connection file is invalid or has no modelId; no model calls were made.",
      );
    const connection = parsedConnection.data;
    pricing = values.pricing
      ? validatePricing(readJsonFile(values.pricing, MAX_CONNECTION_FILE_BYTES))
      : undefined;
    if (values["spend-cap-usd"] !== undefined) {
      if (!pricing)
        throw new Error("--spend-cap-usd requires --pricing; no model calls were made.");
      spendCapUsd = Number(values["spend-cap-usd"]);
      if (!Number.isFinite(spendCapUsd) || spendCapUsd <= 0 || spendCapUsd > 25)
        throw new Error("--spend-cap-usd must be greater than zero and no more than 25.");
    }
    model = learningStreamModelFromConnection(connection);
    route = `${connection.provider}/${connection.modelId}`;
    runtime = new PiAgentRuntime({
      modelFetch: observedModelFetch(
        dispatcherFetch,
        outboundHeaderReceipts,
        serviceTier,
        pendingObservations,
      ),
    });
  } else {
    fixtureServer = startLearningStreamFixtureServer();
    const port = await listen(fixtureServer.server);
    model = {
      provider: "openai-compatible",
      id: "learning-stream-offline-v1",
      apiKey: "synthetic-offline-fixture-key",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiProtocol: "chat-completions",
      allowPrivateEndpoint: true,
      reasoning: false,
      maxTokens: 1024,
      contextWindow: 32_768,
      headers: {},
    };
    route = "synthetic-loopback-fixture";
    runtime = new PiAgentRuntime({
      modelFetch: observedModelFetch(
        dispatcherFetch,
        outboundHeaderReceipts,
        undefined,
        pendingObservations,
      ),
    });
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Evaluation interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const report = await runLearningStream(
      {
        seed,
        trainCount,
        selectionCount,
        holdoutCount,
        model,
        route,
        codeRevision: codeRevision(),
        workingDiffHash: workingDiffHash(),
        spendCapUsd,
        serviceTier,
        mode: values.live ? "live" : "offline-fixture",
      },
      {
        runtime,
        context: { signal: controller.signal },
        pricing,
        outboundHeaderReceipts: () => outboundHeaderReceipts,
        onProgress: (snapshot) => writeReport(values.output!, snapshot),
      },
    );
    await Promise.allSettled([...pendingObservations]);
    report.outboundHeaderReceipts = structuredClone(outboundHeaderReceipts);
    writeReport(values.output!, report);
    console.log(
      JSON.stringify({
        status: report.status,
        termination: report.termination,
        mode: report.execution.mode,
        model: report.execution.model,
        holdout: report.holdout
          ? {
              baseline: report.holdout.baseline.metrics,
              frozen: report.holdout.frozen.metrics,
              accumulating: report.holdout.accumulating.metrics,
              equalBudgetRetry: report.holdout.equalBudgetRetry.metrics,
            }
          : null,
        report: path.resolve(values.output!),
      }),
    );
    if (report.status !== "completed") process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    if (fixtureServer) await closeServer(fixtureServer.server);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message.split("\n")[0] : "Learning-stream evaluation failed",
    );
    process.exitCode = 1;
  });
}
