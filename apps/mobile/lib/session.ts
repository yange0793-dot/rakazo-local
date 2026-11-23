import { isLocalInstallSessionId, LOCAL_INSTALL_SESSION_PREFIX } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";
import { invalidateArtifactCacheSession } from "./artifact-cache-session";
import { stopLiveNotifications } from "./live-notifications";
import { clearNetworkCache } from "./network-cache";
import { forgetReferrals } from "./referral";
import { clearFailedSends } from "./thread-feedback";

const INSTALL_KEY = "rakazo.local-install-id";
const SCOPE_KEY = "rakazo.local-integrations-scope";
let install: Promise<string> | undefined;

/** Identifies the installation for notifications and cache paths; it is not a credential. */
export function loadLocalInstallSessionId(): Promise<string> {
  return install ??= (async () => {
    const stored = await SecureStore.getItemAsync(INSTALL_KEY).catch(() => null);
    if (stored && isLocalInstallSessionId(stored)) return stored;
    const id = LOCAL_INSTALL_SESSION_PREFIX + Array.from({ length: 8 }, () =>
      Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0"),
    ).join("");
    await SecureStore.setItemAsync(INSTALL_KEY, id).catch(() => undefined);
    return id;
  })();
}

export type VerifiedIntegrationsScope = {
  apiBase: string;
  userId: string;
  spaceId: string;
  selectionId: string | null;
};
let generation = 0;
let readyGeneration = 0;
let scopeWrite = Promise.resolve();
const listeners = new Set<() => void>();
const caches = new Set<(sameAccount: boolean) => void | Promise<void>>();

export const currentSessionGeneration = () => generation;
export const currentReadySessionGeneration = () => readyGeneration;
export function subscribeSessionGeneration(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function registerSessionDiskCache(clear: (sameAccount: boolean) => void | Promise<void>) {
  caches.add(clear);
}
export async function changeLocalEndpoint(activate: () => void) {
  generation += 1;
  for (const listener of listeners) listener();
  clearFailedSends();
  clearNetworkCache();
  forgetReferrals();
  // Shortcuts and other optional caches must not block a switch if native storage stalls.
  for (const clear of caches) void (async () => clear(false))().catch(() => undefined);
  await Promise.allSettled([
    stopLiveNotifications(true),
    invalidateArtifactCacheSession(),
    scopeWrite.then(() => SecureStore.deleteItemAsync(SCOPE_KEY)),
  ]);
  activate();
  readyGeneration = generation;
  for (const listener of listeners) listener();
}
export async function saveVerifiedIntegrationsScope(version: number, scope: VerifiedIntegrationsScope) {
  if (version !== generation || readyGeneration !== version) return;
  scopeWrite = scopeWrite.then(() => SecureStore.setItemAsync(SCOPE_KEY, JSON.stringify(scope))).catch(() => undefined);
  await scopeWrite;
}
export async function loadVerifiedIntegrationsScope(): Promise<VerifiedIntegrationsScope | null> {
  const version = generation;
  try {
    const data = JSON.parse((await SecureStore.getItemAsync(SCOPE_KEY)) ?? "null");
    if (version !== readyGeneration || version !== generation || !data ||
        typeof data.apiBase !== "string" || typeof data.userId !== "string" ||
        typeof data.spaceId !== "string" ||
        !(typeof data.selectionId === "string" || data.selectionId === null)) return null;
    return data;
  } catch {
    return null;
  }
}
