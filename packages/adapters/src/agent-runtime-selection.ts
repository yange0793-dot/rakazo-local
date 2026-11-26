import { join } from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { PiAgentRuntime } from "./pi-runtime.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

export type AgentRuntimeRoutes = Readonly<Record<string, "pi" | "codex">>;
export type AgentRuntimeName = "pi" | "scripted" | "codex";

export function parseAgentRuntimeRoutes(value: string | undefined): AgentRuntimeRoutes {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AGENT_RUNTIME_ROUTES must be a JSON object mapping bot IDs to pi or codex.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.entries(parsed).some(
      ([botId, runtime]) => !botId.trim() || (runtime !== "pi" && runtime !== "codex"),
    )
  ) {
    throw new Error("AGENT_RUNTIME_ROUTES must be a JSON object mapping bot IDs to pi or codex.");
  }
  return parsed as AgentRuntimeRoutes;
}

export function resolveAgentRuntimeName(
  botId: string,
  routes: AgentRuntimeRoutes = {},
  defaultRuntime = "pi",
): AgentRuntimeName {
  return Object.hasOwn(routes, botId)
    ? routes[botId]!
    : defaultRuntime === "scripted"
      ? "scripted"
      : "pi";
}

/** Keep the original default runtime; only explicitly routed bots load another adapter. */
export async function createAgentRuntimeSelection(options: {
  defaultRuntime?: string;
  routes?: AgentRuntimeRoutes;
  dataDir: string;
  piSessionRoot?: string;
}): Promise<AgentRuntime> {
  const defaultName = options.defaultRuntime === "scripted" ? "scripted" : "pi";
  const fallback =
    defaultName === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: options.piSessionRoot });
  const entries = Object.entries(options.routes ?? {});
  if (!entries.length) return fallback;
  const runtimes = new Map<AgentRuntimeName, AgentRuntime>([[defaultName, fallback]]);
  if (entries.some(([, name]) => name === "pi") && !runtimes.has("pi"))
    runtimes.set("pi", new PiAgentRuntime({ sessionRoot: options.piSessionRoot }));
  if (entries.some(([, name]) => name === "codex")) {
    const { CodexAgentRuntime } = await import("./codex-runtime.js");
    runtimes.set(
      "codex",
      new CodexAgentRuntime({ stateRoot: join(options.dataDir, "runtime-sessions", "codex") }),
    );
  }
  const routes = new Map(entries);
  const active = new Map<string, { runtime: AgentRuntime }>();
  return {
    describe() {
      const capabilities = [...runtimes.values()].map((runtime) => runtime.describe().capabilities);
      return {
        ...fallback.describe(),
        id: "routed",
        capabilities: {
          streaming: capabilities.every((value) => value.streaming),
          compaction: capabilities.every((value) => value.compaction),
          tools: capabilities.every((value) => value.tools),
          scripted: capabilities.every((value) => value.scripted),
        },
      };
    },
    run(
      request: AgentRunRequest,
      context?: Partial<AdapterContext>,
    ): AsyncIterableIterator<AgentRuntimeEvent> {
      const name = routes.get(request.botId) ?? defaultName;
      const runtime = runtimes.get(name)!;
      getLogger().info("agent runtime selected", {
        "run.id": request.runId,
        "bot.id": request.botId,
        "runtime.id": name,
      });
      const iterator = runtime.run(request, context)[Symbol.asyncIterator]();
      const entry = { runtime };
      active.set(request.runId, entry);
      const release = () => {
        if (active.get(request.runId) === entry) active.delete(request.runId);
      };
      // Forward return() immediately: wrapping a pending next() in an async
      // generator would delay the runtime's own cancellation until that read ends.
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          try {
            const next = await iterator.next();
            if (next.done) release();
            return next;
          } catch (error) {
            release();
            throw error;
          }
        },
        async return() {
          try {
            return iterator.return ? await iterator.return() : { done: true, value: undefined };
          } finally {
            release();
          }
        },
        async throw(error) {
          try {
            if (iterator.throw) return await iterator.throw(error);
            throw error;
          } finally {
            release();
          }
        },
      };
    },
    async abort(runId: string) {
      await active.get(runId)?.runtime.abort(runId);
    },
  };
}
