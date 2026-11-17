import { lookup } from "node:dns/promises";
import type { SemanticMemoryProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalServiceBaseUrl } from "./local-service-endpoint.js";
import type { MemoryProviderDependencies } from "./memory-provider-factory.js";
import {
  createMemoryProvider,
  memoryProviderEndpointAuthorized,
  memoryProviderRequiresPrivateEndpoint,
  prepareMemoryProviderConnection,
  SpaceMemoryProviderResolver,
} from "./memory-provider-factory.js";
import { dispatcherFetch } from "./undici-fetch.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("./undici-fetch.js", () => ({
  dispatcherFetch: vi.fn(),
  fetchPairedWithDispatcher: (transport: typeof fetch) => transport,
}));

function resolverFor(
  plaintext: string,
  options: {
    provider?: string;
    mode?: "cloud" | "local";
    allowPrivateEndpoint?: boolean;
    baseUrl?: string;
    dependencies?: MemoryProviderDependencies;
  } = {},
) {
  vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", options.allowPrivateEndpoint ? "true" : "false");
  const prisma = {
    spaceMemoryConfig: {
      findUnique: vi.fn(async () => ({
        userId: "config-author",
        provider: options.provider ?? "supermemory",
        settings: {
          mode: options.mode ?? "cloud",
          baseUrl: options.baseUrl ?? "https://api.supermemory.ai",
        },
        defaultMemoryScope: "shared",
        secret: { ciphertext: "encrypted" },
      })),
    },
  };
  const secrets = { load: vi.fn(() => plaintext) };
  return {
    resolver: new SpaceMemoryProviderResolver(
      prisma as never,
      secrets as never,
      options.dependencies,
    ),
    secrets,
    prisma,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("SpaceMemoryProviderResolver", () => {
  it("keeps local classification private while authorizing only its explicit memory endpoint", () => {
    const settings = { baseUrl: "http://127.0.0.1:17676" };
    expect(memoryProviderRequiresPrivateEndpoint("local", settings)).toBe(true);
    expect(
      memoryProviderEndpointAuthorized("local", settings, {
        allowPrivateEndpoint: true,
        localAllowedUrls: "",
      }),
    ).toBe(false);
    expect(
      memoryProviderEndpointAuthorized("local", settings, {
        allowPrivateEndpoint: false,
        localAllowedUrls: settings.baseUrl,
      }),
    ).toBe(true);
    expect(
      memoryProviderEndpointAuthorized(
        "honcho",
        { mode: "local", baseUrl: settings.baseUrl },
        { allowPrivateEndpoint: false, localAllowedUrls: settings.baseUrl },
      ),
    ).toBe(false);
  });

  it("does not decrypt credentials or probe unauthorized local endpoints", async () => {
    vi.stubEnv("RAKAZO_LOCAL_MEMORY_ALLOWED_URLS", "http://127.0.0.1:17676");
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const { resolver, secrets } = resolverFor(
      JSON.stringify({ token: "synthetic-local-token-00000000000001" }),
      {
        provider: "local",
        baseUrl: "http://127.0.0.1:17677",
        allowPrivateEndpoint: true,
      },
    );
    await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(secrets.load).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("creates the managed local provider through optional DI without probing during resolution", async () => {
    const baseUrl = "http://127.0.0.1:17676";
    vi.stubEnv("RAKAZO_LOCAL_MEMORY_ALLOWED_URLS", baseUrl);
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const managed = { describe: () => ({ id: "local" }) } as SemanticMemoryProvider;
    const createManagedMemoryProvider = vi.fn(() => managed);
    const { resolver, secrets } = resolverFor(
      JSON.stringify({ token: "synthetic-local-token-00000000000001" }),
      {
        provider: "local",
        baseUrl,
        allowPrivateEndpoint: false,
        dependencies: { createManagedMemoryProvider },
      },
    );
    const configured = await resolver.resolve("workspace-1");
    expect(configured?.provider).toBe(managed);
    expect(createManagedMemoryProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.any(Function),
        upsert: expect.any(Function),
        remove: expect.any(Function),
        health: expect.any(Function),
      }),
    );
    expect(secrets.load).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails visibly when local authority wiring is missing", () => {
    expect(() =>
      createMemoryProvider(
        "local",
        { baseUrl: "http://127.0.0.1:17676" },
        { token: "synthetic-local-token-00000000000001" },
      ),
    ).toThrow(/transactional fact store/);
  });

  it("authorizes local preparation before credentials and the health probe", async () => {
    const baseUrl = "http://127.0.0.1:17676";
    const token = "synthetic-local-token-00000000000001";
    const transport = vi
      .mocked(dispatcherFetch)
      .mockImplementation(async () => Response.json({ ok: true }));
    await expect(
      prepareMemoryProviderConnection({
        provider: "local",
        settings: { baseUrl },
        credentials: { token },
        allowPrivateEndpoint: true,
        localAllowedUrls: "",
      }),
    ).rejects.toThrow(/allowlist/);
    expect(transport).not.toHaveBeenCalled();
    await expect(
      prepareMemoryProviderConnection({
        provider: "local",
        settings: { baseUrl },
        credentials: { token },
        allowPrivateEndpoint: false,
        localAllowedUrls: baseUrl,
      }),
    ).resolves.toEqual({
      provider: "local",
      settings: { baseUrl },
      credentials: { token },
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0]).toBe(`${baseUrl}/health`);
  });

  it.each(["honcho", "supermemory"])(
    "disables %s without loading credentials when local DNS revalidation fails",
    async (provider) => {
      vi.mocked(lookup).mockRejectedValue(new Error("DNS unavailable"));
      const { resolver, secrets } = resolverFor(JSON.stringify({ apiKey: "fake-key" }), {
        provider,
        mode: "local",
        baseUrl: "http://memory.example.test:8000",
        allowPrivateEndpoint: true,
      });

      await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
      expect(lookup).toHaveBeenCalled();
      expect(secrets.load).not.toHaveBeenCalled();
    },
  );

  it("gates and revalidates saved local Honcho endpoints like other local providers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const local = { provider: "honcho", mode: "local" as const };

    const notOwner = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "http://10.0.0.8:8000",
      allowPrivateEndpoint: false,
    });
    await expect(notOwner.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(notOwner.secrets.load).not.toHaveBeenCalled();

    const publicHost = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "http://203.0.113.10:8000",
      allowPrivateEndpoint: true,
    });
    await expect(publicHost.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(publicHost.secrets.load).not.toHaveBeenCalled();

    const missingUrl = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "",
      allowPrivateEndpoint: true,
    });
    await expect(missingUrl.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(missingUrl.secrets.load).not.toHaveBeenCalled();

    const owned = resolverFor(JSON.stringify({ apiKey: "honcho-admin-token" }), {
      ...local,
      baseUrl: "http://10.0.0.8:8000",
      allowPrivateEndpoint: true,
    });
    const configured = await owned.resolver.resolve("workspace-1");
    expect(configured?.provider.describe().id).toBe("honcho");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    "disables saved local configurations without explicit operator authorization: %s",
    async (allowPrivateEndpoint) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { resolver, secrets } = resolverFor("sm_fake_key", {
        mode: "local",
        baseUrl: "http://127.0.0.1:8123/internal-action#",
        allowPrivateEndpoint,
      });

      await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
      expect(secrets.load).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains deployment-owner-configured local memory for Space members", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://localhost:6767/memory/",
      allowPrivateEndpoint: true,
    });
    const configured = await resolver.resolve("workspace-1");
    await configured!.provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "space-member",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:6767/memory/v4/search");
  });

  it("disables ambiguous persisted URLs even when the deployment owner configured them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://127.0.0.1:8123/internal-action#",
      allowPrivateEndpoint: true,
    });
    await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads generic JSON credential payloads", async () => {
    const { resolver } = resolverFor(JSON.stringify({ apiKey: "sm_json_key" }));

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
    expect(configured?.defaultScope).toBe("shared");
  });

  it("keeps legacy raw Supermemory credentials usable after the schema migration", async () => {
    const { resolver } = resolverFor("sm_legacy_key");

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
  });

  it("revalidates persisted provider endpoints before using decrypted credentials", async () => {
    const { resolver, secrets } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://203.0.113.10:6767",
      allowPrivateEndpoint: true,
    });
    await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(secrets.load).not.toHaveBeenCalled();

    await expect(
      assertLocalServiceBaseUrl("https://memory.example.com", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);
    await expect(
      assertLocalServiceBaseUrl("http://example.com:6767", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);

    expect(() =>
      createMemoryProvider(
        "supermemory",
        { mode: "local", baseUrl: "http://203.0.113.10:6767" },
        { apiKey: "sm_test_key" },
      ),
    ).toThrow(/private-network/);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createMemoryProvider(
      "supermemory",
      { mode: "cloud", baseUrl: "https://memory.example.com" },
      { apiKey: "sm_test_key" },
    );

    await provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "user-1",
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.supermemory.ai/v4/search");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
