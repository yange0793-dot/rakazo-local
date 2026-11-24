import { describe, expect, it } from "vitest";
import {
  TicketSourceEventSchema,
  TicketSubscriptionRouteSchema,
  TicketSubscriptionSourceSchema,
} from "./ticket-subscriptions.js";

describe("Ticket subscription contracts", () => {
  it("identifies each provider-neutral source kind", () => {
    expect(TicketSubscriptionSourceSchema.parse({ type: "thread", threadId: "thread-1" })).toEqual({
      type: "thread",
      threadId: "thread-1",
    });
    expect(
      TicketSubscriptionSourceSchema.parse({
        type: "externalConversation",
        externalConversationId: "conversation-1",
      }),
    ).toEqual({ type: "externalConversation", externalConversationId: "conversation-1" });
  });

  it("requires a stable event id and nonnegative source position", () => {
    const event = {
      source: { type: "thread", threadId: "thread-1" },
      eventId: "message-1",
      messageId: "message-1",
      position: 4,
    };
    expect(TicketSourceEventSchema.parse(event)).toEqual(event);
    expect(TicketSourceEventSchema.safeParse({ ...event, position: -1 }).success).toBe(false);
    expect(TicketSourceEventSchema.safeParse({ ...event, eventId: "" }).success).toBe(false);
    expect(
      TicketSourceEventSchema.safeParse({
        ...event,
        source: { type: "thread", externalConversationId: "wrong-shape" },
      }).success,
    ).toBe(false);
  });

  it("represents ambiguity and unknown without selecting a ticket", () => {
    expect(TicketSubscriptionRouteSchema.parse({ status: "unknown" })).toEqual({
      status: "unknown",
    });
    expect(TicketSubscriptionRouteSchema.parse({ status: "ambiguous" })).toEqual({
      status: "ambiguous",
    });
    expect(
      TicketSubscriptionRouteSchema.parse({
        status: "routed",
        ticketId: "ticket-1",
        runId: "run-1",
        duplicate: false,
      }),
    ).toMatchObject({ status: "routed", duplicate: false });
    expect(
      TicketSubscriptionRouteSchema.safeParse({
        status: "routed",
        ticketId: "ticket-1",
      }).success,
    ).toBe(false);
    expect(
      TicketSubscriptionRouteSchema.parse({
        status: "routed",
        ticketId: "ticket-1",
        duplicate: true,
      }),
    ).toMatchObject({ status: "routed", duplicate: true });
  });
});
