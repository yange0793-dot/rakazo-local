import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
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
  taughtSkillPlaybookHash,
} from "../../../packages/adapters/src/taught-skill-revisions.js";
import {
  badDeliveryPlaybook,
  baselineDeliveryPlaybook,
  goodDeliveryPlaybook,
  OfflineTicketImprovementRuntime,
} from "../../../packages/adapters/src/ticket-improvement.test-fixtures.js";
import type { WorkImprovementComposition } from "../../../packages/adapters/src/work-improvement-compose.js";
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
          provisionMessagingIdentity(prisma, { provider: "email", address }),
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
          let composerCalls = 0;
          let composerRequest: AgentRunRequest | undefined;
          const proposedPlaybook = scenario === "bad" ? badDeliveryPlaybook : goodDeliveryPlaybook;
          const composedPlaybook =
            scenario === "bad"
              ? badDeliveryPlaybook
              : {
                  ...goodDeliveryPlaybook,
                  howToCheck:
                    "Check complete directory evidence, then require the final upload receipt.",
                };
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
                  expect(runtime.comparisonCalls).toBe(28);
                  expect(composerCalls).toBe(1);
                  await handlers["harness.reflect"]({ runId: assignedRunId, auto: true });
                  expect(runtime.proposalCalls).toBe(1);
                  expect(runtime.comparisonCalls).toBe(28);
                  expect(composerCalls).toBe(1);
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
                scenario === "bad" ? baselineDeliveryPlaybook : composedPlaybook,
              );
              return "The next delivery uses the chosen revision.";
            }
            throw new Error("Unexpected offline task");
          });
          runtime.proposal = {
            kind: "candidate",
            quote: CORRECTION,
            playbook: proposedPlaybook,
          };
          const run = runtime.run.bind(runtime);
          runtime.run = async function* (request, context) {
            if (
              request.usageOperationKind !== "learning" ||
              request.runId.endsWith(":proposal") ||
              request.tools.length > 0
            ) {
              yield* run(request, context);
              return;
            }
            runtime.requests.push(request);
            composerCalls++;
            composerRequest = request;
            expect(request.tools).toEqual([]);
            expect(request.history).toEqual([]);
            expect(request.executeTool).toBeUndefined();
            expect(request.fallbackModels).toBeUndefined();
            const observer = request.model.callObserver!;
            const callId = `${request.runId}:compose-call`;
            const reservation = await observer.beforeCall({
              callId,
              runId: request.runId,
              provider: request.model.provider,
              modelId: request.model.id,
              inputTokensEstimate: 80,
              maxOutputTokens: request.model.maxTokens ?? 512,
            });
            const usage = {
              type: "usage" as const,
              provider: request.model.provider,
              model: request.model.id,
              callId,
              inputTokens: 20,
              outputTokens: 10,
              totalTokens: 30,
              costUsd: 0,
              usageSource: "deterministic_offline_composer",
            };
            await observer.afterCall(reservation, usage);
            await request.onUsage!(usage);
            yield {
              type: "done",
              text: JSON.stringify({ kind: "compose", playbook: composedPlaybook }),
            };
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
          expect(composerCalls).toBe(0);
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
            comparison: WorkImprovementComposition;
          };
          expect(result.status).toBe(scenario === "bad" ? "retained" : "adopted");
          expect(result).toMatchObject({
            proposal: {
              result: { kind: "candidate", quote: CORRECTION, playbook: proposedPlaybook },
            },
            source: {
              receiptMessageId: receipt.id,
              receipt: {
                schema: 1,
                ticketId,
                runId: assignedRunId,
                version: 1,
                summary: "Installation passed and upload was selected.",
              },
            },
            comparison: {
              schemaVersion: "work-improvement.composition.v1",
              initial: { candidate: { playbook: proposedPlaybook } },
              composition: {
                status: "composed",
                candidate: { playbook: composedPlaybook },
                error: null,
                totalTokens: 30,
                costUsd: 0,
                usage: [
                  {
                    callId: `${composerRequest!.runId}:compose-call`,
                    totalTokens: 30,
                    costUsd: 0,
                    usageSource: "deterministic_offline_composer",
                  },
                ],
              },
              composed: { candidate: { playbook: composedPlaybook } },
            },
          });
          expect(result.comparison.decision).toBe(scenario === "bad" ? "reject" : "adopt");
          const { initial, composition, composed } = result.comparison;
          expect(composed).not.toBeNull();
          for (const comparison of [initial, composed!]) {
            expect(comparison.decision).toBe(scenario === "bad" ? "reject" : "adopt");
            expect(comparison.execution.runtime.id).toBe("deterministic-offline-file-tools");
            expect(comparison.summary.improvements).toEqual(["stale", "selected"]);
            expect(comparison.summary.candidate.falsePositiveCompletions).toBe(0);
            expect(comparison.cases).toHaveLength(7);
            for (const entry of comparison.cases) {
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
          }
          expect(
            new Set(
              [initial, composed!].flatMap((comparison) =>
                comparison.cases.flatMap((entry) => [
                  entry.baseline.workspaceId,
                  entry.candidate.workspaceId,
                ]),
              ),
            ).size,
          ).toBe(28);
          expect(composition.execution.model).toEqual(initial.execution.model);
          expect(composed!.execution.model).toEqual(initial.execution.model);
          expect(composed!.candidate.revision).toBe(composition.candidate!.revision);
          expect(result.comparison.retainedRevision).toBe(
            scenario === "bad" ? baseline.id : composed!.candidate.revision,
          );
          const rerunIds = new Set(composed!.cases.map((entry) => entry.candidate.runId));
          const rerunRequests = runtime.requests.filter((request) => rerunIds.has(request.runId));
          expect(rerunRequests).toHaveLength(7);
          for (const request of rerunRequests)
            expect(JSON.parse(request.instructions.split("\n").at(-1)!).playbook).toEqual(
              composedPlaybook,
            );
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
          if (scenario !== "bad") {
            expect(chosen.snapshot.playbook).toEqual(composedPlaybook);
            expect(taughtSkillPlaybookHash(composedPlaybook)).not.toBe(
              taughtSkillPlaybookHash(proposedPlaybook),
            );
            expect(chosen.snapshot.trial).toMatchObject({
              artifactId: canonical.id,
              version: canonical.version,
              hash: canonical.hash,
              improvedCases: 2,
              protectedCasesPassed: true,
              falsePasses: 0,
              withinBudget: true,
              candidatePlaybookHash: taughtSkillPlaybookHash(composed!.candidate.playbook),
            });
          }
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
          expect(runtime.comparisonCalls).toBe(28);
          expect(composerCalls).toBe(1);
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
          expect(costs).toHaveLength(
            runtime.proposalCalls + runtime.comparisonCalls + composerCalls,
          );
          expect(costs).toHaveLength(30);
          expect(costs.every((cost) => cost.totalTokens === 30 && cost.costUsd === 0)).toBe(true);
          expect(
            costs.filter((cost) => cost.callId === `${composerRequest!.runId}:compose-call`),
          ).toMatchObject([
            {
              botId: workerBot.id,
              provider: initial.execution.model.provider,
              model: initial.execution.model.id,
              parentRunId: assignedRunId,
              operationKind: "learning",
              operationId: `${initial.comparisonId}:comparison:${composerRequest!.runId}`,
              totalTokens: 30,
              costUsd: 0,
              usageSource: "deterministic_offline_composer",
            },
          ]);
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
