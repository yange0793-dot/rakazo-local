import { createHash, randomUUID } from "node:crypto";

export const TERMINAL_OPERATIONS = new Set(["completed", "failed", "cancelled"]);
const STATES = new Set([
  "registered", "dispatching", "accepted", "queued", "running",
  ...TERMINAL_OPERATIONS, "unknown",
]);

export function capabilities(agent) {
  return {
    operationLookup: true,
    events: true,
    steer: true,
    cancelConfirmation: true,
    inputResponse: agent === "codex",
    inputResponseAfterRestart: false,
    nativeOperationLookup: false,
  };
}

export function protocol(agent) {
  return {
    protocolVersion: 1,
    capabilities: capabilities(agent),
    ...(agent ? {} : { capabilitiesByAgent: {
      codex: capabilities("codex"), claude: capabilities("claude"),
    } }),
  };
}

export function refusal(message, code = "operation_conflict") {
  return Object.assign(new Error(message), { code, confirmed: true });
}

export function operationKey(input = {}, generate = true) {
  if (input.requestId != null && input.operationKey != null && input.requestId !== input.operationKey) {
    throw refusal("requestId and operationKey must match.");
  }
  const key = input.requestId ?? input.operationKey;
  if (key != null && (typeof key !== "string" || !key.trim())) {
    throw refusal("Operation key must be a non-empty string.");
  }
  return key ?? (generate ? randomUUID() : undefined);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function fingerprint(input) {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

export function operationUpdate(current, input, at = new Date().toISOString()) {
  if (!STATES.has(input.state)) throw new Error(`Invalid operation state: ${input.state}`);
  // A late start/steer ACK cannot resurrect a turn that already ended.
  if (TERMINAL_OPERATIONS.has(current.state)) return current;
  const rank = (value) => value.state === "queued" ? value.queueOwner === "native" ? 2 : 0 :
    ({ registered: 0, dispatching: 1, accepted: 2, running: 3 })[value.state];
  if (current.state !== "unknown" && input.state !== "unknown" &&
      rank(current) != null && rank(input) != null && rank(input) < rank(current)) {
    return current;
  }
  const fields = [
    "state", "queueOwner", "turnId", "turnIdSource", "nativeSessionId", "nativeMessageId",
    "delivery", "proof", "error", "stopConfirmed", "inputRequestId", "targetRequestId",
    "expectedTurnId", "dispatchStartedAt",
  ];
  const next = { ...current };
  for (const key of fields) if (input[key] !== undefined) next[key] = input[key];
  next.updatedAt = at;
  if (input.state === "unknown") next.lastKnownState = current.state === "unknown" ? current.lastKnownState : current.state;
  if (input.state === "accepted" || input.state === "running" ||
      (input.state === "queued" && input.queueOwner === "native")) {
    next.acceptedAt ??= at;
    next.queueOwner = input.state === "queued" ? "native" : null;
  }
  if (TERMINAL_OPERATIONS.has(input.state)) {
    next.finishedAt = at;
    next.queueOwner = null;
  }
  return next;
}
