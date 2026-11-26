import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { AgentRunRequest, JobPublisher } from "@rakazo/adapter-kit";
import { createBackgroundJobHandlers } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import {
  createDb,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  SemanticFactStore,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";
import { memoryRoutes } from "./routes/memory.js";
import { reactToThreadMessage } from "./thread-reactions.js";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

const pg =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

pg("lesson feedback through the worker and owner API (PostgreSQL)", () => {
  it("reopens an explained dislike, keeps its source on approval and rejects a stale edit", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!url.pathname.startsWith("/rkz_") || !url.username.startsWith("rkz_"))
      throw new Error("Use an isolated lesson test database");
    const db = createDb(url.href);
    const address = `learning-${randomUUID()}@example.test`;
    const priorSwitch = process.env.SELF_EVOLUTION;
    process.env.SELF_EVOLUTION = "on";
    let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>> | undefined;
    try {
      identity = await runAsSystem("lesson fixture", () =>
        provisionMessagingIdentity(
          db.prisma,
          { provider: "email", address },
        ),
      );
      const { userId, spaceId, botId, threadId } = identity;
      const actor: Actor = { userId, spaceId, email: address, isDeploymentOwner: false };
      await runAsTenant({ spaceId, userId }, async () => {
        const { prisma } = db;
        const events = createThreadEvents(prisma);
        const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
        const memoryProviders = {
          resolve: async () => ({
            provider: { describe: () => ({ capabilities: { managedFacts: true } }) },
          }),
        };
        const api = createRouterClient(
          memoryRoutes(
            createRouterContext({
              prisma,
              jobs,
              events,
              memoryProviders,
              env: { agentRuntime: "scripted" },
            } as unknown as RouterDeps),
          ),
          { context: { actor } },
        );
        const target = await resolveThreadTarget(prisma, actor, { botId });
        const source = await createThreadMessage(prisma, {
          threadId,
          role: "user",
          authorUserId: userId,
          blocks: [{ kind: "text", text: "Summarize this ledger." }],
        });
        const task = await prisma.task.create({
          data: {
            userId,
            spaceId,
            botId,
            threadId,
            prompt: "Summarize this ledger.",
            status: "completed",
          },
        });
        const run = await prisma.run.create({
          data: {
            userId,
            spaceId,
            botId,
            threadId,
            taskId: task.id,
            sourceMessageId: source.id,
            trigger: "user",
            status: "running",
            tainted: true,
            // An unchecked historical run requires the person's approval for a lesson edit.
            learningSourceChecked: false,
          },
        });
        const reply = await createThreadMessage(prisma, {
          threadId,
          role: "bot",
          botId,
          runId: run.id,
          blocks: [{ kind: "text", text: "Gross total: 80." }],
        });
        await prisma.run.update({
          where: { id: run.id },
          data: { status: "completed", completedAt: new Date() },
        });
        const ctx = {
          spaceId,
          userId,
          botId,
          operationId: run.id,
          traceId: run.id,
          signal: new AbortController().signal,
        };
        const store = new SemanticFactStore(prisma);
        const old = await store.saveLesson(
          {
            botId,
            cue: "Ledger",
            lesson: "Use gross totals.",
            provenance: {
              kind: "run",
              runId: run.id,
              threadId,
              harness: {
                domainKey: "chat",
                signals: [],
                autoApplied: false,
                evidence: { kind: "user_steering", quote: "Use gross totals." },
              },
            },
          },
          ctx,
        );
        const first = "For this ledger subtract refunds.";
        const second = "For this ledger exclude pending refunds.";
        const prompts: string[] = [];
        const worker = createBackgroundJobHandlers({
          prisma,
          events,
          jobs,
          memoryProviders,
          executor: { resolveModel: async () => ({ provider: "test-reviewer", id: "test" }) },
          runtime: {
            async *run(request: AgentRunRequest) {
              prompts.push(request.prompt);
              const quote = [second, first].find((text) => request.prompt.includes(text)) ?? "👎";
              yield {
                type: "done",
                text: JSON.stringify({
                  lessons: [
                    {
                      cue: "Ledger",
                      lesson: quote,
                      evidence: { kind: "user_feedback", quote },
                      replaces: { id: old!.id, revision: 1 },
                    },
                  ],
                }),
              };
            },
          },
        } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
        const review = () => worker["harness.reflect"]({ runId: run.id, auto: true });
        const write = (text: string, parent?: string, author = userId) =>
          createThreadMessage(prisma, {
            threadId,
            role: "user",
            authorUserId: author,
            replyToMessageId: parent,
            markUnread: false,
            blocks: [{ kind: "text", text }],
          });
        const draft = async (id: string) => {
          const message = await prisma.message.findUniqueOrThrow({
            where: {
              threadId_clientNonce: {
                threadId,
                clientNonce: `reflect-lesson:${run.id}:${id}`,
              },
            },
          });
          const [block] = message.blocks as unknown as MessageBlock[];
          if (block?.kind !== "lesson_draft") throw new Error("Missing lesson draft");
          return block;
        };
        await reactToThreadMessage({ prisma, jobs }, actor, target, {
          messageId: reply.id,
          reaction: "👎",
          mayStartTurn: false,
          clientNonce: randomUUID(),
        });
        expect(jobs.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ name: "harness.reflect" }),
        );
        await write("Unrelated conversation must stay out.");
        await write("A different author's reply.", reply.id, "another-author");
        await review();
        expect(prompts[0]).toContain("user_disliked");
        expect(prompts[0]).not.toContain("Unrelated conversation");
        expect(prompts[0]).not.toContain("A different author's reply");
        expect(
          await prisma.message.count({
            where: { clientNonce: { startsWith: `reflect-lesson:${run.id}` } },
          }),
        ).toBe(0);

        vi.mocked(jobs.enqueue).mockClear();
        const nonce = randomUUID();
        await sendThreadMessage({ prisma, jobs, events, sandbox: {} as never }, actor, target, {
          text: first,
          replyToMessageId: reply.id,
          clientNonce: nonce,
        });
        const correction = await prisma.message.findUniqueOrThrow({
          where: { threadId_clientNonce: { threadId, clientNonce: nonce } },
        });
        expect(jobs.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ payload: { runId: run.id, auto: true } }),
        );
        await review();
        const approved = await draft(correction.id);
        expect(approved.replaces).toEqual({ id: old!.id, expectedRevision: 1 });
        const changed = await api.memory.saveLesson({ botId, lessonId: approved.lessonId });
        expect(changed).toMatchObject({
          id: old!.id,
          revision: 2,
          provenance: {
            harness: {
              autoApplied: false,
              domainKey: "chat",
              evidence: { kind: "user_feedback", quote: first, messageId: correction.id },
            },
          },
        });
        expect((await draft(correction.id)).status).toBe("saved");
        await expect(
          api.memory.saveLesson({ botId, lessonId: approved.lessonId }),
        ).resolves.toMatchObject({ id: old!.id, revision: 2 });

        const later = await write(second, reply.id);
        await review();
        const stale = await draft(later.id);
        await expect(
          api.memory.saveLesson({ botId, lessonId: stale.lessonId }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        const active = (await store.list({ botId, scope: "isolated", kind: "lesson" }, ctx)).items;
        expect(active).toHaveLength(1);
        expect(active[0]).toMatchObject({
          id: old!.id,
          revision: 2,
          content: `cue: Ledger\nlesson: ${first}`,
        });
        expect((await draft(later.id)).status).toBe("draft");
        // Once a newer change succeeds, replaying the old approved card must not report
        // a successful write to the newer revision.
        await store.saveLesson(
          {
            botId,
            cue: "Ledger",
            lesson: second,
            provenance: changed.provenance as Parameters<typeof store.saveLesson>[0]["provenance"],
            replaces: { id: changed.id, expectedRevision: changed.revision },
          },
          ctx,
        );
        await expect(
          api.memory.saveLesson({ botId, lessonId: approved.lessonId }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      });
    } finally {
      if (priorSwitch === undefined) delete process.env.SELF_EVOLUTION;
      else process.env.SELF_EVOLUTION = priorSwitch;
      if (identity) {
        const { spaceId, userId } = identity;
        await runAsSystem("lesson fixture cleanup", async () => {
          await db.prisma.messagingIdentity.deleteMany({ where: { address } });
          await db.prisma.organization.deleteMany({ where: { id: spaceId } });
          await db.prisma.user.deleteMany({ where: { id: userId } });
        });
      }
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
