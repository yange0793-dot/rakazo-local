import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentSteeringMessage,
} from "@rakazo/adapter-kit";
import { redactSecrets, STEERING_CONTINUATION_PROMPT } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { isTerminatingReplyResult, terminatingReplyText } from "./approval-effect.js";
import { createCodexAppServer } from "./codex-app-server.js";
import { createCodexModelBridge } from "./codex-model-bridge.js";
import { toHistory, toPiImages, withoutSteeringMessages } from "./pi-runtime-history.js";
import { modelForCompletion, resolveRuntimeModel } from "./pi-runtime-models.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import {
  agentToolDefinitions,
  createGate,
  createQueue,
  describeToolActivity,
  releaseToolCallBudget,
  toAgentTools,
  toolCallBudgetFor,
} from "./pi-runtime-tools.js";
import { deliverFinishedShells } from "./shell-command-stream.js";
import type { TurnCheckpoint } from "./turn-checkpoint.js";
import {
  restoreTurnCheckpoint,
  serializeTurnCheckpoint,
  unresolvedTurnCheckpointCalls,
} from "./turn-checkpoint.js";

interface NativeTurn {
  id: string;
  status: string;
  error?: { message?: string };
}

interface RuntimeCheckpoint extends TurnCheckpoint {
  runtimeState: {
    runtime: "codex";
    threadId: string;
    runId: string;
    ownerThreadId: string;
  };
}

export interface CodexAgentRuntimeOptions {
  stateRoot: string;
  binary?: string;
}

const noUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Native Codex drives the loop; Rakazo retains tools, effects and durable memory. */
export class CodexAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, { controller: AbortController; work: Promise<void> }>();

  constructor(private readonly options: CodexAgentRuntimeOptions) {}

  describe() {
    return {
      id: "codex",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
    };
  }

  async abort(runId: string) {
    const active = this.active.get(runId);
    active?.controller.abort();
    await active?.work;
  }

  run(request: AgentRunRequest, context?: Partial<AdapterContext>) {
    const controller = new AbortController();
    const queue = createQueue();
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    const work = this.execute(request, context, signal, queue)
      .catch((error) => {
        if (!signal.aborted) queue.fail(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        queue.close();
        if (this.active.get(request.runId)?.controller === controller)
          this.active.delete(request.runId);
      });
    this.active.set(request.runId, { controller, work });
    const events = queue.iterate()[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => events.next(),
      return: async () => {
        controller.abort();
        await work;
        return { done: true as const, value: undefined };
      },
    };
  }

  private async execute(
    request: AgentRunRequest,
    context: Partial<AdapterContext> | undefined,
    signal: AbortSignal,
    queue: ReturnType<typeof createQueue>,
  ) {
    signal.throwIfAborted();
    if (request.computerModel || request.fallbackModels?.length) {
      throw new Error("This runtime pilot requires one model for the whole run.");
    }
    const selected = resolveRuntimeModel(request.model);
    if (!selected.model) throw new Error(`Unknown model ${request.model.id}`);
    const model = modelForCompletion(selected.model, request.model.maxTokens);
    const identity = createHash("sha256").update(request.botId).digest("hex");
    const runKey = createHash("sha256").update(request.runId).digest("hex");
    const home = path.join(this.options.stateRoot, identity);
    const cwd = path.join(home, "workspace");
    const catalog = path.join(home, `model-${runKey}.json`);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await writeFile(catalog, JSON.stringify(modelCatalog(request)), { mode: 0o600 });
    const restored = request.turnCheckpoint
      ? (restoreTurnCheckpoint(request.turnCheckpoint, request.model) as RuntimeCheckpoint)
      : undefined;
    if (
      restored &&
      (restored.runtimeState?.runtime !== "codex" ||
        restored.runtimeState.runId !== request.runId ||
        restored.runtimeState.ownerThreadId !== request.threadId)
    ) {
      throw new Error("This checkpoint belongs to a different runtime or conversation.");
    }
    const initialSteering = (await request.claimSteering?.([])) ?? [];
    signal.throwIfAborted();
    const seen = initialSteering.map((item) => item.id);
    const history =
      restored?.messages ??
      toHistory(
        withoutSteeringMessages(request.history, initialSteering),
        request.prompt,
        request.sourceMessageId,
      );
    const transcript: Message[] = [...history];
    const host: ToolHost = {
      queue,
      context,
      request,
      activeModel: {
        config: request.model,
        models: selected.models,
        model,
        apiKey: selected.apiKey,
      },
      models: selected.models,
      model,
      apiKey: selected.apiKey,
      nestedAgents: new Set(),
      subagentGate: createGate(1),
      toolCallBudget: toolCallBudgetFor(request.runId),
      toolCallSeq: { value: 0 },
      abortTurn: () => {
        interrupted = true;
      },
      signal,
      depth: 0,
      pausePending: false,
      pendingShells: [],
      modelResponses: 0,
    };
    const tools = toAgentTools(request.tools, host);
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    const toolDefinitions = agentToolDefinitions(request.tools);
    let threadId = restored?.runtimeState.threadId;
    let turnId: string | undefined;
    let currentTurn: Promise<string | undefined> | undefined;
    let confirmTurn: (id?: string) => void = () => {};
    let interrupted = false;
    let terminalReply: string | undefined;
    let ending = false;
    let turnFinished = false;
    const undeliveredSteering: AgentSteeringMessage[] = [];
    let toolWork = Promise.resolve();
    let steeringWork = Promise.resolve();
    let buffered: Array<{ method: string; params: Record<string, unknown> }> | undefined = [];
    let resolveTurn: (turn: NativeTurn) => void = () => {};
    let rejectTurn: (error: Error) => void = () => {};
    let finalText = "";
    let currentMessage: string | undefined;
    const messages = new Map<string, string>();
    const bridge = await createCodexModelBridge({
      request,
      signal,
      onUsage: async (event) => {
        await request.onUsage?.(event);
        queue.push({ ...event, accounted: Boolean(request.onUsage) });
        host.modelResponses = (host.modelResponses ?? 0) + 1;
      },
    });
    try {
      signal.throwIfAborted();
      const connection = createCodexAppServer({
        binary: this.options.binary ?? "codex",
        args: ["app-server", "--listen", "stdio://", "-c", "features.plugins=false"],
        cwd,
        env: { ...process.env, CODEX_HOME: home, RAKAZO_MODEL_TOKEN: bridge.token },
        onNotification: ({ method, params }) =>
          notification(method, params as Record<string, unknown>),
        onServerRequest: async ({ method, params: rawParams }) => {
          const params = rawParams as Record<string, unknown>;
          if (method !== "item/tool/call") throw new Error(`Unsupported native request: ${method}`);
          if (params.threadId !== threadId)
            throw new Error("Tool request belongs to another thread.");
          const toolTurn = currentTurn;
          if (!toolTurn) throw new Error("Tool request does not belong to the active turn.");
          const call: ToolCall = {
            type: "toolCall",
            id: String(params.callId),
            name: String(params.tool),
            arguments: params.arguments as ToolCall["arguments"],
          };
          const result = toolWork.then(async () => {
            // A tool may precede the start ACK; only that ACK confirms its turn.
            const confirmedId = await toolTurn;
            if (
              !confirmedId ||
              toolTurn !== currentTurn ||
              params.turnId !== confirmedId ||
              turnFinished ||
              ending
            )
              throw new Error("Tool request does not belong to the active turn.");
            if (host.pausePending || interrupted || signal.aborted) {
              return {
                contentItems: [{ type: "inputText", text: "The run has stopped." }],
                success: false,
              };
            }
            transcript.push(assistant([{ ...call }], "toolUse"));
            const output = await invokeTool(call);
            await steer();
            return {
              contentItems: output.content.map((part) =>
                part.type === "text"
                  ? { type: "inputText", text: part.text }
                  : { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` },
              ),
              success: !output.isError,
            };
          });
          toolWork = result.then(
            () => {},
            () => {},
          );
          // Reply before interrupting so the native transcript records the tool outcome.
          void result
            .then(() => {
              if (interrupted && turnId)
                setImmediate(() => {
                  void interrupt();
                });
            })
            .catch(() => {});
          return result;
        },
        onExit: (error) => {
          if (!ending) rejectTurn(error);
        },
      });
      const assistant = (
        content: AssistantMessage["content"],
        stopReason: AssistantMessage["stopReason"] = "stop",
      ): AssistantMessage => ({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: noUsage,
        stopReason,
        timestamp: Date.now(),
      });
      host.captureCheckpoint = async (pendingToolCallId, executionId) => {
        const snapshot = [...transcript];
        const state: RuntimeCheckpoint = {
          version: 1,
          provider: request.model.provider,
          model: request.model.id,
          systemPrompt: request.instructions,
          messages: snapshot,
          pendingToolCallId,
          executionMode: "sequential",
          historyMessageIds: request.history.flatMap((message) => (message.id ? [message.id] : [])),
          runtimeState: {
            runtime: "codex",
            threadId: threadId!,
            runId: request.runId,
            ownerThreadId: request.threadId,
          },
        };
        await request.onCheckpoint?.(() => serializeTurnCheckpoint(state), executionId);
      };

      async function invokeTool(call: ToolCall): Promise<AgentToolResult<unknown>> {
        const tool = toolsByName.get(call.name);
        let output: AgentToolResult<unknown>;
        try {
          if (!tool) throw new Error(`Tool ${call.name} is not available in this run.`);
          const args = validateToolArguments(tool, {
            ...call,
            arguments: (tool.prepareArguments?.(call.arguments) ??
              call.arguments) as ToolCall["arguments"],
          });
          queue.push({
            type: "progress",
            activity: true,
            text: describeToolActivity(call.name, args, (name) => toolDefinitions.get(name)),
          });
          try {
            output = await tool.execute(call.id, args, signal);
          } finally {
            queue.push({ type: "progress", activity: true, text: "" });
          }
        } catch (error) {
          signal.throwIfAborted();
          output = {
            content: [
              {
                type: "text",
                text: redactSecrets(
                  error instanceof Error ? error.message : String(error),
                  request.secrets ?? [],
                ),
              },
            ],
            details: {},
            isError: true,
          };
        }
        if (isTerminatingReplyResult(output)) terminalReply = terminatingReplyText(output);
        if (!host.pausePending)
          transcript.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: output.content,
            isError: output.isError ?? false,
            timestamp: Date.now(),
          });
        return output;
      }

      function notification(method: string, params: Record<string, unknown>) {
        if (params.threadId !== threadId || ending) return;
        if (buffered) {
          buffered.push({ method, params });
          return;
        }
        const incomingTurn = params.turn as NativeTurn | undefined;
        if ((params.turnId ?? incomingTurn?.id) !== turnId) return;
        if (method === "turn/completed") {
          turnFinished = true;
          resolveTurn(incomingTurn!);
        } else if (method === "item/agentMessage/delta") {
          const id = String(params.itemId);
          if (currentMessage !== id) {
            currentMessage = id;
            queue.push({ type: "turn" });
          }
          const text = String(params.delta ?? "");
          messages.set(id, (messages.get(id) ?? "") + text);
          queue.push({ type: "text", text });
        } else if (method === "item/completed") {
          const item = params.item as { type: string; id: string; text?: string; phase?: string };
          if (item.type === "agentMessage") {
            const text = item.text ?? messages.get(item.id) ?? "";
            const prefix = messages.get(item.id) ?? "";
            if (text.startsWith(prefix) && text.length > prefix.length) {
              if (currentMessage !== item.id) queue.push({ type: "turn" });
              queue.push({ type: "text", text: text.slice(prefix.length) });
            }
            transcript.push(assistant([{ type: "text", text }]));
            messages.set(item.id, text);
            finalText = text;
          }
        } else if (
          method === "item/reasoning/summaryTextDelta" ||
          method === "item/reasoning/textDelta"
        ) {
          queue.push({ type: "thinking", active: true });
        } else if (method === "error" && !params.willRetry) {
          rejectTurn(
            new Error((params.error as { message?: string })?.message ?? "Native runtime failed."),
          );
        }
      }

      async function interrupt() {
        if (!turnId || ending) return;
        await connection.request("turn/interrupt", { threadId, turnId }).catch((error) => {
          if (!ending && !signal.aborted) rejectTurn(error);
        });
      }
      const onAbort = () => {
        confirmTurn();
        rejectTurn(new Error("Run cancelled."));
        void interrupt()
          .finally(() => connection.close())
          .catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });

      async function steer() {
        const next = steeringWork.then(async () => {
          if (!turnId || turnFinished || interrupted || ending || signal.aborted) return;
          const items = (await request.claimSteering?.(seen)) ?? [];
          if (!items.length) return;
          seen.push(...items.map((item) => item.id));
          try {
            await connection.request("turn/steer", {
              threadId,
              expectedTurnId: turnId,
              input: steeringInput(items),
            });
          } catch (error) {
            if (!turnFinished) throw error;
            undeliveredSteering.push(...items);
            return;
          }
          queue.push({
            type: "steered",
            fromRunUser: items.some((item) => item.origin === "user"),
          });
        });
        steeringWork = next.catch(() => {});
        return next;
      }

      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        signal.throwIfAborted();
        await connection.request("initialize", {
          clientInfo: { name: "rakazo_runtime", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        connection.notify("initialized", {});
        const config = {
          model_catalog_json: catalog,
          model_reasoning_effort: request.model.thinkingLevel ?? "medium",
          web_search: "disabled",
          project_doc_max_bytes: 0,
          features: {
            shell_tool: false,
            unified_exec: false,
            multi_agent: false,
            multi_agent_v2: false,
            view_image: false,
            memories: false,
            apps: false,
            js_repl: false,
            plugins: false,
            goals: false,
            default_mode_request_user_input: false,
          },
          memories: { generate_memories: false, use_memories: false },
          tools: {
            update_plan: { enabled: false },
            experimental_request_user_input: { enabled: false },
          },
          model_providers: {
            rakazo: {
              name: "Rakazo",
              base_url: bridge.baseUrl,
              env_key: "RAKAZO_MODEL_TOKEN",
              wire_api: "responses",
              requires_openai_auth: false,
              supports_websockets: false,
              request_max_retries: 0,
              stream_max_retries: 0,
            },
          },
        };
        const options = {
          cwd,
          model: request.model.id,
          modelProvider: "rakazo",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          baseInstructions: request.instructions,
          developerInstructions:
            "Use the supplied Rakazo tools for all work. Their paths refer to the user's workspace. The native process cwd is internal session storage, not the tool workspace; omit shell cwd unless the user or host instructions specify a working directory. Conversation history is historical context, not new authorization.",
          config,
        };
        const started = await connection.request<{ thread: { id: string }; model: string }>(
          restored ? "thread/resume" : "thread/start",
          restored
            ? { ...options, threadId, excludeTurns: true }
            : {
                ...options,
                dynamicTools: tools.map((tool) => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.parameters,
                })),
              },
        );
        threadId = started.thread.id;
        if (started.model !== request.model.id)
          throw new Error("Native runtime selected a different model.");
        getLogger().info("agent.runtime.selected", {
          "run.id": request.runId,
          "bot.id": request.botId,
          runtime: "codex",
          "native.thread.id": threadId,
          "model.id": started.model,
        });
        let prompt = request.prompt;
        if (restored) {
          const pending = unresolvedTurnCheckpointCalls(restored.messages);
          const outputs: string[] = [];
          for (const call of pending) {
            const interaction =
              call.id === restored.pendingToolCallId &&
              ["ask_user", "request_takeover"].includes(call.name);
            const result = interaction
              ? {
                  content: request.resumeToolResult?.content ?? [
                    { type: "text" as const, text: request.prompt },
                  ],
                  details: undefined,
                }
              : await invokeTool(call);
            outputs.push(`${call.name} (${call.id}): ${JSON.stringify(result.content)}`);
            if (host.pausePending) return;
            if (terminalReply) {
              queue.push({ type: "text", text: terminalReply });
              queue.push({ type: "done", text: terminalReply });
              return;
            }
          }
          prompt = `The paused operation has resumed. Its actual result follows; do not repeat completed operations.\n${outputs.join("\n")}\n\n${request.prompt}`;
        } else if (history.length) {
          prompt = `<conversation_history>\n${JSON.stringify(history)}\n</conversation_history>\n\n${prompt}`;
        }
        if (request.prompt.includes(STEERING_CONTINUATION_PROMPT) && initialSteering.length) {
          prompt = initialSteering.map((item) => item.historyText ?? item.text).join("\n");
        }
        if (initialSteering.length)
          queue.push({
            type: "steered",
            fromRunUser: initialSteering.some((item) => item.origin === "user"),
          });
        let input = [
          { type: "text", text: prompt },
          ...imageInput(request.currentTurnImages),
          ...steeringInput(initialSteering),
        ];
        transcript.push({
          role: "user",
          content: [{ type: "text", text: prompt }, ...toPiImages(request.currentTurnImages)],
          timestamp: Date.now(),
        });
        do {
          signal.throwIfAborted();
          turnId = undefined;
          turnFinished = false;
          buffered = [];
          currentTurn = new Promise((resolve) => {
            confirmTurn = resolve;
          });
          const finished = new Promise<NativeTurn>((resolve, reject) => {
            resolveTurn = resolve;
            rejectTurn = reject;
          });
          // Attach before start: a transport failure can precede its acknowledgement.
          void finished.catch(() => {});
          const startedTurn = await connection.request<{ turn: NativeTurn }>("turn/start", {
            threadId,
            input,
            effort: request.model.thinkingLevel ?? "medium",
            responsesapiClientMetadata: { rakazo_run_id: request.runId },
          });
          turnId = startedTurn.turn.id;
          confirmTurn(turnId);
          const early = buffered;
          buffered = undefined;
          for (const event of early) notification(event.method, event.params);
          if (startedTurn.turn.status !== "inProgress") {
            turnFinished = true;
            resolveTurn(startedTurn.turn);
          }
          if (signal.aborted || interrupted) await interrupt();
          timer = setInterval(() => {
            void steer().catch((error) => {
              if (!ending) rejectTurn(error);
            });
          }, 500);
          timer.unref();
          const result = await finished;
          turnFinished = true;
          clearInterval(timer);
          await toolWork;
          await steeringWork;
          if (result.status === "failed")
            throw new Error(result.error?.message ?? "Native turn failed.");
          if (
            result.status !== "completed" &&
            !(result.status === "interrupted" && (interrupted || signal.aborted))
          )
            throw new Error(
              result.error?.message ?? `Native turn ended with status ${result.status}.`,
            );
          if (host.pausePending || signal.aborted || terminalReply) break;
          input = [];
          await deliverFinishedShells(
            (text) => {
              input.push({ type: "text", text });
            },
            host.pendingShells,
            { toolResults: [] },
            signal,
          );
          if (undeliveredSteering.length) {
            input.push(...steeringInput(undeliveredSteering));
            queue.push({
              type: "steered",
              fromRunUser: undeliveredSteering.some((item) => item.origin === "user"),
            });
            undeliveredSteering.length = 0;
          }
        } while (input.length && !signal.aborted);
        if (!host.pausePending && !signal.aborted) {
          if (terminalReply) {
            queue.push({ type: "turn" });
            queue.push({ type: "text", text: terminalReply });
          }
          queue.push({ type: "done", text: terminalReply ?? finalText });
        }
      } finally {
        ending = true;
        confirmTurn();
        currentTurn = undefined;
        clearInterval(timer);
        signal.removeEventListener("abort", onAbort);
        await connection.close();
      }
    } finally {
      try {
        await bridge.close();
      } finally {
        releaseToolCallBudget(request.runId, host.pausePending);
        queue.push({ type: "thinking", active: false });
      }
    }
  }
}

function imageInput(images: AgentRunRequest["currentTurnImages"]) {
  return (images ?? []).map((image) => ({
    type: "image",
    url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
  }));
}

function steeringInput(items: AgentSteeringMessage[]) {
  return items.flatMap((item) => [
    { type: "text", text: item.historyText ?? item.text },
    ...imageInput(item.images),
  ]);
}

function modelCatalog(request: AgentRunRequest) {
  return {
    models: [
      {
        slug: request.model.id,
        display_name: request.model.id,
        description: null,
        base_instructions: "Use the supplied tools to complete the user's task.",
        default_reasoning_level: request.model.thinkingLevel ?? "medium",
        supported_reasoning_levels: [
          { effort: request.model.thinkingLevel ?? "medium", description: "Configured effort" },
        ],
        shell_type: "disabled",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        availability_nux: null,
        upgrade: null,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: "bytes", limit: 50000 },
        context_window: request.model.contextWindow ?? 128000,
        experimental_supported_tools: [],
        input_modalities: request.model.acceptsImages ? ["text", "image"] : ["text"],
      },
    ],
  };
}
