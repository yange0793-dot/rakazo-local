import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { TicketSourceEvent, TicketSubscriptionRoute } from "@rakazo/contracts";
import { TicketSourceEventSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { resolveTicketSubscription } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { prepareTicketRun } from "./ticket-wake.js";

export type RouteTicketSourceEventInput = {
  spaceId: string;
  userId: string;
  botId: string;
  event: TicketSourceEvent;
  ticketBoardEnabled?: boolean;
};

/** Routes and persists inside a caller's existing message transaction. */
export async function routeTicketSourceEventInTransaction(
  tx: Prisma.TransactionClient,
  input: RouteTicketSourceEventInput,
): Promise<TicketSubscriptionRoute> {
  if (!input.ticketBoardEnabled) return { status: "unknown" };
  const event = TicketSourceEventSchema.parse(input.event);
  const resolution = await resolveTicketSubscription(tx, {
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    source: event.source,
  });
  if (resolution.status !== "matched") return resolution;

  const message = await tx.message.findFirst({
    where: {
      id: event.messageId,
      threadId: resolution.sourceThreadId,
      seq: event.position,
      role: "user",
    },
    select: {
      id: true,
      externalTranscriptFor: {
        select: { externalConversationId: true, providerEventId: true },
      },
    },
  });
  if (!message) return { status: "unknown" };
  if (
    (event.source.type === "thread" && event.eventId !== message.id) ||
    (event.source.type === "externalConversation" &&
      (message.externalTranscriptFor?.externalConversationId !==
        event.source.externalConversationId ||
        message.externalTranscriptFor.providerEventId !== event.eventId))
  ) {
    return { status: "unknown" };
  }

  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM ticket_subscriptions
    WHERE id = ${resolution.subscriptionId}
      AND "spaceId" = ${input.spaceId}
      AND active = true
    FOR UPDATE`;
  if (!locked) return { status: "unknown" };

  const previous = await tx.ticketSubscriptionEvent.findUnique({
    where: {
      subscriptionId_eventId: {
        subscriptionId: resolution.subscriptionId,
        eventId: event.eventId,
      },
    },
    select: { runId: true },
  });
  if (previous) {
    return {
      status: "routed",
      ticketId: resolution.ticketId,
      ...(previous.runId ? { runId: previous.runId } : {}),
      duplicate: true,
    };
  }

  const run = await prepareTicketRun(tx, {
    spaceId: input.spaceId,
    ticketId: resolution.ticketId,
    botId: resolution.botId,
  });
  if (!run) return { status: "unknown" };

  await tx.ticketSubscriptionEvent.create({
    data: {
      subscriptionId: resolution.subscriptionId,
      eventId: event.eventId,
      messageId: event.messageId,
      position: event.position,
      runId: run.id,
    },
  });
  await tx.steeringMessage.upsert({
    where: {
      messageId_botId: { messageId: event.messageId, botId: resolution.botId },
    },
    create: {
      messageId: event.messageId,
      botId: resolution.botId,
      userId: input.userId,
      runId: run.id,
      originTrigger:
        event.source.type === "externalConversation"
          ? "ticket_subscription_external"
          : "ticket_subscription",
    },
    update: {},
  });

  const advanced = await tx.$executeRaw`
    UPDATE ticket_subscriptions
    SET "lastProcessedPosition" = GREATEST("lastProcessedPosition", ${event.position}),
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${resolution.subscriptionId}
      AND "spaceId" = ${input.spaceId}
      AND active = true`;
  if (advanced !== 1) throw new Error("Ticket subscription changed during event routing");

  return {
    status: "routed",
    ticketId: resolution.ticketId,
    runId: run.id,
    duplicate: false,
  };
}

/** Owns a transaction for callers that do not already persist the source event. */
export async function routeTicketSourceEvent(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue">; ticketBoardEnabled?: boolean },
  input: Omit<RouteTicketSourceEventInput, "ticketBoardEnabled">,
): Promise<TicketSubscriptionRoute> {
  if (!deps.ticketBoardEnabled) return { status: "unknown" };
  const route = await deps.prisma.$transaction((tx) =>
    routeTicketSourceEventInTransaction(tx, {
      ...input,
      ticketBoardEnabled: deps.ticketBoardEnabled,
    }),
  );

  if (route.status === "routed" && route.runId) {
    const run = await deps.prisma.run.findFirst({
      where: {
        id: route.runId,
        ticketId: route.ticketId,
        spaceId: input.spaceId,
        userId: input.userId,
      },
      select: { status: true },
    });
    if (run?.status === "queued")
      await deps.jobs.enqueue(runContinueJob(route.runId)).catch((error) => {
        getLogger().warn("ticket source wake deferred to reconciliation", error);
      });
  }
  return route;
}
