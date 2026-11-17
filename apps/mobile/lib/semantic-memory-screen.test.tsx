// @vitest-environment jsdom

import type { SemanticFact } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SemanticMemoryScreen from "../app/(settings)/semantic-memory";
import { queryClient } from "./query";

type HeaderItem = {
  type: string;
  menu?: { items: { label: string; disabled?: boolean; onPress: () => void }[] };
};
type AlertButton = { text: string; style?: string; onPress?: () => void };
const mocks = vi.hoisted(() => ({
  rpc: vi.fn<(method: string, input: unknown) => Promise<unknown>>(),
  share: vi.fn(),
  alert: vi.fn(),
  options: {} as { headerRight?: () => ReactNode; unstable_headerRightItems?: () => HeaderItem[] },
  preventRemove: false,
  nativeHeader: false,
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => mocks.nativeHeader }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (create: () => unknown) => create() }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: (method: string, input: unknown) => mocks.rpc(method, input),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
  useNavigation: () => ({
    setOptions: (options: typeof mocks.options) => Object.assign(mocks.options, options),
  }),
  usePreventRemove: (active: boolean) => {
    mocks.preventRemove = active;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    detail,
    disabled,
    onPress,
  }: {
    title: string;
    detail?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    onPress ? (
      <button type="button" disabled={disabled} onClick={onPress}>
        {title}
      </button>
    ) : (
      <p>
        {title} {detail}
      </p>
    ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
  MenuPickerMenu: ({
    label,
    choices,
    onChange,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <div aria-label={label}>
      {choices.map((choice) => (
        <button key={choice.key} type="button" onClick={() => onChange(choice.key)}>
          {choice.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box,
    ScrollView: Box,
    Modal: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
    Text: ({
      children,
      accessibilityRole,
    }: {
      children?: ReactNode;
      accessibilityRole?: ComponentProps<"p">["role"];
    }) => <p role={accessibilityRole}>{children}</p>,
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      multiline,
      editable,
    }: {
      accessibilityLabel: string;
      value: string;
      onChangeText: (value: string) => void;
      multiline?: boolean;
      editable?: boolean;
    }) =>
      multiline ? (
        <textarea
          aria-label={accessibilityLabel}
          value={value}
          readOnly={editable === false}
          onChange={(event) => onChangeText(event.target.value)}
        />
      ) : (
        <input
          aria-label={accessibilityLabel}
          value={value}
          onChange={(event) => onChangeText(event.target.value)}
        />
      ),
    ActivityIndicator: () => <span role="status" aria-label="Loading" />,
    Alert: { alert: mocks.alert },
    Share: { share: mocks.share },
    StyleSheet: { create: (styles: unknown) => styles },
    Platform: { OS: "ios" },
  };
});

const fact: SemanticFact = {
  id: "fact-fixture",
  botId: "bot-fixture",
  scope: "isolated",
  kind: "durable",
  content: "Synthetic memory record.",
  revision: 4,
  status: "active",
  provenance: {
    kind: "run",
    runId: "run-fixture",
    messageId: "message-fixture",
    quote: "Synthetic source quote.",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.options = {};
  mocks.nativeHeader = false;
  mocks.rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === "bots/list")
      return [
        { id: "bot-fixture", name: "Fixture bot" },
        { id: "other-bot", name: "Other bot" },
      ];
    if (method === "memory/facts") return { supported: true, items: [fact], nextCursor: null };
    if (method === "memory/correctFact") return { ...fact, revision: 5 };
    if (method === "memory/forgetFact") return { ok: true };
    if (method === "memory/exportFacts")
      return { format: "rakazo-semantic-memory-v1", facts: [fact] };
    throw new Error(`Unexpected ${method}`);
  });
  mocks.share.mockReset().mockResolvedValue({ action: "sharedAction" });
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
  await act(async () => root.render(<SemanticMemoryScreen />));
  await settle();
}
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function select(label: string, value: string) {
  const input = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing ${label}`);
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function openList() {
  await render();
  await select("Bot", "bot-fixture");
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
  await settle();
}
function confirm(label: string) {
  const buttons = mocks.alert.mock.calls.at(-1)?.[2] as AlertButton[];
  buttons.find((entry) => entry.text === label)?.onPress?.();
}

it("waits for an explicit bot, requests isolated records, and keeps source details behind a tap", async () => {
  await render();
  expect(mocks.rpc).not.toHaveBeenCalledWith("memory/facts", expect.anything());
  await select("Bot", "bot-fixture");
  expect(mocks.rpc).toHaveBeenCalledWith("memory/facts", {
    botId: "bot-fixture",
    scope: "isolated",
    limit: 20,
    includeHistory: false,
  });
  expect(container.textContent).not.toContain("message-fixture");
  await act(async () => button(fact.content).click());
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => button("Source").click());
  expect(container.textContent).toContain("message-fixture");
  expect(container.textContent).toContain(fact.updatedAt);
  expect(container.textContent).toContain("Synthetic source quote.");
  expect(container.textContent).not.toContain("Shared memory");
});

it("shows an unsupported fallback without search, export, or mutation controls", async () => {
  mocks.rpc.mockImplementation(async (method: string) =>
    method === "bots/list"
      ? [{ id: "bot-fixture", name: "Fixture bot" }]
      : { supported: false, items: [], nextCursor: null },
  );
  await openList();
  expect(container.textContent).toContain("does not support managing saved facts");
  expect(container.querySelector('[aria-label="Search"]')).toBeNull();
  expect(mocks.options.headerRight).toBeUndefined();
  expect(container.textContent).not.toContain("Correct");
  expect(container.textContent).not.toContain("Forget");
});

it("sends the opened revision and retains a conflicting correction", async () => {
  const initial = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((method: string, input: unknown) =>
    method === "memory/correctFact"
      ? Promise.reject(Object.assign(new Error("Revision conflict"), { code: "CONFLICT" }))
      : initial(method, input),
  );
  await openList();
  await act(async () => button(fact.content).click());
  await act(async () => button("Correct").click());
  await type("textarea", "Synthetic corrected memory.");
  await act(async () => button("Save correction").click());
  expect(mocks.rpc).toHaveBeenCalledWith("memory/correctFact", {
    id: fact.id,
    botId: "bot-fixture",
    scope: "isolated",
    content: "Synthetic corrected memory.",
    expectedRevision: 4,
  });
  expect(container.querySelector("textarea")?.value).toBe("Synthetic corrected memory.");
  expect(container.textContent).toContain("Record changed");
  expect(container.textContent).toContain("Revision conflict");
  expect(button("Save correction").disabled).toBe(true);
});

it("requires native confirmation before forgetting and leaves failures visible", async () => {
  const initial = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((method: string, input: unknown) =>
    method === "memory/forgetFact"
      ? Promise.reject(new Error("Could not forget fixture"))
      : initial(method, input),
  );
  await openList();
  await act(async () => button(fact.content).click());
  await act(async () => button("Forget").click());
  expect(mocks.rpc).not.toHaveBeenCalledWith("memory/forgetFact", expect.anything());
  expect(mocks.alert).toHaveBeenCalledWith(
    "Forget this record?",
    "It will no longer be recalled.",
    expect.any(Array),
  );
  await act(async () => confirm("Forget"));
  expect(mocks.rpc).toHaveBeenCalledWith("memory/forgetFact", {
    id: fact.id,
    botId: "bot-fixture",
    scope: "isolated",
    expectedRevision: 4,
  });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain("Could not forget fixture");
});

it("pages, searches and exports the explicitly selected shared scope through native header actions", async () => {
  mocks.nativeHeader = true;
  const initial = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((method: string, input: unknown) => {
    const request = input as { cursor?: string };
    return method === "memory/facts"
      ? Promise.resolve({
          supported: true,
          items: request.cursor
            ? [{ ...fact, id: "next-fact", content: "Next synthetic record." }]
            : [fact],
          nextCursor: request.cursor ? null : "cursor-fixture",
        })
      : initial(method, input);
  });
  await openList();
  await select("Scope", "shared");
  await act(async () => button("Show more").click());
  await settle();
  expect(mocks.rpc).toHaveBeenCalledWith(
    "memory/facts",
    expect.objectContaining({ botId: "bot-fixture", scope: "shared", cursor: "cursor-fixture" }),
  );
  await type('input[aria-label="Search"]', "synthetic");
  expect(mocks.rpc).toHaveBeenCalledWith(
    "memory/facts",
    expect.objectContaining({ scope: "shared", query: "synthetic" }),
  );
  const exportAction = mocks.options
    .unstable_headerRightItems?.()[0]
    ?.menu?.items.find((entry) => entry.label === "Export");
  await act(async () => exportAction?.onPress());
  expect(mocks.rpc).toHaveBeenCalledWith("memory/exportFacts", {
    botId: "bot-fixture",
    scope: "shared",
  });
  const exported = JSON.parse(mocks.share.mock.calls.at(-1)?.[0].message);
  expect(exported).toEqual({ format: "rakazo-semantic-memory-v1", facts: [fact] });
});
