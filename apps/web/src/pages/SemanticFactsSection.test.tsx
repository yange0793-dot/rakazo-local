// @vitest-environment jsdom

import type { SemanticFact } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bots: { list: vi.fn() },
  memory: { facts: vi.fn(), correctFact: vi.fn(), forgetFact: vi.fn(), exportFacts: vi.fn() },
}));
vi.mock("../lib/rpc", () => {
  const client = { bots: api.bots, memory: api.memory };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("../lib/artifact-open", () => ({ downloadArtifactBytes: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  return {
    Button,
    Field: Box,
    FieldLabel: (props: ComponentProps<"label">) => <label {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Spinner: () => <span role="status" aria-label="Loading" />,
    DropdownMenu: Box,
    DropdownMenuContent: Box,
    DropdownMenuItem: Button,
    DropdownMenuTrigger: ({
      render: _render,
      ...props
    }: ComponentProps<"button"> & { render?: ReactNode }) => <button type="button" {...props} />,
    AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: Box,
    AlertDialogDescription: Box,
    AlertDialogFooter: Box,
    AlertDialogCancel: Button,
    AlertDialogAction: Button,
  };
});

import { downloadArtifactBytes } from "../lib/artifact-open";
import { SemanticFactsSection } from "./SemanticFactsSection";

const fact: SemanticFact = {
  id: "fact-fixture",
  botId: "bot-fixture",
  scope: "isolated",
  kind: "durable",
  content: "Use the synthetic workspace.",
  revision: 3,
  status: "active",
  provenance: {
    kind: "run",
    runId: "run-fixture",
    threadId: "thread-fixture",
    messageId: "message-fixture",
    quote: "Use the synthetic workspace.",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockReset().mockResolvedValue([
    { id: "bot-fixture", name: "Fixture bot" },
    { id: "other-bot", name: "Other bot" },
  ]);
  api.memory.facts
    .mockReset()
    .mockResolvedValue({ supported: true, items: [fact], nextCursor: null });
  api.memory.correctFact.mockReset().mockResolvedValue({ ...fact, revision: 4 });
  api.memory.forgetFact.mockReset().mockResolvedValue({ ok: true });
  api.memory.exportFacts
    .mockReset()
    .mockResolvedValue({ format: "rakazo-semantic-memory-v1", facts: [fact] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <SemanticFactsSection />
      </QueryClientProvider>,
    ),
  );
  await settle();
}
function button(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}
async function choose(value: string, index = 0) {
  const select = container.querySelectorAll("select")[index];
  if (!select) throw new Error("Missing select");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function openList() {
  await render();
  await act(async () => button("Saved facts").click());
  await settle();
  await choose("bot-fixture");
}
async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!input) throw new Error("Missing input");
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("requests no guessed bot, starts isolated, and discloses exact source only on demand", async () => {
  await render();
  expect(api.bots.list).not.toHaveBeenCalled();
  await act(async () => button("Saved facts").click());
  await settle();
  expect(api.memory.facts).not.toHaveBeenCalled();
  await choose("bot-fixture");
  expect(api.memory.facts).toHaveBeenCalledWith(
    expect.objectContaining({ botId: "bot-fixture", scope: "isolated", limit: 20 }),
    expect.anything(),
  );
  expect(container.textContent).toContain(fact.content);
  expect(container.querySelector("details")).toBeNull();
  await act(async () => button(fact.content).click());
  const source = container.querySelector("details");
  expect(source?.open).toBe(false);
  expect(source?.textContent).toContain("message-fixture");
  expect(source?.textContent).toContain(fact.updatedAt);
  expect(source?.textContent).toContain("3");
  expect(container.textContent).not.toContain("Shared memory");
});

it("hides unsupported management controls instead of offering dead actions", async () => {
  api.memory.facts.mockResolvedValue({ supported: false, items: [], nextCursor: null });
  await openList();
  expect(container.textContent).toContain("does not support managing saved facts");
  expect(container.querySelector('input[type="search"]')).toBeNull();
  expect(container.textContent).not.toContain("Export");
  expect(container.textContent).not.toContain("Correct");
  expect(container.textContent).not.toContain("Forget");
});

it("corrects the opened revision and keeps a conflicting draft and error visible", async () => {
  api.memory.correctFact.mockRejectedValue(
    Object.assign(new Error("Revision conflict"), { code: "CONFLICT" }),
  );
  await openList();
  await act(async () => button(fact.content).click());
  await act(async () => button("Correct").click());
  await type("textarea", "Use the second synthetic workspace.");
  expect(container.querySelectorAll("select")[0]?.disabled).toBe(true);
  await act(async () => button("Save correction").click());
  expect(api.memory.correctFact).toHaveBeenCalledWith({
    id: fact.id,
    botId: "bot-fixture",
    scope: "isolated",
    content: "Use the second synthetic workspace.",
    expectedRevision: 3,
  });
  expect(container.querySelector("textarea")?.value).toBe("Use the second synthetic workspace.");
  expect(container.textContent).toContain("Record changed");
  expect(container.textContent).toContain("Revision conflict");
  expect(button("Save correction").disabled).toBe(true);
});

it("forgets only after confirmation with the opened revision", async () => {
  await openList();
  await act(async () => button(fact.content).click());
  await act(async () => button("Forget").click());
  expect(api.memory.forgetFact).not.toHaveBeenCalled();
  const dialog = container.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Forget this record?");
  await act(async () =>
    [...dialog!.querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.textContent === "Forget")
      ?.click(),
  );
  expect(api.memory.forgetFact).toHaveBeenCalledWith({
    id: fact.id,
    botId: "bot-fixture",
    scope: "isolated",
    expectedRevision: 3,
  });
});

it("uses exact search paging and exports only the selected scope", async () => {
  api.memory.facts.mockImplementation(
    async (input: { cursor?: string; query?: string; scope: string }) => ({
      supported: true,
      items: input.cursor
        ? [{ ...fact, id: "next-fixture", content: "Next synthetic record." }]
        : [fact],
      nextCursor: input.cursor ? null : "cursor-fixture",
    }),
  );
  await openList();
  await act(async () => button("Show more").click());
  await settle();
  expect(api.memory.facts).toHaveBeenCalledWith(
    expect.objectContaining({ cursor: "cursor-fixture", botId: "bot-fixture", scope: "isolated" }),
    expect.anything(),
  );
  expect(container.textContent).toContain("Next synthetic record.");
  await type('input[type="search"]', " synthetic ");
  await act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await settle();
  expect(api.memory.facts).toHaveBeenCalledWith(
    expect.objectContaining({ query: "synthetic", scope: "isolated" }),
    expect.anything(),
  );
  await choose("shared", 1);
  await act(async () => button("Export").click());
  expect(api.memory.exportFacts).toHaveBeenCalledWith({ botId: "bot-fixture", scope: "shared" });
  expect(downloadArtifactBytes).toHaveBeenCalledWith(
    "memory.json",
    "application/json",
    expect.anything(),
  );
  const bytes = vi.mocked(downloadArtifactBytes).mock.calls.at(-1)?.[2];
  // Check the encoded bytes without tying their constructor to jsdom's realm.
  expect(ArrayBuffer.isView(bytes)).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
    format: "rakazo-semantic-memory-v1",
    facts: [fact],
  });
});
