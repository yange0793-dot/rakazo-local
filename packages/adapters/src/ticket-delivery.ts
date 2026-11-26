import { createHash, randomUUID } from "node:crypto";
import type { MessageBlock, TicketFileDeliveryAcceptance } from "@rakazo/contracts";
import {
  THREAD_MESSAGE_TEXT_MAX_LENGTH,
  TicketFileDeliveryAcceptanceSchema,
  TicketFileDeliveryRequirementsSchema,
  TicketWorkResult,
} from "@rakazo/contracts";
import { messageBlockForArtifact, redactSecrets } from "@rakazo/core";
import type { Artifact, Run } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  getManagedWorkCompletionBlockers,
  IsolationError,
  LISTED_ARTIFACT,
  lockSpaceGroup,
  ManagedWorkError,
  managedWorkOriginAvailable,
  recordManagedDependencyChangeInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FileDeliveryAcceptanceInput } from "./file-delivery-acceptance.js";
import { evaluateFileDeliveryAcceptanceWithJudge } from "./file-delivery-acceptance.js";
import type { FileDeliveryJudge } from "./file-delivery-judge.js";
import { ensureRootManagedWorkInTransaction, managedReceiptReplyTicketId } from "./managed-work.js";
import {
  reconcileManagedWorkEvents,
  recordManagedChildOutcomeInTransaction,
  settleManagedWorkEventsInTransaction,
} from "./managed-work-events.js";
import { runLeaseFor } from "./run-messages.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";

class WorkDeliveryConflict extends Error {}

export async function deliverTicketWork(
  deps: Pick<
    ExecutorDeps,
    "artifacts" | "prisma" | "events" | "onTicketChange" | "runLease" | "ticketBoardEnabled"
  > &
    Partial<Pick<ExecutorDeps, "jobs">> & { fileDeliveryJudge?: FileDeliveryJudge },
  run: Pick<Run, "id" | "spaceId" | "botId" | "threadId" | "ticketId" | "userId">,
  input: { id: string; result: unknown; ownerAuthored: boolean; secrets: string[] },
) {
  const store = deps.artifacts;
  if (!deps.ticketBoardEnabled || !ticketReceiptsEnabled() || !store) {
    return { error: "Ticket delivery is unavailable." };
  }
  const parsed = TicketWorkResult.safeParse(input.result);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map(({ path, message }) => `${path.join(".")}: ${message}`)
        .join("; "),
    };
  }
  const {
    previousVersion,
    summary,
    findings,
    artifactIds = [],
    finalArtifactId,
    fileDelivery,
  } = parsed.data;
  if (finalArtifactId && !artifactIds.includes(finalArtifactId))
    return { error: "finalArtifactId must be one of artifactIds." };
  const ticket = await deps.prisma.ticket.findFirst({
    where: {
      id: input.id,
      spaceId: run.spaceId,
      createdByUserId: run.userId,
      originKey: { not: null },
    },
    include: {
      originThread: {
        select: { id: true, botId: true, groupId: true, externalConversationId: true },
      },
      board: { select: { ticketPrefix: true } },
    },
  });
  const origin = ticket?.originThread;
  if (
    !ticket ||
    !origin ||
    (!ticket.originMessageId && !(ticket.managedVersion && ticket.originRoutineId)) ||
    !ticket.createdByBotId ||
    origin.externalConversationId
  ) {
    return { error: "Original chat is unavailable." };
  }
  // Self-assignment can change the durable link during this same tool turn.
  const currentRun = await deps.prisma.run.findFirst({
    where: {
      id: run.id,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      threadId: run.threadId,
    },
    select: {
      ticketId: true,
      workControlEpoch: true,
      workRequirementsVersion: true,
      thread: { select: { groupId: true } },
    },
  });
  const assigned = currentRun?.ticketId === ticket.id && run.botId === ticket.assigneeBotId;
  const inOrigin =
    input.ownerAuthored && run.threadId === origin.id && run.botId === ticket.createdByBotId;
  if (
    !currentRun ||
    (!assigned && !inOrigin) ||
    (currentRun.ticketId && currentRun.ticketId !== ticket.id)
  ) {
    return { error: "Only this assignment or its original owner chat can deliver the result." };
  }
  // Receipt replies can reach delivery before their managed identity is initialized.
  if (
    ticket.managedVersion &&
    !ticket.parentTicketId &&
    !ticket.stopRequestedAt &&
    inOrigin &&
    ticket.assigneeBotId === run.botId &&
    currentRun.workControlEpoch === null &&
    currentRun.workRequirementsVersion === null
  ) {
    try {
      const adopted = await deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticket.id} AND "spaceId" = ${run.spaceId} FOR UPDATE`;
        const source = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            userId: run.userId,
            botId: run.botId,
            threadId: run.threadId,
            status: "running",
            OR: [{ ticketId: null }, { ticketId: ticket.id }],
            workControlEpoch: null,
            workRequirementsVersion: null,
          },
          select: { sourceMessage: true },
        });
        if (
          !source ||
          (await managedReceiptReplyTicketId(tx, run, source.sourceMessage)) !== ticket.id
        )
          return null;
        const adopted = await ensureRootManagedWorkInTransaction(tx, run, {
          brief: summary,
          operationKey: `${run.id}:ticket_update:result`,
        });
        if (adopted.receiptVersion !== previousVersion)
          throw new ManagedWorkError("Receipt changed. Read ticket_get before revising it.");
        return adopted;
      }, THREAD_LOCK_TRANSACTION_OPTIONS);
      if (adopted) {
        Object.assign(ticket, adopted);
        currentRun.ticketId = adopted.id;
        currentRun.workControlEpoch = adopted.controlEpoch;
        currentRun.workRequirementsVersion = adopted.requirementsVersion;
      }
    } catch (error) {
      if (error instanceof ManagedWorkError) return { error: error.message };
      throw error;
    }
  }
  if (
    ticket.managedVersion &&
    (ticket.stopRequestedAt ||
      currentRun.workControlEpoch !== ticket.controlEpoch ||
      currentRun.workRequirementsVersion !== ticket.requirementsVersion ||
      !(await managedWorkOriginAvailable(deps.prisma, ticket)))
  )
    return {
      error: "Work was stopped, requirements changed, or its original request is unavailable.",
    };
  const savedRequirements =
    ticket.fileDeliveryRequirements == null
      ? undefined
      : TicketFileDeliveryRequirementsSchema.safeParse(ticket.fileDeliveryRequirements);
  if (savedRequirements && !savedRequirements.success)
    return { error: "Saved file-delivery requirements are unavailable." };
  const requirements = savedRequirements?.success ? savedRequirements.data : undefined;
  if (fileDelivery && !requirements)
    return { error: "File-delivery requirements must be fixed when the ticket is created." };
  const author = ticket.createdByBotId;
  const internal = Boolean(ticket.managedVersion && ticket.parentTicketId);
  const ref = `${ticket.board.ticketPrefix}-${ticket.number}`;
  const clean = (text: string) => redactSecrets(text, input.secrets);
  const result = {
    summary: clean(summary),
    findings: findings.map((finding) => ({
      ...finding,
      conclusion: clean(finding.conclusion),
      evidence: clean(finding.evidence),
    })),
    artifactIds: [...new Set(artifactIds)].sort(),
    ...(finalArtifactId ? { finalArtifactId } : {}),
    ...(fileDelivery ? { fileDelivery } : {}),
  };
  const reportedDone = result.findings.every((finding) => finding.outcome === "pass");
  let status = !requirements && reportedDone ? "done" : "review";
  const version = previousVersion + 1;
  const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  const clientNonce = `work-receipt:${ticket.id}:${version}:${digest}`;
  const context = {
    operationId: clientNonce,
    traceId: clientNonce,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: author,
    runId: run.id,
    signal: new AbortController().signal,
  };
  const previousDelivery = async () => {
    const message = await deps.prisma.message.findFirst({
      where: { threadId: origin.id, role: "bot", botId: author, clientNonce },
      select: { id: true, blocks: true },
    });
    if (!message) return null;
    if (!requirements)
      return {
        ok: true,
        version,
        messageId: message.id,
        status: reportedDone ? "done" : "review",
        managed: Boolean(ticket.managedVersion),
      };
    // Replay the immutable receipt, not today's artifact/effect observations or ticket status.
    const fileIds = (message.blocks as MessageBlock[]).flatMap((block) =>
      block.kind === "file" ? [block.artifactId] : [],
    );
    const artifact = await deps.prisma.artifact.findFirst({
      where: {
        ...(ticket.managedVersion
          ? { OR: [{ clientNonce }, { id: { in: fileIds } }] }
          : { id: { in: fileIds } }),
        spaceId: run.spaceId,
        userId: run.userId,
        botId: author,
        groupId: origin.groupId,
        name: `work-${ticket.id}.json`,
        mimeType: "application/json",
      },
    });
    if (!artifact) return { error: "Original receipt is unavailable." };
    const bytes = await store.get(artifact.storageKey, context);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.hash)
      return { error: "Original receipt hash mismatch." };
    const saved = z
      .object({
        schema: z.literal(1),
        ticketId: z.literal(ticket.id),
        version: z.literal(version),
        acceptance: TicketFileDeliveryAcceptanceSchema,
      })
      .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!saved.success) return { error: "Original receipt acceptance is unavailable." };
    return {
      ok: true,
      version,
      messageId: message.id,
      requirementsVersion: saved.data.acceptance.requirementsVersion,
      status: reportedDone && saved.data.acceptance.status === "verified" ? "done" : "review",
      acceptance: saved.data.acceptance,
      managed: Boolean(ticket.managedVersion),
    };
  };
  const previous = await previousDelivery();
  if (previous) return previous;
  if (requirements && fileDelivery && fileDelivery.requirementsVersion !== requirements.version) {
    return { error: "Requirements changed. Read ticket_get before delivering this work." };
  }
  if (ticket.receiptVersion !== previousVersion) {
    return { error: "Receipt changed. Read ticket_get before revising it." };
  }
  if (ticket.managedVersion && reportedDone) {
    const blockers = await getManagedWorkCompletionBlockers(deps.prisma, {
      spaceId: run.spaceId,
      ticketId: ticket.id,
    });
    if (blockers.ticketIds.length || blockers.executionIds.length)
      return {
        error:
          "Delegated work or external execution remains unresolved. Deliver partial findings as issue or unknown.",
      };
  }
  // An assignment can explicitly share its own user's private files. Other groups and bots
  // remain outside that authority; files already in the destination retain their identity.
  const sources = result.artifactIds.length
    ? await deps.prisma.artifact.findMany({
        where: {
          id: { in: result.artifactIds },
          spaceId: run.spaceId,
          OR: [
            { groupId: origin.groupId, ...(!origin.groupId ? { botId: author } : {}) },
            ...(currentRun.thread.groupId === null
              ? [{ groupId: null, botId: run.botId, userId: run.userId }]
              : []),
          ],
          ...LISTED_ARTIFACT,
        },
      })
    : [];
  if (sources.length !== result.artifactIds.length) {
    return { error: "An evidence file is unavailable to this assignment or the original chat." };
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const copies: Artifact[] = [];
  const files: Array<{ source: Artifact; visible: Artifact }> = [];
  const observedArtifacts: FileDeliveryAcceptanceInput["artifacts"][number][] = [];
  let acceptance: TicketFileDeliveryAcceptance | undefined;
  let finalText: string | undefined;
  let committed: { id: string; seq: number } | undefined;
  try {
    for (const id of result.artifactIds) {
      const source = sourceById.get(id)!;
      const alreadyVisible =
        source.groupId === origin.groupId && (origin.groupId || source.botId === author);
      let sourceBytes: Uint8Array | undefined;
      if (requirements || !alreadyVisible || source.id === finalArtifactId) {
        try {
          sourceBytes = await store.get(source.storageKey, {
            ...context,
            botId: source.botId ?? run.botId,
          });
        } catch (error) {
          // A missing read is unknown evidence. A file still needing a copy cannot be delivered.
          if (!alreadyVisible || source.id === finalArtifactId) throw error;
        }
      }
      if (source.id === finalArtifactId) {
        if (createHash("sha256").update(sourceBytes!).digest("hex") !== source.hash)
          throw new WorkDeliveryConflict("The finished artifact hash no longer matches.");
        if (source.mimeType === "text/markdown" || source.mimeType === "text/plain") {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
          if (clean(text) !== text)
            throw new WorkDeliveryConflict(
              "Remove secrets from the finished artifact before delivery.",
            );
          if (text.length <= THREAD_MESSAGE_TEXT_MAX_LENGTH) finalText = text;
        }
      }
      if (requirements)
        observedArtifacts.push({
          id: source.id,
          name: source.name,
          mimeType: source.mimeType,
          version: source.version,
          hash: source.hash,
          bytes: sourceBytes,
          observedAt: new Date().toISOString(),
        });
      if (alreadyVisible) {
        files.push({ source, visible: source });
        continue;
      }
      const bytes = sourceBytes!;
      const priorFinal =
        ticket.managedVersion && source.id === finalArtifactId && source.rootArtifactId
          ? await deps.prisma.artifact.findFirst({
              where: {
                spaceId: run.spaceId,
                botId: author,
                groupId: origin.groupId,
                userId: run.userId,
                clientNonce: { startsWith: `work-receipt:${ticket.id}:` },
                OR: [
                  { clientNonce: { contains: `:family:${source.rootArtifactId}:` } },
                  { clientNonce: { endsWith: `:artifact:${source.rootArtifactId}` } },
                ],
              },
              select: { id: true, rootArtifactId: true },
            })
          : null;
      const finalRoot = priorFinal && (priorFinal.rootArtifactId ?? priorFinal.id);
      const priorVersion = finalRoot
        ? await deps.prisma.artifact.findFirst({
            where: { OR: [{ id: finalRoot }, { rootArtifactId: finalRoot }] },
            orderBy: { version: "desc" },
            select: { version: true },
          })
        : null;
      const stored = await store.put(
        { name: source.name, mimeType: source.mimeType, bytes },
        context,
      );
      const copy: Artifact = {
        ...source,
        id: randomUUID(),
        botId: author,
        groupId: origin.groupId,
        userId: run.userId,
        runId: run.id,
        storageKey: stored.id,
        size: bytes.byteLength,
        hash: createHash("sha256").update(bytes).digest("hex"),
        version: priorVersion ? priorVersion.version + 1 : 1,
        rootArtifactId: finalRoot ?? null,
        standalone: true,
        clientNonce:
          ticket.managedVersion && source.id === finalArtifactId
            ? `${clientNonce}:family:${source.rootArtifactId ?? source.id}:artifact:${source.id}`
            : `${clientNonce}:artifact:${source.id}`,
        createdAt: new Date(),
      };
      copies.push(copy);
      files.push({ source, visible: copy });
    }
    if (requirements) {
      const effectIds =
        fileDelivery?.evidenceRefs.flatMap((ref) =>
          ref.kind === "effect" ? [ref.effectId] : [],
        ) ?? [];
      const effects = effectIds.length
        ? await deps.prisma.externalEffect.findMany({
            where: { id: { in: effectIds }, spaceId: run.spaceId, runId: run.id },
            select: { id: true, kind: true, status: true, result: true, updatedAt: true },
          })
        : [];
      acceptance = await evaluateFileDeliveryAcceptanceWithJudge(
        {
          requirements,
          fileDelivery,
          deliveredArtifactIds: result.artifactIds,
          artifacts: observedArtifacts,
          effects: effects.map((effect) => ({
            ...effect,
            observedAt: effect.updatedAt.toISOString(),
          })),
        },
        { judge: deps.fileDeliveryJudge, context },
      );
      status = reportedDone && acceptance.status === "verified" ? "done" : "review";
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        {
          schema: 1,
          ticketId: ticket.id,
          ref,
          goal: clean(ticket.title),
          version,
          runId: run.id,
          observedAt: new Date().toISOString(),
          ...result,
          ...(requirements ? { requirements, acceptance } : {}),
          artifactIds: files.map(({ visible }) => visible.id),
          ...(finalArtifactId
            ? {
                finalArtifactId: files.find(({ source }) => source.id === finalArtifactId)!.visible
                  .id,
              }
            : {}),
          artifacts: files.map(({ source, visible }) => ({
            id: visible.id,
            name: visible.name,
            version: visible.version,
            hash: visible.hash,
            ...(source.id !== visible.id
              ? {
                  sourceArtifactId: source.id,
                  sourceVersion: source.version,
                  sourceHash: source.hash,
                }
              : {}),
          })),
        },
        null,
        2,
      ),
    );
    await attachWorkspaceFileToThread(
      { prisma: deps.prisma, artifacts: store },
      {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: author,
        groupId: origin.groupId ?? undefined,
        runId: run.id,
        operationId: clientNonce,
        filePath: `work-${ticket.id}.json`,
        bytes,
        onAttached: async (tx, artifact) => {
          if (origin.groupId) {
            await lockSpaceGroup(tx, run, origin.groupId);
            const group = await tx.chatGroup.findFirst({
              where: {
                id: origin.groupId,
                spaceId: run.spaceId,
                archivedAt: null,
                members: { some: { botId: author, bot: { userId: run.userId, archivedAt: null } } },
              },
              select: { id: true },
            });
            if (!group) throw new WorkDeliveryConflict("Original group is unavailable.");
            await touchGroupUpdatedAt(tx, group.id);
          }
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${origin.id} FOR UPDATE`;
          const source = ticket.originMessageId
            ? await tx.message.findFirst({
                where: {
                  id: ticket.originMessageId!,
                  threadId: origin.id,
                  role: "user",
                  authorUserId: run.userId,
                  thread: {
                    spaceId: run.spaceId,
                    ...(!origin.groupId
                      ? { bot: { id: author, userId: run.userId, archivedAt: null } }
                      : { groupId: origin.groupId }),
                  },
                },
                select: { id: true },
              })
            : null;
          if (ticket.managedVersion) {
            if (!(await managedWorkOriginAvailable(tx, ticket)))
              throw new WorkDeliveryConflict("Original request is unavailable.");
          } else if (!source) throw new WorkDeliveryConflict("Original request is unavailable.");
          // Requirements edits and work-state saves lock the ticket before touching its run.
          await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticket.id} AND "spaceId" = ${run.spaceId} FOR UPDATE`;
          if (ticket.managedVersion && status === "done") {
            const blockers = await getManagedWorkCompletionBlockers(tx, {
              spaceId: run.spaceId,
              ticketId: ticket.id,
            });
            if (blockers.ticketIds.length || blockers.executionIds.length)
              throw new WorkDeliveryConflict(
                "Delegated work or external execution remains unresolved.",
              );
          }
          const linked = await tx.run.updateMany({
            where: {
              id: run.id,
              spaceId: run.spaceId,
              botId: run.botId,
              userId: run.userId,
              ...(assigned
                ? { ticketId: ticket.id }
                : { OR: [{ ticketId: null }, { ticketId: ticket.id }] }),
              ...(ticket.managedVersion
                ? {
                    workControlEpoch: ticket.controlEpoch,
                    workRequirementsVersion: ticket.requirementsVersion,
                  }
                : {}),
            },
            data: { ticketId: ticket.id },
          });
          if (linked.count !== 1)
            throw new WorkDeliveryConflict(
              "Execution changed. Read ticket_get before revising it.",
            );
          const changed = await tx.ticket.updateMany({
            where: {
              id: ticket.id,
              spaceId: run.spaceId,
              receiptVersion: previousVersion,
              originThreadId: origin.id,
              originMessageId: ticket.originMessageId,
              ...(ticket.managedVersion
                ? {
                    stopRequestedAt: null,
                    controlEpoch: ticket.controlEpoch,
                    requirementsVersion: ticket.requirementsVersion,
                  }
                : {}),
              ...(requirements
                ? {
                    fileDeliveryRequirements: {
                      path: ["version"],
                      equals: requirements.version,
                    },
                  }
                : {}),
              ...(assigned ? { assigneeBotId: run.botId } : {}),
            },
            data: {
              receiptVersion: version,
              status,
              completedAt: status === "done" ? new Date() : null,
              ...(ticket.managedVersion
                ? {
                    acceptedRequirementsVersion:
                      status === "done" ? ticket.requirementsVersion : null,
                    acceptedReceiptVersion: status === "done" ? version : null,
                  }
                : {}),
            },
          });
          if (changed.count !== 1)
            throw new WorkDeliveryConflict(
              "Receipt, requirements, or assignee changed. Read ticket_get before revising it.",
            );
          for (const copy of copies) await tx.artifact.create({ data: copy });
          if (ticket.managedVersion)
            await tx.artifact.update({
              where: { id: artifact.id },
              data: { clientNonce },
            });
          const blocks: MessageBlock[] = [
            ...(internal ? [{ kind: "delivery" as const }] : []),
            {
              kind: "text",
              text:
                ticket.managedVersion && !internal
                  ? (finalText ?? result.summary)
                  : `${ref} · ${result.summary}`,
            },
            ...(!ticket.managedVersion || internal ? [messageBlockForArtifact(artifact)] : []),
            ...files.map(({ visible }) => messageBlockForArtifact(visible)),
          ];
          const lease = runLeaseFor(deps, run.id);
          const message = await createThreadMessageInTransaction(tx, {
            threadId: origin.id,
            role: "bot",
            botId: author,
            runId: run.id,
            lease,
            replyToMessageId: source?.id,
            blocks,
            clientNonce,
            ...(internal ? { markUnread: false } : {}),
          });
          const event = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: origin.id,
            botId: author,
            runId: run.id,
            lease,
            type: "thread.message.created",
            payload: {
              messageId: message.id,
              role: "bot",
              blocks,
              ...(source ? { replyToMessageId: source.id } : {}),
              clientNonce,
            },
          });
          if (ticket.managedVersion && ticket.parentTicketId)
            await recordManagedChildOutcomeInTransaction(tx, {
              spaceId: run.spaceId,
              runId: run.id,
              ticketId: ticket.id,
              payload: {
                receiptMessageId: message.id,
                receiptArtifactId: artifact.id,
                summary: result.summary,
                status,
                receiptVersion: version,
                artifactIds: files.map(({ visible }) => visible.id),
                ...(finalArtifactId
                  ? {
                      finalArtifactId: files.find(({ source }) => source.id === finalArtifactId)!
                        .visible.id,
                    }
                  : {}),
              },
            });
          if (ticket.managedVersion) {
            await recordManagedDependencyChangeInTransaction(tx, {
              spaceId: run.spaceId,
              ticketId: ticket.id,
              sourceRunId: run.id,
            });
            await settleManagedWorkEventsInTransaction(tx, {
              spaceId: run.spaceId,
              runId: run.id,
            });
          }
          committed = { id: message.id, seq: event.seq };
        },
      },
    );
  } catch (error) {
    await Promise.allSettled(copies.map((copy) => store.remove(copy.storageKey, context)));
    if (!(error instanceof WorkDeliveryConflict) && !(error instanceof IsolationError)) throw error;
    const duplicate = await previousDelivery();
    return (
      duplicate ?? {
        error:
          error instanceof WorkDeliveryConflict ? error.message : "Original chat is unavailable.",
      }
    );
  }
  if (!committed) throw new Error("Missing committed ticket receipt");
  await deps.events
    .notify(origin.id, committed.seq)
    .catch((error) => getLogger().warn("ticket receipt notification", error));
  await deps.onTicketChange?.({
    spaceId: run.spaceId,
    boardId: ticket.boardId,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    wakeAssignee: false,
  });
  if (ticket.managedVersion && deps.jobs)
    await reconcileManagedWorkEvents(
      { prisma: deps.prisma, jobs: deps.jobs, events: deps.events },
      { spaceId: run.spaceId },
    );
  return {
    ok: true,
    version,
    messageId: committed.id,
    status,
    managed: Boolean(ticket.managedVersion),
    ...(acceptance ? { requirementsVersion: acceptance.requirementsVersion, acceptance } : {}),
  };
}
