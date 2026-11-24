import type { AdapterContext, MemoryDerivedSpan, MemorySourceFact } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma, semanticFactNamespace } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";
import { memorySpanHash } from "./memory-derivation.js";

const human: AdapterContext = {
  spaceId: "space-a",
  userId: "user-a",
  operationId: "memory-edit",
  traceId: "trace-a",
  signal: new AbortController().signal,
};
const agent = { ...human, botId: "bot-a", runId: "run-a" };
const source: MemorySourceFact = {
  id: "fact-a",
  revision: 1,
  botId: "bot-a",
  scope: "isolated",
  kind: "durable",
};
const location = { scope: "bot" as const, botId: "bot-a", path: "MEMORY.md" };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) =>
    key === "OR"
      ? (value as Record<string, unknown>[]).some((part) => matches(row, part))
      : row[key] === value,
  );
}

function fixture(content = "Handwritten.\nDerived fact.\n", tracked = true) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const span = { start: "Handwritten.\n".length, end: content.length, sources: [source] };
  const documents = [
    {
      id: "doc-a",
      spaceId: human.spaceId,
      userId: human.userId,
      ...location,
      content,
      revision: 1,
      derivations: tracked ? ([span] as MemoryDerivedSpan[] | null) : null,
      updatedAt: now,
      createdAt: now,
    },
  ];
  const facts = [
    {
      id: "fact-a",
      botId: "bot-a",
      spaceId: human.spaceId,
      userId: human.userId,
      scope: "isolated",
      namespace: semanticFactNamespace(human.spaceId, "isolated", "bot-a"),
      kind: "durable",
      revision: 1,
      status: "active",
      content: "Source fact.",
      provenance: JSON.stringify({ kind: "manual" }),
      sourceThreadId: null,
      sourceGeneration: null,
      validFrom: null,
      validTo: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
  const history: Record<string, unknown>[] = [];
  const db = {
    spaceMember: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "membership" })),
    },
    space: {
      findFirst: vi.fn(
        async (): Promise<{ deletingAt: Date | null } | null> => ({ deletingAt: null }),
      ),
    },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        userId: human.userId,
      })),
    },
    semanticFact: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          facts.find((row) => matches(row, where)) ?? null,
      ),
    },
    semanticMemoryRetirement: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
    },
    memoryDocument: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        documents.filter((row) => matches(row, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          documents.find((row) => matches(row, where)) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = documents.find((doc) => doc.id === where.id)!;
          Object.assign(row, data, {
            derivations: data.derivations === Prisma.DbNull ? null : data.derivations,
          });
          return row;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...documents[0]!, id: `doc-${documents.length}`, ...data, revision: 1 };
        documents.push(row);
        return row;
      }),
    },
    memoryRevision: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        history.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return {
    db,
    documents,
    facts,
    history,
    store: new MarkdownMemoryStore(db as unknown as PrismaClient),
  };
}

describe("derived Markdown through production store paths", () => {
  it.each(["revision", "forgotten", "retired", "missing"] as const)(
    "filters %s source projections from read and search without changing raw text",
    async (change) => {
      const f = fixture();
      expect((await f.store.read(location, agent)).documents[0]?.content).toContain(
        "Derived fact.",
      );
      if (change === "revision") f.facts[0]!.revision = 2;
      if (change === "forgotten") f.facts[0]!.status = "forgotten";
      if (change === "retired")
        f.db.semanticMemoryRetirement.findFirst.mockResolvedValue({ id: "fence-a" });
      if (change === "missing") f.facts.length = 0;
      expect((await f.store.read(location, agent)).documents[0]?.content).toBe("Handwritten.\n");
      expect(
        await f.store.search({ query: "Derived", scope: "bot", botId: "bot-a" }, agent),
      ).toEqual([]);
      expect(f.documents[0]?.content).toBe("Handwritten.\nDerived fact.\n");
      expect(f.db.memoryDocument.update).not.toHaveBeenCalled();
    },
  );

  it("keeps untracked legacy text byte-for-byte and never invents a source for it", async () => {
    const f = fixture("Manual text.\r\nDerived fact.\n", false);
    f.facts[0]!.status = "forgotten";
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe(
      f.documents[0]!.content,
    );
    expect(
      await f.store.search({ query: "Derived", scope: "bot", botId: "bot-a" }, agent),
    ).toHaveLength(1);
    expect(f.documents[0]!.derivations).toBeNull();
    expect(f.db.semanticFact.findFirst).not.toHaveBeenCalled();
  });

  it("preserves hidden original bytes and handwritten lines across successive automatic saves", async () => {
    const f = fixture();
    f.facts[0]!.revision = 2;
    const first = await f.store.read(location, agent);
    const visible = first.documents[0]!;
    const saved = await f.store.commit(
      {
        ...location,
        content: `${visible.content}New note.\n`,
        expectedRevision: visible.revision,
        sourceRunId: "run-a",
      },
      agent,
    );
    expect(saved.content).toBe("Handwritten.\nNew note.\n");
    expect(f.documents[0]!.content).toBe("Handwritten.\nNew note.\nDerived fact.\n");
    const second = await f.store.commit(
      {
        ...location,
        content: `Another note.\n${saved.content}`,
        expectedRevision: saved.revision,
        sourceRunId: "run-a",
      },
      agent,
    );
    expect(second.content).toBe("Another note.\nHandwritten.\nNew note.\n");
    expect(f.documents[0]!.content).toBe("Another note.\nHandwritten.\nNew note.\nDerived fact.\n");
    expect(f.history.at(-1)?.content).toBe(f.documents[0]!.content);
    expect(
      (await f.store.read({ ...location, purpose: "edit" }, human)).documents[0]?.content,
    ).toBe(f.documents[0]!.content);
  });

  it("does not resurrect a projection when its source changes between the agent read and save", async () => {
    const f = fixture();
    const snapshot = (await f.store.read(location, agent)).documents[0]!;
    f.facts[0]!.revision = 2;
    const saved = await f.store.commit(
      {
        ...location,
        content: `${snapshot.content}New note.\n`,
        expectedRevision: snapshot.revision,
      },
      agent,
    );
    expect(saved.content).toBe("Handwritten.\nNew note.\n");
    expect(f.documents[0]!.content.match(/Derived fact\./g)).toHaveLength(1);
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe(saved.content);
  });

  it("rebases new annotations beside old hidden spans, without returning either stale source text or source bytes", async () => {
    const f = fixture();
    f.facts[0]!.revision = 2;
    const content = "Handwritten.\nNew derived.\n";
    const saved = await f.store.commit(
      {
        ...location,
        content,
        expectedRevision: 1,
        derivations: [
          {
            start: "Handwritten.\n".length,
            end: content.length,
            sources: [{ ...source, revision: 2 }],
          },
        ],
      },
      agent,
    );
    expect(saved.content).toBe(content);
    expect(f.documents[0]!.derivations).toEqual([
      {
        start: "Handwritten.\n".length,
        end: content.length,
        sources: [{ ...source, revision: 2 }],
        contentHash: memorySpanHash("New derived.\n"),
      },
      {
        start: content.length,
        end: f.documents[0]!.content.length,
        sources: [source],
        contentHash: memorySpanHash("Derived fact.\n"),
      },
    ]);
    f.facts[0]!.revision = 3;
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe("Handwritten.\n");
    expect(JSON.stringify(f.documents[0]!.derivations)).not.toContain("Source fact.");
  });

  it("detaches only manually edited lines, retaining dependencies on unchanged lines", async () => {
    const f = fixture("Handwritten.\nFirst derived.\nSecond derived.\n");
    await f.store.commit(
      {
        ...location,
        content: "Handwritten.\nMy edited note.\nSecond derived.\n",
        expectedRevision: 1,
      },
      human,
    );
    f.facts[0]!.revision = 2;
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe(
      "Handwritten.\nMy edited note.\n",
    );
    expect(f.documents[0]!.content).toContain("Second derived.");
  });

  it("does not let an automatic rewrite detach provenance by omitting source_facts", async () => {
    const f = fixture();
    const request = {
      ...location,
      expectedRevision: 1,
      content: "Handwritten.\nReworded projection.\n",
    };
    await expect(f.store.commit(request, agent)).rejects.toThrow(/requires source_facts/);
    expect(f.db.memoryDocument.update).not.toHaveBeenCalled();
    await f.store.commit(
      {
        ...request,
        derivations: [
          { start: "Handwritten.\n".length, end: request.content.length, sources: [source] },
        ],
      },
      agent,
    );
    f.facts[0]!.revision = 2;
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe("Handwritten.\n");
  });
  it("retains dependencies when automatic edits move and duplicate lines", async () => {
    const f = fixture();
    await f.store.commit(
      {
        ...location,
        content: "Derived fact.\nHandwritten.\nDerived fact.\n",
        expectedRevision: 1,
      },
      agent,
    );
    f.facts[0]!.status = "forgotten";
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe("Handwritten.\n");
  });

  it.each(["Written note.\n", "Replaced with a longer handwritten line.\n"])(
    "preserves old-writer human edits when stale annotations no longer match %j",
    async (edited) => {
      const f = fixture();
      await f.store.commit(
        { ...location, expectedRevision: 1, content: f.documents[0]!.content },
        human,
      );
      f.documents[0]!.content = `Handwritten.\n${edited}`;
      f.facts[0]!.status = "forgotten";
      expect((await f.store.read(location, agent)).documents[0]?.content).toBe(
        f.documents[0]!.content,
      );
    },
  );

  it("preserves handwritten duplicate occurrences while filtering automatic occurrences", async () => {
    const f = fixture("Same.\nSame.\n");
    f.documents[0]!.derivations = [
      { start: "Same.\n".length, end: "Same.\nSame.\n".length, sources: [source] },
    ];
    await f.store.commit(
      { ...location, content: "Same.\nSame.\nUnrelated edit.\n", expectedRevision: 1 },
      human,
    );
    f.facts[0]!.status = "forgotten";
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe(
      "Same.\nUnrelated edit.\n",
    );
  });

  it("preserves tracked lines through CRLF normalization and a newly appended trailing newline", async () => {
    const f = fixture("Handwritten.\r\nDerived fact.");
    f.documents[0]!.derivations = [
      { start: "Handwritten.\r\n".length, end: f.documents[0]!.content.length, sources: [source] },
    ];
    await f.store.commit(
      { ...location, content: "Handwritten.\nDerived fact.\n", expectedRevision: 1 },
      agent,
    );
    f.facts[0]!.revision = 2;
    expect((await f.store.read(location, agent)).documents[0]?.content).toBe("Handwritten.\n");
  });

  it("rejects invalid source revisions and stale document revisions before any write", async () => {
    const f = fixture();
    const request = {
      ...location,
      content: "Derived.\n",
      expectedRevision: 1,
      derivations: [{ start: 0, end: "Derived.\n".length, sources: [{ ...source, revision: 2 }] }],
    };
    await expect(f.store.commit(request, agent)).rejects.toThrow(/source/);
    await expect(f.store.commit({ ...request, expectedRevision: 7 }, agent)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    await expect(
      f.store.commit({ ...request, expectedRevision: undefined }, agent),
    ).rejects.toThrow(/expected document revision/);
    expect(f.db.memoryDocument.update).not.toHaveBeenCalled();
    expect(f.db.memoryRevision.create).not.toHaveBeenCalled();
  });

  it("refuses raw reads by a run, and rechecks member, active space and bot boundaries for human edits", async () => {
    const f = fixture();
    await expect(f.store.read({ ...location, purpose: "edit" }, agent)).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(
      f.store.read({ ...location, botId: "bot-b", purpose: "edit" }, { ...human, botId: "bot-a" }),
    ).rejects.toBeInstanceOf(IsolationError);
    f.db.spaceMember.findFirst.mockResolvedValueOnce(null);
    await expect(f.store.read({ ...location, purpose: "edit" }, human)).rejects.toBeInstanceOf(
      IsolationError,
    );
    f.db.space.findFirst.mockResolvedValueOnce({ deletingAt: new Date() });
    await expect(f.store.read({ ...location, purpose: "edit" }, human)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(f.db.memoryDocument.findMany).not.toHaveBeenCalled();
  });

  it("rejects a source from another tenant or isolated bot, including on a shared document", async () => {
    const f = fixture();
    for (const invalid of [
      { ...source, botId: "bot-b" },
      { ...source, id: "foreign-fact" },
    ]) {
      await expect(
        f.store.commit(
          {
            ...location,
            content: "Derived.\n",
            expectedRevision: 1,
            derivations: [{ start: 0, end: "Derived.\n".length, sources: [invalid] }],
          },
          agent,
        ),
      ).rejects.toThrow(/source/);
    }
    await expect(
      f.store.commit(
        {
          scope: "user",
          path: "shared.md",
          content: "Derived.\n",
          expectedRevision: 0,
          derivations: [{ start: 0, end: "Derived.\n".length, sources: [source] }],
        },
        agent,
      ),
    ).rejects.toThrow(/source/);
    expect(f.db.memoryDocument.update).not.toHaveBeenCalled();
    expect(f.db.memoryDocument.create).not.toHaveBeenCalled();
  });
});
