import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;
const migration = readFileSync(
  new URL(
    "../../db/prisma/migrations/20261218120500_messaging_delivery_state/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describePostgres("messaging delivery legacy writer compatibility (PostgreSQL)", () => {
  const schema = `messaging_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: url });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE messaging_identities (id TEXT PRIMARY KEY);
      CREATE TABLE messaging_channels (id TEXT PRIMARY KEY, "threadId" TEXT UNIQUE);
      CREATE TABLE messaging_outbound (
        id TEXT PRIMARY KEY, "idempotencyKey" TEXT UNIQUE, kind TEXT,
        "identityId" TEXT, "threadId" TEXT, body TEXT,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        "nextAttemptAt" TIMESTAMP(3), "providerHandle" TEXT, "sourceMessageId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO messaging_outbound (id, status, "providerHandle") VALUES
        ('historical-unknown', 'sent', NULL),
        ('historical-handle', 'sent', 'receipt-old');
    `);
    await client.query(migration);
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  async function lane(prefix: string) {
    await client.query("INSERT INTO messaging_identities (id) VALUES ($1)", [prefix]);
    await client.query(
      `INSERT INTO messaging_outbound (id, "identityId", "createdAt") VALUES
        ($1, $3, '2026-01-01'), ($2, $3, '2026-01-02')`,
      [`${prefix}-1`, `${prefix}-2`, prefix],
    );
  }
  async function row(id: string) {
    return (await client.query("SELECT * FROM messaging_outbound WHERE id=$1", [id])).rows[0];
  }
  async function oldClaim(id: string) {
    return client.query(
      `UPDATE messaging_outbound SET status='sent', "nextAttemptAt"=NULL
        WHERE id=$1 AND status='pending'`,
      [id],
    );
  }

  it("keeps historical state and confirmation unset, including sent without a handle", async () => {
    for (const id of ["historical-unknown", "historical-handle"]) {
      expect(await row(id)).toMatchObject({ deliveryState: null, confirmedAt: null });
    }
  });

  it("holds a legacy uncertain send, suppressing retry/exhaustion and later lane claims", async () => {
    await lane("old");
    expect((await oldClaim("old-1")).rowCount).toBe(1);
    expect(await row("old-1")).toMatchObject({ status: "sent", deliveryState: "unknown" });
    for (const status of ["pending", "failed"]) {
      await client.query(
        `UPDATE messaging_outbound SET status=$2, attempts=5, "updatedAt"='2000-01-01'
          WHERE id=$1`,
        ["old-1", status],
      );
      expect(await row("old-1")).toMatchObject({
        status: "sent",
        deliveryState: "unknown",
        confirmedAt: null,
      });
      expect((await oldClaim("old-2")).rowCount).toBe(0);
    }
    await client.query(
      `UPDATE messaging_outbound SET "providerHandle"='receipt-1' WHERE id='old-1'`,
    );
    expect(await row("old-1")).toMatchObject({
      deliveryState: "accepted",
      confirmedAt: expect.any(Date),
    });
    expect((await oldClaim("old-2")).rowCount).toBe(1);
  });

  it("blocks legacy sends behind a new claim and allows only explicit pre-send recovery", async () => {
    await lane("new");
    await client.query(
      `UPDATE messaging_outbound SET status='sent', "deliveryState"='claimed',
        "claimedAt"='2026-01-01' WHERE id='new-1'`,
    );
    expect((await oldClaim("new-2")).rowCount).toBe(0);
    await client.query(
      `UPDATE messaging_outbound SET status='pending', "deliveryState"='retryable',
        "claimedAt"=NULL WHERE id='new-1' AND "deliveryState"='claimed'`,
    );
    const stale = await client.query(
      `UPDATE messaging_outbound SET "deliveryState"='unknown'
        WHERE id='new-1' AND "deliveryState"='claimed' AND "claimedAt"='2026-01-01'`,
    );
    expect(stale.rowCount).toBe(0);
    expect((await oldClaim("new-2")).rowCount).toBe(0);
    expect((await oldClaim("new-1")).rowCount).toBe(1);
    // New code can record a proven rejection; a legacy worker cannot infer it.
    await client.query(
      `UPDATE messaging_outbound SET status='failed', "deliveryState"='rejected' WHERE id='new-1'`,
    );
    expect((await oldClaim("new-2")).rowCount).toBe(1);
  });

  it("serializes a legacy writer against a new claim on another connection", async () => {
    await lane("race");
    const other = new Client({ connectionString: url });
    await other.connect();
    await other.query(`SET search_path TO "${schema}"`);
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM messaging_identities WHERE id='race' FOR UPDATE");
      await client.query(
        `UPDATE messaging_outbound SET status='sent', "deliveryState"='claimed',
          "claimedAt"=CURRENT_TIMESTAMP WHERE id='race-1' AND status='pending'`,
      );
      const legacy = other.query(
        `UPDATE messaging_outbound SET status='sent' WHERE id='race-2' AND status='pending'`,
      );
      await client.query("COMMIT");
      expect((await legacy).rowCount).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      await other.end();
    }
  });
});
