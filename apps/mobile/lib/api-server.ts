import { t } from "@lingui/core/macro";
import * as SecureStore from "expo-secure-store";
import {
  clearStoredValue,
  currentApiBase,
  currentSpaceSelectionGeneration,
  nextSpaceSelectionRequest,
  queueEndpointChange,
  rawSelectedSpaceId,
  SPACE_KEY,
  SPACE_ROLLBACK_KEY,
  selectedSpaceId,
  setCachedApiBase,
  setSelectedSpace,
  spaceSelectionSeq,
  writeStoredValue,
} from "./api";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { resumeLiveNotifications } from "./live-notifications";
import { API_BASE_STORAGE_KEY as ENDPOINT_KEY } from "./server-config";
import { loadServerHeaders, saveServerHeaders, serverHeaders } from "./server-headers";
import { changeLocalEndpoint, currentSessionGeneration, loadLocalInstallSessionId } from "./session";

/** The Space last used in each organization on this device, by organization id. */
const ORGANIZATION_SPACES_KEY = "rakazo.org_spaces";
const confirmedSpaceSwitchListeners = new Set<() => void>();
/** Fires when a selection change to another Space is confirmed durable; a
 * rollback after a failed switch, or selecting the same Space again, does not. */
export function subscribeConfirmedSpaceSwitch(listener: () => void): () => void {
  confirmedSpaceSwitchListeners.add(listener);
  return () => {
    confirmedSpaceSwitchListeners.delete(listener);
  };
}
function noteConfirmedSpaceSwitch(): void {
  for (const listener of [...confirmedSpaceSwitchListeners]) listener();
}
export async function loadApiBase() {
  let apiBase = defaultApiBase();
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        apiBase = parsed.url;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  await loadServerHeaders(apiBase);
  setCachedApiBase(apiBase);
  try {
    const storedSpace = (await SecureStore.getItemAsync(SPACE_KEY)) ?? "";
    setSelectedSpace(storedSpace);
    // A deletion fallback must override the now-invalid saved Space even when
    // the device failed to replace that value before the previous process exited.
    await recoverSpaceRollback(apiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  return currentApiBase();
}
export async function selectSpace(id: string) {
  const requestGeneration = nextSpaceSelectionRequest();
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Rollback cleanup is the first await. A newer selection may have claimed
  // the live space while this call was still deleting the rollback record.
  if (requestGeneration !== spaceSelectionSeq()) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = rawSelectedSpaceId();
  setSelectedSpace(id);
  // Generation ownership distinguishes A→B→A from "we still own this claim":
  // an ID-only check would treat a later same-id selection as ours.
  const claimGeneration = currentSpaceSelectionGeneration();
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    // Our write may have landed stale behind a newer overlapping selection's
    // write. Re-assert the live selection best-effort so durable converges
    // to it; each selector heals at most once, so overlapping chains settle
    // on the latest claim. Never delete here: a missing memory owner means
    // another path (recovery, sign-out) owns cleanup.
    const liveSpaceId = rawSelectedSpaceId();
    if (liveSpaceId && liveSpaceId !== id) {
      await writeStoredValue(SPACE_KEY, liveSpaceId);
    }
  } catch {
    // Roll back the claim and heal durable state: a concurrent recovery may
    // have persisted the rolled-back id after reading it, which would leave
    // restart opening a Space the live session is not using. A newer
    // overlapping selection owns both by now, so only heal a claim we hold.
    if (rawSelectedSpaceId() === id && currentSpaceSelectionGeneration() === claimGeneration) {
      setSelectedSpace(previousSpaceId);
      const rollbackGeneration = currentSpaceSelectionGeneration();
      if (previousSpaceId) await writeStoredValue(SPACE_KEY, previousSpaceId);
      if (previousSpaceId)
        await resumeSelectedSpaceNotifications(previousSpaceId, rollbackGeneration);
    }
    return false;
  }
  // Playback belongs to the conversation being left; the listener in voice.ts
  // stops it once a switch to another Space is confirmed. A fallback that
  // failed to persist left its origin pending; this confirmed switch consumes
  // it, so the fallback's retry cannot stop this Space's later playback.
  if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
  pendingFallbackSwitchFrom = null;
  await resumeSelectedSpaceNotifications(id, claimGeneration);
  return true;
}
async function resumeSelectedSpaceNotifications(id: string, generation: number): Promise<void> {
  const apiBase = currentApiBase();
  const sessionGeneration = currentSessionGeneration();
  const token = await loadLocalInstallSessionId();
  if (
    generation !== currentSpaceSelectionGeneration() ||
    sessionGeneration !== currentSessionGeneration() ||
    apiBase !== currentApiBase()
  )
    return;
  await resumeLiveNotifications(apiBase, token, id).catch(() => undefined);
}
/** Keep requests usable after the server deleted the selected Space but native
 * storage could not replace it. Neutralize any same-endpoint rollback before
 * writing the replacement selection so a cleanup failure cannot leave the new
 * id beside a stale record that recoverSpaceRollback would prefer on restart. */
/** The Space the user was actually on before a fallback adoption that has not
 * landed yet; a retry that persists must still count as leaving it. */
let pendingFallbackSwitchFrom: string | null = null;
export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  const previousSpaceId = rawSelectedSpaceId();
  if (pendingFallbackSwitchFrom === null && previousSpaceId !== id) {
    pendingFallbackSwitchFrom = previousSpaceId;
  }
  setSelectedSpace(id);
  // Neutralize any same-endpoint rollback before writing SPACE_KEY. Writing the
  // selection first can leave it beside a stale record that recoverSpaceRollback
  // would prefer on restart if later cleanup fails.
  const rollbackNeutralized =
    (await clearStoredValue(SPACE_ROLLBACK_KEY)) || (await saveSpaceRollback(id));
  // Playback belongs to the conversation being left; the fallback too is a
  // confirmed switch once it durably adopts another Space. A failed attempt
  // already claimed the replacement in memory, so the Space remembered before
  // the first attempt, not the claim, decides whether one was left behind.
  if (rollbackNeutralized && (await writeStoredValue(SPACE_KEY, id))) {
    // SPACE_KEY is authoritative; drop a rollback we may have written only to
    // overwrite a stale record (best-effort).
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
    pendingFallbackSwitchFrom = null;
    await resumeLiveNotifications(currentApiBase(), await loadLocalInstallSessionId(), id).catch(
      () => undefined,
    );
    return true;
  }
  // Clear before saving recovery: an empty selection lets startup resolve the
  // server default even when the recovery record cannot be written.
  const staleSelectionCleared = await clearStoredValue(SPACE_KEY);
  const recoverySaved = await saveSpaceRollback(id);
  await resumeLiveNotifications(currentApiBase(), await loadLocalInstallSessionId(), id).catch(
    () => undefined,
  );
  // Only treat a cleared selection as durable success when no same-endpoint
  // rollback remains to override it after restart.
  const durable =
    recoverySaved || (staleSelectionCleared && (await clearStoredValue(SPACE_ROLLBACK_KEY)));
  if (durable && (pendingFallbackSwitchFrom ?? previousSpaceId) !== id) {
    noteConfirmedSpaceSwitch();
  }
  if (durable) pendingFallbackSwitchFrom = null;
  return durable;
}
export async function selectInitialSpace(id: string) {
  if (selectedSpaceId()) return true;
  return selectSpace(id);
}
export async function loadOrganizationSpaces(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(
      (await SecureStore.getItemAsync(ORGANIZATION_SPACES_KEY)) || "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}
export async function rememberOrganizationSpace(
  organizationId: string,
  spaceId: string,
): Promise<void> {
  const spaces = await loadOrganizationSpaces();
  await writeStoredValue(
    ORGANIZATION_SPACES_KEY,
    JSON.stringify({ ...spaces, [organizationId]: spaceId }),
  );
}
export async function clearSpace(): Promise<boolean> {
  const organizationsCleared = await clearStoredValue(ORGANIZATION_SPACES_KEY);
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  const rollbackCleared = await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!organizationsCleared || !spaceCleared || !rollbackCleared) return false;
  setSelectedSpace("");
  return true;
}
/** Finish the current call before switching the requests to another server. */
let hangUpBeforeCredentialsCleared: (() => Promise<void>) | undefined;
/** Registers (or clears) the hang-up that runs before an endpoint change clears credentials. */
export function configureSessionEndHangUp(hangUp: (() => Promise<void>) | undefined): void {
  hangUpBeforeCredentialsCleared = hangUp;
}
async function saveSpaceRollback(spaceId: string): Promise<boolean> {
  return writeStoredValue(
    SPACE_ROLLBACK_KEY,
    JSON.stringify({ apiBase: currentApiBase(), spaceId }),
  );
}
async function recoverSpaceRollback(apiBase: string) {
  const stored = await SecureStore.getItemAsync(SPACE_ROLLBACK_KEY);
  if (!stored) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  const rollback = parsed as { apiBase?: unknown; spaceId?: unknown };
  if (rollback.apiBase !== apiBase || typeof rollback.spaceId !== "string" || !rollback.spaceId) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  setSelectedSpace(rollback.spaceId);
  if (await writeStoredValue(SPACE_KEY, rollback.spaceId)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  // Could not replace the selection yet. Drop the deleted id so startup RPCs
  // are not scoped to an inaccessible Space; keep the recovery record.
  await clearStoredValue(SPACE_KEY);
}

export async function saveApiBase(input: string, headers: Record<string, string> = {}): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  return queueEndpointChange(parsed.url, async (previous, switching) => {
    const failure = { ok: false, error: t`Could not save the server URL` } as const;
    if (switching) await hangUpBeforeCredentialsCleared?.();
    const spaceKeys = [SPACE_KEY, SPACE_ROLLBACK_KEY, ORGANIZATION_SPACES_KEY];
    const stored = switching
      ? await Promise.all(spaceKeys.map((key) => SecureStore.getItemAsync(key))).catch(() => null)
      : [];
    if (!stored) return failure;
    const oldSpace = rawSelectedSpaceId();
    const oldHeaders = serverHeaders(previous);
    if (!(await saveServerHeaders(parsed.url, headers))) return failure;
    const saved = (!switching || await clearSpace()) && (parsed.url === defaultApiBase()
      ? await clearStoredValue(ENDPOINT_KEY)
      : await writeStoredValue(ENDPOINT_KEY, parsed.url));
    if (!saved) {
      await saveServerHeaders(previous, oldHeaders);
      if (switching) {
        for (const [i, value] of stored.entries()) {
          if (i !== 0 && value != null) await writeStoredValue(spaceKeys[i]!, value);
        }
        setSelectedSpace(oldSpace);
        const restoreSpace = oldSpace || stored[0];
        if (restoreSpace && !(await writeStoredValue(SPACE_KEY, restoreSpace))) {
          await saveSpaceRollback(restoreSpace);
        }
      }
      return failure;
    }
    if (switching) await changeLocalEndpoint(() => setCachedApiBase(parsed.url));
    else setCachedApiBase(parsed.url);
    return parsed;
  });
}

export function resetApiBase() { return saveApiBase(defaultApiBase()); }
