import type { ManagedModelCapabilities, ModelApiProtocol } from "@rakazo/contracts";
import { ModelApiProtocolSchema } from "@rakazo/contracts";
import * as z from "zod";

export type CatalogChannel = {
  id: string;
  label: string;
  enabled: boolean;
  models: Array<{ id: string; label: string; capabilities: ManagedModelCapabilities }>;
};

export type ModelCatalogSourceAdapter = {
  key: string;
  label: string;
  group: string;
  baseUrl: string;
  apiProtocol: ModelApiProtocol;
  read(signal?: AbortSignal): Promise<CatalogChannel[]>;
};

const SourceConfig = z.object({
  id: z.string().min(1),
  adapter: z.literal("mixrouter"),
  label: z.string().min(1),
  controlUrl: z.url(),
  baseUrl: z.url(),
  group: z.string().min(1),
  apiProtocol: ModelApiProtocolSchema,
});

/** Operator-owned sources; clients never supply control endpoints or upstream keys. */
export async function modelCatalogSourcesFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<ModelCatalogSourceAdapter[]> {
  if (!env.MODEL_CATALOG_SOURCES?.trim()) return [];
  const configs = z.array(SourceConfig).parse(JSON.parse(env.MODEL_CATALOG_SOURCES));
  const { createMixRouterCatalogSource } = await import("./mixrouter-catalog-source.js");
  return configs.map((config) => createMixRouterCatalogSource(config));
}
