import { describe, expect, it } from "vitest";
import {
  MemoryDerivedSpansSchema,
  MemorySourceFactSchema,
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
  it("keeps derivations optional for legacy content and rejects invalid source/range contracts", () => {
    const source = {
      id: "fact-a",
      revision: 2,
      botId: "bot-a",
      scope: "isolated",
      kind: "durable",
    };
    expect(SemanticFactProvenanceSchema.parse({ kind: "manual" })).toEqual({ kind: "manual" });
    expect(SemanticFactProvenanceSchema.parse({ kind: "run", derivedFrom: [source] })).toEqual({
      kind: "run",
      derivedFrom: [source],
    });
    expect(MemorySourceFactSchema.safeParse({ ...source, revision: -1 }).success).toBe(false);
    expect(
      MemorySourceFactSchema.safeParse({ ...source, kind: "lesson", scope: "shared" }).success,
    ).toBe(false);
    expect(MemorySourceFactSchema.safeParse({ ...source, kind: "history" }).success).toBe(false);
    expect(
      MemoryDerivedSpansSchema.safeParse([{ start: 1, end: 1, sources: [source] }]).success,
    ).toBe(false);
    expect(
      MemoryDerivedSpansSchema.safeParse([
        { start: 0, end: 5, sources: [source] },
        { start: 3, end: 8, sources: [source] },
      ]).success,
    ).toBe(false);
  });
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
  it("supports lesson discovery and exact revision reads without widening lesson scope", () => {
    expect(
      SemanticMemoryRecallInputSchema.parse({
        query: "部署失败",
        kind: "lesson",
      }),
    ).toEqual({ query: "部署失败", kind: "lesson", limit: 20, scope: "current" });
    expect(
      SemanticMemoryRecallInputSchema.parse({
        id: "lesson-a",
        expected_revision: 4,
        kind: "lesson",
      }),
    ).toEqual({
      id: "lesson-a",
      expected_revision: 4,
      kind: "lesson",
      scope: "current",
    });
    expect(
      SemanticMemoryRecallInputSchema.safeParse({
        id: "lesson-a",
        expected_revision: 4,
        kind: "lesson",
        scope: "shared",
      }).success,
    ).toBe(false);
    expect(
      SemanticMemoryRecallInputSchema.safeParse({
        query: "部署",
        kind: "lesson",
        scope: "all",
      }).success,
    ).toBe(false);
    expect(
      SemanticMemoryRecallInputSchema.safeParse({
        id: "fact-a",
        expected_revision: 0,
      }).success,
    ).toBe(false);
  });

  it("requires one discovery query or exact citation and keeps caller scope fields host-owned", () => {
    expect(
      SemanticMemoryRecallInputSchema.parse({
        id: "fact-a",
        expected_revision: 2,
        scope: "shared",
      }),
    ).toEqual({ id: "fact-a", expected_revision: 2, scope: "shared" });
    for (const input of [
      {},
      { id: "fact-a" },
      { expected_revision: 2 },
      { id: "  ", expected_revision: 2 },
      { id: "fact-a", expected_revision: 2.5 },
      { id: "fact-a", expected_revision: 2, query: "fact" },
      { id: "fact-a", expected_revision: 2, limit: 1 },
      { id: "fact-a", expected_revision: 2, scope: "all" },
      { id: "fact-a", expected_revision: 2, spaceId: "space-other" },
      { id: "fact-a", expected_revision: 2, botId: "bot-other" },
      { id: "fact-a", expected_revision: 2, historyGeneration: 0 },
      { query: "lesson", kind: "durable" },
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
