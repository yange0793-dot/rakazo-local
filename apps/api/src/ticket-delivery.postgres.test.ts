import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import {
  createBackgroundJobHandlers,
  createRunExecutor,
  createTicket,
  createTicketChangeNotifier,
  EncryptedSecretStore,
  FakeSandboxProvider,
  FakeWebProvider,
  LocalAgentHomeStore,
  LocalArtifactStore,
  ScriptedAgentRuntime,
  updateTicket,
} from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { projectMessages, userVisibleMessages } from "@rakazo/core";
import {
  createBoardEvents,
  createDb,
  createRepos,
  createThreadEvents,
  createThreadMessage,
  IsolationError,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  saveAutoReviewPreference,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../../../packages/adapters/src/executor-deps.js";
import { claimRun } from "../../../packages/adapters/src/run-lifecycle.js";
import { attachWorkspaceFileToThread } from "../../../packages/adapters/src/thread-artifacts.js";
import { deliverTicketWork } from "../../../packages/adapters/src/ticket-delivery.js";
import { getOwnedArtifact, getSpaceArtifact } from "./artifacts.js";
import { loadMessagePage, shouldForwardBackgroundThreadEvent } from "./thread-message-pages.js";
import { reactToThreadMessage } from "./thread-reactions.js";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

const pg =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

async function ticketFixture() {
  vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
  vi.stubEnv("SELF_EVOLUTION", "off");
  const db = createDb(process.env.DATABASE_URL!);
  const { prisma } = db;
  const dataDir = await mkdtemp(join(tmpdir(), "ticket-recovery-"));
  const address = `work-${randomUUID()}@example.test`;
  const identity = await runAsSystem("ticket fixture", () =>
    provisionMessagingIdentity(
      prisma,
      { provider: "email", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    ),
  );
  const actor = {
    spaceId: identity.spaceId,
    userId: identity.userId,
    email: address,
    isDeploymentOwner: false,
  };
  const queue: BackgroundJob[] = [];
  const jobs: JobPublisher = {
    enqueue: async (job) => {
      queue.push(job);
    },
    cancel: async () => {},
    close: async () => {},
  };
  const events = createThreadEvents(prisma);
  const sandbox = new FakeSandboxProvider();
  const artifacts = new LocalArtifactStore(dataDir);
  const base = {
    prisma,
    jobs,
    events,
    sandbox,
    artifacts,
    ticketBoardEnabled: true,
    onTicketChange: createTicketChangeNotifier({
      prisma,
      jobs,
      boardEvents: createBoardEvents(),
      ticketBoardEnabled: true,
    }),
  };
  const target = await runAsTenant(actor, () =>
    resolveThreadTarget(prisma, actor, { botId: identity.botId }),
  );
  const workerDeps = {
    ...base,
    memoryProviders: { resolve: async () => null },
    web: new FakeWebProvider(),
    home: new LocalAgentHomeStore(dataDir),
    memory: new MarkdownMemoryStore(prisma),
    secretStore: new EncryptedSecretStore("fixture-secret"),
    secrets: [],
    deploymentModelKey: "fixture-key",
    deploymentModelConfigured: true,
    dataDir,
  };
  const close = async () => {
    vi.unstubAllEnvs();
    await Promise.all([prisma.$disconnect(), rm(dataDir, { recursive: true, force: true })]);
    await db.pool.end();
  };
  return { prisma, identity, actor, base, target, workerDeps, queue, close };
}

pg("chat ticket work delivery", () => {
  it.each([true, false])(
    "requires a receipt after a plain final, with one repair turn (deliver=%s)",
    async (deliver) => {
      const f = await ticketFixture();
      try {
        await runAsTenant(f.actor, async () => {
          const sent = await sendThreadMessage(f.base, f.actor, f.target, {
            text: "Check this delivery and return its evidence here.",
            clientNonce: randomUUID(),
          });
          let turns = 0;
          let ticketId = "";
          const runtime = {
            describe: () => ({
              ...new ScriptedAgentRuntime().describe(),
              capabilities: {
                ...new ScriptedAgentRuntime().describe().capabilities,
                scripted: false,
              },
            }),
            abort: async () => {},
            async *run(request: AgentRunRequest) {
              turns++;
              if (turns === 1) {
                const made = (await request.executeTool!(
                  "ticket_create",
                  {
                    title: "Delivery check",
                    ownerBotId: f.identity.botId,
                  },
                  "create",
                )) as { ticket: { id: string } };
                ticketId = made.ticket.id;
              } else if (deliver) {
                expect(request.prompt).toContain("has not been delivered");
                expect(
                  await request.executeTool!(
                    "ticket_update",
                    {
                      id: ticketId,
                      result: {
                        previousVersion: 0,
                        summary: "Directory observation is still needed.",
                        findings: [
                          {
                            outcome: "unknown",
                            conclusion: "The full directory is unverified.",
                            evidence: "Only manifest members were checked.",
                          },
                        ],
                      },
                    },
                    "deliver",
                  ),
                ).toHaveProperty("ok", true);
              }
              yield { type: "done" as const, text: "A draft has been prepared." };
            },
          };
          await createRunExecutor({ ...f.workerDeps, runtime }).continueRun(
            sent.runId,
            "receipt-worker",
          );
          expect(turns).toBe(2);
          const completed = await f.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
          expect(completed.status).toBe(deliver ? "completed" : "failed");
          if (!deliver) expect(completed.error).toContain("without delivering");
          expect(
            await f.prisma.message.count({
              where: { threadId: f.target.threadId, clientNonce: { startsWith: "work-receipt:" } },
            }),
          ).toBe(deliver ? 1 : 0);
          expect(
            (await f.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status,
          ).toBe(deliver ? "review" : "todo");
        });
      } finally {
        await f.close();
      }
    },
    60_000,
  );

  it("resumes an approval, opens delegated files in the original chat and attributes later corrections", async () => {
    vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
    vi.stubEnv("SELF_EVOLUTION", "on");
    const db = createDb(process.env.DATABASE_URL!);
    const { prisma } = db;
    const address = `research-${randomUUID()}@example.test`;
    const dataDir = await mkdtemp(join(tmpdir(), "work-delivery-"));
    try {
      const identity = await runAsSystem("work delivery fixture", () =>
        provisionMessagingIdentity(
          prisma,
          { provider: "email", address },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      const actor = {
        spaceId: identity.spaceId,
        userId: identity.userId,
        email: address,
        isDeploymentOwner: false,
      };
      await runAsTenant(actor, async () => {
        const repos = createRepos(prisma);
        const peer = await repos.createBot(actor, {
          name: "Researcher",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        });
        const unrelated = await repos.createBot(actor, {
          name: "Unrelated work",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        });
        const peerTarget = await resolveThreadTarget(prisma, actor, { botId: peer.id });
        const target = await resolveThreadTarget(prisma, actor, { botId: identity.botId });
        const queue: BackgroundJob[] = [];
        const jobs: JobPublisher = {
          enqueue: async (job) => {
            queue.push(job);
          },
          cancel: async () => {},
          close: async () => {},
        };
        const events = createThreadEvents(prisma);
        const sandbox = new FakeSandboxProvider();
        const artifacts = new LocalArtifactStore(dataDir);
        const base = {
          prisma,
          jobs,
          events,
          sandbox,
          artifacts,
          ticketBoardEnabled: true,
          onTicketChange: createTicketChangeNotifier({
            prisma,
            jobs,
            boardEvents: createBoardEvents(),
            ticketBoardEnabled: true,
          }),
        };
        await prisma.$transaction((tx) =>
          saveAutoReviewPreference(
            tx,
            actor,
            { enabled: false },
            { enabled: false, skipApprovals: false },
          ),
        );
        const send = (text: string, replyToMessageId?: string) =>
          sendThreadMessage(base, actor, target, {
            text,
            replyToMessageId,
            clientNonce: randomUUID(),
          });
        const sent = await send(
          "Continue last version’s research and return the differences here.",
        );
        let id = "";
        let ref = "";
        let revision = 0;
        let visibleEvidenceId = "";
        let workerTurns = 0;
        const findings = [
          {
            outcome: "pass",
            conclusion: "The newer release contains the review screen.",
            evidence: "Sample client inventory v2, entry review.",
          },
          {
            outcome: "unknown",
            conclusion: "Server-side adoption is unconfirmed.",
            evidence: "The retained evidence only covers the client.",
          },
        ];
        const result = {
          previousVersion: 0,
          summary: "One client change found. Server behavior is still open.",
          findings,
          artifactIds: [] as string[],
        };
        const workCalls: unknown[] = [];
        const runtime = {
          describe: () => ({
            ...new ScriptedAgentRuntime().describe(),
            capabilities: {
              ...new ScriptedAgentRuntime().describe().capabilities,
              scripted: false,
              ready: true,
            },
          }),
          abort: async () => {},
          async *run(request: AgentRunRequest) {
            const execute = request.executeTool!;
            if (!id) {
              const made = (await execute(
                "ticket_create",
                { title: "Compare retained releases", ownerBotId: peer.id },
                "start-work",
              )) as { ticket: { id: string; ref: string } };
              expect(made).toHaveProperty("ticket.id");
              id = made.ticket.id;
              ref = made.ticket.ref;
            } else if (revision) {
              expect(`${request.instructions}\n${request.prompt}`).toContain(
                `${ref} [${revision === 1 ? "review" : "done"}]`,
              );
              workCalls.push(
                await execute(
                  "ticket_update",
                  {
                    id,
                    result: {
                      ...result,
                      previousVersion: revision,
                      summary:
                        revision === 1
                          ? "Both checks now have evidence."
                          : "The server conclusion needs correction.",
                      artifactIds: [visibleEvidenceId],
                      findings: [
                        findings[0]!,
                        {
                          outcome: revision === 1 ? "pass" : "issue",
                          conclusion:
                            revision === 1
                              ? "The server check is recorded."
                              : "The client sample cannot establish server adoption.",
                          evidence:
                            revision === 1
                              ? "Retained server observation, sample build v2."
                              : "The retained inventory describes only the client.",
                        },
                      ],
                    },
                  },
                  `revised-${revision}`,
                ),
              );
            } else {
              if (++workerTurns === 1) {
                const ticket = (await execute("ticket_get", { ref }, "ticket")) as {
                  delivery: { previousVersion: number };
                };
                expect(ticket).toMatchObject({ delivery: { previousVersion: 0 } });
              }
              const read = await execute(
                "web_fetch",
                { url: "https://example.test/inventory" },
                "fetch-inventory",
              );
              await request.onToolCompleted?.({
                name: "web_fetch",
                executionId: "fetch-inventory",
                durationMs: 1,
                result: read,
                paused: workerTurns === 1,
              });
              if (workerTurns === 1) {
                yield { type: "done" as const, text: "" };
                return;
              }
              const evidence = await attachWorkspaceFileToThread(
                { prisma, artifacts },
                {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  botId: peer.id,
                  runId: request.runId,
                  filePath: "comparison.md",
                  bytes: new TextEncoder().encode(
                    "Retained client inventory: review screen added.",
                  ),
                  operationId: `evidence:${request.runId}`,
                },
              );
              const source = await prisma.artifact.findUniqueOrThrow({
                where: { id: evidence.artifactId },
              });
              result.artifactIds.push(source.id);
              const foreign = await prisma.artifact.create({
                data: {
                  ...source,
                  id: randomUUID(),
                  botId: unrelated.id,
                  rootArtifactId: null,
                  standalone: true,
                  clientNonce: null,
                },
              });
              const anotherUser = await prisma.artifact.create({
                data: {
                  ...source,
                  id: randomUUID(),
                  userId: "another-user",
                  rootArtifactId: null,
                  standalone: true,
                  clientNonce: null,
                },
              });
              for (const blocked of [foreign, anotherUser]) {
                expect(
                  await execute(
                    "ticket_update",
                    { id, result: { ...result, artifactIds: [blocked.id] } },
                    `blocked-${blocked.id}`,
                  ),
                ).toHaveProperty("error");
              }
              expect(
                await prisma.message.count({
                  where: { clientNonce: { startsWith: `work-receipt:${id}:` } },
                }),
              ).toBe(0);
              workCalls.push(await execute("ticket_update", { id, result }, "deliver-work"));
              workCalls.push(await execute("ticket_update", { id, result }, "repeat-work"));
            }
            yield { type: "done" as const, text: "Recorded." };
          },
        };
        const deps = {
          ...base,
          memoryProviders: { resolve: async () => null },
          web: new FakeWebProvider(),
          home: new LocalAgentHomeStore(dataDir),
          memory: new MarkdownMemoryStore(prisma),
          secretStore: new EncryptedSecretStore("fixture-secret"),
          secrets: [],
          deploymentModelKey: "fixture-key",
          deploymentModelConfigured: true,
          dataDir,
          runtime,
        };
        const execute = (runId: string, worker: string) =>
          createRunExecutor(deps).continueRun(runId, worker);
        await execute(sent.runId, "chat");
        const origin = await prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        expect(origin.error).toBeNull();
        const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id } });
        expect(ticket).toMatchObject({
          originThreadId: target.threadId,
          originMessageId: origin.sourceMessageId,
          originRunId: origin.id,
          assigneeBotId: peer.id,
        });
        expect(
          await createTicket(base, {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: identity.botId,
            title: ticket.title,
            ownerBotId: peer.id,
            origin: {
              threadId: target.threadId,
              runId: origin.id,
              messageId: origin.sourceMessageId!,
              key: ticket.originKey!,
            },
          }),
        ).toHaveProperty("ticket.id", id);
        expect(
          await createTicket(base, {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: identity.botId,
            title: ticket.title,
            ownerBotId: peer.id,
            origin: {
              threadId: peerTarget.threadId,
              runId: origin.id,
              messageId: origin.sourceMessageId!,
              key: `${origin.id}:wrong-thread`,
            },
          }),
        ).toHaveProperty("error", "Ticket source does not match its execution.");
        const [assigned] = await prisma.run.findMany({ where: { ticketId: id } });
        expect(assigned).toMatchObject({
          botId: peer.id,
          trigger: "tickets",
          sourceMessageId: null,
          status: "queued",
        });
        expect(await prisma.run.count({ where: { ticketId: id } })).toBe(1);
        expect(queue).toContainEqual(
          expect.objectContaining({ name: "run.continue", payload: { runId: assigned!.id } }),
        );
        await execute(assigned!.id, "before-input");
        const paused = await prisma.run.findUniqueOrThrow({ where: { id: assigned!.id } });
        expect(paused.error).toBeNull();
        expect(paused.status).toBe("waiting_input");
        const card = await prisma.message.findFirstOrThrow({
          where: { runId: assigned!.id, blocks: { array_contains: [{ kind: "ask" }] } },
        });
        expect(
          await events.answerRunInput({
            spaceId: actor.spaceId,
            threadId: card.threadId,
            runId: assigned!.id,
            messageId: card.id,
            answeredByUserId: actor.userId,
            answer: "allow",
          }),
        ).toBe(true);
        await execute(assigned!.id, "after-input");
        expect(await prisma.run.findUniqueOrThrow({ where: { id: assigned!.id } })).toMatchObject({
          status: "completed",
          error: null,
          leaseFence: 2,
        });
        const ticketState = await prisma.ticket.findUniqueOrThrow({ where: { id } });
        expect(ticketState).toMatchObject({
          receiptVersion: 1,
          status: "review",
          completedAt: null,
        });
        expect(workCalls).toHaveLength(2);
        expect(workCalls[1]).toEqual(workCalls[0]);
        const messages = await prisma.message.findMany({
          where: {
            threadId: target.threadId,
            replyToMessageId: ticket.originMessageId,
            role: "bot",
            clientNonce: { startsWith: "work-receipt:" },
          },
        });
        expect(messages).toHaveLength(1);
        const message = messages[0]!;
        expect(message.botId).toBe(identity.botId);
        expect(message.runId).toBe(assigned!.id);
        const receiptEvent = await prisma.event.findFirstOrThrow({
          where: {
            threadId: target.threadId,
            type: "thread.message.created",
            payload: { path: ["messageId"], equals: message.id },
          },
        });
        expect(receiptEvent).toMatchObject({ runId: assigned!.id, botId: identity.botId });
        expect(
          userVisibleMessages(projectMessages([receiptEvent]), {
            backgroundRunIds: [assigned!.id],
          }).map((row) => row.id),
        ).toContain(message.id);
        expect(
          shouldForwardBackgroundThreadEvent({
            type: receiptEvent.type,
            payload: receiptEvent.payload as Record<string, unknown>,
          }),
        ).toBe(true);
        const page = await loadMessagePage(prisma, target.threadId, undefined, 50);
        expect(
          userVisibleMessages(page.messages, { includePeerReceipts: true }).map((row) => row.id),
        ).toContain(message.id);
        expect(
          (await repos.listBots(actor)).find((bot) => bot.id === identity.botId)?.preview,
        ).toBe(`${ref} · ${result.summary}`);
        const file = (message.blocks as MessageBlock[]).find((b) => b.kind === "file");
        expect(file).toBeDefined();
        const opened = await getOwnedArtifact(base, actor, {
          botId: identity.botId,
          artifactId: file!.artifactId,
        });
        expect(JSON.parse(Buffer.from(opened.contentBase64, "base64").toString())).toMatchObject({
          runId: assigned!.id,
          version: 1,
          ticketId: id,
          findings,
        });
        const evidence = (message.blocks as MessageBlock[]).find(
          (b) => b.kind === "file" && b.name === "comparison.md",
        );
        if (evidence?.kind !== "file") throw new Error("Missing comparison evidence");
        visibleEvidenceId = evidence.artifactId;
        expect(visibleEvidenceId).not.toBe(result.artifactIds[0]);
        const visible = await getOwnedArtifact(base, actor, {
          botId: identity.botId,
          artifactId: visibleEvidenceId,
        });
        expect(Buffer.from(visible.contentBase64, "base64").toString()).toBe(
          "Retained client inventory: review screen added.",
        );
        const originalEvidence = await prisma.artifact.findUniqueOrThrow({
          where: { id: result.artifactIds[0]! },
        });
        const copiedEvidence = await prisma.artifact.findUniqueOrThrow({
          where: { id: visibleEvidenceId },
        });
        expect(copiedEvidence).toMatchObject({
          botId: identity.botId,
          userId: actor.userId,
          groupId: null,
          runId: assigned!.id,
          hash: originalEvidence.hash,
        });
        expect(copiedEvidence.storageKey).not.toBe(originalEvidence.storageKey);
        expect(JSON.parse(Buffer.from(opened.contentBase64, "base64").toString())).toMatchObject({
          artifactIds: [visibleEvidenceId],
          artifacts: [
            {
              id: visibleEvidenceId,
              sourceArtifactId: originalEvidence.id,
              sourceVersion: originalEvidence.version,
              sourceHash: originalEvidence.hash,
            },
          ],
        });
        expect(
          await prisma.artifact.count({ where: { name: "comparison.md", botId: identity.botId } }),
        ).toBe(1);
        expect(
          await prisma.artifact.count({ where: { name: opened.name, botId: identity.botId } }),
        ).toBe(1);
        expect(
          await updateTicket(base, {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: peer.id,
            id,
            status: "done",
          }),
        ).toHaveProperty("error");
        await reactToThreadMessage(base, actor, target, {
          messageId: message.id,
          reaction: "👎",
          mayStartTurn: false,
          clientNonce: randomUUID(),
        });
        expect(queue).toContainEqual(
          expect.objectContaining({
            name: "harness.reflect",
            payload: { runId: assigned!.id, auto: true },
          }),
        );
        await createThreadMessage(prisma, {
          threadId: target.threadId,
          role: "user",
          authorUserId: actor.userId,
          blocks: [{ kind: "text", text: "Unrelated conversation must stay out." }],
        });
        revision = 1;
        const correction = await send("Please revise this after the new observation.", message.id);
        expect(
          await prisma.run.findUniqueOrThrow({
            where: { id: correction.runId },
            include: { sourceMessage: true },
          }),
        ).toMatchObject({
          ticketId: id,
          botId: identity.botId,
          sourceMessage: {
            threadId: target.threadId,
            authorUserId: actor.userId,
            replyToMessageId: message.id,
          },
        });
        const prompts: string[] = [];
        const review = createBackgroundJobHandlers({
          prisma,
          events,
          jobs,
          memoryProviders: {
            resolve: async () => ({
              provider: { describe: () => ({ capabilities: { managedFacts: true } }) },
            }),
          },
          executor: { resolveModel: async () => ({ provider: "test-reviewer", id: "test" }) },
          runtime: {
            async *run(request: AgentRunRequest) {
              prompts.push(request.prompt);
              yield {
                type: "done",
                text: JSON.stringify({ skip: true, reason: "No reusable lesson in this fixture." }),
              };
            },
          },
        } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
        await review["harness.reflect"]({ runId: assigned!.id, auto: true });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("user_disliked");
        expect(prompts[0]).toContain("Please revise this after the new observation.");
        expect(prompts[0]).not.toContain("Unrelated conversation must stay out.");
        await execute(correction.runId, "correction");
        expect(await prisma.ticket.findUniqueOrThrow({ where: { id } })).toMatchObject({
          receiptVersion: 2,
          status: "done",
        });
        expect(
          await prisma.artifact.findFirstOrThrow({ where: { rootArtifactId: file!.artifactId } }),
        ).toMatchObject({ version: 2, runId: correction.runId });
        const revised = await prisma.message.findFirstOrThrow({
          where: {
            threadId: target.threadId,
            runId: correction.runId,
            clientNonce: { startsWith: `work-receipt:${id}:2:` },
          },
        });
        revision = 2;
        const afterDone = await send(
          "The retained client evidence does not verify the server conclusion.",
          revised.id,
        );
        expect(
          await prisma.run.findUniqueOrThrow({ where: { id: afterDone.runId } }),
        ).toMatchObject({ ticketId: id, botId: identity.botId });
        await execute(afterDone.runId, "after-done");
        expect(await prisma.ticket.findUniqueOrThrow({ where: { id } })).toMatchObject({
          receiptVersion: 3,
          status: "review",
          completedAt: null,
        });
        expect(
          await updateTicket(base, {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: peer.id,
            id,
            status: "done",
          }),
        ).toHaveProperty("error");
        expect(
          await prisma.artifact.count({ where: { name: "comparison.md", botId: identity.botId } }),
        ).toBe(1);
        vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
        expect(
          (await loadMessagePage(prisma, target.threadId, undefined, 50)).messages.map(
            (row) => row.id,
          ),
        ).toContain(message.id);
        expect(
          await updateTicket(base, {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: peer.id,
            id,
            status: "closed",
          }),
        ).toHaveProperty("ticket.status", "closed");
      });
    } finally {
      vi.unstubAllEnvs();
      await Promise.all([db.prisma.$disconnect(), rm(dataDir, { recursive: true, force: true })]);
      await db.pool.end();
    }
  }, 60000);

  it("keeps a self-assigned chat on its current execution and rejects an unrelated source message", async () => {
    const f = await ticketFixture();
    try {
      await runAsTenant(f.actor, async () => {
        const sent = await sendThreadMessage(f.base, f.actor, f.target, {
          text: "Compare the retained release and return the file here.",
          clientNonce: randomUUID(),
        });
        let id = "";
        let delivered: unknown;
        const result = {
          previousVersion: 0,
          summary: "The retained client comparison is ready.",
          findings: [
            {
              outcome: "pass",
              conclusion: "The client inventory is compared.",
              evidence: "Retained client inventories v1 and v2.",
            },
          ],
        };
        const runtime = {
          describe: () => ({
            ...new ScriptedAgentRuntime().describe(),
            capabilities: {
              ...new ScriptedAgentRuntime().describe().capabilities,
              scripted: false,
              ready: true,
            },
          }),
          abort: async () => {},
          async *run(request: AgentRunRequest) {
            const made = (await request.executeTool!(
              "ticket_create",
              { title: "Compare client inventories" },
              "create-self",
            )) as { ticket: { id: string } };
            expect(made).toHaveProperty("ticket.id");
            id = made.ticket.id;
            expect(
              await request.executeTool!(
                "ticket_update",
                { id, ownerBotId: f.identity.botId, status: "doing" },
                "claim-self",
              ),
            ).toHaveProperty("ticket.assigneeBotId", f.identity.botId);
            delivered = await request.executeTool!("ticket_update", { id, result }, "deliver-self");
            yield { type: "done" as const, text: "Recorded." };
          },
        };
        await createRunExecutor({ ...f.workerDeps, runtime }).continueRun(
          sent.runId,
          "self-worker",
        );
        const run = await f.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        expect(run).toMatchObject({ status: "completed", error: null, ticketId: id });
        const ticket = await f.prisma.ticket.findUniqueOrThrow({ where: { id } });
        expect(ticket).toMatchObject({
          originThreadId: f.target.threadId,
          originMessageId: run.sourceMessageId,
          originRunId: run.id,
          assigneeBotId: f.identity.botId,
          receiptVersion: 1,
          status: "done",
        });
        expect(delivered).toMatchObject({ ok: true, version: 1, status: "done" });
        expect(await f.prisma.run.count({ where: { ticketId: id, trigger: "tickets" } })).toBe(0);
        expect(f.queue.filter((job) => job.name === "run.continue")).toHaveLength(1);
        expect(
          await createTicket(f.base, {
            ...f.actor,
            botId: f.identity.botId,
            title: ticket.title,
            origin: {
              threadId: f.target.threadId,
              messageId: run.sourceMessageId!,
              runId: run.id,
              key: ticket.originKey!,
            },
          }),
        ).toHaveProperty("ticket.id", id);
        expect(await f.prisma.ticket.count({ where: { spaceId: f.actor.spaceId } })).toBe(1);
        const another = await createThreadMessage(f.prisma, {
          threadId: f.target.threadId,
          role: "user",
          authorUserId: f.actor.userId,
          blocks: [{ kind: "text", text: "A different request." }],
        });
        expect(
          await createTicket(f.base, {
            ...f.actor,
            botId: f.identity.botId,
            title: "Wrong source",
            origin: {
              threadId: f.target.threadId,
              messageId: another.id,
              runId: run.id,
              key: `${run.id}:wrong-message`,
            },
          }),
        ).toHaveProperty("error", "Ticket source does not match its execution.");
        expect(await f.prisma.ticket.count({ where: { spaceId: f.actor.spaceId } })).toBe(1);
      });
    } finally {
      await f.close();
    }
  }, 60000);

  it("reclaims an abandoned running lease after receipt commit without repeating the delivery", async () => {
    const f = await ticketFixture();
    try {
      await runAsTenant(f.actor, async () => {
        const peer = await createRepos(f.prisma).createBot(f.actor, {
          name: "Worker",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        });
        const sent = await sendThreadMessage(f.base, f.actor, f.target, {
          text: "Return the retained comparison here.",
          clientNonce: randomUUID(),
        });
        const origin = await f.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        const made = await createTicket(f.base, {
          ...f.actor,
          botId: f.identity.botId,
          title: "Recover client comparison",
          ownerBotId: peer.id,
          origin: {
            threadId: f.target.threadId,
            messageId: origin.sourceMessageId!,
            runId: origin.id,
            key: `${origin.id}:recover`,
          },
        });
        if (!("ticket" in made)) throw new Error("Missing recovery ticket");
        const ticket = made.ticket;
        const assigned = await f.prisma.run.findFirstOrThrow({
          where: { ticketId: ticket.id, botId: peer.id },
        });
        const lease = await claimRun(
          { ...f.workerDeps, runtime: new ScriptedAgentRuntime() } as ExecutorDeps,
          assigned,
          "lost-worker",
        );
        if (!lease) throw new Error("Missing first worker lease");
        await f.prisma.run.update({ where: { id: assigned.id }, data: { startedAt: new Date() } });
        await f.prisma.task.update({ where: { id: assigned.taskId }, data: { status: "running" } });
        const evidence = await attachWorkspaceFileToThread(f.base, {
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          botId: peer.id,
          runId: assigned.id,
          filePath: "recovered-comparison.md",
          bytes: new TextEncoder().encode("Retained comparison completed."),
          operationId: `evidence:${assigned.id}`,
        });
        const result = {
          previousVersion: 0,
          summary: "The retained comparison is ready.",
          findings: [
            {
              outcome: "pass",
              conclusion: "Both retained client inventories were compared.",
              evidence: "Retained inventories v1 and v2.",
            },
          ],
          artifactIds: [evidence.artifactId],
        };
        const lostDeps = {
          ...f.base,
          runLease: { runId: assigned.id, owner: "lost-worker", fence: lease.fence },
        };
        const delivered = await deliverTicketWork(lostDeps, assigned, {
          id: ticket.id,
          result,
          ownerAuthored: false,
          secrets: [],
        });
        expect(delivered).toMatchObject({ ok: true, version: 1, status: "done" });
        // These are the durable records left when a process disappears after delivery and
        // before completion. Recovery must claim this running lease, not answer an ask card.
        await f.prisma.run.update({
          where: { id: assigned.id },
          data: { leaseExpiresAt: new Date(Date.now() - 1000) },
        });
        expect(await f.prisma.run.findUniqueOrThrow({ where: { id: assigned.id } })).toMatchObject({
          status: "running",
          leaseOwner: "lost-worker",
          leaseFence: 1,
          completedAt: null,
        });
        let replay: unknown;
        const runtime = {
          describe: () => ({
            ...new ScriptedAgentRuntime().describe(),
            capabilities: {
              ...new ScriptedAgentRuntime().describe().capabilities,
              scripted: false,
              ready: true,
            },
          }),
          abort: async () => {},
          async *run(request: AgentRunRequest) {
            replay = await request.executeTool!(
              "ticket_update",
              { id: ticket.id, result },
              "deliver-after-restart",
            );
            yield { type: "done" as const, text: "" };
          },
        };
        await createRunExecutor({ ...f.workerDeps, runtime }).continueRun(
          assigned.id,
          "replacement-worker",
        );
        expect(await f.prisma.run.findUniqueOrThrow({ where: { id: assigned.id } })).toMatchObject({
          status: "completed",
          error: null,
          leaseFence: 2,
        });
        expect(replay).toEqual(delivered);
        expect(
          await f.prisma.message.count({
            where: {
              threadId: f.target.threadId,
              clientNonce: { startsWith: `work-receipt:${ticket.id}:` },
            },
          }),
        ).toBe(1);
        expect(
          await f.prisma.artifact.count({
            where: { botId: f.identity.botId, name: `work-${ticket.id}.json` },
          }),
        ).toBe(1);
        expect(
          await f.prisma.artifact.count({
            where: { botId: f.identity.botId, name: "recovered-comparison.md" },
          }),
        ).toBe(1);
        await expect(
          deliverTicketWork(lostDeps, assigned, {
            id: ticket.id,
            result: {
              ...result,
              previousVersion: 1,
              summary: "A stale worker tried to revise this.",
            },
            ownerAuthored: false,
            secrets: [],
          }),
        ).rejects.toThrow("Run cannot write thread history");
        expect(await f.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject(
          { receiptVersion: 1, status: "done" },
        );
        expect(
          await f.prisma.artifact.count({
            where: { botId: f.identity.botId, name: `work-${ticket.id}.json` },
          }),
        ).toBe(1);
        expect(
          await f.prisma.artifact.count({
            where: { botId: f.identity.botId, name: "recovered-comparison.md" },
          }),
        ).toBe(1);
      });
    } finally {
      await f.close();
    }
  }, 60000);

  it("copies delegated private files into the original group without exposing another group's files", async () => {
    const f = await ticketFixture();
    try {
      await runAsTenant(f.actor, async () => {
        const peer = await createRepos(f.prisma).createBot(f.actor, {
          name: "Group researcher",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        });
        const group = await f.prisma.chatGroup.create({
          data: {
            spaceId: f.actor.spaceId,
            userId: f.actor.userId,
            name: "Research",
            members: { create: [{ botId: f.identity.botId }, { botId: peer.id }] },
            thread: { create: { spaceId: f.actor.spaceId, userId: f.actor.userId } },
          },
        });
        const target = await resolveThreadTarget(f.prisma, f.actor, { groupId: group.id });
        const sent = await sendThreadMessage(f.base, f.actor, target, {
          text: "Compare the retained client versions and return the evidence here.",
          mentions: [f.identity.botId],
          clientNonce: randomUUID(),
        });
        const origin = await f.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        const made = await createTicket(f.base, {
          ...f.actor,
          botId: f.identity.botId,
          title: "Group comparison",
          ownerBotId: peer.id,
          origin: {
            threadId: target.threadId,
            messageId: origin.sourceMessageId!,
            runId: origin.id,
            key: `${origin.id}:group`,
          },
        });
        if (!("ticket" in made)) throw new Error("Missing group ticket");
        const ticket = made.ticket;
        const assigned = await f.prisma.run.findFirstOrThrow({
          where: { ticketId: ticket.id, botId: peer.id },
        });
        const lease = await claimRun(
          { ...f.workerDeps, runtime: new ScriptedAgentRuntime() } as ExecutorDeps,
          assigned,
          "group-worker",
        );
        if (!lease) throw new Error("Missing group worker lease");
        const input = {
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          botId: peer.id,
          runId: assigned.id,
        };
        const evidence = await attachWorkspaceFileToThread(f.base, {
          ...input,
          filePath: "group-evidence.md",
          bytes: new TextEncoder().encode("The retained group comparison."),
          operationId: `evidence:${assigned.id}`,
        });
        const privateGroup = await f.prisma.chatGroup.create({
          data: { spaceId: f.actor.spaceId, userId: f.actor.userId, name: "Other research" },
        });
        const privateFile = await attachWorkspaceFileToThread(f.base, {
          ...input,
          groupId: privateGroup.id,
          filePath: "private-evidence.md",
          bytes: new TextEncoder().encode("A different group's private research."),
          operationId: `private:${assigned.id}`,
        });
        const result = {
          previousVersion: 0,
          summary: "The group comparison is ready.",
          findings: [
            {
              outcome: "pass",
              conclusion: "Both client inventories were compared.",
              evidence: "Retained client inventories v1 and v2.",
            },
          ],
        };
        const deps = {
          ...f.base,
          runLease: { runId: assigned.id, owner: "group-worker", fence: lease.fence },
        };
        expect(
          await deliverTicketWork(deps, assigned, {
            id: ticket.id,
            result: { ...result, artifactIds: [privateFile.artifactId] },
            ownerAuthored: false,
            secrets: [],
          }),
        ).toHaveProperty("error");
        const delivered = await deliverTicketWork(deps, assigned, {
          id: ticket.id,
          result: { ...result, artifactIds: [evidence.artifactId] },
          ownerAuthored: false,
          secrets: [],
        });
        if (!("messageId" in delivered)) throw new Error("Missing group receipt");
        const receipt = await f.prisma.message.findUniqueOrThrow({
          where: { id: delivered.messageId },
        });
        expect(receipt).toMatchObject({
          threadId: target.threadId,
          botId: f.identity.botId,
          runId: assigned.id,
          replyToMessageId: origin.sourceMessageId,
        });
        const file = (receipt.blocks as MessageBlock[]).find(
          (block) => block.kind === "file" && block.name === "group-evidence.md",
        );
        if (file?.kind !== "file") throw new Error("Missing group evidence");
        expect(file.artifactId).not.toBe(evidence.artifactId);
        const opened = await getSpaceArtifact(f.base, f.actor, {
          artifactId: file.artifactId,
          groupId: group.id,
          contextBotId: f.identity.botId,
        });
        expect(Buffer.from(opened.contentBase64, "base64").toString()).toBe(
          "The retained group comparison.",
        );
        await expect(
          getSpaceArtifact(f.base, f.actor, {
            artifactId: file.artifactId,
            groupId: privateGroup.id,
            contextBotId: f.identity.botId,
          }),
        ).rejects.toBeInstanceOf(IsolationError);
        await expect(
          getOwnedArtifact(f.base, f.actor, {
            artifactId: file.artifactId,
            botId: f.identity.botId,
          }),
        ).rejects.toBeInstanceOf(IsolationError);
        expect(
          await f.prisma.artifact.count({
            where: { groupId: group.id, name: "private-evidence.md" },
          }),
        ).toBe(0);
        expect(
          (await loadMessagePage(f.prisma, target.threadId, undefined, 50)).messages.map(
            (row) => row.id,
          ),
        ).toContain(receipt.id);
      });
    } finally {
      await f.close();
    }
  }, 60000);
});
