import { createHash, randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { TicketWorkResult } from "@rakazo/contracts";
import { messageBlockForArtifact, redactSecrets } from "@rakazo/core";
import type { Artifact, Run } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  LISTED_ARTIFACT,
  lockSpaceGroup,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";

class WorkDeliveryConflict extends Error {}

export async function deliverTicketWork(
  deps: Pick<
    ExecutorDeps,
    "artifacts" | "prisma" | "events" | "onTicketChange" | "runLease" | "ticketBoardEnabled"
  >,
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
  const { previousVersion, summary, findings, artifactIds = [] } = parsed.data;
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
    !ticket.originMessageId ||
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
    select: { ticketId: true, thread: { select: { groupId: true } } },
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
  const author = ticket.createdByBotId;
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
  };
  const status = result.findings.every((finding) => finding.outcome === "pass") ? "done" : "review";
  const version = previousVersion + 1;
  const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  const clientNonce = `work-receipt:${ticket.id}:${version}:${digest}`;
  const previousDelivery = () =>
    deps.prisma.message.findFirst({
      where: { threadId: origin.id, role: "bot", botId: author, clientNonce },
      select: { id: true },
    });
  const previous = await previousDelivery();
  if (previous) return { ok: true, version, messageId: previous.id, status };
  if (ticket.receiptVersion !== previousVersion) {
    return { error: "Receipt changed. Read ticket_get before revising it." };
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
  const context = {
    operationId: clientNonce,
    traceId: clientNonce,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: author,
    runId: run.id,
    signal: new AbortController().signal,
  };
  const copies: Artifact[] = [];
  const files: Array<{ source: Artifact; visible: Artifact }> = [];
  let committed: { id: string; seq: number } | undefined;
  try {
    for (const id of result.artifactIds) {
      const source = sourceById.get(id)!;
      if (source.groupId === origin.groupId && (origin.groupId || source.botId === author)) {
        files.push({ source, visible: source });
        continue;
      }
      const bytes = await store.get(source.storageKey, { ...context, botId: run.botId });
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
        version: 1,
        rootArtifactId: null,
        standalone: true,
        clientNonce: `${clientNonce}:artifact:${source.id}`,
        createdAt: new Date(),
      };
      copies.push(copy);
      files.push({ source, visible: copy });
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
          artifactIds: files.map(({ visible }) => visible.id),
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
          const source = await tx.message.findFirst({
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
          });
          if (!source) throw new WorkDeliveryConflict("Original request is unavailable.");
          const linked = await tx.run.updateMany({
            where: {
              id: run.id,
              spaceId: run.spaceId,
              botId: run.botId,
              userId: run.userId,
              ...(assigned
                ? { ticketId: ticket.id }
                : { OR: [{ ticketId: null }, { ticketId: ticket.id }] }),
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
              originMessageId: source.id,
              ...(assigned ? { assigneeBotId: run.botId } : {}),
            },
            data: {
              receiptVersion: version,
              status,
              completedAt: status === "done" ? new Date() : null,
            },
          });
          if (changed.count !== 1)
            throw new WorkDeliveryConflict(
              "Receipt or assignee changed. Read ticket_get before revising it.",
            );
          for (const copy of copies) await tx.artifact.create({ data: copy });
          const blocks: MessageBlock[] = [
            { kind: "text", text: `${ref} · ${result.summary}` },
            messageBlockForArtifact(artifact),
            ...files.map(({ visible }) => messageBlockForArtifact(visible)),
          ];
          const lease = runLeaseFor(deps, run.id);
          const message = await createThreadMessageInTransaction(tx, {
            threadId: origin.id,
            role: "bot",
            botId: author,
            runId: run.id,
            lease,
            replyToMessageId: source.id,
            blocks,
            clientNonce,
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
              replyToMessageId: source.id,
              clientNonce,
            },
          });
          committed = { id: message.id, seq: event.seq };
        },
      },
    );
  } catch (error) {
    await Promise.allSettled(copies.map((copy) => store.remove(copy.storageKey, context)));
    if (!(error instanceof WorkDeliveryConflict) && !(error instanceof IsolationError)) throw error;
    const duplicate = await previousDelivery();
    return duplicate
      ? { ok: true, version, messageId: duplicate.id, status }
      : {
          error:
            error instanceof WorkDeliveryConflict ? error.message : "Original chat is unavailable.",
        };
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
  return { ok: true, version, messageId: committed.id, status };
}
