// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createPageSession, PagesProvider } from "../../lib/pages";
import { PageNotice } from "./PageNotice";
import { PageViewHost } from "./PageViewHost";
import type * as PrivateBrowserPageModule from "./PrivateBrowserPage";

const data = vi.hoisted(() => ({ live: false }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    pages: {
      get: {
        // Like the server: the link only when asked for.
        queryOptions: ({ input }: { input: { pageId: string; link?: true } }) => ({
          queryKey: ["page", input],
          queryFn: async () => ({
            id: "p1",
            title: data.live ? "Gemini" : "Plan",
            code: "",
            botId: data.live ? "bot-1" : null,
            owner: { name: "" },
            visibility: data.live ? "private" : "link",
            shareUrl: input.link === true ? "https://rakazo.example/p/1" : null,
          }),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/page-actions", () => ({
  pageMutationOptions: () => ({ rename: {}, setVisibility: {} }),
}));
vi.mock("./PrivateBrowserPage", async (original) => {
  const module = await original<typeof PrivateBrowserPageModule>();
  return { ...module, PrivateBrowserPage: () => <div>Live browser frame</div> };
});
vi.mock("./PageView", () => ({
  PageView: ({
    composer,
    share,
    notice,
    liveFrame,
  }: {
    composer: ReactNode;
    share: ReactNode;
    notice: ReactNode;
    liveFrame: ReactNode;
  }) => (
    <div>
      {share}
      {composer}
      {notice ?? liveFrame}
    </div>
  ),
}));

afterEach(() => {
  data.live = false;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("opens a live frame when the JSX page runtime is unavailable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  data.live = true;
  const session = createPageSession();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  const runtime = vi.fn(async () => {
    throw new Error("runtime unavailable");
  });
  await client.fetchQuery({ queryKey: ["page-runtime"], queryFn: runtime }).catch(() => {});
  vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/app/bot-1?page=p1"]}>
            <PagesProvider value={{ open: () => {}, session }}>
              <PageViewHost />
            </PagesProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.body.textContent).toContain("Live browser frame");
    expect(document.body.textContent).not.toContain("This page couldn't load");
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

it("docks the chat's composer over a tablet's page sheet, so its reply goes to the page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A touch tablet: coarse pointer and at least 900px wide.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async () => new Response(""));
  const session = createPageSession();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/app/bot-1?page=p1"]}>
          <PagesProvider value={{ open: () => {}, session }}>
            <PageViewHost />
          </PagesProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  expect(session.dock.get().node).not.toBeNull();
  const card = {
    id: "m1",
    blocks: [{ kind: "page" as const, pageId: "p1", version: 1, title: "Plan" }],
  };
  expect(session.send("mark task 3 done", [card])).toEqual({
    text: "mark task 3 done",
    replyToMessageId: "m1",
  });
  root.unmount();
});

it("shows the link when Share opens on a page that is already shared", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async () => new Response(""));
  const session = createPageSession();
  session.askShare("p1");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/app/bot-1?page=p1"]}>
          <PagesProvider value={{ open: () => {}, session }}>
            <PageViewHost />
          </PagesProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  const share = document.querySelector('[data-testid="page-share"]');
  expect(share?.textContent).toContain("Open link");
  expect(share?.querySelector("a")?.getAttribute("href")).toBe("https://rakazo.example/p/1");
  root.unmount();
});

it("announces why a page is not showing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<PageNotice title="This page couldn't load" detail="Check your connection." />),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "This page couldn't load",
  );
  root.unmount();
});
