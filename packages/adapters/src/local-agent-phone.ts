import type {
  AdapterContext,
  ConnectorProvider,
  ConnectorRoute,
  ExternalExecutionCapabilities,
  ExternalExecutionEventPage,
  ExternalExecutionProvider,
  ExternalExecutionSnapshot,
} from "@rakazo/adapter-kit";
import * as z from "zod";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./approval-effect.js";
import { CATALOG_APPROVAL_TOOL } from "./run-effects.js";

const ObjectValue = z.record(z.string(), z.unknown());
const Envelope = z.object({
  isError: z.boolean().optional(),
  structuredContent: ObjectValue.optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});
const Capabilities = z.object({
  operationLookup: z.boolean(),
  events: z.boolean(),
  steer: z.boolean(),
  cancelConfirmation: z.boolean(),
  inputResponse: z.boolean().default(false),
});
const Session = z
  .object({
    id: z.string(),
    turnId: z.string().optional(),
    status: z.string(),
    cursor: z.number().int().nonnegative().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();
const Operation = z
  .object({
    state: z.string(),
    queueOwner: z.string().nullish(),
    turnId: z.string().nullish(),
  })
  .passthrough();
const Event = z
  .object({
    seq: z.number().int().nonnegative(),
    type: z.string(),
    requestId: z.union([z.string(), z.number()]).optional(),
    operationId: z.string().optional(),
    operationKey: z.string().optional(),
    operationKeys: z.array(z.string()).optional(),
    turnId: z.string().optional(),
    at: z.string().optional(),
    status: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

export function isLocalAgentPhoneRoute(route: ConnectorRoute | undefined): boolean {
  return Boolean(
    route?.connectorId === "mcp" &&
      route.resourceId &&
      ["phone_start", "phone_send", "phone_stop"].includes(route.toolName),
  );
}

function payloadOf(value: unknown): Record<string, unknown> {
  const envelope = Envelope.parse(value);
  if (envelope.isError) {
    throw new Error(
      envelope.content?.map((item) => item.text ?? "").join("\n") || "Agent call failed.",
    );
  }
  if (envelope.structuredContent) return envelope.structuredContent;
  const text = envelope.content?.find((item) => item.type === "text")?.text;
  if (text) return ObjectValue.parse(JSON.parse(text));
  return ObjectValue.parse(value);
}

/** Match evidence actually returned by a scoped read, not a monitor's newer snapshot. */
export function localAgentPhoneObservedOutcome(
  effect: { request: unknown; result: unknown },
  evidence: Record<string, unknown>,
): boolean {
  const bound =
    boundDirectApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL) ??
    catalogApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL);
  const route = bound?.route;
  if (
    route?.connectorId !== "mcp" ||
    route.resourceId !== evidence.connectionId ||
    !["phone_read", "phone_inspect"].includes(route.toolName) ||
    typeof evidence.sessionId !== "string" ||
    typeof evidence.turnId !== "string" ||
    typeof evidence.operationKey !== "string" ||
    !["completed", "failed", "cancelled", "stopped"].includes(String(evidence.status))
  )
    return false;
  let receipt: Record<string, unknown>;
  try {
    receipt = payloadOf(effect.result);
  } catch {
    return false;
  }
  if (receipt.error || receipt.found === false) return false;
  const session = Session.safeParse(receipt.session);
  if (!session.success || session.data.id !== evidence.sessionId) return false;
  const sameOutput = (result: unknown, error: unknown) =>
    (evidence.result === undefined ||
      (typeof result === "string" && result.slice(0, 12_000) === evidence.result)) &&
    (evidence.error === undefined || error === evidence.error);
  const operationMatches = (value: unknown) => {
    const operation = ObjectValue.safeParse(value);
    return (
      operation.success &&
      operation.data.operationKey === evidence.operationKey &&
      operation.data.turnId === evidence.turnId &&
      operation.data.state === evidence.status
    );
  };
  const operations = [
    receipt.operation,
    ...(Array.isArray(receipt.operations) ? receipt.operations : []),
    ...(Array.isArray(session.data.operations) ? session.data.operations : []),
  ];
  if (
    session.data.turnId === evidence.turnId &&
    operations.some(operationMatches) &&
    sameOutput(session.data.result, session.data.error)
  )
    return true;
  // A paginated read can carry an older turn's exact result even after the
  // session has moved on; the current session result alone cannot cover it.
  const events = z.array(Event).safeParse(receipt.events);
  return Boolean(
    events.success &&
      events.data.some(
        (event) =>
          event.turnId === evidence.turnId &&
          (event.operationKey === evidence.operationKey ||
            event.operationKeys?.includes(evidence.operationKey as string)) &&
          ((event.type === "result" && evidence.status === "completed") ||
            (event.type === "error" && evidence.status === "failed")) &&
          sameOutput(event.text, event.error),
      ),
  );
}

function snapshotOf(receipt: Record<string, unknown>): ExternalExecutionSnapshot {
  if (receipt.error) throw new Error(String(receipt.error));
  const session = receipt.session ? Session.parse(receipt.session) : undefined;
  const operation = receipt.operation ? Operation.parse(receipt.operation) : undefined;
  return {
    found: receipt.found !== false && Boolean(session),
    sessionId: session?.id,
    turnId: operation ? (operation.turnId ?? undefined) : session?.turnId,
    status: session?.status,
    operationStatus: operation?.state,
    queueOwner: operation?.queueOwner ?? undefined,
    cursor: session?.cursor === undefined ? undefined : String(session.cursor),
    // Session text can belong to a different operation; only associated events supply results.
    error: typeof operation?.error === "string" ? operation.error : undefined,
    receipt,
  };
}

/** Keeps native protocol details inside the connection adapter. */
export class LocalAgentPhoneProvider implements ExternalExecutionProvider {
  constructor(
    private readonly connector: ConnectorProvider,
    private readonly route: ConnectorRoute,
  ) {}

  private async call(
    toolName: string,
    args: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    let result: Record<string, unknown> | undefined;
    for await (const event of this.connector.execute(
      {
        tool: toolName,
        route: { ...this.route, toolName, appResourceUri: undefined },
        args,
        executionId: context.operationId,
      },
      context,
    )) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "result") result = payloadOf(event.data);
    }
    if (!result) throw new Error("Agent connection returned no receipt.");
    return result;
  }

  async describe(context: AdapterContext): Promise<ExternalExecutionCapabilities> {
    const result = await this.call("phone_inspect", {}, context);
    if (result.protocolVersion !== 1) {
      throw new Error("Agent connection does not support managed execution receipts.");
    }
    return Capabilities.parse(result.capabilities);
  }

  async start(
    input: { operationKey: string; payload: Record<string, unknown> },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot> {
    return snapshotOf(
      await this.call(
        "phone_start",
        {
          ...input.payload,
          requestId: input.operationKey,
          operationKey: input.operationKey,
        },
        context,
      ),
    );
  }

  async send(
    input: { operationKey: string; sessionId: string; payload: Record<string, unknown> },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot> {
    return snapshotOf(
      await this.call(
        "phone_send",
        {
          ...input.payload,
          sessionId: input.sessionId,
          requestId: input.operationKey,
          operationKey: input.operationKey,
        },
        context,
      ),
    );
  }

  async inspect(
    input: { sessionId?: string; operationKey?: string },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot> {
    return snapshotOf(
      await this.call(
        "phone_inspect",
        {
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.operationKey ? { requestId: input.operationKey } : {}),
        },
        context,
      ),
    );
  }

  async readEvents(
    input: { sessionId: string; cursor: string; waitMs?: number },
    context: AdapterContext,
  ): Promise<ExternalExecutionEventPage> {
    const after = Number(input.cursor);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid agent event cursor.");
    const receipt = await this.call(
      "phone_read",
      {
        sessionId: input.sessionId,
        after,
        waitMs: input.waitMs ?? 20_000,
        limit: 100,
      },
      context,
    );
    const events = z.array(Event).parse(receipt.events);
    const cursor = z.number().int().nonnegative().parse(receipt.cursor);
    return {
      ...snapshotOf(receipt),
      events: events.map((event) => ({
        id: String(event.seq),
        type: event.type,
        operationKey: event.operationKey ?? event.operationId,
        operationKeys: event.operationKeys,
        turnId: event.turnId,
        at: event.at,
        status: event.status,
        text: event.text,
        data: event,
      })),
      nextCursor: String(cursor),
      hasMore: receipt.hasMore === true,
    };
  }

  async cancel(
    input: {
      sessionId: string;
      operationKey: string;
      expectedTurnId?: string;
      targetOperationKey?: string;
    },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot> {
    return snapshotOf(
      await this.call(
        "phone_stop",
        {
          sessionId: input.sessionId,
          requestId: input.operationKey,
          ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {}),
          ...(input.targetOperationKey ? { targetRequestId: input.targetOperationKey } : {}),
        },
        context,
      ),
    );
  }
}
