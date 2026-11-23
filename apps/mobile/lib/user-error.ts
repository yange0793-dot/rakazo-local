import { t } from "@lingui/core/macro";
import {
  CONNECTOR_AUTH_UNAVAILABLE,
  isVoiceAccountErrorCode,
  MCP_OAUTH_CLIENT_REQUIRED,
} from "@rakazo/contracts";
import {
  CALL_NOT_RINGING_ERROR,
  isServerUnreachable,
  MODEL_IMAGE_INPUT_ERROR,
  MODEL_IMAGE_INPUT_UNKNOWN,
  userErrorMessage,
} from "@rakazo/core";

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(error: unknown, fallback = t`Something went wrong. Try again.`): string {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined;
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_ERROR)
    return t`This model cannot read images. Choose a model that supports images.`;
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_UNKNOWN)
    return t`Image input is not configured for this model.`;
  if (typeof message === "string" && message.trim() === CALL_NOT_RINGING_ERROR)
    return t`This call is no longer ringing.`;
  if (errorCode(error) === CONNECTOR_AUTH_UNAVAILABLE)
    return t`This app needs its own sign-in setup to connect.`;
  if (errorCode(error) === MCP_OAUTH_CLIENT_REQUIRED) return t`Needs an OAuth client ID`;
  return (
    voiceAccountErrorText(error) ??
    userErrorMessage(error, { fallback, offline: t`Could not reach the server` })
  );
}

/** Text for an error or `/api/voice` body whose code says the voice account needs attention. */
export function voiceAccountErrorText(error: unknown): string | undefined {
  const code = errorCode(error);
  if (!isVoiceAccountErrorCode(code)) return undefined;
  return code === "VOICE_OUT_OF_CREDIT"
    ? t`Your voice provider is out of credit.`
    : t`Your voice provider key was rejected.`;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

export type LoadFailureKind = "offline" | "session" | "server" | "other";

/** Why a load failed, when the error says: no answer, a rejected session, or a server fault. */
export function loadFailureKind(error: unknown): LoadFailureKind {
  if (isServerUnreachable(error)) return "offline";
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  if (status === 401) return "session";
  if (typeof status === "number" && status >= 500) return "server";
  return "other";
}

/** Keep useful boot details; the screen supplies the recovery title and copy. */
export function computerBootErrorDetail(error: unknown): string | null {
  if (isServerUnreachable(error) || loadFailureKind(error) === "server") return null;
  const detail = errorText(error, "");
  return !detail ||
    /^(?:internal server error|server error|http\s+5\d{2}\b|5\d{2}\b)|time[ -]?out|timed out/i.test(
      detail,
    )
    ? null
    : detail;
}
