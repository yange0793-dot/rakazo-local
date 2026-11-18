import { describe, expect, it, vi } from "vitest";
import { createMixRouterCatalogSource } from "./mixrouter-catalog-source.js";

const config = {
  id: "router-a",
  label: "Local gateway",
  controlUrl: "http://127.0.0.1:9001",
  baseUrl: "http://127.0.0.1:9000/v1",
  group: "claude",
  apiProtocol: "anthropic-messages" as const,
};

describe("gateway catalog adapter", () => {
  it.each([
    ["responses", ["low", "medium", "high", "xhigh", "max"]],
    ["chat", ["low", "medium", "high", "max"]],
  ])("uses explicit effort for a converted %s route", async (wire, levels) => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/api/state")
          ? {
              providers: {
                claude: [{ id: "p", name: "Channel", models: ["model"], wire_api: wire }],
              },
            }
          : { models: [] },
      ),
    );
    expect(
      (await createMixRouterCatalogSource(config, transport).read())[0]?.models[0]?.capabilities,
    ).toEqual({ source: "declared", reasoningMode: "adaptive", thinkingLevels: levels });
  });

  it("intersects endpoint effort declarations with the gateway's encodable levels", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/api/state")
          ? {
              providers: {
                claude: [{ id: "p", name: "Channel", models: ["model"], wire_api: "chat" }],
              },
            }
          : {
              models: [
                {
                  app: "claude",
                  provider: "p",
                  model: "model",
                  capabilities: {
                    reasoning_levels: { value: ["low", "xhigh", "max"], source: "manual" },
                  },
                },
              ],
            },
      ),
    );
    expect(
      (await createMixRouterCatalogSource(config, transport).read())[0]?.models[0]?.capabilities,
    ).toEqual({
      source: "declared",
      reasoningMode: "adaptive",
      thinkingLevels: ["low", "max"],
    });
  });

  it("keeps protocol groups and stable IDs separate without copying keys", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/api/state")
          ? {
              providers: {
                claude: [
                  { id: "messages-id", name: "Channel", models: ["model-a"], api_key: "secret" },
                ],
                codex: [{ id: "responses-id", name: "Channel", model: "model-b" }],
              },
            }
          : { models: [] },
      ),
    );
    const source = createMixRouterCatalogSource(config, transport);
    const rows = await source.read();
    expect(rows).toEqual([
      {
        id: "messages-id",
        label: "Channel",
        enabled: true,
        models: [
          { id: "messages-id/model-a", label: "model-a", capabilities: { source: "unknown" } },
        ],
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/state",
      "/api/insights/models",
    ]);
  });

  it("does not turn a missing group or a failed read into an empty catalog", async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ providers: {} }));
    await expect(createMixRouterCatalogSource(config, missing).read()).rejects.toThrow(
      "configured group",
    );
    const empty = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ providers: { claude: [] } }));
    await expect(createMixRouterCatalogSource(config, empty).read()).rejects.toThrow("no channels");
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(createMixRouterCatalogSource(config, failed).read()).rejects.toThrow("HTTP 503");
  });

  it("rejects a group/protocol mismatch before making a request", () => {
    expect(() => createMixRouterCatalogSource({ ...config, group: "codex" })).toThrow(
      "do not match",
    );
  });

  it("projects declared capabilities without inferring a model or an output limit", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/api/state")
          ? { providers: { claude: [{ id: "p", name: "Channel", models: ["model"] }] } }
          : {
              models: [
                {
                  app: "claude",
                  provider: "p",
                  model: "model",
                  capabilities: {
                    context_window: { value: 500000, source: "manual" },
                    vision: { value: true, source: "manual" },
                    reasoning_levels: { value: ["low", "high"], source: "manual" },
                    max_output_tokens: { value: 4096, source: "manual" },
                  },
                },
              ],
            },
      ),
    );
    expect(
      (await createMixRouterCatalogSource(config, transport).read())[0]?.models[0]?.capabilities,
    ).toEqual({
      source: "declared",
      contextWindow: 500000,
      supportsImages: true,
      thinkingLevels: ["low", "high"],
    });
  });
});
