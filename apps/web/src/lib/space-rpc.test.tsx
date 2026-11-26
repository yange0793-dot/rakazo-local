import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { spaceQueries, useSpaceQueries } from "./query";
import { SpaceRpcProvider, useSpaceRpc } from "./space-rpc";

const clients = vi.hoisted(() => ({
  selected: vi.fn(() => "another-tab"),
  unscoped: {},
  clients: { home: {}, settings: {} },
}));

vi.mock("./rpc", () => ({
  rpc: {},
  createSpaceRpc: () => clients.unscoped,
  rpcForSpace: (id: keyof typeof clients.clients) => clients.clients[id] ?? {},
  selectedSpaceId: clients.selected,
}));

it("keeps descendant requests in the mounted shell's space, including an unselected home", () => {
  function Probe({ spaceId }: { spaceId: "home" | "settings" | null }) {
    expect(useSpaceQueries()).toBe(spaceQueries(null, spaceId));
    expect(useSpaceRpc()).toBe(spaceId === null ? clients.unscoped : clients.clients[spaceId]);
    return null;
  }

  renderToStaticMarkup(
    <>
      <SpaceRpcProvider spaceId={null}>
        <SpaceRpcProvider spaceId={undefined}>
          <Probe spaceId={null} />
        </SpaceRpcProvider>
      </SpaceRpcProvider>
      <SpaceRpcProvider spaceId="home">
        <Probe spaceId="home" />
        <SpaceRpcProvider spaceId="settings">
          <Probe spaceId="settings" />
        </SpaceRpcProvider>
      </SpaceRpcProvider>
    </>,
  );
  expect(clients.selected).not.toHaveBeenCalled();
});
