// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpaceRpcProvider } from "../../lib/space-rpc";
import { IntegrationSetup } from "./IntegrationSetup";

const { api, scoped, oauth } = vi.hoisted(() => ({
  api: { capabilities: { catalogSearch: vi.fn() }, mcp: { servers: { list: vi.fn() } } },
  scoped: {
    capabilities: { catalogSearch: vi.fn() },
    mcp: {
      servers: { list: vi.fn(), create: vi.fn() },
      assignments: { approve: vi.fn() },
    },
  },
  oauth: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({ rpc: api, rpcForSpace: () => scoped }));
vi.mock("../../lib/mcp-connect", () => ({ connectMcpOauth: oauth }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.capabilities.catalogSearch.mockReset().mockResolvedValue({ enabled: true, results: [] });
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("does not search on open without a query", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <IntegrationSetup />
      </StrictMode>,
    ),
  );
  expect(host.querySelector("input")?.value).toBe("");
  expect(host.textContent).not.toContain("No remote MCP servers found");
  expect(api.capabilities.catalogSearch).not.toHaveBeenCalled();
});

it("searches the public catalog once for a query it opens with", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <IntegrationSetup initialQuery="canva" />
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("No remote MCP servers found"));
  expect(host.querySelector("input")?.value).toBe("canva");
  expect(api.capabilities.catalogSearch.mock.calls).toEqual([
    [{ query: "canva", usePublicCatalog: true }],
  ]);
});

it("creates and authorizes a server with the mounted Space's client", async () => {
  const endpoint = "https://mcp.example.test/endpoint";
  scoped.capabilities.catalogSearch.mockResolvedValue({
    enabled: true,
    results: [{ name: "Fixture", surfaces: [{ kind: "mcp", source: endpoint }] }],
  });
  scoped.mcp.servers.list.mockResolvedValue([]);
  scoped.mcp.servers.create.mockResolvedValue({ id: "server" });
  oauth.mockResolvedValue("connected");
  await act(async () =>
    root.render(
      <SpaceRpcProvider spaceId="space-a">
        <IntegrationSetup botId="bot-a" initialQuery="fixture" />
      </SpaceRpcProvider>,
    ),
  );
  const button = Array.from(host.querySelectorAll("button")).find(
    (element) => element.textContent === "Connect" && !element.disabled,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(api.mcp.servers.list).not.toHaveBeenCalled();
  expect(scoped.mcp.servers.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ endpoint, name: "Fixture" }),
  );
  expect(oauth).toHaveBeenCalledExactlyOnceWith("server", scoped);
  expect(scoped.mcp.assignments.approve).toHaveBeenCalledExactlyOnceWith({
    botId: "bot-a",
    serverId: "server",
  });
});
