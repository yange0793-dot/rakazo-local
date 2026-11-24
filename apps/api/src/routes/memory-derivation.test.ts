import { createRouterClient } from "@orpc/server";
import type { Actor, MemorySourceFact, SemanticFact } from "@rakazo/contracts";
import { SemanticFactStore } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouterContext } from "./context.js";
import { memoryRoutes } from "./memory.js";

const actor: Actor = {
  userId: "user-a",
  spaceId: "space-a",
  email: "member@example.test",
  isDeploymentOwner: false,
};
const source: MemorySourceFact = {
  id: "fact-a",
  revision: 2,
  botId: "bot-a",
  scope: "shared",
  kind: "durable",
};
const fact: SemanticFact = {
  id: "lesson-a",
  revision: 1,
  botId: "bot-a",
  scope: "isolated",
  kind: "lesson",
  content: "cue: Files\nlesson: Check paths.",
  status: "active",
  provenance: { kind: "run", runId: "run-a", derivedFrom: [source] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("lesson draft source confirmation", () => {
  it.each([true, false])(
    "preserves host draft sources with old drafts still supported (sources: %s)",
    async (tracked) => {
      const save = vi.spyOn(SemanticFactStore.prototype, "saveLesson").mockResolvedValue(fact);
      const block = {
        kind: "lesson_draft",
        lessonId: "draft-a",
        runId: "run-a",
        cue: "Files",
        lesson: "Check paths.",
        evidence: { kind: "tool_error", quote: "missing file" },
        status: "draft",
        ...(tracked ? { derivedFrom: [source] } : {}),
      };
      const deps = {
        prisma: {
          bot: {
            findFirst: vi.fn(async () => ({
              id: "bot-a",
              spaceId: actor.spaceId,
              userId: actor.userId,
              archivedAt: null,
              thread: { id: "thread-a" },
            })),
          },
          message: {
            findMany: vi.fn(async () => [{ id: "draft-message", blocks: [block] }]),
            update: vi.fn(async () => ({})),
          },
        },
        memoryProviders: {
          resolve: vi.fn(async () => ({
            provider: { describe: () => ({ capabilities: { managedFacts: true } }) },
          })),
        },
        events: { append: vi.fn(async () => ({})) },
        env: { agentRuntime: "scripted" },
      } as unknown as RouterDeps;
      const client = createRouterClient(memoryRoutes(createRouterContext(deps)), {
        context: { actor },
      });
      await expect(
        client.memory.saveLesson({ botId: "bot-a", lessonId: "draft-a" }),
      ).resolves.toMatchObject({ id: "lesson-a" });
      const provenance = save.mock.calls[0]?.[0].provenance;
      expect(provenance?.derivedFrom).toEqual(tracked ? [source] : undefined);
      expect(provenance).toMatchObject({ runId: "run-a", messageId: "draft-message" });
    },
  );
});
