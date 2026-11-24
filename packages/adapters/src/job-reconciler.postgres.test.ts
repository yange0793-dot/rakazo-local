import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createJobReconciler, createPostgresReconciliationLeadership } from "./job-reconciler.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("job reconciliation leadership (PostgreSQL contract)", () => {
  it("elects one session and hands leadership to a follower after release", async () => {
    const pool = new Pool({ connectionString: databaseUrl!, max: 2 });
    const lockId = -Math.min(process.pid, 2_000_000_000);
    const first = createPostgresReconciliationLeadership(pool, { lockId });
    const second = createPostgresReconciliationLeadership(pool, { lockId });

    try {
      await expect(first.tryAcquire()).resolves.toBe(true);
      await expect(second.tryAcquire()).resolves.toBe(false);

      await first.release();
      await expect(second.tryAcquire()).resolves.toBe(true);
    } finally {
      await first.release();
      await second.release();
      await pool.end();
    }
  });
});

describePostgres("messaging claim reconciliation (PostgreSQL contract)", () => {
  it("wakes the drain for expired pre-send claims, leaving unknown sends held", async () => {
    const db = createDb(databaseUrl!);
    const system = asSystem(db.prisma);
    const prefix = `claim-${randomUUID()}`;
    const ids = [`${prefix}-claimed`, `${prefix}-unknown`, `${prefix}-legacy`];
    const published: BackgroundJob[] = [];
    const jobs: JobPublisher = {
      enqueue: async (job) => {
        published.push(job);
      },
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const reconcile = createJobReconciler({ prisma: system, jobs });
    try {
      await system.messagingOutbound.createMany({
        data: [
          {
            id: ids[0]!,
            idempotencyKey: ids[0]!,
            kind: "dm",
            body: "claimed",
            status: "sent",
            deliveryState: "claimed",
            claimedAt: new Date(),
          },
          {
            id: ids[1]!,
            idempotencyKey: ids[1]!,
            kind: "dm",
            body: "unknown",
            status: "sent",
            deliveryState: "unknown",
            claimedAt: new Date(0),
          },
          { id: ids[2]!, idempotencyKey: ids[2]!, kind: "dm", body: "legacy", status: "sent" },
        ],
      });
      await reconcile.reconcileOnce();
      const drains = () => published.filter((job) => job.replaceKey === "messaging.deliver:drain");
      expect(drains()).toHaveLength(0);
      await system.messagingOutbound.update({
        where: { id: ids[0] },
        data: { claimedAt: new Date(0) },
      });
      await reconcile.reconcileOnce();
      expect(drains()).toHaveLength(1);
      expect(await system.messagingOutbound.findUnique({ where: { id: ids[1] } })).toMatchObject({
        status: "sent",
        deliveryState: "unknown",
      });
    } finally {
      await system.messagingOutbound.deleteMany({ where: { id: { in: ids } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});

describePostgres("bounded routine reconciliation (PostgreSQL contract)", () => {
  it("reads stable routine pages from the current schema in one pass", async () => {
    const db = createDb(databaseUrl!);
    const system = asSystem(db.prisma);
    const address = `reconciler-${randomUUID()}@example.test`;
    let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>> | undefined;
    try {
      identity = await runAsSystem("reconciliation fixture", () =>
        provisionMessagingIdentity(db.prisma, { provider: "email", address }),
      );
      const nextRunAt = new Date(Date.now() - 1_000);
      const prefix = `routine-${randomUUID()}-`;
      await system.routine.createMany({
        data: Array.from({ length: 250 }, (_, i) => ({
          spaceId: identity!.spaceId,
          userId: identity!.userId,
          botId: identity!.botId,
          threadId: identity!.threadId,
          id: `${prefix}${String(i).padStart(4, "0")}`,
          name: "Recovery fixture",
          prompt: "fixture",
          crons: ["* * * * *"],
          active: true,
          nextRunAt,
        })),
      });
      const published: BackgroundJob[] = [];
      const jobs: JobPublisher = {
        enqueue: async (job) => {
          published.push(job);
        },
        cancel: async () => undefined,
        close: async () => undefined,
      };
      const run = (maxPagesPerPass: number) =>
        runAsSystem("reconcile jobs", () =>
          createJobReconciler({ prisma: db.prisma, jobs }, { maxPagesPerPass }).reconcileOnce(),
        );
      // Other due routines in a shared database can join a page, so only one page's
      // size is asserted globally and the drained set is checked for this fixture.
      await run(1);
      expect(published.filter((job) => job.name === "routine.wakeup")).toHaveLength(100);
      published.length = 0;
      await run(10);
      const routines = published.filter((job) => job.replaceKey?.startsWith(`routine:${prefix}`));
      expect(routines).toHaveLength(250);
      expect(new Set(routines.map((job) => job.replaceKey)).size).toBe(250);
      expect(routines.every((job) => job.availableAt?.getTime() === nextRunAt.getTime())).toBe(
        true,
      );
    } finally {
      if (identity) {
        await system.messagingIdentity.deleteMany({ where: { address } });
        await system.organization.deleteMany({ where: { id: identity.spaceId } });
        await system.user.deleteMany({ where: { id: identity.userId } });
      }
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
