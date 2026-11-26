import type { AdapterContext } from "./types.js";

export interface ExternalExecutionCapabilities {
  operationLookup: boolean;
  events: boolean;
  steer: boolean;
  cancelConfirmation: boolean;
  inputResponse: boolean;
}

export interface ExternalExecutionSnapshot {
  found: boolean;
  sessionId?: string;
  turnId?: string;
  status?: string;
  operationStatus?: string;
  queueOwner?: string;
  cursor?: string;
  result?: string;
  error?: string;
  /** The provider's receipt, already redacted by the connection boundary. */
  receipt: Record<string, unknown>;
}

export interface ExternalExecutionEvent {
  id: string;
  type: string;
  operationKey?: string;
  operationKeys?: string[];
  turnId?: string;
  at?: string;
  status?: string;
  text?: string;
  data: Record<string, unknown>;
}

export interface ExternalExecutionEventPage extends ExternalExecutionSnapshot {
  events: ExternalExecutionEvent[];
  nextCursor: string;
  hasMore: boolean;
}

export interface ExternalExecutionProvider {
  describe(context: AdapterContext): Promise<ExternalExecutionCapabilities>;
  start(
    input: { operationKey: string; payload: Record<string, unknown> },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot>;
  send(
    input: { operationKey: string; sessionId: string; payload: Record<string, unknown> },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot>;
  inspect(
    input: { sessionId?: string; operationKey?: string },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot>;
  readEvents(
    input: { sessionId: string; cursor: string; waitMs?: number },
    context: AdapterContext,
  ): Promise<ExternalExecutionEventPage>;
  cancel(
    input: {
      sessionId: string;
      operationKey: string;
      expectedTurnId?: string;
      targetOperationKey?: string;
    },
    context: AdapterContext,
  ): Promise<ExternalExecutionSnapshot>;
}
