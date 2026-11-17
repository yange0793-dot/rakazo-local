import { createRouterClient } from "@orpc/server";
import type { SemanticMemoryProvider } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { Actor, SemanticFact } from "@rakazo/contracts";
import { currentDbContext } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouterContext } from "./context.js";
import { memoryRoutes } from "./memory.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "person@example.test",
  isDeploymentOwner: false,
};
const fact: SemanticFact = {
  id: "fact-1",
  botId: "bot-1",
  scope: "isolated",
  kind: "durable",
  content: "Synthetic preference",
  revision: 2,
  status: "active",
  provenance: { kind: "run", runId: "run-1", threadId: "thread-1", messageId: "message-1" },
  createdAt: "2026-11-16T00:00:00.000Z",
  updatedAt: "2026-11-16T00:01:00.000Z",
};
const target = { botId: "bot-1", scope: "isolated" as const };

function setup(options: { managed?: boolean; configured?: boolean; missingBot?: boolean } = {}) {
  const findBot = vi.fn(async () =>
    options.missingBot ? null : { id: "bot-1", spaceId: actor.spaceId, archivedAt: null },
  );
  const listFacts = vi.fn<NonNullable<SemanticMemoryProvider["listFacts"]>>(async () => ({
    ok: true as const,
    value: { supported: true, items: [fact], nextCursor: null as string | null },
  }));
  const correctFact = vi.fn<NonNullable<SemanticMemoryProvider["correctFact"]>>(async () => ({
    ok: true as const,
    value: {
      ...fact,
      content: "Corrected preference",
      revision: 3,
      provenance: { kind: "manual" as const },
    },
  }));
  const forget = vi.fn<NonNullable<SemanticMemoryProvider["forget"]>>(async () => ({
    ok: true as const,
    value: { id: fact.id, expired: true, reason: null },
  }));
  const provider = {
    describe: () => ({
      id: "synthetic-memory",
      capabilities: {
        recall: true,
        save: true,
        sharedScope: true,
        purgeHistory: true,
        managedFacts: options.managed ?? true,
      },
    }),
    listFacts,
    correctFact,
    forget,
  } as unknown as SemanticMemoryProvider;
  const resolve = vi.fn(async () =>
    options.configured === false ? null : { provider, defaultScope: "isolated" as const },
  );
  const deps = {
    prisma: { bot: { findFirst: findBot } },
    memoryProviders: { resolve },
    env: { agentRuntime: "scripted" },
  } as unknown as RouterDeps;
  const router = memoryRoutes(createRouterContext(deps));
  const client = createRouterClient(router, { context: { actor } });
  return { client, router, listFacts, correctFact, forget, resolve, findBot };
}

describe("semantic fact management routes", () => {
  it("requires authentication before inspecting a bot or provider", async () => {
    const { router, findBot, resolve } = setup();
    const anonymous = createRouterClient(router, { context: { actor: null } });
    await expect(anonymous.memory.facts(target)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(findBot).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("checks a real bot in the actor's space even when facts are unsupported", async () => {
    const { client, resolve, listFacts, findBot } = setup({ missingBot: true, managed: false });
    await expect(client.memory.facts(target)).rejects.toThrow("Resource not found");
    expect(findBot).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: "space-1" },
      include: { thread: true, computer: true },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(listFacts).not.toHaveBeenCalled();
  });

  it.each([{ managed: false }, { configured: false }])(
    "returns an unsupported page without calling optional management on an unmanaged provider: %o",
    async (options) => {
      const { client, listFacts } = setup(options);
      await expect(client.memory.facts(target)).resolves.toEqual({
        supported: false,
        items: [],
        nextCursor: null,
      });
      expect(listFacts).not.toHaveBeenCalled();
    },
  );

  it("forwards exact scope and paging under the authenticated tenant and bot context", async () => {
    const { client, listFacts, resolve } = setup();
    let tenant: ReturnType<typeof currentDbContext>;
    listFacts.mockImplementationOnce(async () => {
      tenant = currentDbContext();
      return { ok: true, value: { supported: true, items: [fact], nextCursor: "page-2" } };
    });
    const input = {
      botId: "bot-1",
      scope: "shared" as const,
      query: "pref",
      cursor: "page-1",
      limit: 7,
      includeHistory: true,
    };
    const page = await client.memory.facts(input);
    expect(page.nextCursor).toBe("page-2");
    expect(resolve).toHaveBeenCalledWith(actor.spaceId);
    expect(listFacts).toHaveBeenCalledExactlyOnceWith(
      input,
      expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-1",
        operationId: "memory.facts",
      }),
    );
    expect(tenant).toEqual({ kind: "tenant", spaceId: actor.spaceId, userId: actor.userId });
  });

  it("passes the revision while rejecting client-authored provenance", async () => {
    const { client, correctFact } = setup();
    const input = { ...target, id: fact.id, content: "Corrected preference", expectedRevision: 2 };
    const result = await client.memory.correctFact({
      ...input,
      provenance: { kind: "user", runId: "forged-run" },
      source: { kind: "durable", messageId: "forged-message", quote: "unverified" },
    } as never);
    expect(result.provenance.kind).toBe("manual");
    expect(correctFact).toHaveBeenCalledExactlyOnceWith(
      input,
      expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-1",
        operationId: "memory.correctFact",
      }),
    );
  });

  it.each([undefined, 0, -1, 1.5])(
    "rejects missing or invalid expected revisions: %s",
    async (expectedRevision) => {
      const { client, correctFact, forget, resolve } = setup();
      await expect(
        client.memory.correctFact({
          ...target,
          id: fact.id,
          content: "new",
          expectedRevision,
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        client.memory.forgetFact({ ...target, id: fact.id, expectedRevision } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(correctFact).not.toHaveBeenCalled();
      expect(forget).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("surfaces revision conflicts rather than acknowledging a failed correction", async () => {
    const { client, correctFact } = setup();
    correctFact.mockResolvedValueOnce({
      ok: false,
      error: MEMORY_REVISION_CONFLICT_ERROR,
      code: "CONFLICT",
    } as never);
    await expect(
      client.memory.correctFact({ ...target, id: fact.id, content: "new", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: MEMORY_REVISION_CONFLICT_ERROR });
  });

  it("surfaces foreign-scope and actor failures from managed authority", async () => {
    const { client, forget } = setup();
    forget.mockResolvedValueOnce({
      ok: false,
      error: "Resource not found",
      code: "NOT_FOUND",
    } as never);
    await expect(
      client.memory.forgetFact({ ...target, id: "foreign-fact", expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    forget.mockResolvedValueOnce({
      ok: false,
      error: "Actor is not authorized",
      code: "FORBIDDEN",
    } as never);
    await expect(
      client.memory.forgetFact({ ...target, id: fact.id, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires managed support for mutations and export, even when an unmanaged provider implements forget", async () => {
    const { client, correctFact, forget, listFacts } = setup({ managed: false });
    await expect(
      client.memory.correctFact({ ...target, id: fact.id, content: "new", expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(
      client.memory.forgetFact({ ...target, id: fact.id, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(client.memory.exportFacts(target)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    expect(correctFact).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect(listFacts).not.toHaveBeenCalled();
  });

  it("acknowledges forget only after the scoped revision succeeds", async () => {
    const { client, forget } = setup();
    const input = { ...target, id: fact.id, expectedRevision: 2 };
    await expect(client.memory.forgetFact(input)).resolves.toEqual({ ok: true });
    expect(forget).toHaveBeenCalledExactlyOnceWith(
      input,
      expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-1",
      }),
    );
  });

  it("does not acknowledge a provider refusal to forget", async () => {
    const { client, forget } = setup();
    forget.mockResolvedValueOnce({
      ok: true,
      value: { id: fact.id, expired: false, reason: "Synthetic refusal" },
    });
    await expect(
      client.memory.forgetFact({ ...target, id: fact.id, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "Synthetic refusal" });
  });

  it("exports every authoritative page including history in only the requested scope", async () => {
    const { client, listFacts } = setup();
    const historical: SemanticFact = { ...fact, id: "fact-2", revision: 1, status: "historical" };
    listFacts.mockResolvedValueOnce({
      ok: true,
      value: { supported: true, items: [fact], nextCursor: "page-2" },
    });
    listFacts.mockResolvedValueOnce({
      ok: true,
      value: { supported: true, items: [historical], nextCursor: null },
    });
    await expect(client.memory.exportFacts(target)).resolves.toEqual({
      format: "rakazo-semantic-memory-v1",
      facts: [fact, historical],
    });
    expect(listFacts.mock.calls.map(([request]) => request)).toEqual([
      { ...target, includeHistory: true, limit: 100 },
      { ...target, includeHistory: true, limit: 100, cursor: "page-2" },
    ]);
  });

  it("does not return a partial export or empty success on provider failure", async () => {
    const { client, listFacts } = setup();
    listFacts.mockResolvedValueOnce({
      ok: true,
      value: { supported: true, items: [fact], nextCursor: "page-2" },
    });
    listFacts.mockResolvedValueOnce({ ok: false, error: "Synthetic storage failure" } as never);
    await expect(client.memory.exportFacts(target)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Synthetic storage failure",
    });
  });
});
