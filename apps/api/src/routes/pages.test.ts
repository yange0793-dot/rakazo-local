import { createRouterClient, implement } from "@orpc/server";
import { appContract } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { pagesRoutes } from "./pages.js";

const { getPage, readFrame, restore, findFirst } = vi.hoisted(() => ({
  getPage: vi.fn(),
  readFrame: vi.fn(),
  restore: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("../pages.js", async (original) => ({
  ...(await original<typeof import("../pages.js")>()),
  getPage,
}));
vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  createBrowserProvider: () => ({ readFrame, restore }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function setup(visibility = "private") {
  vi.stubEnv("BROWSER_PROVIDER", "ego");
  const actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "user@example.test",
    isDeploymentOwner: false,
  };
  const computer = {
    id: "computer-1",
    kind: "desktop",
    state: "running",
    providerRef: "/workspace",
    homeKey: "bot-home",
  };
  getPage.mockResolvedValue({ visibility, title: "Gemini", botId: "bot-1" });
  const provider = { session: { spaceId: "15", pageLabel: "p3" } };
  findFirst.mockResolvedValue({
    result: { browserState: { computerId: computer.id, provider } },
  });
  readFrame.mockResolvedValue(Buffer.from("frame"));
  const ctx = {
    authed: implement(appContract).$context<{ actor: typeof actor }>(),
    deps: { prisma: { externalEffect: { findFirst } }, env: {} },
    repos: { getBot: vi.fn(async () => ({ id: "bot-1", computer })) },
  } as unknown as RouterContext;
  return {
    client: createRouterClient(pagesRoutes(ctx), { context: { actor } }),
    provider,
  };
}

it("restores the caller's browser receipt and reads its bound page", async () => {
  const { client, provider } = setup();
  expect(await client.pages.frame({ pageId: "page-1" })).toEqual({
    image: Buffer.from("frame").toString("base64"),
  });
  expect(findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        spaceId: "space-1",
        run: { botId: "bot-1", userId: "user-1" },
        AND: [
          { result: { path: ["browserState", "computerId"], equals: "computer-1" } },
          { result: { path: ["url"], string_starts_with: "https://gemini.google.com/" } },
        ],
      }),
    }),
  );
  expect(restore).toHaveBeenCalledWith(
    expect.objectContaining({ id: "/workspace", botId: "bot-home" }),
    provider,
    expect.objectContaining({ botId: "bot-1", userId: "user-1" }),
  );
  expect(readFrame).toHaveBeenCalledWith(
    expect.objectContaining({ id: "/workspace", botId: "bot-home" }),
    undefined,
    expect.anything(),
  );
});

it("does not expose a live browser frame through a shared page", async () => {
  const { client } = setup("link");
  expect(await client.pages.frame({ pageId: "page-1" })).toEqual({ image: null });
  expect(readFrame).not.toHaveBeenCalled();
  expect(findFirst).not.toHaveBeenCalled();
});
