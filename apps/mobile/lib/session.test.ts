import * as SecureStore from "expo-secure-store";
import { beforeEach, expect, it, vi } from "vitest";
import { stopLiveNotifications } from "./live-notifications";
import { clearFailedSends } from "./thread-feedback";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {store.set(key,value);}),
  deleteItemAsync: vi.fn(async (key: string) => {store.delete(key);}),
}));
vi.mock("./live-notifications", () => ({stopLiveNotifications: vi.fn(async () => undefined)}));
vi.mock("./artifact-cache-session", () => ({invalidateArtifactCacheSession: vi.fn(async () => undefined)}));
vi.mock("./network-cache", () => ({clearNetworkCache: vi.fn()}));
vi.mock("./referral", () => ({forgetReferrals: vi.fn()}));
vi.mock("./thread-feedback", () => ({clearFailedSends: vi.fn()}));

const scope={apiBase:"http://127.0.0.1:3100",userId:"local",spaceId:"mine",selectionId:null};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  store.clear();
});

it("creates one installation ID across concurrent reads and reuses it at the next launch", async () => {
  const {loadLocalInstallSessionId}=await import("./session");
  const [first,second]=await Promise.all([loadLocalInstallSessionId(),loadLocalInstallSessionId()]);
  expect(first).toMatch(/^rakazo-local-install:[a-f0-9-]+$/);
  expect(second).toBe(first);
  expect(SecureStore.setItemAsync).toHaveBeenCalledOnce();
  vi.resetModules();
  expect(await (await import("./session")).loadLocalInstallSessionId()).toBe(first);
});

it("persists the verified initial scope, then drops it and its queue when switching endpoints", async () => {
  const session=await import("./session");
  const id=await session.loadLocalInstallSessionId();
  const initial=session.currentSessionGeneration();
  await session.saveVerifiedIntegrationsScope(initial, scope);
  expect(await session.loadVerifiedIntegrationsScope()).toEqual(scope);
  const activate=vi.fn();
  await session.changeLocalEndpoint(activate);
  expect(activate).toHaveBeenCalledOnce();
  expect(stopLiveNotifications).toHaveBeenCalledWith(true);
  expect(clearFailedSends).toHaveBeenCalledOnce();
  expect(await session.loadLocalInstallSessionId()).toBe(id);
  await session.saveVerifiedIntegrationsScope(initial,scope);
  expect(await session.loadVerifiedIntegrationsScope()).toBeNull();
  expect(session.currentReadySessionGeneration()).toBe(initial+1);
});

it("cannot resurrect a scope whose disk write was in flight when the server changed", async () => {
  const session=await import("./session");
  let release!:()=>void;
  const held=new Promise<void>(done=>{release=done;});
  vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key,value)=>{
    await held;
    store.set(key,value);
  });
  const saving=session.saveVerifiedIntegrationsScope(session.currentSessionGeneration(),scope);
  const switching=session.changeLocalEndpoint(()=>{});
  release();
  await Promise.all([saving,switching]);
  expect(await session.loadVerifiedIntegrationsScope()).toBeNull();
});

it("ignores a malformed scope in storage", async () => {
  store.set("rakazo.local-integrations-scope", JSON.stringify({userId:"local"}));
  expect(await (await import("./session")).loadVerifiedIntegrationsScope()).toBeNull();
});
