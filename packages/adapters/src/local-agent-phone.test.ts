import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  isLocalAgentPhoneRoute,
  LocalAgentPhoneProvider,
  localAgentPhoneObservedOutcome,
} from "./local-agent-phone.js";

const context = {
  operationId: "effect-one",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const route = { connectorId: "mcp", resourceId: "server", toolName: "phone_start" };
const session = { id: "session", status: "running", turnId: "turn", cursor: 4 };

describe("local execution outcome observation", () => {
  const evidence = {
    connectionId: "server",
    sessionId: "session",
    operationKey: "operation",
    turnId: "turn",
    status: "completed",
    result: "Output ready.",
  };
  const readEffect = (toolName = "phone_read") => ({
    request: [
      "__rakazoCatalogTool",
      "connectors_execute_tool",
      { id: `server:${toolName}`, arguments: { sessionId: "session" } },
      { ...route, toolName },
    ],
    result: {
      structuredContent: {
        session: {
          ...session,
          status: "idle",
          result: "Output ready.",
          operations: [{ operationKey: "operation", state: "completed", turnId: "turn" }],
        },
        events: [],
        cursor: 3,
        hasMore: true,
      },
    },
  });
  it.each(["phone_read", "phone_inspect"])(
    "accepts the exact completed snapshot returned by %s",
    (toolName) => {
      expect(localAgentPhoneObservedOutcome(readEffect(toolName), evidence)).toBe(true);
    },
  );
  it.each([
    { sessionId: "another-session" },
    { turnId: "another-turn" },
    { operationKey: "another-operation" },
    { connectionId: "another-server" },
    { result: "New evidence not read yet." },
  ])("does not cover a different outcome %j", (change) => {
    expect(localAgentPhoneObservedOutcome(readEffect(), { ...evidence, ...change })).toBe(false);
  });
  it("refuses connecting/start results and native state with no output", () => {
    expect(localAgentPhoneObservedOutcome(readEffect("phone_start"), evidence)).toBe(false);
    const effect = readEffect();
    effect.result.structuredContent.session.status = "connecting";
    effect.result.structuredContent.session.operations[0]!.state = "registered";
    effect.result.structuredContent.session.result = "";
    expect(localAgentPhoneObservedOutcome(effect, evidence)).toBe(false);
  });
});

function providerFor(result: unknown) {
  const execute = vi.fn(async function* () {
    yield { type: "result" as const, data: { structuredContent: result } };
  });
  return {
    execute,
    provider: new LocalAgentPhoneProvider({ execute } as unknown as ConnectorProvider, route),
  };
}

describe("local external execution protocol", () => {
  it("only handles an assigned MCP phone route", () => {
    expect(isLocalAgentPhoneRoute(route)).toBe(true);
    expect(isLocalAgentPhoneRoute({ ...route, resourceId: undefined })).toBe(false);
    expect(isLocalAgentPhoneRoute({ ...route, toolName: "phone_read" })).toBe(false);
    expect(isLocalAgentPhoneRoute({ ...route, connectorId: "other" })).toBe(false);
  });

  it("does not upgrade a duplicate registered operation into accepted", async () => {
    const { provider, execute } = providerFor({
      session,
      duplicate: true,
      operation: { state: "registered", queueOwner: null },
    });
    const receipt = await provider.start(
      { operationKey: "stable", payload: { message: "task", requestId: "untrusted" } },
      context,
    );
    expect(receipt.operationStatus).toBe("registered");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { message: "task", requestId: "stable", operationKey: "stable" },
        route: expect.objectContaining({ resourceId: "server", toolName: "phone_start" }),
      }),
      context,
    );
  });

  it("looks up a lost start response by operation without creating a session", async () => {
    const { provider, execute } = providerFor({ found: false });
    expect(await provider.inspect({ operationKey: "lost" }, context)).toMatchObject({
      found: false,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ toolName: "phone_inspect" }),
        args: { requestId: "lost" },
      }),
      context,
    );
  });

  it("preserves local queue ownership and maps replay cursor and operation associations", async () => {
    const { provider } = providerFor({
      session,
      operation: { state: "queued", queueOwner: "local", turnId: null },
      events: [
        {
          seq: 4,
          type: "status",
          status: "idle",
          turnId: "turn",
          operationKeys: ["start", "steering"],
        },
      ],
      cursor: 4,
      hasMore: false,
    });
    const page = await provider.readEvents({ sessionId: "session", cursor: "3" }, context);
    expect(page).toMatchObject({
      operationStatus: "queued",
      queueOwner: "local",
      nextCursor: "4",
      events: [{ id: "4", turnId: "turn", operationKeys: ["start", "steering"] }],
    });
  });

  it("targets cancellation to the existing operation and turn", async () => {
    const { provider, execute } = providerFor({
      session,
      operation: { state: "dispatching" },
    });
    const receipt = await provider.cancel(
      {
        sessionId: "session",
        operationKey: "stop",
        targetOperationKey: "start",
        expectedTurnId: "turn",
      },
      context,
    );
    expect(receipt.operationStatus).toBe("dispatching");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {
          sessionId: "session",
          requestId: "stop",
          targetRequestId: "start",
          expectedTurnId: "turn",
        },
      }),
      context,
    );
  });

  it("refuses a server without the operation receipt capability", async () => {
    const { provider } = providerFor({ protocolVersion: 0 });
    await expect(provider.describe(context)).rejects.toThrow("managed execution receipts");
  });

  it("does not assign stale session turn or result to an unconfirmed operation", async () => {
    const { provider } = providerFor({
      session: { ...session, result: "a different turn", error: "old error" },
      operation: { state: "unknown" },
    });
    const result = await provider.inspect({ operationKey: "unconfirmed" }, context);
    expect(result.turnId).toBeUndefined();
    expect(result.result).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("accepts a numeric native input request without treating it as an operation key", async () => {
    const { provider } = providerFor({
      session,
      events: [
        { seq: 4, type: "tool", requestId: 7, inputRequestId: "7", status: "waiting_input" },
      ],
      cursor: 4,
      hasMore: false,
    });
    const page = await provider.readEvents({ sessionId: "session", cursor: "3" }, context);
    expect(page.events[0]?.operationKey).toBeUndefined();
    expect(page.events[0]?.data.inputRequestId).toBe("7");
  });
});
