import { RPCHandler } from "@orpc/server/fetch";
import type { AdapterContext, BrowserControlRequest, ComputerRef } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const browserFactory = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  createBrowserProvider: browserFactory,
}));

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function fixture() {
  const order: string[] = [];
  const computer = {
    id: "computer-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    homeKey: "home-1",
    providerRef: "/test/workspace",
    kind: "desktop",
    scope: "dedicated",
    state: "running",
    maintenanceId: null,
    controlHolder: "none",
    controlLeaseId: null as string | null,
    controlUserId: null as string | null,
    controlLeaseExpiresAt: null as Date | null,
    controlBotId: null as string | null,
    controlRunId: "run-1" as string | null,
  };
  const run = { id: "run-1", botId: "bot-1", userId: actor.userId, status: "waiting_takeover" };
  const effect = {
    id: "effect-1",
    result: {
      tree: "original observation",
      browserState: {
        computerId: "computer-1",
        provider: { selectedPage: "7:p2", control: "agent" },
      },
    },
  };
  let browserState: unknown;
  const browser = {
    restore: vi.fn((_ref: ComputerRef, state: unknown, _context: AdapterContext) => {
      browserState = state;
    }),
    checkpoint: vi.fn(() => browserState),
    control: vi.fn(
      async (_ref: ComputerRef, request: BrowserControlRequest, _context: AdapterContext) => {
        order.push(`browser:${request.action}`);
        browserState = {
          selectedPage: request.action === "resume" ? "7:p3" : "7:p2",
          control: request.action === "resume" ? "agent" : "user",
        };
        return { ok: true };
      },
    ),
  };
  browserFactory.mockReturnValue(browser);
  const prisma = {
    spaceMember: { count: vi.fn(async () => 1) },
    bot: {
      findFirst: vi.fn(async () => ({
        id: "bot-1",
        userId: actor.userId,
        spaceId: actor.spaceId,
        computer: { ...computer },
        thread: { id: "thread-1" },
      })),
    },
    computer: {
      findUniqueOrThrow: vi.fn(async () => ({ ...computer })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(computer, data);
        return { count: 1 };
      }),
    },
    computerExecutionLease: {
      findUnique: vi.fn(async () => ({ runId: run.id, expiresAt: new Date(Date.now() + 60000) })),
    },
    run: { findUnique: vi.fn(async () => ({ ...run })) },
    externalEffect: {
      findFirst: vi.fn(async () => effect),
      update: vi.fn(async ({ data }: { data: typeof effect }) => {
        order.push("persist-browser");
        Object.assign(effect, data);
        return effect;
      }),
    },
    $queryRaw: vi.fn(async () => []),
  };
  const events = {
    append: vi.fn(async () => {}),
    finalizeComputerControlRelease: vi.fn(async () => {
      order.push("release-run");
      Object.assign(computer, {
        controlHolder: "none",
        controlLeaseId: null,
        controlBotId: null,
        controlUserId: null,
        controlRunId: null,
      });
      return { runId: run.id };
    }),
  };
  const deps = {
    prisma: { ...prisma, $transaction: async (fn: (tx: typeof prisma) => unknown) => fn(prisma) },
    events,
    sandbox: { setScreenControl: vi.fn(async () => {}) },
    jobs: { enqueue: vi.fn(async () => {}), cancel: vi.fn(async () => {}) },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake",
      sandboxProvider: "fake",
      webOrigin: "https://web.example.test",
      screenProxySecret: "test-only",
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function rpc(
    name: "takeover" | "release",
    input: Record<string, unknown> = {},
    user: Actor | null = actor,
  ) {
    const { response } = await handler.handle(
      new Request(`https://api.example.test/rpc/computer/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1", ...input } }),
      }),
      { prefix: "/rpc", context: { actor: user } },
    );
    return response!;
  }
  return { rpc, computer, run, effect, browser, prisma, events, order };
}

beforeEach(() => browserFactory.mockReset());

describe("browser control through authenticated computer RPC", () => {
  it("hands off the restored page, then persists the user's returned page before resuming the run", async () => {
    const f = fixture();
    expect((await f.rpc("takeover")).status).toBe(200);
    expect(f.browser.control).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "/test/workspace" }),
      { action: "hand_off" },
      expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId, botId: "bot-1" }),
    );
    expect(f.effect.result.browserState.provider).toEqual({
      selectedPage: "7:p2",
      control: "user",
    });
    f.order.length = 0;
    expect((await f.rpc("release", { runId: "run-1", reason: "done" })).status).toBe(200);
    expect(f.browser.control).toHaveBeenLastCalledWith(
      expect.anything(),
      { action: "resume", userConfirmed: true },
      expect.objectContaining({ userId: actor.userId, botId: "bot-1" }),
    );
    expect(f.order).toEqual(["browser:resume", "persist-browser", "release-run"]);
    expect(f.effect.result.tree).toBe("original observation");
    expect(f.effect.result.browserState.provider).toEqual({
      selectedPage: "7:p3",
      control: "agent",
    });
    expect(f.prisma.externalEffect.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: actor.spaceId,
          run: { botId: "bot-1", userId: actor.userId },
          kind: { in: ["browser_navigate", "browser_snapshot", "browser_act"] },
          status: "completed",
          result: { path: ["browserState", "computerId"], equals: "computer-1" },
        },
      }),
    );
  });

  it("does not return a browser for an unsigned request, another user or a stale run", async () => {
    const f = fixture();
    expect((await f.rpc("takeover")).status).toBe(200);
    f.browser.control.mockClear();
    expect((await f.rpc("release", { runId: "run-1" }, null)).status).toBe(401);
    expect(
      (await f.rpc("release", { runId: "run-1" }, { ...actor, userId: "another-user" })).status,
    ).toBe(409);
    expect((await f.rpc("release", { runId: "another-run" })).status).toBe(409);
    expect(f.browser.control).not.toHaveBeenCalled();
    expect(f.events.finalizeComputerControlRelease).not.toHaveBeenCalled();
  });

  it("leaves the run waiting if returning browser control fails", async () => {
    const f = fixture();
    expect((await f.rpc("takeover")).status).toBe(200);
    f.browser.control.mockRejectedValueOnce(new Error("Browser unavailable"));
    expect((await f.rpc("release", { runId: "run-1" })).status).toBe(500);
    expect(f.events.finalizeComputerControlRelease).not.toHaveBeenCalled();
    expect(f.computer.controlHolder).toBe("user");
  });

  it("does not resume without a current control lease or pending takeover", async () => {
    const f = fixture();
    f.computer.controlRunId = null;
    expect((await f.rpc("release", { userConfirmed: true })).status).toBe(200);
    expect(f.browser.control).not.toHaveBeenCalled();
    expect(f.prisma.externalEffect.findFirst).not.toHaveBeenCalled();
  });

  it("does not pass a record for a different computer to the browser", async () => {
    const f = fixture();
    f.effect.result.browserState.computerId = "old-computer";
    expect((await f.rpc("takeover")).status).toBe(200);
    expect(f.browser.restore).not.toHaveBeenCalled();
    expect(f.browser.control).not.toHaveBeenCalled();
  });

  it("supports returning the pending needs-you card without opening the screen", async () => {
    const f = fixture();
    expect((await f.rpc("release", { runId: "run-1", reason: "done" })).status).toBe(200);
    expect(f.browser.control).toHaveBeenCalledWith(
      expect.anything(),
      { action: "resume", userConfirmed: true },
      expect.anything(),
    );
    expect(f.order).toEqual(["browser:resume", "persist-browser", "release-run"]);
  });
});
