import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { contentEncryptionOf, withContentEncryption } from "./content-encryption.js";
import type { SpaceKeyRecord, SpaceKeyStore } from "./content-keys.js";
import { ContentKeyRing, LocalKeyProvider } from "./content-keys.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { PrismaClient as Client } from "./generated/prisma/client.js";

// A recorder intercepts every ORM operation before the adapter; no DB socket opens.
const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
const records: SpaceKeyRecord[] = [];
const keyStore: SpaceKeyStore = {
  forSpace: async (spaceId) => records.filter((record) => record.spaceId === spaceId),
  byId: async (id) => records.find((record) => record.id === id),
  insert: async (record) => {
    records.push(record);
    return record;
  },
  rowContext: async () => undefined,
  sampleByMasterKey: async () => [],
};
const ring = new ContentKeyRing(
  new LocalKeyProvider([{ id: "test", key: randomBytes(32) }]),
  keyStore,
);
const writes: Array<{ model: string; data: Record<string, unknown> }> = [];
const prisma = withContentEncryption(new Client({ adapter: new PrismaPg(pool) }), ring).$extends({
  query: {
    $allModels: {
      async $allOperations({ model, args }) {
        const data = (args as { data: Record<string, unknown> }).data;
        writes.push({ model, data });
        return { ...data };
      },
    },
  },
}) as unknown as PrismaClient;

afterAll(async () => {
  await pool.end();
});

describe("semantic fact encryption", () => {
  it("seals body and provenance separately under owning space content keys", async () => {
    const source = {
      id: "fact-a",
      spaceId: "space-a",
      userId: "user-a",
      botId: "bot-a",
      namespace: "ns",
      scope: "isolated",
      kind: "durable",
      content: "Synthetic private fact.",
      provenance: JSON.stringify({ kind: "run", quote: "private source quote", runId: "run-a" }),
    };
    const row = await prisma.semanticFact.create({ data: source });
    expect(row).toMatchObject(source);
    const written = writes.at(-1)!.data;
    expect(written.content).toMatch(/^rkz1:/);
    expect(written.provenance).toMatch(/^rkz1:/);
    expect(JSON.stringify(written)).not.toContain("private source quote");
    expect(written.namespace).toBe("ns");
    expect(written.userId).toBe("user-a");
  });

  it("seals each revision to its own row and fact owner", async () => {
    const source = {
      id: "revision-a",
      spaceId: "space-a",
      factId: "fact-a",
      revision: 1,
      content: "Synthetic old assertion.",
      provenance: '{"kind":"manual"}',
      status: "active",
    };
    expect(await prisma.semanticFactRevision.create({ data: source })).toMatchObject(source);
    const written = writes.at(-1)!.data;
    expect(written.content).toMatch(/^rkz1:/);
    const swapped = { ...written, id: "revision-b" } as { id: string };
    await expect(
      contentEncryptionOf(prisma)!.openRows("SemanticFactRevision", [swapped]),
    ).rejects.toThrow(/decrypt/);
  });
});
