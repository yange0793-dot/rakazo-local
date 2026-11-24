import * as z from "zod";
import { Id } from "./ids.js";

export const TicketSubscriptionSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("thread"), threadId: Id }),
  z.strictObject({ type: z.literal("externalConversation"), externalConversationId: Id }),
]);
export type TicketSubscriptionSource = z.infer<typeof TicketSubscriptionSourceSchema>;

export const TicketSourceEventSchema = z.strictObject({
  source: TicketSubscriptionSourceSchema,
  eventId: Id,
  messageId: Id,
  position: z.number().int().nonnegative(),
});
export type TicketSourceEvent = z.infer<typeof TicketSourceEventSchema>;

export const TicketSubscriptionRouteSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      status: z.literal("routed"),
      ticketId: Id,
      runId: Id.optional(),
      duplicate: z.boolean(),
    })
    .refine((route) => route.duplicate || route.runId !== undefined, {
      message: "A newly routed event requires its durable run id.",
    }),
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({ status: z.literal("ambiguous") }),
]);
export type TicketSubscriptionRoute = z.infer<typeof TicketSubscriptionRouteSchema>;
