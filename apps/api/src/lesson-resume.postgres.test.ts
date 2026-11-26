import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import {
  createBackgroundJobHandlers,
  createRunExecutor,
  EncryptedSecretStore,
  FakeSandboxProvider,
  FakeWebProvider,
  LocalAgentHomeStore,
  LocalArtifactStore,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import {
  createDb,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  saveAutoReviewPreference,
  SemanticFactStore,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

const pg =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

pg("learning after an approval (PostgreSQL)", () => {
  it.each([true, false])("saves only a claimed correction (corrected=%s)", async (corrected) => {
    const db = createDb(process.env.DATABASE_URL!);
    const { prisma } = db;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-lesson-resume-"));
    const address = `resume-${randomUUID()}@example.test`;
    vi.stubEnv("SELF_EVOLUTION", "on");
    let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>> | undefined;
    try {
      identity = await runAsSystem("lesson resume fixture", () =>
        provisionMessagingIdentity(prisma, { provider: "email", address }),
      );
      const { spaceId, userId, botId, threadId } = identity;
      const actor = { spaceId, userId, email: address, isDeploymentOwner: false };
      await runAsTenant(actor, async () => {
        await prisma.$transaction((tx) => saveAutoReviewPreference(tx, actor, { mode: "ask" }));
        const queued: BackgroundJob[] = [];
        const jobs: JobPublisher = {
          enqueue: async (job) => {
            queued.push(job);
          },
          cancel: async () => undefined,
          close: async () => undefined,
        };
        const events = createThreadEvents(prisma);
        const sandbox = new FakeSandboxProvider();
        const web = new FakeWebProvider();
        const target = await resolveThreadTarget(prisma, actor, { botId });
        const send = (text: string) =>
          sendThreadMessage({ prisma, events, jobs, sandbox }, actor, target, {
            text,
            clientNonce: randomUUID(),
          });
        const { runId } = await send("Read the ledger and summarize it.");
        const fix = "Subtract settled refunds when reporting this project's net total.";
        const unrelated = "Unclaimed text linked to the same run.";
        const prompts: string[] = [];
        let turn = 0;
        let correctionId: string | undefined;
        const runtime = {
          describe: () => ({
            ...new ScriptedAgentRuntime().describe(),
            capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
          }),
          abort: async () => undefined,
          async *run(request: AgentRunRequest) {
            if (request.usageOperationKind === "learning") {
              prompts.push(request.prompt);
              yield {
                type: "done" as const,
                text: JSON.stringify({
                  lessons: [
                    {
                      cue: "Project net total",
                      lesson: fix,
                      evidence: {
                        kind: "user_steering",
                        quote: fix,
                        messageId: "untrusted-model-id",
                      },
                    },
                  ],
                }),
              };
              return;
            }
            if (++turn === 1 && corrected) {
              const sent = await send(fix);
              expect(sent.runId).toBe(runId);
              const [claimed] = await request.claimSteering!([]);
              correctionId = claimed?.messageId;
              expect(claimed).toMatchObject({ text: fix, origin: "user" });
            }
            // The restored turn does not claim steering again. It replays only the approved action.
            const result = await request.executeTool!(
              "web_fetch",
              { url: "https://example.test/ledger" },
              "ledger-read",
            );
            await request.onToolCompleted?.({
              name: "web_fetch",
              executionId: "ledger-read",
              durationMs: 1,
              result,
              paused: turn === 1,
            });
            yield { type: "done" as const, text: "Ledger read." };
          },
        };
        const deps = {
          prisma,
          sandbox,
          web,
          events,
          jobs,
          runtime,
          home: new LocalAgentHomeStore(dataDir),
          artifacts: new LocalArtifactStore(dataDir),
          memory: new MarkdownMemoryStore(prisma),
          memoryProviders: { resolve: async () => null },
          secretStore: new EncryptedSecretStore("fixture-secret"),
          secrets: [],
          deploymentModelKey: "fixture-key",
          deploymentModelConfigured: true,
          dataDir,
        };
        const executor = createRunExecutor(deps);
        const status = () => prisma.run.findUniqueOrThrow({ where: { id: runId } });
        await executor.continueRun(runId, "before-approval");
        expect(await status()).toMatchObject({ status: "waiting_input" });
        const reviews = () => queued.filter((job) => job.name === "harness.reflect");
        expect(reviews()).toHaveLength(0);
        expect(web.lastFetch).toBeUndefined();
        const card = await prisma.message.findFirstOrThrow({
          where: { threadId, runId, role: "bot", blocks: { array_contains: [{ kind: "ask" }] } },
        });
        expect(
          await events.answerRunInput({
            spaceId,
            threadId,
            runId,
            messageId: card.id,
            answeredByUserId: userId,
            answer: "allow",
          }),
        ).toBe(true);
        await createThreadMessage(prisma, {
          threadId,
          runId,
          role: "user",
          authorUserId: userId,
          blocks: [{ kind: "text", text: unrelated }],
        });
        await executor.continueRun(runId, "after-approval");
        expect(await status()).toMatchObject({
          status: "completed",
          tainted: true,
          learningSourceChecked: true,
        });
        expect(turn).toBe(2);
        expect(web.lastFetch?.url).toBe("https://example.test/ledger");
        expect(await prisma.steeringMessage.count({ where: { runId } })).toBe(0);
        expect(reviews()).toHaveLength(corrected ? 1 : 0);
        if (!corrected) return;
        const worker = createBackgroundJobHandlers({
          ...deps,
          executor,
          workerId: "reviewer",
          memoryProviders: {
            resolve: async () =>
              ({
                provider: { describe: () => ({ capabilities: { managedFacts: true } }) },
                defaultScope: "isolated",
              }) as never,
          },
        });
        await worker["harness.reflect"](reviews()[0]!.payload);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain(`<user_steering>\n${fix}\n</user_steering>`);
        expect(prompts[0]).not.toContain(unrelated);
        const { items } = await new SemanticFactStore(prisma).list(
          { botId, scope: "isolated", kind: "lesson" },
          {
            spaceId,
            userId,
            botId,
            operationId: runId,
            traceId: runId,
            signal: new AbortController().signal,
          },
        );
        expect(items).toMatchObject([
          {
            content: `cue: Project net total\nlesson: ${fix}`,
            provenance: {
              kind: "run",
              runId,
              threadId,
              harness: {
                autoApplied: true,
                signals: ["user_steering"],
                evidence: { kind: "user_steering", quote: fix, messageId: correctionId },
              },
            },
          },
        ]);
        expect(
          await prisma.message.findUnique({
            where: { threadId_clientNonce: { threadId, clientNonce: `reflect-lesson:${runId}` } },
          }),
        ).toBeNull();
      });
    } finally {
      vi.unstubAllEnvs();
      if (identity) {
        const { userId, spaceId } = identity;
        await runAsSystem("lesson resume cleanup", async () => {
          await prisma.messagingIdentity.deleteMany({ where: { address } });
          await prisma.organization.deleteMany({ where: { id: spaceId } });
          await prisma.user.deleteMany({ where: { id: userId } });
        });
      }
      await prisma.$disconnect();
      await db.pool.end();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
