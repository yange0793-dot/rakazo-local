import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LastBot from "./last-bot";
import type * as Session from "./session";

const { saved } = vi.hoisted(() => ({ saved: new Map<string, string>() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: session.currentSessionGeneration(),
    headers: { "x-rakazo-install-id": await session.loadLocalInstallSessionId() },
  }),
  fetchMobileJson: async () => ({
    response: Response.json({}),
    body: { id: "account-a" },
  }),
  selectedSpaceId: () => "space-a",
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));

let session: typeof Session;
let lastBot: typeof LastBot;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  saved.clear();
  vi.mocked(SecureStore.getItemAsync)
    .mockReset()
    .mockImplementation(async (key) => saved.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync)
    .mockReset()
    .mockImplementation(async (key, value) => {
      saved.set(key, value);
    });
  vi.mocked(SecureStore.deleteItemAsync)
    .mockReset()
    .mockImplementation(async (key) => {
      saved.delete(key);
    });
  session = await import("./session");
  lastBot = await import("./last-bot");
  session.registerSessionDiskCache((sameAccount) => {
    if (!sameAccount) return lastBot.clearLastBot();
  });
  await lastBot.saveLastBotId("researcher", "space-a");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function stall(operation: "write" | "delete") {
  if (operation === "delete") {
    const remove = vi.mocked(SecureStore.deleteItemAsync).getMockImplementation()!;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation((key) =>
      key === "rakazo.last_bot_id" ? new Promise<void>(() => {}) : remove(key),
    );
  } else {
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(() => {
      started();
      return new Promise<void>(() => {});
    });
    void lastBot.saveLastBotId("unfinished", "space-a");
    await writing;
  }
}

describe("stalled last-bot storage", () => {
  it.each(["write", "delete"] as const)(
    "does not block an endpoint switch on a never-settling %s",
    async (operation) => {
      await stall(operation);
      const signedOut = vi.fn();
      void session.changeLocalEndpoint(() => {}).then(signedOut);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signedOut).toHaveBeenCalledOnce();

      const signedIn = vi.fn();
      void session.changeLocalEndpoint(() => {}).then(signedIn);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signedIn).toHaveBeenCalledOnce();
      expect(await session.loadLocalInstallSessionId()).toMatch(/^rakazo-local-install:/);
    },
  );

  it.each(["write", "delete"] as const)(
    "returns no target on a never-settling %s",
    async (operation) => {
      await stall(operation);
      void session.changeLocalEndpoint(() => {});
      const loaded = vi.fn();
      void lastBot.loadLastBotId().then(loaded);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(loaded).toHaveBeenCalledExactlyOnceWith("");
    },
  );
});
