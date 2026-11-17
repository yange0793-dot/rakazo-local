import type { ManagedModelCapabilities, ModelApiProtocol } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import * as z from "zod";
import type { ModelCatalogSourceAdapter } from "./model-catalog-source.js";

const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  models: z.array(z.string()).optional(),
  wire_api: z.string().optional(),
});
const StateSchema = z.object({
  providers: z.record(z.string(), z.array(ProviderSchema)),
});
const ValueSchema = z.object({ value: z.unknown(), source: z.string() });
const InsightsSchema = z.object({
  models: z.array(
    z.object({
      app: z.string(),
      provider: z.string(),
      model: z.string(),
      capabilities: z.record(z.string(), ValueSchema),
    }),
  ),
});

export function createMixRouterCatalogSource(
  config: {
    id: string;
    label: string;
    controlUrl: string;
    baseUrl: string;
    group: string;
    apiProtocol: ModelApiProtocol;
  },
  transport: typeof fetch = fetch,
): ModelCatalogSourceAdapter {
  if (
    (config.group === "claude" && config.apiProtocol !== "anthropic-messages") ||
    (config.group === "codex" && config.apiProtocol === "anthropic-messages") ||
    !["claude", "codex"].includes(config.group)
  ) {
    throw new Error("Catalog group and protocol do not match");
  }
  const readJson = async (path: string, signal?: AbortSignal) => {
    const response = await transport(new URL(path, config.controlUrl), {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Catalog source returned HTTP ${response.status}`);
    return response.json();
  };
  return {
    key: `${config.id}:${config.group}`,
    label: config.label,
    group: config.group,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    apiProtocol: config.apiProtocol,
    async read(signal) {
      const state = StateSchema.parse(await readJson("/api/state", signal));
      const providers = state.providers[config.group];
      if (!providers) throw new Error("Catalog source did not return the configured group");
      const insights = InsightsSchema.parse(await readJson("/api/insights/models", signal));
      const ids = new Set<string>();
      return providers.map((provider) => {
        if (ids.has(provider.id)) throw new Error("Catalog source returned duplicate channel IDs");
        ids.add(provider.id);
        const models = [...new Set([provider.model, ...(provider.models ?? [])])]
          .filter((id): id is string => Boolean(id?.trim()))
          .map((model) => {
            const row = insights.models.find(
              (item) =>
                item.app === config.group && item.provider === provider.id && item.model === model,
            );
            const caps = row?.capabilities;
            const capabilities: ManagedModelCapabilities = { source: "unknown" };
            // Converted routes forward output_config.effort, not Messages token budgets.
            if (
              config.apiProtocol === "anthropic-messages" &&
              (provider.wire_api === "responses" || provider.wire_api === "chat")
            ) {
              capabilities.reasoningMode = "adaptive";
              capabilities.thinkingLevels =
                provider.wire_api === "responses"
                  ? ["low", "medium", "high", "xhigh", "max"]
                  : ["low", "medium", "high", "max"];
              capabilities.source = "declared";
            }
            if (caps) {
              const context = caps.context_window;
              if (
                context?.source !== "unknown" &&
                typeof context?.value === "number" &&
                Number.isSafeInteger(context.value) &&
                context.value > 0
              )
                capabilities.contextWindow = context.value;
              const vision = caps.vision;
              if (vision?.source !== "unknown" && typeof vision?.value === "boolean")
                capabilities.supportsImages = vision.value;
              const levels = z.array(ThinkingLevelSchema).safeParse(caps.reasoning_levels?.value);
              if (caps.reasoning_levels?.source !== "unknown" && levels.success)
                capabilities.thinkingLevels = capabilities.thinkingLevels
                  ? levels.data.filter((level) => capabilities.thinkingLevels!.includes(level))
                  : levels.data;
              if (Object.keys(capabilities).length > 1) capabilities.source = "declared";
            }
            return { id: `${provider.id}/${model}`, label: model, capabilities };
          });
        return {
          id: provider.id,
          label: provider.name,
          enabled: provider.enabled !== false,
          models,
        };
      });
    },
  };
}
