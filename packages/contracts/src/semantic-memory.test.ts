import { describe, expect, it } from "vitest";
import {
  SemanticFactCorrectRequestSchema,
  SemanticFactForgetRequestSchema,
  SemanticFactListRequestSchema,
  SemanticFactProvenanceSchema,
  SemanticFactSchema,
  SemanticMemoryRecallInputSchema,
} from "./semantic-memory.js";

const fact = {
  id: "fact-a",
  botId: "bot-a",
  scope: "isolated",
  kind: "durable",
  content: "Use the staging environment for the synthetic project.",
  revision: 2,
  status: "active",
  provenance: { kind: "user", messageId: "message-a", observedAt: "2026-11-16T00:00:00Z" },
  createdAt: "2026-11-15T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
};

describe("managed semantic fact contracts", () => {
  it("defaults to a bounded topic search and permits deeper scoped recall", () => {
    expect(SemanticMemoryRecallInputSchema.parse({ query: " project " })).toEqual({
      query: "project",
      limit: 20,
      scope: "current",
    });
    expect(
      SemanticMemoryRecallInputSchema.parse({ query: "project", limit: 50, scope: "all" }),
    ).toEqual({ query: "project", limit: 50, scope: "all" });
    for (const input of [
      { query: "" },
      { query: "project", limit: 51 },
      { query: "project", limit: -1 },
      { query: "project", limit: 2.5 },
      { query: "project", scope: "other-user" },
      { query: "project", botId: "another-bot" },
    ]) {
      expect(SemanticMemoryRecallInputSchema.safeParse(input).success).toBe(false);
    }
  });
  it("preserves source and revision without introducing vendor-specific fields", () => {
    expect(SemanticFactSchema.parse(fact)).toEqual(fact);
  });

  it("requires an explicit bot and namespace for management", () => {
    expect(SemanticFactListRequestSchema.safeParse({ botId: "bot-a" }).success).toBe(false);
    expect(SemanticFactListRequestSchema.safeParse({ scope: "shared" }).success).toBe(false);
    expect(
      SemanticFactListRequestSchema.safeParse({ botId: "bot-a", scope: "shared" }).success,
    ).toBe(true);
    expect(
      SemanticFactListRequestSchema.safeParse({ botId: "bot-a", scope: "shared", limit: 101 })
        .success,
    ).toBe(false);
  });

  it("requires conditional revisions for correction and forgetting", () => {
    const scope = { id: "fact-a", botId: "bot-a", scope: "isolated" };
    expect(
      SemanticFactCorrectRequestSchema.safeParse({ ...scope, content: "replacement" }).success,
    ).toBe(false);
    expect(SemanticFactForgetRequestSchema.safeParse(scope).success).toBe(false);
    expect(
      SemanticFactForgetRequestSchema.safeParse({ ...scope, expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      SemanticFactCorrectRequestSchema.safeParse({ ...scope, expectedRevision: 1, content: " " })
        .success,
    ).toBe(false);
    expect(
      SemanticFactCorrectRequestSchema.parse({
        ...scope,
        expectedRevision: 1,
        content: "replacement",
      }).expectedRevision,
    ).toBe(1);
  });

  it("rejects a correction that fits the character limit but exceeds the UTF-8 index budget", () => {
    const request = { id: "fact-a", botId: "bot-a", scope: "isolated", expectedRevision: 1 };
    expect(
      SemanticFactCorrectRequestSchema.safeParse({ ...request, content: "界".repeat(14_000) })
        .success,
    ).toBe(false);
    expect(
      SemanticFactCorrectRequestSchema.safeParse({ ...request, content: "界".repeat(10_000) })
        .success,
    ).toBe(true);
  });

  it("keeps imported evidence as inert provenance, not an active-state upgrade", () => {
    const imported = SemanticFactSchema.parse({
      ...fact,
      status: "historical",
      provenance: {
        kind: "import",
        sourceId: "legacy-drawer-a",
        legacy: {
          validationStatus: "candidate",
          sourceBotId: "legacy-bot",
          originalObservedAt: null,
        },
      },
    });
    expect(imported.status).toBe("historical");
    expect(imported.provenance.legacy?.originalObservedAt).toBeNull();
    expect(
      SemanticFactProvenanceSchema.safeParse({ kind: "user", validFrom: "yesterday" }).success,
    ).toBe(false);
  });
});
