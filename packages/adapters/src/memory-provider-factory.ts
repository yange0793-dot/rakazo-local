import type { DurableMemoryScope, SecretStore, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  createHonchoProvider,
  HONCHO_PROVIDER_ID,
  honchoRequiresPrivateEndpoint,
  prepareHonchoConnection,
} from "./honcho-memory-provider.js";
import {
  assertLocalMemoryEndpointAllowed,
  localMemoryEndpointAllowed,
  normalizeLocalMemoryBaseUrl,
} from "./local-memory-endpoint.js";
import type { LocalMemoryIndex } from "./local-memory-index.js";
import { createLocalMemoryIndex, LOCAL_MEMORY_PROVIDER_ID } from "./local-memory-index.js";
import { revalidateLocalServiceSettings } from "./local-service-endpoint.js";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  prepareSerenityConnection,
  SERENITY_PROVIDER_ID,
  serenityRequiresPrivateEndpoint,
} from "./serenity-memory-provider.js";

export { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

import {
  createSupermemoryProvider,
  decodeLegacySupermemoryCredentials,
  prepareSupermemoryConnection,
  SUPERMEMORY_PROVIDER_ID,
  supermemoryRequiresPrivateEndpoint,
} from "./supermemory-memory-provider.js";

export interface MemoryProviderConnectionInput {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
  /** When false, providers must not probe endpoints that classify as private. */
  allowPrivateEndpoint?: boolean;
  /** Exact local-memory policy; independent of permission to reach private MCP endpoints. */
  localAllowedUrls?: string;
}

export interface PreparedMemoryProviderConnection {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

export interface ConfiguredMemoryProvider {
  provider: SemanticMemoryProvider;
  defaultScope: DurableMemoryScope;
}

export interface MemoryProviderResolver {
  resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null>;
}

export interface MemoryProviderDependencies {
  /** Composition roots bind their authority store and optional job scheduler. */
  createManagedMemoryProvider?: (index: LocalMemoryIndex) => SemanticMemoryProvider;
}

export interface MemoryProviderEndpointPolicy {
  allowPrivateEndpoint?: boolean;
  localAllowedUrls?: string;
}

interface MemoryProviderAdapter {
  requiresPrivateEndpoint(settings: Record<string, string>): boolean;
  /** Async trust classification (e.g. DNS) without probing credentials. */
  classifySettings?(settings: Record<string, string>): Promise<Record<string, string>>;
  /** Recheck persisted endpoint settings before their credentials are decrypted. */
  revalidate?(settings: Record<string, string>): Promise<void>;
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options?: MemoryProviderEndpointPolicy,
  ): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }>;
  create(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    dependencies?: MemoryProviderDependencies,
  ): SemanticMemoryProvider;
  decodeLegacyCredentials?(plaintext: string): Record<string, string> | null;
}

const MEMORY_PROVIDER_ADAPTERS: ReadonlyMap<string, MemoryProviderAdapter> = new Map<
  string,
  MemoryProviderAdapter
>([
  [
    LOCAL_MEMORY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: () => true,
      classifySettings: async (settings) => ({
        baseUrl: normalizeLocalMemoryBaseUrl(settings.baseUrl ?? ""),
      }),
      revalidate: async (settings) => {
        assertLocalMemoryEndpointAllowed(settings.baseUrl ?? "");
      },
      prepare: async (settings, credentials, options) => {
        // Local memory always requires its own exact allowlist, even when private MCP is enabled.
        const baseUrl = assertLocalMemoryEndpointAllowed(
          settings.baseUrl ?? "",
          options?.localAllowedUrls,
        );
        const token = credentials.token ?? "";
        const index = createLocalMemoryIndex(
          { baseUrl, token },
          { allowedUrls: options?.localAllowedUrls },
        );
        await index.health(new AbortController().signal);
        return { settings: { baseUrl }, credentials: { token: token.trim() } };
      },
      create: (settings, credentials, dependencies) => {
        if (!dependencies?.createManagedMemoryProvider) {
          throw new Error("Local memory requires a configured transactional fact store.");
        }
        const index = createLocalMemoryIndex({
          baseUrl: settings.baseUrl ?? "",
          token: credentials.token ?? "",
        });
        return dependencies.createManagedMemoryProvider(index);
      },
    },
  ],
  [
    SUPERMEMORY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: supermemoryRequiresPrivateEndpoint,
      revalidate: revalidateLocalServiceSettings,
      prepare: prepareSupermemoryConnection,
      create: createSupermemoryProvider,
      decodeLegacyCredentials: decodeLegacySupermemoryCredentials,
    },
  ],
  [
    SERENITY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: serenityRequiresPrivateEndpoint,
      classifySettings: classifySerenityConnectionSettings,
      prepare: (
        settings: Record<string, string>,
        credentials: Record<string, string>,
        options?: { allowPrivateEndpoint?: boolean },
      ) => prepareSerenityConnection(settings, credentials, undefined, options),
      create: createSerenityProvider,
    },
  ],
  [
    HONCHO_PROVIDER_ID,
    {
      requiresPrivateEndpoint: honchoRequiresPrivateEndpoint,
      revalidate: revalidateLocalServiceSettings,
      prepare: prepareHonchoConnection,
      create: createHonchoProvider,
    },
  ],
]);

function memoryProviderAdapter(provider: string): MemoryProviderAdapter {
  const adapter = MEMORY_PROVIDER_ADAPTERS.get(provider);
  if (!adapter) throw new Error(`Unknown memory provider "${provider}".`);
  return adapter;
}

/** Adapters classify their settings; callers enforce the deployment trust boundary. */
export function memoryProviderRequiresPrivateEndpoint(
  provider: string,
  settings: Record<string, string>,
): boolean {
  return memoryProviderAdapter(provider).requiresPrivateEndpoint(settings);
}

/** Local memory has an exact allowlist; other providers retain their existing private policy. */
export function memoryProviderEndpointAuthorized(
  provider: string,
  settings: Record<string, string>,
  policy: MemoryProviderEndpointPolicy = {},
): boolean {
  if (provider === LOCAL_MEMORY_PROVIDER_ID) {
    return localMemoryEndpointAllowed(settings.baseUrl ?? "", policy.localAllowedUrls);
  }
  return (
    !memoryProviderRequiresPrivateEndpoint(provider, settings) ||
    policy.allowPrivateEndpoint === true
  );
}

/**
 * Run provider-specific trust classification (DNS, etc.) without credentialed probes.
 * Callers must authorize private endpoints through operator configuration before prepare/probe.
 */
export async function classifyMemoryProviderSettings(
  provider: string,
  settings: Record<string, string>,
): Promise<Record<string, string>> {
  const adapter = memoryProviderAdapter(provider);
  return adapter.classifySettings ? adapter.classifySettings(settings) : settings;
}

export async function prepareMemoryProviderConnection(
  input: MemoryProviderConnectionInput,
): Promise<PreparedMemoryProviderConnection> {
  const prepared = await memoryProviderAdapter(input.provider).prepare(
    input.settings,
    input.credentials,
    { allowPrivateEndpoint: input.allowPrivateEndpoint, localAllowedUrls: input.localAllowedUrls },
  );
  return { provider: input.provider, ...prepared };
}

export function createMemoryProvider(
  provider: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
  dependencies: MemoryProviderDependencies = {},
): SemanticMemoryProvider {
  return memoryProviderAdapter(provider).create(settings, credentials, dependencies);
}

export function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function decodeCredentials(provider: string, plaintext: string): Record<string, string> {
  try {
    const credentials = toStringRecord(JSON.parse(plaintext));
    if (Object.keys(credentials).length > 0) return credentials;
  } catch {
    // Configurations created before the generic provider boundary stored the API key directly.
  }
  const legacyCredentials = memoryProviderAdapter(provider).decodeLegacyCredentials?.(plaintext);
  if (legacyCredentials) return legacyCredentials;
  throw new Error(`Stored credentials for memory provider "${provider}" are invalid.`);
}

export class SpaceMemoryProviderResolver implements MemoryProviderResolver {
  constructor(
    private readonly prisma: Pick<PrismaClient, "spaceMemoryConfig">,
    private readonly secrets: SecretStore,
    private readonly dependencies: MemoryProviderDependencies = {},
  ) {}

  async resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null> {
    const config = await this.prisma.spaceMemoryConfig.findUnique({
      where: { spaceId },
      include: { secret: true },
    });
    if (!config) return null;
    const settings = toStringRecord(config.settings);
    const adapter = memoryProviderAdapter(config.provider);
    try {
      // Saved configurations cannot bypass an operator's current network policy.
      if (
        !memoryProviderEndpointAuthorized(config.provider, settings, {
          allowPrivateEndpoint: process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
        })
      )
        return null;
      await adapter.revalidate?.(settings);
    } catch {
      getLogger().warn("Semantic memory disabled: endpoint revalidation failed");
      return null;
    }
    const credentials = decodeCredentials(
      config.provider,
      await this.secrets.load(config.secret.ciphertext, config.secret.id),
    );
    return {
      provider: createMemoryProvider(config.provider, settings, credentials, this.dependencies),
      defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    };
  }
}
