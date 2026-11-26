// @vitest-environment jsdom

import type { ModelCatalogSourceStatus, ModelCredential } from "@rakazo/contracts";
import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelConnection from "../app/(settings)/model-connection";
import Models from "../app/(settings)/models";
import type { ModelConnectionRequest } from "./model-connection-request";
import {
  MODEL_CONNECT_TIMEOUT_MS,
  modelConnectionRequest,
  openModelConnection,
} from "./model-connection-request";
import { modelPickerRequest } from "./model-picker-selection";
import { queryClient } from "./query";

const savedEndpoint = "https://models.example.test/v1";
const { push, back, params, rpcCalls, saved } = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  params: {} as { requestId?: string; spaceId?: string },
  rpcCalls: [] as [
    string,
    unknown,
    { requestContext?: { headers: object }; timeoutMs?: number }?,
  ][],
  saved: {
    baseUrl: "https://models.example.test/v1",
    hasKey: false,
    label: "Fixture",
    held: null as Promise<void> | null,
    failMe: false,
    apiProtocol: undefined as string | undefined,
    reasoning: false,
    thinkingLevel: undefined as string | undefined,
    reasoningCapabilities: undefined as ModelCredential["reasoningCapabilities"],
    bots: [] as {
      id: string;
      name: string;
      modelProvider: string | null;
      modelId: string | null;
    }[],
    failBotList: false,
    // A failed save either keeps the bot's own model or finds it already cleared elsewhere.
    failBotUpdates: {} as Record<string, "kept" | "changed elsewhere">,
    needsModel: false,
    sources: [] as ModelCatalogSourceStatus[],
    catalogSource: undefined as ModelCredential["catalogSource"],
    failSync: false,
    focused: true,
  },
}));

vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  captureApiRequestContext: async (spaceId = "space-fixture") => ({
    headers: { "x-rakazo-space-id": spaceId },
  }),
  selectedSpaceId: () => "space-fixture",
  rpc: async (
    procedure: string,
    input?: unknown,
    options?: { requestContext?: { headers: object }; timeoutMs?: number },
  ) => {
    rpcCalls.push([procedure, input, options]);
    if (saved.held) await saved.held;
    if (saved.failMe && procedure === "me") throw new Error("offline");
    if (procedure === "models/syncSources") {
      if (saved.failSync) throw new Error("source offline");
      return saved.sources;
    }
    if (procedure === "models/sources") return saved.sources;
    if (procedure === "me")
      return {
        userId: "user-fixture",
        spaceId: "space-fixture",
        defaultProvider: "openai-compatible",
        defaultModel: "model-fixture",
        needsModel: saved.needsModel,
      };
    if (procedure === "models/probeOpenAiCompatible")
      return { models: Array.from({ length: 11 }, (_, index) => `found-${index}`) };
    if (procedure === "models/role") return { primary: null, backups: [] };
    if (procedure === "bots/list") {
      if (saved.failBotList) throw new Error("offline");
      return saved.bots;
    }
    if (procedure === "bots/update") {
      const { botId } = input as { botId: string };
      const failure = saved.failBotUpdates[botId];
      if (failure !== "kept")
        saved.bots = saved.bots.map((bot) =>
          bot.id === botId ? { ...bot, modelProvider: null, modelId: null } : bot,
        );
      if (failure) throw new Error("offline");
      return {};
    }
    if (procedure === "models/connect") return { id: "credential-new" };
    if (procedure === "models/forRole") return [];
    if (procedure === "models/list")
      return [
        {
          provider: "openai-compatible",
          id: "model-fixture",
          label: "Fixture",
          endpointPresets: [{ name: "Ollama Cloud", baseUrl: "https://ollama.com/v1" }],
        },
        { provider: "anthropic", providerName: "Anthropic", id: "claude-fixture", label: "Claude" },
        // Deployment-funded models still leave room for a personal key.
        {
          provider: "openrouter",
          providerName: "OpenRouter",
          id: "funded-fixture",
          label: "Funded",
          managed: true,
        },
      ];
    if (procedure === "models/credentials")
      return [
        {
          id: "credential-fixture",
          provider: "openai-compatible",
          modelId: "model-fixture",
          baseUrl: saved.baseUrl,
          hasKey: saved.hasKey,
          headerNames: ["x-session"],
          label: saved.label,
          catalogSource: saved.catalogSource,
          ...(saved.apiProtocol ? { apiProtocol: saved.apiProtocol } : {}),
          ...(saved.reasoning ? { reasoning: true } : {}),
          ...(saved.thinkingLevel ? { thinkingLevel: saved.thinkingLevel } : {}),
          reasoningCapabilities: saved.reasoningCapabilities,
        },
      ];
    return [];
  },
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push, back }),
  useNavigation: () => ({ setOptions: vi.fn() }),
  useLocalSearchParams: () => params,
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => (saved.focused ? effect() : undefined), [effect, saved.focused]),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    title,
    children,
  }: {
    actions: { id: string; title: string; state?: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    title: string;
    children?: ReactNode;
  }) =>
    createElement(
      "div",
      { "aria-label": title },
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "aria-pressed": action.state === "on",
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({}),
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    disabled,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null, Checkmark: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label?: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
      label,
    ),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return {
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    ActivityIndicator: () => createElement("span", {}, "Loading"),
    Alert: { alert: vi.fn() },
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: "ios" },
    PlatformColor: (name: string) => name,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: view,
    View: view,
    Text: view,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
    TextInput: ({
      accessibilityLabel,
      placeholder,
      value,
      onChangeText,
      secureTextEntry,
      maxLength,
      editable,
    }: {
      accessibilityLabel?: string;
      placeholder?: string;
      value: string;
      onChangeText: (value: string) => void;
      secureTextEntry?: boolean;
      maxLength?: number;
      editable?: boolean;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        placeholder,
        value,
        maxLength,
        readOnly: editable === false,
        type: secureTextEntry ? "password" : "text",
        onInput: (event: { currentTarget: HTMLInputElement }) =>
          onChangeText(event.currentTarget.value),
      }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;

async function renderConnection(request: Partial<ModelConnectionRequest> = {}) {
  params.requestId = openModelConnection({
    provider: "openai-compatible",
    credentialId: "credential-fixture",
    makeDefault: false,
    target: { scope: "account" },
    ...request,
  });
  await act(async () => root.render(createElement(ModelConnection)));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  rpcCalls.length = 0;
  delete params.spaceId;
  back.mockClear();
  saved.focused = true;
  saved.sources = [];
  saved.catalogSource = undefined;
  saved.reasoningCapabilities = undefined;
  saved.failSync = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await renderConnection();
  const advanced = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Advanced",
  );
  expect(advanced).toBeDefined();
  await act(async () => advanced!.click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function field(label: string): HTMLInputElement | null {
  return container.querySelector(`input[aria-label="${label}"]`);
}
async function change(label: string, value: string) {
  const input = field(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function expectSavedHeader() {
  expect(field("Header name")?.value).toBe("x-session");
  expect(field("Header value")?.value).toBe("");
  expect(field("Header value")?.placeholder).toBe("••••••••");
  expect(field("Header value")?.type).toBe("password");
}

describe("mobile saved model headers", () => {
  it.each([
    " https://models.example.test/v1 ",
    "https://models.example.test/v1/",
    "https://models.example.test",
  ])("keeps masked saved headers for the equivalent endpoint %s", async (endpoint) => {
    expectSavedHeader();
    await change("OpenAI-compatible server URL", endpoint);
    expectSavedHeader();
  });

  it.each(["https://other.example.test/v1", "https://models.example.test/v2", "http://", ""])(
    "does not show saved headers at a changed or incomplete endpoint %s",
    async (endpoint) => {
      await change("OpenAI-compatible server URL", endpoint);
      expect(field("Header name")).toBeNull();
      const add = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Add header",
      )!;
      await act(async () => add.click());
      await change("Header name", "x-session");
      expect(field("Header value")?.placeholder).toBe("Header value");
      await change("OpenAI-compatible server URL", savedEndpoint);
      expectSavedHeader();
    },
  );
});

async function remount(render: () => Promise<void>) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
}

async function notConnectedChoices() {
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  const add = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Add fallback"),
  );
  expect(add).toBeDefined();
  await act(async () => add!.click());
  const route = push.mock.calls.at(-1)?.[0] as { params: { requestId: string } };
  return modelPickerRequest(route.params.requestId)!.connectChoices ?? [];
}

it("offers deployment-funded providers and Ollama Cloud once among providers to connect", async () => {
  expect((await notConnectedChoices()).map((choice) => choice.label)).toEqual([
    "Anthropic",
    "OpenRouter",
    "Ollama Cloud",
  ]);
});

it("does not offer Ollama Cloud again once it is the saved connection", async () => {
  saved.baseUrl = "https://ollama.com/";
  try {
    expect((await notConnectedChoices()).map((choice) => choice.label)).toEqual([
      "Anthropic",
      "OpenRouter",
    ]);
  } finally {
    saved.baseUrl = savedEndpoint;
  }
});

it("opens the Ollama preset through the compatible form with a visible key field", async () => {
  await remount(() => renderConnection({ baseUrl: "https://ollama.com/v1", credentialId: null }));
  expect(field("OpenAI-compatible server URL")?.value).toBe("https://ollama.com/v1");
  expect(field("API key")?.placeholder).toBe("");
  expect(field("API key")?.type).toBe("password");
  expect(
    [...container.querySelectorAll("button")].filter((button) =>
      ["Setup help", "API key"].includes(button.textContent ?? ""),
    ),
  ).toHaveLength(0);
});

it("hands a connected model back to the slot that asked for it", async () => {
  const onConnected = vi.fn(async () => undefined);
  await remount(() => renderConnection({ makeDefault: true, onConnected }));
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => save.click());
  expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
    provider: "openai-compatible",
    modelId: "model-fixture",
    makeDefault: true,
    scope: "account",
  });
  expect(onConnected).toHaveBeenCalledWith({
    provider: "openai-compatible",
    modelId: "model-fixture",
    credentialId: "credential-new",
  });
  expect(back).toHaveBeenCalledOnce();
});

describe("a Space's model override", () => {
  const otherSpace = { headers: { "x-rakazo-space-id": "space-other" } };

  it("edits that Space's lists in that Space and leaves connections to the account", async () => {
    params.spaceId = "space-other";
    await notConnectedChoices();
    expect(rpcCalls).toContainEqual([
      "models/role",
      { role: "main", expectedUserId: "user-fixture", scope: "space" },
      { requestContext: otherSpace },
    ]);
    expect(container.textContent).not.toContain("Add provider");
    const picker = modelPickerRequest(
      (push.mock.calls.at(-1)![0] as { params: { requestId: string } }).params.requestId,
    )!;
    const connect = picker.continueTo?.(picker.connectChoices![0]!) as unknown as {
      params: { requestId: string };
    };
    expect(modelConnectionRequest(connect.params.requestId)?.target).toEqual({
      scope: "space",
      spaceId: "space-other",
    });
  });

  it("connects through that Space so a new main model lands in its override", async () => {
    const onConnected = vi.fn(async () => undefined);
    await remount(() =>
      renderConnection({
        makeDefault: true,
        target: { scope: "space", spaceId: "space-other" },
        onConnected,
      }),
    );
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => save.click());
    const connect = rpcCalls.find(([procedure]) => procedure === "models/connect");
    expect(connect?.[1]).toMatchObject({ makeDefault: true, scope: "space" });
    expect(connect?.[2]).toEqual({
      requestContext: otherSpace,
      timeoutMs: MODEL_CONNECT_TIMEOUT_MS,
    });
  });

  it("moves that Space's bots onto the main model in that Space", async () => {
    params.spaceId = "space-other";
    saved.bots = [
      { id: "bot-own", name: "Archie", modelProvider: "anthropic", modelId: "claude-fixture" },
    ];
    try {
      await remount(async () => {
        await act(async () => root.render(createElement(Models)));
      });
      rpcCalls.length = 0;
      await switchToSpaceDefault("Switch 1 bot to the space default?");
      const sent = (procedure: string) => rpcCalls.find(([name]) => name === procedure)?.[2];
      expect(sent("bots/update")).toEqual({ requestContext: otherSpace });
      expect(sent("bots/list")).toMatchObject({ requestContext: otherSpace });
      expect(container.textContent).toContain("1 bot now uses the space default.");
    } finally {
      saved.bots = [];
    }
  });
});

async function switchToSpaceDefault(confirmTitle: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Use space default",
  );
  await act(async () => button!.click());
  expect(rpcCalls.some(([procedure]) => procedure === "bots/update")).toBe(false);
  const [title, , buttons] = vi.mocked(Alert.alert).mock.calls.at(-1)!;
  expect(title).toBe(confirmTitle);
  await act(async () => buttons!.find((choice) => choice.text === "Switch")!.onPress!());
}

it("moves bots off their own model onto the main model, keeping failed ones listed", async () => {
  const pinned = (id: string, name: string) => ({
    id,
    name,
    modelProvider: "anthropic",
    modelId: "claude-fixture",
  });
  saved.bots = [
    pinned("bot-archie", "Archie"),
    pinned("bot-basil", "Basil"),
    pinned("bot-nova", "Nova"),
    pinned("bot-inbox", "Inbox"),
    { id: "bot-default", name: "Scout", modelProvider: null, modelId: null },
  ];
  const renderModels = () =>
    remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
  try {
    // An unreadable bot list hides only the bot group.
    saved.failBotList = true;
    await renderModels();
    expect(container.textContent).toContain("Main model");
    expect(container.textContent).not.toContain("Bot models");
    expect(container.textContent).not.toContain("Could not load model settings");
    saved.failBotList = false;
    // Without a main model there is no default to move bots onto.
    saved.needsModel = true;
    await renderModels();
    expect(container.textContent).toContain("Main model");
    expect(container.textContent).not.toContain("Archie");
    saved.needsModel = false;
    await renderModels();
    expect(container.textContent).toContain(
      "4 bots have their own model: Archie, Basil, Nova, Inbox",
    );
    expect(container.textContent).not.toContain("Scout");

    saved.failBotUpdates = { "bot-inbox": "kept", "bot-nova": "changed elsewhere" };
    rpcCalls.length = 0;
    await switchToSpaceDefault("Switch 4 bots to the space default?");
    expect(container.textContent).toContain("2 bots now use the space default.");
    expect(container.textContent).toContain("Could not switch Inbox. Try again.");
    expect(container.textContent).toContain("1 bot has its own model: Inbox");
    expect(container.textContent).not.toMatch(/Archie|Basil|Nova/);

    saved.failBotUpdates = {};
    rpcCalls.length = 0;
    await switchToSpaceDefault("Switch 1 bot to the space default?");
    expect(rpcCalls.filter(([procedure]) => procedure === "bots/update")).toEqual([
      [
        "bots/update",
        { botId: "bot-inbox", modelProvider: null, modelId: null, thinkingLevel: null },
        { requestContext: { headers: { "x-rakazo-space-id": "space-fixture" } } },
      ],
    ]);
    expect(container.textContent).toContain("1 bot now uses the space default.");
    expect(container.textContent).not.toContain("Could not switch");
    expect(container.textContent).not.toContain("Use space default");
  } finally {
    saved.bots = [];
    saved.failBotList = false;
    saved.failBotUpdates = {};
    saved.needsModel = false;
  }
});

const PROTOCOL_LABELS = ["Chat Completions", "Responses", "Anthropic Messages"] as const;

function protocolChoice(label: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === label)!;
}

function currentProtocol(): string | undefined {
  return PROTOCOL_LABELS.find(
    (label) => protocolChoice(label).getAttribute("aria-pressed") === "true",
  );
}

const EFFORT_LABELS = ["Default", "Minimal", "Low", "Medium", "High", "Extra high", "Max"];

/** The reasoning-effort choice the picker marks current, when reasoning is on. */
function currentEffort(): string | undefined {
  return EFFORT_LABELS.find(
    (label) => protocolChoice(label)?.getAttribute("aria-pressed") === "true",
  );
}

async function saveConnection() {
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => save.click());
}

it("drops the saved model at another endpoint and restores it at the saved one", async () => {
  await remount(() => renderConnection());
  await change("OpenAI-compatible server URL", "https://other.example.test/v1");
  await saveConnection();
  expect(
    rpcCalls.some(
      ([procedure, input]) =>
        procedure === "models/connect" &&
        (input as { modelId?: string }).modelId === "model-fixture",
    ),
  ).toBe(false);
  await change("OpenAI-compatible server URL", `${savedEndpoint}/`);
  await saveConnection();
  expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
    modelId: "model-fixture",
  });
});

it("offers the wire protocol on the compatible form and sends the saved choice", async () => {
  saved.apiProtocol = "anthropic-messages";
  try {
    await remount(() => renderConnection());
    expect(currentProtocol()).toBe("Anthropic Messages");
    await act(async () => protocolChoice("Responses").click());
    await saveConnection();
    expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
      provider: "openai-compatible",
      apiProtocol: "responses",
    });
  } finally {
    saved.apiProtocol = undefined;
  }
});

it("keeps the chosen protocol when the endpoint changes", async () => {
  saved.apiProtocol = "anthropic-messages";
  try {
    await remount(() => renderConnection());
    await change("OpenAI-compatible server URL", "https://other.example.test/v1");
    expect(currentProtocol()).toBe("Anthropic Messages");
  } finally {
    saved.apiProtocol = undefined;
  }
});

/** Remounting folds Advanced away again; the effort picker lives inside it. */
async function remountWithAdvanced(render: () => Promise<void>) {
  await remount(render);
  const advanced = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Advanced",
  );
  expect(advanced).toBeDefined();
  await act(async () => advanced!.click());
}

it("keeps Max selected and saves it after changing the wire protocol", async () => {
  saved.reasoning = true;
  saved.thinkingLevel = "max";
  try {
    await remountWithAdvanced(() => renderConnection());
    expect(currentEffort()).toBe("Max");
    await act(async () => protocolChoice("Anthropic Messages").click());
    expect(currentEffort()).toBe("Max");
    await saveConnection();
    expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
      apiProtocol: "anthropic-messages",
      thinkingLevel: "max",
    });
  } finally {
    saved.reasoning = false;
    saved.thinkingLevel = undefined;
  }
});

it("offers all effort levels regardless of adaptive catalog metadata", async () => {
  saved.apiProtocol = "anthropic-messages";
  saved.reasoning = true;
  saved.thinkingLevel = "max";
  saved.reasoningCapabilities = { mode: "adaptive", levels: ["low", "high", "max"] };
  try {
    await remountWithAdvanced(() => renderConnection());
    expect(currentEffort()).toBe("Max");
    const effortMenu = container.querySelector('[aria-label="Reasoning effort"]')!;
    expect([...effortMenu.querySelectorAll("button")].map((button) => button.textContent)).toEqual(
      EFFORT_LABELS,
    );
    await act(async () => protocolChoice("Extra high").click());
    expect(currentEffort()).toBe("Extra high");
    await saveConnection();
    expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
      apiProtocol: "anthropic-messages",
      thinkingLevel: "xhigh",
    });
  } finally {
    saved.apiProtocol = undefined;
    saved.reasoning = false;
    saved.thinkingLevel = undefined;
    saved.reasoningCapabilities = undefined;
  }
});

it("offers no protocol choice on a catalog provider's connection", async () => {
  await remount(() => renderConnection({ provider: "anthropic", credentialId: null }));
  expect(PROTOCOL_LABELS.some((label) => container.textContent?.includes(label))).toBe(false);
});

it("lets the limit fields hold every value the server accepts", () => {
  expect(field("Maximum output tokens")?.maxLength).toBe(String(MAX_MODEL_MAX_TOKENS).length);
  expect(field("Context limit")?.maxLength).toBe(String(MAX_MODEL_CONTEXT_WINDOW).length);
});

it("keeps setup help and API key collapsible for generic compatible servers", async () => {
  const row = (name: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === name)!;
  expect(field("API key")).toBeNull();
  expect(container.textContent).not.toContain("Rakazo adds /v1");
  await act(async () => row("Setup help").click());
  expect(container.textContent).toContain("Rakazo adds /v1");
  await act(async () => row("Setup help").click());
  expect(container.textContent).not.toContain("Rakazo adds /v1");
  await act(async () => row("API key").click());
  expect(field("API key")).not.toBeNull();
  await act(async () => row("API key").click());
  expect(field("API key")).toBeNull();
});

it.each(["https://ollama.com", "https://ollama.com/v1/"])(
  "keeps Save enabled with a saved Ollama key at %s",
  async (baseUrl) => {
    saved.baseUrl = "https://ollama.com/v1";
    saved.hasKey = true;
    try {
      await remount(() => renderConnection());
      await change("OpenAI-compatible server URL", baseUrl);
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save",
      );
      expect(save).toBeDefined();
      expect(save!.disabled).toBe(false);
      await change("OpenAI-compatible server URL", "https://other.test/v1");
      await change("OpenAI-compatible server URL", "https://ollama.com/v1/");
      expect(save!.disabled).toBe(false);
    } finally {
      saved.baseUrl = savedEndpoint;
      saved.hasKey = false;
    }
  },
);

it("paints a revisit from cache without a spinner and refreshes behind it", async () => {
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  expect(container.textContent).toContain("Fixture");
  let release!: () => void;
  saved.held = new Promise((resolve) => {
    release = resolve;
  });
  saved.label = "Renamed fixture";
  try {
    rpcCalls.length = 0;
    await remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
    expect(container.textContent).not.toContain("Loading");
    expect(container.textContent).not.toContain("Renamed fixture");
    expect(rpcCalls.map(([procedure]) => procedure)).toContain("models/syncSources");

    await act(async () => release());
    expect(rpcCalls.map(([procedure]) => procedure)).toContain("models/credentials");
    expect(container.textContent).toContain("Renamed fixture");
  } finally {
    saved.held = null;
    saved.label = "Fixture";
  }
});

it("offers a retry when the first load fails, then shows the model lists", async () => {
  queryClient.clear();
  saved.failMe = true;
  try {
    await remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
    expect(container.textContent).not.toContain("Add fallback");
    expect(container.textContent).toContain("Could not load model settings");
    saved.failMe = false;
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    await act(async () => retry!.click());
    expect(container.textContent).toContain("Add fallback");
    expect(container.textContent).not.toContain("Could not load model settings");
  } finally {
    saved.failMe = false;
  }
});

it("searches discovered models without losing the selected default", async () => {
  expect(field("Search")).toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Find models")!
      .click(),
  );
  expect(field("Search")).not.toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "found-0")!
      .click(),
  );
  await act(async () => field("found-1")!.click());
  await change("Search", "found-10");
  expect(container.textContent).not.toContain("found-0");
  expect(container.textContent).toContain("found-10");
  await change("Search", "");
  expect(container.textContent).toContain("found-0");
  expect(field("found-0")?.checked).toBe(true);
  expect(field("found-1")?.checked).toBe(true);
});

it("syncs model sources on open and refreshes a channel with its native action", async () => {
  saved.sources = [
    {
      id: "source-fixture",
      label: "Model gateway",
      group: "messages",
      apiProtocol: "anthropic-messages",
      lastSyncedAt: "2026-11-16T10:00:00.000Z",
      lastAttemptAt: "2026-11-16T10:00:00.000Z",
      error: null,
      connectionCount: 1,
      unavailableCount: 0,
    },
  ];
  saved.catalogSource = {
    id: "source-fixture",
    label: "Model gateway",
    group: "messages",
    providerId: "provider-fixture",
    available: true,
    unavailableModelIds: [],
  };
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  expect(
    rpcCalls.some(
      ([procedure, input]) => procedure === "models/syncSources" && JSON.stringify(input) === "{}",
    ),
  ).toBe(true);
  expect(container.textContent).toContain("Model gateway");
  expect(container.textContent).not.toContain("Unavailable");
  expect(container.textContent).not.toContain("openai-compatible (Fixture)");
  const before = rpcCalls.filter(([procedure]) => procedure === "models/credentials").length;
  saved.catalogSource.available = false;
  saved.sources[0]!.error = "Source temporarily unavailable";
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Refresh Model gateway"]')!
      .click(),
  );
  expect(rpcCalls).toContainEqual([
    "models/syncSources",
    { sourceId: "source-fixture" },
    undefined,
  ]);
  expect(
    rpcCalls.filter(([procedure]) => procedure === "models/credentials").length,
  ).toBeGreaterThan(before);
  expect(container.textContent).toContain("Unavailable");
  expect(container.textContent).toContain("Source temporarily unavailable");
});

it("keeps the models screen usable after a source RPC failure and retries", async () => {
  saved.failSync = true;
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  expect(container.textContent).toContain("Fixture");
  expect(container.textContent).toContain("Could not sync model sources");
  saved.failSync = false;
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry sync"]')!.click(),
  );
  expect(container.textContent).not.toContain("Could not sync model sources");
});

it("preserves the connection draft when returning to a refreshed screen", async () => {
  await change("Maximum output tokens", "8192");
  await change("OpenAI-compatible server URL", "https://edited.example.test/v1");
  saved.focused = false;
  await act(async () => root.render(createElement(ModelConnection)));
  saved.baseUrl = "https://updated.example.test/v1";
  try {
    saved.focused = true;
    await act(async () => root.render(createElement(ModelConnection)));
    expect(field("Maximum output tokens")?.value).toBe("8192");
    expect(field("OpenAI-compatible server URL")?.value).toBe("https://edited.example.test/v1");
    expect(rpcCalls.some(([procedure]) => procedure === "models/connect")).toBe(false);
  } finally {
    saved.baseUrl = savedEndpoint;
  }
});

it("keeps managed endpoint fields fixed and capability limits editable", async () => {
  saved.catalogSource = {
    id: "source-fixture",
    label: "Model gateway",
    group: "messages",
    providerId: "provider-fixture",
    available: true,
    unavailableModelIds: [],
  };
  await remountWithAdvanced(() => renderConnection());
  expect(field("OpenAI-compatible server URL")?.readOnly).toBe(true);
  expect(container.textContent).not.toContain("Find models");
  expect(container.textContent).not.toContain("Setup help");
  expect(field("Maximum output tokens")?.readOnly).toBe(false);
  await change("Maximum output tokens", "8192");
  expect(field("Maximum output tokens")?.value).toBe("8192");
});
