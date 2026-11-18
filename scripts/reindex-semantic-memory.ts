/**
 * Rebuild the local semantic-memory index from the authoritative facts.
 *
 * The index is a projection: losing it (deleted palace directory, restored backup, corrupted
 * SQLite file) leaves every fact in Postgres and every recall empty. This script queues an
 * upsert for each active fact in the existing index outbox, so the normal `memory.sync` worker
 * drains it into the index with the production connection, credentials and embeddings.
 *
 * Index rows without a live fact are not removed here; recall already drops them when the
 * authority is rechecked. To rebuild after a loss, start the index on an empty palace first.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Row shape mirrors `SemanticFactStore.enqueueIndex` in packages/db/src/semantic-facts.ts. */
export interface ReindexFact {
  id: string;
  spaceId: string;
  userId: string;
  namespace: string;
  revision: number;
}

export interface ReindexRow extends ReindexFact {
  outboxId: string;
  indexId: string;
  action: "upsert";
}

export interface ReindexPlan {
  rows: ReindexRow[];
  /** One sync job per space is enough: a job drains that space's whole outbox. */
  spaces: string[];
}

export function planReindex(facts: readonly ReindexFact[]): ReindexPlan {
  const rows = facts.map((fact) => ({
    ...fact,
    outboxId: `sm-upsert:${fact.id}:${fact.revision}`,
    indexId: `sm:${fact.id}:${fact.revision}`,
    action: "upsert" as const,
  }));
  return { rows, spaces: [...new Set(rows.map((row) => row.spaceId))].sort() };
}

interface ReindexOptions {
  databaseUrlFile: string;
  apply: boolean;
}

function parseArgs(args: string[]): ReindexOptions {
  let databaseUrlFile: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg !== "--database-url-file") throw new Error("Unknown semantic memory reindex option");
    const value = args[++index];
    if (!value || value.startsWith("--") || databaseUrlFile) {
      throw new Error("Use one --database-url-file <path>");
    }
    databaseUrlFile = path.resolve(value);
  }
  if (!databaseUrlFile) throw new Error("--database-url-file is required");
  return { databaseUrlFile, apply };
}

export async function runReindex(
  options: ReindexOptions,
): Promise<{ facts: number; spaces: number }> {
  const connectionString = (await readFile(options.databaseUrlFile, "utf8")).trim();
  if (!connectionString) throw new Error("The database URL file is empty.");
  const { createDb } = await import("../packages/db/src/index.js");
  const db = createDb(connectionString, { applicationName: "semantic-memory-reindex" });
  try {
    const facts = await db.prisma.semanticFact.findMany({
      where: {
        status: "active",
        OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
      },
      orderBy: { id: "asc" },
      select: { id: true, spaceId: true, userId: true, namespace: true, revision: true },
    });
    const plan = planReindex(facts);
    if (!options.apply) return { facts: plan.rows.length, spaces: plan.spaces.length };
    await db.prisma.semanticMemoryIndexOutbox.createMany({
      data: plan.rows.map((row) => ({
        id: row.outboxId,
        spaceId: row.spaceId,
        userId: row.userId,
        namespace: row.namespace,
        indexId: row.indexId,
        factId: row.id,
        revision: row.revision,
        action: row.action,
      })),
      skipDuplicates: true,
    });
    if (plan.spaces.length) {
      const { GraphileJobPublisher } = await import("../packages/adapters/src/wakeup.js");
      const { semanticMemorySyncJob } = await import("../packages/adapter-kit/src/index.js");
      const jobs = new GraphileJobPublisher(db.pool);
      try {
        for (const spaceId of plan.spaces) {
          await jobs.enqueue(semanticMemorySyncJob(spaceId));
        }
      } finally {
        await jobs.close();
      }
    }
    return { facts: plan.rows.length, spaces: plan.spaces.length };
  } finally {
    await db.pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options: ReindexOptions | undefined;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid options"}\n`);
    process.exitCode = 1;
  }
  if (options) {
    const { apply } = options;
    runReindex(options)
      .then((summary) => {
        process.stdout.write(`${JSON.stringify({ ...summary, applied: apply })}\n`);
      })
      .catch(() => {
        // The URL and the database error text can contain credentials.
        process.stderr.write("Semantic memory reindex failed.\n");
        process.exitCode = 1;
      });
  }
}
