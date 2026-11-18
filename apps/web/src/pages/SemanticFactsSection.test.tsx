// @vitest-environment jsdom

import type { SemanticFact } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
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
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray | { id: string; message?: string }, ...values: unknown[]) =>
      "raw" in parts ? String.raw(parts, ...values) : (parts.message ?? parts.id),
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
  const Category = createContext<{ value: string[]; onValueChange: (next: string[]) => void }>({
    value: [],
    onValueChange: () => undefined,
  });
  return {
    Button,
    ToggleGroup: ({
      value,
      onValueChange,
      children,
      spacing: _spacing,
      ...props
    }: Omit<ComponentProps<"div">, "onChange"> & {
      value: string[];
      onValueChange: (value: string[]) => void;
      spacing?: number;
      disabled?: boolean;
    }) => (
      <Category.Provider value={{ value, onValueChange }}>
        <div {...props}>{children}</div>
      </Category.Provider>
    ),
    ToggleGroupItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const group = useContext(Category);
      return (
        <button
          type="button"
          aria-pressed={group.value.includes(value)}
          onClick={() => group.onValueChange([value])}
        >
          {children}
        </button>
      );
    },
    Field: Box,
    // biome-ignore lint/a11y/noLabelWithoutControl: the mock renders the htmlFor the section sets
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
  // Times read in the app's locale; the exact ISO value stays in the element's title.
  const updated = source?.querySelector(`time[datetime="${fact.updatedAt}"]`);
  expect(updated?.textContent).toBeTruthy();
  expect(updated?.textContent).not.toBe(fact.updatedAt);
  expect(source?.textContent).not.toContain(fact.updatedAt);
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

it("warns before a correction outgrows the 40 KB the server stores", async () => {
  await openList();
  await act(async () => button(fact.content).click());
  await act(async () => button("Correct").click());
  // Chinese takes three bytes a character, so 14,000 characters stay under the field's
  // 20,000 cap yet pass the 40 KiB the server stores, which used to fail only on save.
  await type("textarea", "记".repeat(14_000));
  expect(container.textContent).toContain("Too long to save");
  expect(button("Save correction").disabled).toBe(true);
  await type("textarea", "记".repeat(13_000));
  expect(container.textContent).not.toContain("Too long to save");
  expect(button("Save correction").disabled).toBe(false);
});

it("does not claim nothing is remembered while only history is hidden", async () => {
  api.memory.facts.mockResolvedValue({ supported: true, items: [], nextCursor: null });
  await openList();
  expect(container.textContent).toContain("No current records");
  expect(container.textContent).not.toContain("Nothing remembered yet");
  await act(async () => button("Show history").click());
  await settle();
  expect(container.textContent).toContain("Nothing remembered yet");
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

const lesson: SemanticFact = {
  ...fact,
  id: "lesson-fixture",
  kind: "lesson",
  content: "cue: The build failed twice.\nlesson: Read the whole log before retrying.",
  provenance: {
    kind: "run",
    runId: "run-fixture",
    threadId: "thread-fixture",
    messageId: "message-fixture",
    harness: {
      domainKey: "files",
      signals: ["run_failed"],
      autoApplied: false,
      evidence: { kind: "run_failed", quote: "build failed" },
    },
  },
};

it("lists experience as lessons in the bot's own scope, with no fact-only controls", async () => {
  api.memory.facts.mockResolvedValue({ supported: true, items: [lesson], nextCursor: null });
  await openList();
  expect(api.memory.facts.mock.calls.at(-1)?.[0]).not.toHaveProperty("kind");
  await act(async () => button("Experience").click());
  await settle();
  expect(api.memory.facts).toHaveBeenCalledWith(
    expect.objectContaining({ botId: "bot-fixture", scope: "isolated", kind: "lesson" }),
    expect.anything(),
  );
  // Experience is always the bot's own scope, so the Scope field is not shown at all.
  expect(container.querySelectorAll("select")).toHaveLength(1);
  expect(container.textContent).toContain(lesson.content);
  // Export only carries facts, so experience does not offer it.
  expect(container.textContent).not.toContain("Export");
  await act(async () => button(lesson.content).click());
  const source = container.querySelector("details");
  expect(source?.textContent).toContain("files");
});

it("corrects and forgets an experience with the lesson kind", async () => {
  api.memory.facts.mockResolvedValue({ supported: true, items: [lesson], nextCursor: null });
  await openList();
  await act(async () => button("Experience").click());
  await settle();
  await act(async () => button(lesson.content).click());
  await act(async () => button("Correct").click());
  await type("textarea", "cue: The build failed three times.\nlesson: Ask before retrying.");
  await act(async () => button("Save correction").click());
  expect(api.memory.correctFact).toHaveBeenCalledWith({
    id: lesson.id,
    botId: "bot-fixture",
    scope: "isolated",
    kind: "lesson",
    content: "cue: The build failed three times.\nlesson: Ask before retrying.",
    expectedRevision: lesson.revision,
  });
  await act(async () => button(lesson.content).click());
  await act(async () => button("Forget").click());
  const dialog = container.querySelector('[role="alertdialog"]');
  await act(async () =>
    [...dialog!.querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.textContent === "Forget")
      ?.click(),
  );
  expect(api.memory.forgetFact).toHaveBeenCalledWith({
    id: lesson.id,
    botId: "bot-fixture",
    scope: "isolated",
    kind: "lesson",
    expectedRevision: lesson.revision,
  });
});
