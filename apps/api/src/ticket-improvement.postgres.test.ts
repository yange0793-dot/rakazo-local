import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import {
  createBackgroundJobHandlers,
  createRunExecutor,
  createTicketChangeNotifier,
  EncryptedSecretStore,
  FakeSandboxProvider,
  FakeWebProvider,
  LocalAgentHomeStore,
  LocalArtifactStore,
} from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import {
  createBoardEvents,
  createDb,
  createRepos,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  saveAutoReviewPreference,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { describe, expect, it, vi } from "vitest";
import {
  getCurrentTaughtSkillRevision,
  listPinnedTaughtSkillRevisions,
  saveTaughtSkillRevision,
} from "../../../packages/adapters/src/taught-skill-revisions.js";
import {
  badDeliveryPlaybook,
  baselineDeliveryPlaybook,
  goodDeliveryPlaybook,
  OfflineTicketImprovementRuntime,
} from "../../../packages/adapters/src/ticket-improvement.test-fixtures.js";
import type { WorkImprovementComparison } from "../../../packages/adapters/src/work-improvement.js";
import { getOwnedArtifact } from "./artifacts.js";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

const pg =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const CORRECTION =
  "You checked installation but did not inspect the complete directory or confirm upload completion.";

pg("ticket improvement through chat and background jobs (PostgreSQL)", () => {
  it.each(["good", "bad", "recover"] as const)(
    "runs the complete offline pilot and retains the chosen revision (%s)",
    async (scenario) => {
      vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
      vi.stubEnv("SELF_EVOLUTION", "on");
      const db = createDb(process.env.DATABASE_URL!);
      const { prisma } = db;
      const address = `improvement-${randomUUID()}@example.test`;
      const dataDir = await mkdtemp(join(tmpdir(), "ticket-improvement-"));
      let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>> | undefined;
      try {
        identity = await runAsSystem("ticket improvement fixture", () =>
          provisionMessagingIdentity(
            prisma,
            { provider: "email", address },
            { signupsEnabled: undefined, signupAllowlist: undefined },
          ),
        );
        const { spaceId, userId, botId } = identity;
        const actor = { spaceId, userId, email: address, isDeploymentOwner: false };
        await runAsTenant(actor, async () => {
          await prisma.$transaction((tx) =>
            saveAutoReviewPreference(
              tx,
              actor,
              { enabled: false },
              { enabled: false, skipApprovals: false },
            ),
          );
          const workerBot = await createRepos(prisma).createBot(actor, {
            name: "Delivery checker",
            description: "",
            instructions: "",
            notifyOnFinish: false,
          });
          const skill = await prisma.taughtSkill.create({
            data: {
              spaceId,
              userId,
              botId: workerBot.id,
              status: "saved",
              name: "Verify delivery",
              goal: "Verify a retained file delivery.",
              playbook: baselineDeliveryPlaybook,
            },
          });
          const baseline = await saveTaughtSkillRevision(prisma, actor, {
            skillId: skill.id,
            scope: { taskFamilies: ["file-delivery"] },
          });
          const queued: BackgroundJob[] = [];
          const jobs: JobPublisher = {
            enqueue: async (job) => {
              queued.push(job);
            },
            cancel: async () => undefined,
            close: async () => undefined,
          };
          const events = createThreadEvents(prisma);
          const artifacts = new LocalArtifactStore(dataDir);
          const sandbox = new FakeSandboxProvider();
          const home = new LocalAgentHomeStore(dataDir);
          const secretStore = new EncryptedSecretStore("offline-fixture-secret");
          const base = {
            prisma,
            events,
            jobs,
            artifacts,
            sandbox,
            ticketBoardEnabled: true,
            onTicketChange: createTicketChangeNotifier({
              prisma,
              jobs,
              boardEvents: createBoardEvents(),
              ticketBoardEnabled: true,
            }),
          };
          const originTarget = await resolveThreadTarget(prisma, actor, { botId });
          const workerTarget = await resolveThreadTarget(prisma, actor, { botId: workerBot.id });
          let ticketId = "";
          let ticketRef = "";
          let assignedRunId = "";
          let correctionRunId = "";
          let nextRunId = "";
          let handledWhileRunning = false;
          let handlers: ReturnType<typeof createBackgroundJobHandlers>;
          const runtime = new OfflineTicketImprovementRuntime(async (request) => {
            const execute = request.executeTool!;
            if (!ticketId && request.botId === botId) {
              const created = (await execute(
                "ticket_create",
                { title: "Verify retained delivery", ownerBotId: workerBot.id },
                "create-delivery-ticket",
              )) as { ticket: { id: string; ref: string } };
              expect(created).toHaveProperty("ticket.id");
              ticketId = created.ticket.id;
              ticketRef = created.ticket.ref;
              return "The checker owns this delivery.";
            }
            if (request.runId === assignedRunId) {
              const ticket = await execute(
                "ticket_get",
                { ref: ticketRef },
                "read-delivery-ticket",
              );
              expect(ticket).toHaveProperty("delivery.previousVersion", 0);
              // Without its task family the scoped skill says what it is limited to.
              expect(
                await execute("skill_read", { taughtSkillId: skill.id }, "read-unscoped-skill"),
              ).toMatchObject({ error: expect.any(String), taskFamilies: ["file-delivery"] });
              const loaded = (await execute(
                "skill_read",
                { taughtSkillId: skill.id, taskFamily: "file-delivery" },
                "read-delivery-skill",
              )) as { revision: { id: string } };
              expect(loaded.revision.id).toBe(baseline.id);
              const delivered = await execute(
                "ticket_update",
                {
                  id: ticketId,
                  result: {
                    previousVersion: 0,
                    summary: "Installation passed and upload was selected.",
                    findings: [
                      {
                        outcome: "pass",
                        conclusion: "The package is installed and delivered.",
                        evidence: "Manifest installation check and file selection.",
                      },
                    ],
                  },
                },
                "deliver-original-receipt",
              );
              expect(delivered).toHaveProperty("ok", true);
              return "The receipt is in the original chat.";
            }
            if (request.runId === correctionRunId) {
              const running = await prisma.run.findUniqueOrThrow({
                where: { id: correctionRunId },
              });
              expect(running).toMatchObject({ status: "running", ticketId });
              const feedbackJob = queued.findLast(
                (job) => job.name === "harness.reflect" && job.payload.runId === assignedRunId,
              );
              expect(feedbackJob).toBeDefined();
              if (scenario === "recover") {
                const put = artifacts.put.bind(artifacts);
                let failResult = true;
                const injected = vi
                  .spyOn(artifacts, "put")
                  .mockImplementation(async (input, context) => {
                    const body = JSON.parse(new TextDecoder().decode(input.bytes)) as {
                      schemaVersion?: string;
                      phase?: string;
                    };
                    if (
                      failResult &&
                      body.schemaVersion === "ticket-improvement.v1" &&
                      body.phase === "result"
                    ) {
                      failResult = false;
                      throw new Error("Offline checkpoint write interrupted");
                    }
                    return put(input, context);
                  });
                try {
                  await expect(
                    handlers["harness.reflect"]({ runId: assignedRunId, auto: true }),
                  ).rejects.toThrow("Offline checkpoint write interrupted");
                  expect(runtime.proposalCalls).toBe(1);
                  expect(runtime.comparisonCalls).toBe(12);
                  await handlers["harness.reflect"]({ runId: assignedRunId, auto: true });
                } finally {
                  injected.mockRestore();
                }
              } else {
                await handlers["harness.reflect"]({ runId: assignedRunId, auto: true });
              }
              expect(
                await prisma.run.findUniqueOrThrow({ where: { id: correctionRunId } }),
              ).toMatchObject({ status: "running", leaseFence: running.leaseFence });
              handledWhileRunning = true;
              return "The corrected method has been reviewed.";
            }
            if (request.runId === nextRunId) {
              const loaded = (await execute(
                "skill_read",
                { taughtSkillId: skill.id, taskFamily: "file-delivery" },
                "load-chosen-revision",
              )) as { revision: { snapshot: { playbook: unknown } } };
              expect(loaded.revision.snapshot.playbook).toEqual(
                scenario === "bad" ? baselineDeliveryPlaybook : goodDeliveryPlaybook,
              );
              return "The next delivery uses the chosen revision.";
            }
            throw new Error("Unexpected offline task");
          });
          runtime.proposal = {
            kind: "candidate",
            quote: CORRECTION,
            playbook: scenario === "bad" ? badDeliveryPlaybook : goodDeliveryPlaybook,
          };
          const deps = {
            ...base,
            runtime,
            home,
            secretStore,
            memory: new MarkdownMemoryStore(prisma),
            memoryProviders: { resolve: async () => null },
            web: new FakeWebProvider(),
            secrets: [],
            deploymentModelKey: "offline-model-key",
            deploymentModelConfigured: true,
            dataDir,
          };
          const executor = createRunExecutor(deps);
          handlers = createBackgroundJobHandlers({ ...deps, executor, workerId: "offline-worker" });
          const sent = await sendThreadMessage(base, actor, originTarget, {
            text: "Verify the retained package and return its receipt here.",
            clientNonce: randomUUID(),
          });
          await handlers["run.continue"]({ runId: sent.runId });
          expect(await prisma.run.findUniqueOrThrow({ where: { id: sent.runId } })).toMatchObject({
            status: "completed",
            error: null,
          });
          const assigned = await prisma.run.findFirstOrThrow({
            where: { ticketId, botId: workerBot.id, trigger: "tickets" },
          });
          assignedRunId = assigned.id;
          expect(queued).toContainEqual(
            expect.objectContaining({ name: "run.continue", payload: { runId: assignedRunId } }),
          );
          await handlers["run.continue"]({ runId: assignedRunId });
          expect(
            await prisma.run.findUniqueOrThrow({ where: { id: assignedRunId } }),
          ).toMatchObject({ status: "completed", error: null });
          const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
          expect(ticket).toMatchObject({
            originThreadId: originTarget.threadId,
            assigneeBotId: workerBot.id,
            receiptVersion: 1,
            status: "done",
          });
          const receipt = await prisma.message.findFirstOrThrow({
            where: {
              threadId: originTarget.threadId,
              botId,
              role: "bot",
              runId: assignedRunId,
              replyToMessageId: ticket.originMessageId,
              clientNonce: { startsWith: "work-receipt:" },
            },
          });
          expect(runtime.proposalCalls).toBe(0);
          expect(runtime.comparisonCalls).toBe(0);
          const feedback = await sendThreadMessage(base, actor, originTarget, {
            text: CORRECTION,
            replyToMessageId: receipt.id,
            clientNonce: randomUUID(),
          });
          correctionRunId = feedback.runId;
          const correction = await prisma.run.findUniqueOrThrow({ where: { id: correctionRunId } });
          expect(correction).toMatchObject({ ticketId, sourceMessageId: expect.any(String) });
          await handlers["run.continue"]({ runId: correctionRunId });
          expect(
            await prisma.run.findUniqueOrThrow({ where: { id: correctionRunId } }),
          ).toMatchObject({ status: "completed", error: null });
          expect(handledWhileRunning).toBe(true);
          const meta = await prisma.message.findFirstOrThrow({
            where: {
              threadId: originTarget.threadId,
              botId,
              replyToMessageId: correction.sourceMessageId,
              clientNonce: { startsWith: "ticket-improvement:" },
            },
          });
          expect(meta.runId).toBeNull();
          const block = (meta.blocks as MessageBlock[]).find((item) => item.kind === "file")!;
          expect(block).toBeDefined();
          const opened = await getOwnedArtifact(base, actor, {
            botId,
            artifactId: block.artifactId,
          });
          const bytes = Buffer.from(opened.contentBase64, "base64");
          const result = JSON.parse(bytes.toString()) as {
            status: string;
            candidateRevisionId: string;
            comparisonArtifact: { id: string; version: number; hash: string };
            comparison: WorkImprovementComparison;
          };
          expect(result.status).toBe(scenario === "bad" ? "retained" : "adopted");
          expect(result.comparison.decision).toBe(scenario === "bad" ? "reject" : "adopt");
          expect(result.comparison.execution.runtime.id).toBe("deterministic-offline-file-tools");
          expect(result.comparison.summary.improvements).toEqual(["stale", "selected"]);
          expect(result.comparison.summary.candidate.falsePositiveCompletions).toBe(0);
          for (const entry of result.comparison.cases) {
            expect(entry.baseline.workspaceId).not.toBe(entry.candidate.workspaceId);
            expect(entry.baseline.tools[0]).toMatchObject({
              name: "read_file",
              status: "succeeded",
              result: { path: "request.json", content: expect.any(String) },
            });
            expect(entry.candidate.tools[1]).toMatchObject({
              name: "read_file",
              status: "succeeded",
              result: { path: "manifest.json", content: expect.any(String) },
            });
          }
          const canonical = await prisma.artifact.findUniqueOrThrow({
            where: { id: result.comparisonArtifact.id },
          });
          expect(canonical).toMatchObject({
            botId: workerBot.id,
            userId,
            groupId: null,
            version: result.comparisonArtifact.version,
            hash: result.comparisonArtifact.hash,
          });
          const visible = await prisma.artifact.findUniqueOrThrow({
            where: { id: block.artifactId },
          });
          expect(visible).toMatchObject({
            botId,
            groupId: null,
            hash: createHash("sha256").update(bytes).digest("hex"),
          });
          expect(bytes.toString()).not.toContain("offline-model-key");
          const chosen = await getCurrentTaughtSkillRevision(prisma, actor, skill.id);
          expect(chosen.id).toBe(scenario === "bad" ? baseline.id : result.candidateRevisionId);
          if (scenario !== "bad")
            expect(chosen.snapshot.trial).toMatchObject({
              artifactId: canonical.id,
              version: canonical.version,
              hash: canonical.hash,
              improvedCases: 2,
              protectedCasesPassed: true,
              falsePasses: 0,
              withinBudget: true,
            });
          const originalPins = await listPinnedTaughtSkillRevisions(prisma, actor, assignedRunId);
          expect(originalPins).toMatchObject([
            { id: baseline.id, snapshot: { playbook: baselineDeliveryPlaybook } },
          ]);
          const next = await sendThreadMessage(base, actor, workerTarget, {
            text: "Verify another retained delivery with the saved method.",
            clientNonce: randomUUID(),
          });
          nextRunId = next.runId;
          await handlers["run.continue"]({ runId: nextRunId });
          expect(await prisma.run.findUniqueOrThrow({ where: { id: nextRunId } })).toMatchObject({
            status: "completed",
            error: null,
          });
          expect(await listPinnedTaughtSkillRevisions(prisma, actor, nextRunId)).toMatchObject([
            { id: chosen.id },
          ]);
          const artifactCount = await prisma.artifact.count({ where: { runId: assignedRunId } });
          await handlers["harness.reflect"]({ runId: assignedRunId, auto: true });
          expect(runtime.proposalCalls).toBe(1);
          expect(runtime.comparisonCalls).toBe(12);
          expect(await prisma.artifact.count({ where: { runId: assignedRunId } })).toBe(
            artifactCount,
          );
          expect(
            await prisma.message.count({
              where: {
                threadId: originTarget.threadId,
                replyToMessageId: correction.sourceMessageId,
                clientNonce: { startsWith: "ticket-improvement:" },
              },
            }),
          ).toBe(1);
          const costs = await prisma.usageRecord.findMany({
            where: { spaceId, userId, parentRunId: assignedRunId, operationKind: "learning" },
          });
          expect(costs).toHaveLength(13);
          expect(costs.every((cost) => cost.totalTokens === 30 && cost.costUsd === 0)).toBe(true);
        });
      } finally {
        vi.unstubAllEnvs();
        if (identity)
          await runAsSystem("ticket improvement cleanup", async () => {
            await prisma.messagingIdentity.deleteMany({ where: { address } });
            await prisma.organization.deleteMany({ where: { id: identity!.spaceId } });
            await prisma.user.deleteMany({ where: { id: identity!.userId } });
          });
        await prisma.$disconnect();
        await db.pool.end();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
