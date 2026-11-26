import { t } from "@lingui/core/macro";
import type { RpcInput, RpcOutput, RpcPath, ThreadSnapshot } from "@rakazo/contracts";
import { CLIENT_UPDATE_REQUIRED_STATUS } from "@rakazo/contracts";
import {
  aiConsentTargets,
  aiDataUsesForProcedure,
  cancelResponseBody,
  displayIdentityResult,
  ensureAiDataConsent,
  isServerUnreachable,
  isUnreachableStatus,
  parseRetryAfter,
  readBoundedJsonResponse,
  ResponseBodyTooLargeError,
  withAbort,
} from "@rakazo/core";
import { clientCorrelationHeaders, responseCorrelation } from "@rakazo/logging/monitoring";
import * as SecureStore from "expo-secure-store";
import { promptAiConsent } from "./ai-consent";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { identityLabels } from "./identity-display";
import {
  newMobileAvatarSnapshotRequest,
  rememberMobileAvatarSnapshot,
  syncMobileAvatarSession,
} from "./logo-avatar-activity";
import { reportMobileError } from "./monitoring";
import { followSelectedSpace, selectedSpaceChanged } from "./referral";
import { fetchServer } from "./server-headers";
import {
  currentSessionGeneration,
  loadLocalInstallSessionId,
  saveVerifiedIntegrationsScope,
} from "./session";
import { clearUnsentSends } from "./thread-feedback";
import { errorText } from "./user-error";

export const SPACE_KEY = "rakazo.space_id";
export const SPACE_ROLLBACK_KEY = "rakazo.space_rollback";
const RPC_TIMEOUT_MS = 8_000;
export const MAX_MOBILE_METADATA_BYTES = 256 * 1024;
export const MAX_MOBILE_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

function joinResponseChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset === length) break;
  }
  return bytes;
}

function artifactResponseBudget(prefix: string, bytesRead: number) {
  // The oRPC artifact schema serializes stored size before its final base64 field.
  const field = ',"contentBase64":';
  const contentField = prefix.indexOf(field);
  if (contentField < 0) throw new ResponseBodyTooLargeError(MAX_MOBILE_RPC_RESPONSE_BYTES);
  const metadata = JSON.parse(`${prefix.slice(0, contentField)}}}`) as {
    json?: { size?: number };
  };
  const size = metadata.json?.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
    throw new ResponseBodyTooLargeError(MAX_MOBILE_RPC_RESPONSE_BYTES);
  // Prefix through the field name, two string quotes and the two closing braces.
  const limit =
    new TextEncoder().encode(prefix.slice(0, contentField + field.length)).byteLength +
    Math.ceil(size / 3) * 4 +
    4;
  if (!Number.isSafeInteger(limit) || bytesRead > limit) throw new ResponseBodyTooLargeError(limit);
  return limit;
}

function parseArtifactRpcResponse(text: string) {
  const parsed = JSON.parse(text) as {
    json?: { size?: unknown; contentBase64?: unknown } | null;
  };
  if (parsed?.json != null) {
    const { size, contentBase64 } = parsed.json;
    if (typeof contentBase64 !== "string" || contentBase64.length % 4 !== 0)
      throw new Error("Incomplete artifact download");
    const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
    if (
      size !== (contentBase64.length / 4) * 3 - padding ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
    )
      throw new Error("Incomplete artifact download");
  }
  return parsed;
}

async function readArtifactRpcResponse(response: Response, signal: AbortSignal) {
  const body = response.body;
  const decoder = new TextDecoder();
  let limit = MAX_MOBILE_RPC_RESPONSE_BYTES;
  if (!body) {
    if (signal.aborted) throw signal.reason ?? new Error("Request aborted");
    const bytes = new Uint8Array(await withAbort(response.arrayBuffer(), signal));
    if (bytes.byteLength > limit) {
      artifactResponseBudget(decoder.decode(bytes.subarray(0, limit)), bytes.byteLength);
    }
    return parseArtifactRpcResponse(decoder.decode(bytes));
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      chunks.push(value);
      bytesRead += value.byteLength;
      if (bytesRead <= limit) continue;
      if (limit !== MAX_MOBILE_RPC_RESPONSE_BYTES) throw new ResponseBodyTooLargeError(limit);

      limit = artifactResponseBudget(decoder.decode(joinResponseChunks(chunks, limit)), bytesRead);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return parseArtifactRpcResponse(decoder.decode(joinResponseChunks(chunks, bytesRead)));
}

/** Inbox bootstrap reads safe to replay without a Space header during auth recovery. */
const SPACE_AUTH_RECOVERY_SAFE_PROCS = new Set(["spaces/list", "me"]);
let cachedApiBase: string | undefined;
const apiBaseListeners = new Set<() => void>();
export function subscribeApiBase(listener: () => void): () => void {
  apiBaseListeners.add(listener);
  return () => {
    apiBaseListeners.delete(listener);
  };
}
export function setCachedApiBase(url: string): void {
  if (cachedApiBase !== undefined && cachedApiBase !== url) clearUnsentSends();
  cachedApiBase = url;
  for (const listener of apiBaseListeners) listener();
}
let cachedSpaceId = "";
followSelectedSpace(() => cachedSpaceId || null);
/** Bumped on every in-memory Space selection change so a delayed response
 * cannot treat a later reselection of the same Space id as its own. */
let spaceSelectionGeneration = 0;
/** Counts selectSpace attempts so one still cleaning up a rollback record
 * cannot claim the selection after a newer attempt has started. */
let spaceSelectionRequestGeneration = 0;
/** Includes pending selections that have not claimed the in-memory space yet. */
export function spaceSelectionSeq(): number {
  return spaceSelectionRequestGeneration;
}
function bumpSpaceSelectionGeneration(): void {
  spaceSelectionGeneration += 1;
  // Another Space can belong to another organization, with its own invite link.
  selectedSpaceChanged();
}
/** Serialize endpoint switches, including persistence and rollback. */
let endpointChangeQueue: Promise<unknown> = Promise.resolve();
export function queueEndpointChange(
  url: string,
  change: (previous: string, switching: boolean) => Promise<EndpointResult>,
): Promise<EndpointResult> {
  const result = endpointChangeQueue.then(async () => {
    const previous = currentApiBase();
    return change(previous, url !== previous);
  });
  endpointChangeQueue = result.catch(() => undefined);
  return result;
}
/** Keeps a timeout or cancel reason; turns transport and parsing detail into copy. */
function requestError(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted ? (signal.reason ?? error) : new Error(errorText(error), { cause: error });
}
let serverReachable = true;
const serverReachableListeners = new Set<() => void>();
/** False from a request that could not reach the server until the server answers again. */
export function isServerReachable(): boolean {
  return serverReachable;
}
/** Calls `listener` each time the server stops or starts answering. */
export function subscribeServerReachable(listener: () => void): () => void {
  serverReachableListeners.add(listener);
  return () => {
    serverReachableListeners.delete(listener);
  };
}
export function noteServerReachable(reachable: boolean): void {
  if (reachable !== serverReachable) {
    serverReachable = reachable;
    for (const listener of [...serverReachableListeners]) listener();
  }
}
export function currentApiBase() {
  const parsed = normalizeApiBase(cachedApiBase ?? defaultApiBase());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.url;
}
export function selectedSpaceId(): string | null {
  return cachedSpaceId || null;
}
export async function clearStoredValue(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key);
    return true;
  } catch {
    return writeStoredValue(key, "");
  }
}
export async function writeStoredValue(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value);
    return true;
  } catch {
    return false;
  }
}
let clientBuild: { headers: () => Record<string, string>; onUpdateRequired: () => void } = {
  headers: () => ({}),
  onUpdateRequired: () => {},
};
/** The app names its build on every request and decides what a refused build does. */
export function configureClientBuild(options: typeof clientBuild): void {
  clientBuild = options;
}
export async function authHeaders(
  spaceId: string | null = selectedSpaceId(),
): Promise<Record<string, string>> {
  return {
    ...clientBuild.headers(),
    "x-rakazo-install-id": await loadLocalInstallSessionId(),
    ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
  };
}
export type ApiRequestContext = {
  sessionGeneration?: number;
  apiBase: string;
  headers: Record<string, string>;
};
/** Keeps consent prompts separate across servers and the selected Space. */
export function aiConsentCoalesceKey(requestContext: ApiRequestContext): string {
  return [requestContext.apiBase, requestContext.headers["x-rakazo-space-id"] ?? ""].join("\u0000");
}
/** Pins a request to the current server and session, and to a Space (the selected one by default). */
export async function captureApiRequestContext(
  spaceId: string | null = selectedSpaceId(),
): Promise<ApiRequestContext> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const headers = await authHeaders(spaceId);
  if (apiBase !== currentApiBase()) {
    throw new Error(t`The server changed while starting the request`);
  }
  if (generation !== currentSessionGeneration())
    throw new Error(t`Something went wrong. Try again.`);
  return { apiBase, headers, sessionGeneration: generation };
}
export async function fetchMobileJson<T>(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  invalidJsonFallback?: T,
): Promise<{ response: Response; body: T; invalidJson?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), RPC_TIMEOUT_MS);
  try {
    const response = await withAbort(
      fetchServer(
        input,
        {
          ...init,
          signal: controller.signal,
        },
        currentApiBase(),
      ),
      controller.signal,
      "Request timed out",
    ).catch((error: unknown) => {
      throw requestError(error, controller.signal);
    });
    try {
      const body = await readBoundedJsonResponse<T>(
        response,
        MAX_MOBILE_METADATA_BYTES,
        controller.signal,
      );
      return { response, body };
    } catch (error) {
      if (invalidJsonFallback !== undefined && error instanceof SyntaxError) {
        return { response, body: invalidJsonFallback, invalidJson: true };
      }
      throw requestError(error, controller.signal);
    }
  } finally {
    clearTimeout(timer);
  }
}
export type RpcOptions = {
  signal?: AbortSignal;
  timeoutMs?: number | null;
  requestContext?: ApiRequestContext;
  skipSpaceAuthRecovery?: boolean;
};
/** The body may be left out when the procedure takes none or every field is optional. */
export type RpcArgs<P extends RpcPath> =
  undefined extends RpcInput<P>
    ? [body?: RpcInput<P>, options?: RpcOptions]
    : // biome-ignore lint/complexity/noBannedTypes: an input whose fields are all optional
      {} extends RpcInput<P>
      ? [body?: RpcInput<P>, options?: RpcOptions]
      : [body: RpcInput<P>, options?: RpcOptions];
/** Calls a procedure from the shared contract; its path picks the body and result types. */
export function rpc<P extends RpcPath>(proc: P, ...[body, options]: RpcArgs<P>) {
  return request(proc, body, options) as Promise<RpcOutput<P>>;
}
async function request(
  proc: RpcPath,
  body: unknown = {},
  options: RpcOptions = {},
): Promise<unknown> {
  syncMobileAvatarSession(currentApiBase(), currentSessionGeneration());
  const avatarSnapshotOrder = proc === "threads/get" ? newMobileAvatarSnapshotRequest() : 0;
  const requestSpaceGeneration = spaceSelectionGeneration;
  const requestSessionGeneration = currentSessionGeneration();
  const requestApiBase = options.requestContext?.apiBase ?? currentApiBase();
  const uses = aiDataUsesForProcedure(proc, body);
  const consentContext =
    options.requestContext ?? (uses.length ? await captureApiRequestContext() : undefined);
  for (const consentTarget of aiConsentTargets(body)) {
    await ensureAiDataConsent({
      uses,
      status: () =>
        rpc("aiConsent/status", { uses, ...consentTarget }, { requestContext: consentContext }),
      prompt: promptAiConsent,
      allow: (input) =>
        rpc(
          "aiConsent/allow",
          consentTarget.settingsScope
            ? { ...input, settingsScope: consentTarget.settingsScope }
            : input,
          { requestContext: consentContext },
        ),
      coalesceKey: consentContext ? aiConsentCoalesceKey(consentContext) : undefined,
    });
  }
  // Abort with an explicit reason so every consumer of the signal (the fetch, the bounded body
  // read, and nested recovery calls that share this signal) reports the same cause.
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Request canceled"));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer =
    options.timeoutMs === null
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              Object.defineProperty(new Error("Request timed out"), "name", {
                value: "TimeoutError",
              }),
            ),
          options.timeoutMs ?? RPC_TIMEOUT_MS,
        );
  // Bind recovery to the Space + selection epoch this request was sent with:
  // a 401 arriving after the user switched Spaces — including A → B → A —
  // belongs to a stale request and must not touch the current selection.
  try {
    const requestHeaders = consentContext?.headers ?? (await authHeaders());
    const requestSpaceId = requestHeaders["x-rakazo-space-id"];
    if (
      requestApiBase !== currentApiBase() ||
      (consentContext?.sessionGeneration ?? requestSessionGeneration) !== currentSessionGeneration()
    )
      throw new Error(t`Something went wrong. Try again.`);
    let res: Response;
    const correlation = clientCorrelationHeaders();
    try {
      res = await fetchServer(
        `${requestApiBase}/rpc/${proc}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "rakazo://",
            ...requestHeaders,
            ...correlation,
          },
          body: JSON.stringify({ json: body }),
          signal: controller.signal,
        },
        requestApiBase,
      );
    } catch (error) {
      // The native fetch reports an aborted request with an implementation detail
      // ("FetchRequestCanceledException") and an unreachable server with a native stack
      // location; say what happened instead.
      if (!controller.signal.aborted)
        reportMobileError(error, "rpc.transport", responseCorrelation(new Headers(correlation)));
      throw requestError(error, controller.signal);
    }
    if (
      requestSessionGeneration === currentSessionGeneration() &&
      requestApiBase === currentApiBase()
    )
      noteServerReachable(!isUnreachableStatus(res.status));
    if (proc === "aiConsent/status" && res.status === 404) {
      cancelResponseBody(res);
      throw new Error(t`Update your server to use AI data sharing in this mobile version.`);
    }
    const artifactDownload = res.ok && (proc === "artifacts/get" || proc === "artifacts/getById");
    const parsed: { json?: unknown } = await (artifactDownload
      ? readArtifactRpcResponse(res, controller.signal)
      : readBoundedJsonResponse<{ json?: unknown }>(
          res,
          MAX_MOBILE_RPC_RESPONSE_BYTES,
          controller.signal,
        )
    ).catch((error: unknown) => {
      // A proxy, or a server without this procedure, can fail with a body that is not JSON.
      if (!res.ok && error instanceof SyntaxError) return {};
      throw requestError(error, controller.signal);
    });
    if (!res.ok) {
      // oRPC sends a failure as `{ json: { code, status, message } }`; the message is the
      // server's user-facing copy.
      const error = parsed?.json as
        | { message?: unknown; code?: unknown; data?: unknown }
        | undefined;
      const message = errorText(typeof error?.message === "string" ? error.message : "");
      const unauthorized = res.status === 401;
      // After a delete where SecureStore could not clear the stale id, restart
      // reloads it and the first RPCs 401. Probe once without a Space header:
      // success means the selection was inaccessible (clear it); failure means
      // the session itself is bad (restore the selection; it stays until
      // sign-in resets it). Never replay a mutation against the default
      // Space — only safe reads may retry as themselves; other procs probe
      // with spaces/list, then fail the original call.
      const previousSpaceId = selectedSpaceId();
      // Clear stale selection records, then re-persist a Space selected while
      // cleanup was in flight: check-then-clear cannot be atomic on
      // SecureStore, so reconcile afterwards instead of trusting the check.
      const clearStaleSpaceSelection = async () => {
        await clearStoredValue(SPACE_KEY);
        await clearStoredValue(SPACE_ROLLBACK_KEY);
        const reselected = selectedSpaceId();
        if (!reselected) return;
        // Own the reconcile write by generation: a newer selection that
        // persists between snapshot and write must not be overwritten by
        // this stale id, and a write that lands stale heals once to live.
        const writeGeneration = spaceSelectionGeneration;
        await writeStoredValue(SPACE_KEY, reselected);
        if (spaceSelectionGeneration !== writeGeneration) {
          const live = selectedSpaceId();
          if (live) await writeStoredValue(SPACE_KEY, live);
        }
      };
      if (
        unauthorized &&
        previousSpaceId &&
        requestSpaceId &&
        requestApiBase === currentApiBase() &&
        requestSessionGeneration === currentSessionGeneration() &&
        selectedSpaceId() === requestSpaceId &&
        spaceSelectionGeneration === requestSpaceGeneration &&
        !options.requestContext &&
        !options.skipSpaceAuthRecovery
      ) {
        cachedSpaceId = "";
        bumpSpaceSelectionGeneration();
        const retrySameProc = SPACE_AUTH_RECOVERY_SAFE_PROCS.has(proc);
        // Share the original deadline/cancellation with recovery calls instead
        // of starting a second full timeout behind the first request.
        const recoveryOptions: RpcOptions = {
          ...options,
          timeoutMs: null,
          signal: controller.signal,
          skipSpaceAuthRecovery: true,
        };
        try {
          if (retrySameProc) {
            const result = await request(proc, body, recoveryOptions);
            // A Space selected while the retry was in flight already owns both
            // the in-memory and durable selection; leave it alone.
            if (!selectedSpaceId()) await clearStaleSpaceSelection();
            return result;
          }
          await request("spaces/list", {}, recoveryOptions);
        } catch (retryError) {
          if (!selectedSpaceId()) {
            cachedSpaceId = previousSpaceId;
            bumpSpaceSelectionGeneration();
          }
          throw retryError;
        }
        if (!selectedSpaceId()) await clearStaleSpaceSelection();
        throw new Error(message);
      }
      throw Object.assign(
        httpError(message, res, typeof error?.code === "string" ? error.code : undefined),
        { data: error?.data },
      );
    }
    if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "json")) {
      throw new Error(t`Something went wrong. Try again.`);
    }
    const verifiedUser = parsed.json as { userId?: unknown; spaceId?: unknown } | null;
    if (
      proc === "me" &&
      typeof verifiedUser?.userId === "string" &&
      typeof verifiedUser.spaceId === "string"
    ) {
      await saveVerifiedIntegrationsScope(requestSessionGeneration, {
        apiBase: requestApiBase,
        userId: verifiedUser.userId,
        spaceId: requestSpaceId || verifiedUser.spaceId,
        selectionId: requestSpaceId ?? null,
      });
    }
    if (
      proc === "threads/get" &&
      requestSessionGeneration === currentSessionGeneration() &&
      requestApiBase === currentApiBase()
    ) {
      const snapshot = parsed.json as ThreadSnapshot;
      if (typeof snapshot?.threadId === "string" && typeof snapshot.cursor === "number")
        rememberMobileAvatarSnapshot(snapshot, avatarSnapshotOrder);
    }
    return displayIdentityResult(proc.split("/"), parsed.json, identityLabels());
  } catch (error) {
    if (
      requestSessionGeneration === currentSessionGeneration() &&
      requestApiBase === currentApiBase() &&
      isServerUnreachable(error)
    )
      noteServerReachable(false);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
/**
 * A failed response as an error the shared retry policy can read: its status, oRPC code, and any
 * Retry-After. A 426 also asks the user to update, from whichever request noticed it.
 */
export function httpError(message: string, res: Response, code?: string): Error {
  if (res.status === CLIENT_UPDATE_REQUIRED_STATUS) clientBuild.onUpdateRequired();
  return Object.defineProperties(new Error(message), {
    status: { value: res.status },
    // oRPC's error code; a proxy's bare 404 has none.
    code: { value: code },
    retryAfterMs: { value: parseRetryAfter(res.headers.get("retry-after")) },
  });
}
/** Claims the in-memory Space selection ("" clears it) and starts a new selection epoch. */
export function setSelectedSpace(id: string): void {
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
}

/** The in-memory selection as stored: "" when no Space is selected. */
export function rawSelectedSpaceId(): string {
  return cachedSpaceId;
}

/** Bumped on every in-memory Space selection change. */
export function currentSpaceSelectionGeneration(): number {
  return spaceSelectionGeneration;
}

/** Starts a selectSpace attempt; see spaceSelectionSeq. */
export function nextSpaceSelectionRequest(): number {
  return ++spaceSelectionRequestGeneration;
}
