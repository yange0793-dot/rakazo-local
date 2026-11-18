import { i18n } from "@lingui/core";
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { memoryProviderSettings } from "./registry";
import {
  SERENITY_ENDPOINT_PLACEHOLDER,
  serenityConnectionDraft,
  serenityEndpointError,
} from "./serenity-settings";

describe("Serenity memory provider settings", () => {
  it("requires an explicit endpoint and leaves URL validity to the backend", () => {
    expect(serenityEndpointError("")).toBe("required");
    expect(serenityEndpointError("   ")).toBe("required");
    expect(serenityEndpointError("not a url")).toBeNull();
    expect(serenityEndpointError("ftp://serenity.example.test/mcp")).toBeNull();
    expect(serenityEndpointError("https://user:pass@serenity.example.test/mcp")).toBeNull();
    expect(serenityEndpointError("https://serenity.example.test/mcp?x=1")).toBeNull();
    expect(serenityEndpointError(SERENITY_ENDPOINT_PLACEHOLDER)).toBeNull();

    expect(
      serenityConnectionDraft({
        endpoint: "",
        token: "serenity_token",
        brainLabel: "",
        allowWrites: false,
      }),
    ).toEqual({ ok: false, error: "required" });

    expect(
      serenityConnectionDraft({
        endpoint: "not a url",
        token: "serenity_token",
        brainLabel: "",
        allowWrites: false,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: { endpoint: "not a url", allowWrites: "false" },
        credentials: { token: "serenity_token" },
      },
    });

    expect(
      serenityConnectionDraft({
        endpoint: SERENITY_ENDPOINT_PLACEHOLDER,
        token: "sk_live_example",
        brainLabel: " personal ",
        allowWrites: true,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: {
          endpoint: "https://serenity.sire.run/mcp",
          allowWrites: "true",
          brainLabel: "personal",
        },
        credentials: { token: "sk_live_example" },
      },
    });
  });
});

describe("Memory provider labels", () => {
  function config(settings: Record<string, string>): SpaceMemoryConfig {
    return {
      provider: "fixture",
      settings,
      defaultMemoryScope: "isolated",
      updatedAt: "",
    } as SpaceMemoryConfig;
  }

  afterEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("reads provider names and connection descriptions through the shared catalog", () => {
    i18n.load("zh-CN", {
      "Local memory": "本地记忆",
      "read/write": "读写",
      "recall only": "仅召回",
      "Self-hosted ({baseUrl})": "自托管（{baseUrl}）",
      "Honcho Cloud": "Honcho 云端",
    });
    i18n.activate("zh-CN");
    expect(memoryProviderSettings("local")?.name).toBe("本地记忆");
    expect(
      memoryProviderSettings("serenity")?.connectedLabel(
        config({ endpoint: "http://brain", allowWrites: "false" }),
      ),
    ).toBe("http://brain, 仅召回");
    expect(
      memoryProviderSettings("serenity")?.connectedLabel(
        config({ endpoint: "http://brain", allowWrites: "true" }),
      ),
    ).toBe("http://brain, 读写");
    expect(memoryProviderSettings("honcho")?.connectedLabel(config({ mode: "cloud" }))).toBe(
      "Honcho 云端",
    );
    expect(
      memoryProviderSettings("honcho")?.connectedLabel(
        config({ mode: "local", baseUrl: "http://h" }),
      ),
    ).toBe("自托管（http://h）");
  });
});
