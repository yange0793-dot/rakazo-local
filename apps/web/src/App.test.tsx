// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const capability = vi.hoisted(() => ({
  enabled: false,
  boardLoaded: vi.fn(),
  screen: vi.fn(async () => ({ ok: true })),
  me: vi.fn(async () => ({
    userId: "local-user",
    name: "Local",
    email: "local@rakazo.local",
  })),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./lib/bootstrap", () => ({
  getTicketBoardEnabled: () => capability.enabled,
  subscribeTicketBoardEnabled: () => () => {},
}));
vi.mock("./lib/monitoring", () => ({ identifyMonitoringUser: vi.fn() }));
vi.mock("./lib/logo-avatar-activity", () => ({ syncWebLogoAvatarIdentity: vi.fn() }));
vi.mock("./lib/remote-images-preference", () => ({
  remoteImagesPreference: { use: () => false },
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./lib/rpc", () => ({
  rpc: { me: capability.me, analytics: { screen: capability.screen } },
}));
vi.mock("./components/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", async () => {
  const { useLocalIdentity } = await import("./lib/local-identity");
  return {
    ShellPage: () => <div data-local-user={useLocalIdentity().user.id}>Shell</div>,
  };
});
vi.mock("./components/call/CallLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CallLayout: () => <Outlet /> };
});
vi.mock("./components/markdown-link-prompt", () => ({
  MarkdownLinkPrompt: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Board", () => {
  capability.boardLoaded();
  return { BoardPage: () => <div>Board page</div> };
});
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));

import { App } from "./App";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  capability.enabled = false;
  capability.me.mockClear();
  capability.screen.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("closes an integration callback without loading the local workspace", async () => {
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  window.history.replaceState(null, "", "/integrations/callback?status=success");
  await act(async () => root.render(<MemoryRouter><App /></MemoryRouter>));
  expect(close).toHaveBeenCalledOnce();
  expect(container.textContent).toBe("You can close this window.");
  expect(capability.me).not.toHaveBeenCalled();
});

it("opens the shell with the local owner without a login", async () => {
  await act(async () =>
    root.render(<MemoryRouter initialEntries={["/app"]}><App /></MemoryRouter>),
  );
  expect(container.textContent).toBe("Shell");
  expect(container.querySelector("[data-local-user]")?.getAttribute("data-local-user")).toBe("local-user");
  expect(capability.me).toHaveBeenCalledOnce();
});

it("loads the board chunk only after bootstrap enables the route", async () => {
  const render = () => <MemoryRouter initialEntries={["/app/board"]}><App /></MemoryRouter>;
  await act(async () => root.render(render()));
  expect(container.textContent).toBe("Shell");
  expect(capability.screen).toHaveBeenCalledExactlyOnceWith({ screen: "board", surface: "web" });
  expect(capability.boardLoaded).not.toHaveBeenCalled();
  capability.enabled = true;
  await act(async () => {
    root.render(render());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(capability.boardLoaded).toHaveBeenCalledOnce();
  expect(container.textContent).toBe("Board page");
});

it("retries an unavailable local identity without opening a login page", async () => {
  capability.me.mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    root.render(<MemoryRouter initialEntries={["/app"]}><App /></MemoryRouter>),
  );
  expect(container.textContent).toContain("Can't reach the server.");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("Shell");
  expect(capability.me).toHaveBeenCalledTimes(2);
});

it.each(["throw", "reject"])(
  "keeps screen reporting failures out of the app error boundary (%s)",
  async (mode) => {
    if (mode === "throw") capability.screen.mockImplementationOnce(() => {
      throw new Error("analytics unavailable");
    });
    else capability.screen.mockRejectedValueOnce(new Error("analytics unavailable"));
    await act(async () =>
      root.render(<MemoryRouter initialEntries={["/app"]}><App /></MemoryRouter>),
    );
    expect(container.textContent).toBe("Shell");
  },
);
