import { createRouterClient, implement } from "@orpc/server";
import { McpOAuthBroker, recordMcpServerHealth } from "@rakazo/adapters";
import { appContract } from "@rakazo/contracts";
import { currentDbContext, recordSecurityEvent } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { mcpRoutes } from "./mcp.js";

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  recordMcpServerHealth: vi.fn(),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  recordSecurityEvent: vi.fn(),
}));

const requestActor = {
  userId: "user-a",
  spaceId: "space-b",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const input = { sessionId: "attempt", code: "fixture-code", state: "attempt" };

function setup({ userId = requestActor.userId, member = true } = {}) {
  const session = vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
    where.id === input.sessionId && where.userId === requestActor.userId
      ? { spaceId: "space-a" }
      : null,
  );
  const membership = vi.fn(async () =>
    member ? { userId, spaceId: "space-a", member: { user: { email: requestActor.email } } } : null,
  );
  const server = { id: "server", revision: 2 };
  const prisma = {
    spaceMember: { findFirst: membership },
    mcpOAuthSession: { findFirst: session },
    mcpServer: { findFirst: vi.fn().mockResolvedValue(server) },
  };
  const mcpOAuth = new McpOAuthBroker(prisma as never, {} as never);
  const complete = vi.spyOn(mcpOAuth, "complete").mockImplementation(async () => {
    expect(currentDbContext()).toEqual({ kind: "tenant", spaceId: "space-a", userId });
    return { serverId: server.id, revision: server.revision };
  });
  const grant = { status: "connected" as const, clientId: null, credential: true };
  const summary = vi.spyOn(mcpOAuth, "summaryFor").mockResolvedValue(grant);
  const beginMcpProbe = vi.fn();
  const os = implement(appContract).$context<{ actor: typeof requestActor }>();
  const context = {
    os,
    authed: os,
    deps: { prisma },
    mcpOAuth,
    beginMcpProbe,
  } as unknown as RouterContext;
  const client = createRouterClient(mcpRoutes(context), {
    context: { actor: { ...requestActor, userId } },
  });
  return { client, session, membership, complete, beginMcpProbe, summary, grant, server, prisma };
}

afterEach(() => vi.clearAllMocks());

it("completes OAuth and probes in the attempt's Space after selection changes", async () => {
  const { client, session, membership, complete, beginMcpProbe, summary, grant, server, prisma } =
    setup();
  await expect(client.mcp.oauth.complete(input)).resolves.toEqual({ ok: true });
  expect(session).toHaveBeenCalledWith({
    where: { id: input.sessionId, userId: "user-a", createdAt: { gte: expect.any(Date) } },
    select: { spaceId: true },
  });
  expect(membership).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { spaceId: "space-a", userId: "user-a", space: { deletingAt: null } },
    }),
  );
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    ...input,
    userId: "user-a",
    spaceId: "space-a",
  });
  expect(recordMcpServerHealth).toHaveBeenCalledWith(
    prisma,
    "server",
    { status: "unknown", message: null },
    2,
  );
  const actor = { ...requestActor, spaceId: "space-a" };
  await vi.waitFor(() => expect(beginMcpProbe).toHaveBeenCalledWith(server, actor, grant));
  expect(summary).toHaveBeenCalledWith(server, actor);
  expect(recordSecurityEvent).toHaveBeenCalledExactlyOnceWith({
    type: "credential.created",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { procedure: "mcp.oauth.complete", kind: "mcp_oauth" },
  });
});

it("denies a callback after the user leaves the attempt's Space", async () => {
  const { client, complete, beginMcpProbe } = setup({ member: false });
  await expect(client.mcp.oauth.complete(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(complete).not.toHaveBeenCalled();
  expect(recordMcpServerHealth).not.toHaveBeenCalled();
  expect(beginMcpProbe).not.toHaveBeenCalled();
  expect(recordSecurityEvent).not.toHaveBeenCalled();
});

it("does not resolve a different user's attempt or a mismatched state", async () => {
  const { client, session, membership, complete } = setup({ userId: "user-b" });
  await expect(client.mcp.oauth.complete({ ...input, state: "different" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(session).not.toHaveBeenCalled();
  await expect(client.mcp.oauth.complete(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(membership).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});
