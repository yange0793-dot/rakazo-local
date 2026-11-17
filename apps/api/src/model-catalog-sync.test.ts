import type { CatalogChannel, StoredModelSecret } from "@rakazo/adapters";
import { parseModelSecret, serializeModelSecret } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { projectCatalogChannel } from "./model-catalog-sync.js";

const source = { id: "source-a", label: "Gateway", group: "messages" };
const channel: CatalogChannel = {
  id: "provider-id",
  label: "Channel",
  enabled: true,
  models: [{ id: "provider-id/model-a", label: "model-a", capabilities: { source: "unknown" } }],
};
const previous: Extract<StoredModelSecret, { kind: "openai_compatible" }> = {
  kind: "openai_compatible",
  baseUrl: "http://127.0.0.1:9000/v1",
  apiProtocol: "anthropic-messages",
  enabledModelIds: ["Channel/model-a", "Channel/removed"],
  visionModelIds: ["Channel/model-a"],
  contextWindow: 1000000,
  thinkingLevel: "high",
};

describe("managed catalog projection", () => {
  it("keeps overrides and removed identities while using stable request IDs", () => {
    const next = projectCatalogChannel(source, channel, previous, "Channel", "provider-id");
    expect(next.enabledModelIds).toEqual(["provider-id/model-a"]);
    expect(next.managedCatalog?.unavailableModelIds).toEqual(["Channel/removed"]);
    expect(next.managedCatalog?.aliases["Channel/model-a"]).toBe("provider-id/model-a");
    expect(next.contextWindow).toBe(1000000);
    expect(next.thinkingLevel).toBe("high");
    expect(next.visionModelIds).toEqual(["provider-id/model-a"]);
    expect(next.maxTokens).toBeUndefined();
    expect(parseModelSecret(serializeModelSecret(next))).toEqual(next);
  });

  it("retains old aliases through rename and is idempotent", () => {
    const first = projectCatalogChannel(source, channel, previous, "Channel", "provider-id");
    const renamed = { ...channel, label: "Renamed" };
    const next = projectCatalogChannel(source, renamed, first, "Channel", "provider-id");
    expect(next.managedCatalog?.aliases).toEqual({
      "Channel/model-a": "provider-id/model-a",
      "Renamed/model-a": "provider-id/model-a",
    });
    expect(projectCatalogChannel(source, renamed, next, "Renamed", "provider-id")).toEqual(next);
  });

  it("deactivates removed channels and restores the same identities when they return", () => {
    const first = projectCatalogChannel(source, channel, previous, "Channel", "provider-id");
    const missing = projectCatalogChannel(source, undefined, first, "Channel", "provider-id");
    expect(missing.enabledModelIds).toEqual([]);
    expect(missing.managedCatalog?.unavailableModelIds).toContain("provider-id/model-a");
    const restored = projectCatalogChannel(source, channel, missing, "Channel", "provider-id");
    expect(restored.enabledModelIds).toEqual(["provider-id/model-a"]);
    expect(restored.managedCatalog?.unavailableModelIds).toEqual(["Channel/removed"]);
  });

  it("preserves locally disabled models while enabling newly added source models", () => {
    const first = projectCatalogChannel(source, channel, previous, "Channel", "provider-id");
    first.managedCatalog!.disabledModelIds = ["provider-id/model-a"];
    const expanded: CatalogChannel = {
      ...channel,
      models: [
        ...channel.models,
        {
          id: "provider-id/model-b",
          label: "model-b",
          capabilities: { source: "unknown" },
        },
      ],
    };
    const next = projectCatalogChannel(source, expanded, first, "Channel", "provider-id");
    expect(next.enabledModelIds).toEqual(["provider-id/model-b"]);
    expect(next.managedCatalog?.disabledModelIds).toEqual(["provider-id/model-a"]);
  });
});
