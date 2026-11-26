// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { MCP_OAUTH_CHANNEL } from "../lib/mcp-oauth-channel";
import { selectSpace } from "../lib/rpc";
import { McpOAuthCallbackPage } from "./McpOAuthCallback";

vi.mock("@lingui/react/macro", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

it("completes without the Space selected by another tab and broadcasts only its own attempt", async () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const postMessage = vi.fn();
  const close = vi.fn();
  const fetch = vi.fn(async (_request: Request, _init: RequestInit) =>
    Response.json({ json: { ok: true } }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      constructor(name: string) {
        expect(name).toBe(MCP_OAUTH_CHANNEL);
      }
      postMessage = postMessage;
      close = close;
    },
  );
  selectSpace("space-a");
  window.localStorage.setItem("rakazo:space-id", "space-b");
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <I18nProvider i18n={i18n}>
          <MemoryRouter initialEntries={["/mcp/oauth/callback?state=attempt-a&code=fixture"]}>
            <Routes>
              <Route path="/mcp/oauth/callback" element={<McpOAuthCallbackPage />} />
              <Route path="/app" element={<p>App</p>} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "mcp-oauth-complete",
      sessionId: "attempt-a",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [request, init] = fetch.mock.calls[0]!;
    const url = new URL(request.url);
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe("/rpc/mcp/oauth/complete");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).has("x-rakazo-space-id")).toBe(false);
    expect(await request.json()).toEqual({
      json: { sessionId: "attempt-a", state: "attempt-a", code: "fixture" },
    });
  } finally {
    await act(async () => root.unmount());
    window.localStorage.removeItem("rakazo:space-id");
    vi.unstubAllGlobals();
  }
});
