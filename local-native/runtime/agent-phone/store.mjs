import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { TERMINAL_OPERATIONS, fingerprint, operationKey, operationUpdate, protocol, refusal } from "./operations.mjs";

const activeStatuses = new Set(["connecting", "running", "stopping"]);

function applySessionEvent(session, event) {
  session.updatedAt = event.at;
  if (event.nativeSessionId) session.nativeSessionId = event.nativeSessionId;
  if (event.turnId && event.type === "status" && ["running", "stopping"].includes(event.status)) session.turnId = event.turnId;
  if (typeof event.connected === "boolean") session.connected = event.connected;
  if (typeof event.deliveryUnknown === "boolean") session.deliveryUnknown = event.deliveryUnknown;
  if (event.type === "status") session.status = event.status;
  if (event.type === "result") {
    session.result = event.text ?? "";
    session.usage = event.usage ?? session.usage;
  }
  if (event.type === "error") session.error = event.message;
  if (event.inputRequestId != null && event.status === "waiting_input") {
    session.pendingInputRequests = (session.pendingInputRequests ?? []).filter((request) => request.inputRequestId !== event.inputRequestId);
    session.pendingInputRequests.push(event);
  }
  if (event.type === "input_resolved") {
    session.pendingInputRequests = (session.pendingInputRequests ?? []).filter((request) => request.inputRequestId !== event.inputRequestId);
  }
}

export class PhoneStore extends EventEmitter {
  constructor({ directory, adapters, env = process.env }) {
    super();
    this.directory = directory;
    this.adapters = adapters;
    this.env = env;
    this.sessions = new Map();
    this.connections = new Map();
    this.connecting = new Map();
    this.sending = new Map();
    this.stopping = new Map();
    this.operations = new Map();
    this.closing = false;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const index = path.join(directory, "sessions.json");
    if (fs.existsSync(index)) {
      for (const session of JSON.parse(fs.readFileSync(index, "utf8"))) {
        const log = path.join(directory, `${session.id}.jsonl`);
        session.operations ??= [];
        if (fs.existsSync(log)) {
          // The append-only journal can be ahead of the index after a crash.
          const text = fs.readFileSync(log, "utf8");
          // Only an incomplete tail can be discarded; a corrupt committed
          // record remains an error rather than silently losing evidence.
          const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
          if (complete.length !== text.length) fs.truncateSync(log, Buffer.byteLength(complete));
          for (const line of complete.split("\n").filter(Boolean)) {
            const event = JSON.parse(line);
            session.cursor = event.seq;
            applySessionEvent(session, event);
            if (event.operation) {
              const previous = session.operations.findIndex((op) => op.operationKey === event.operation.operationKey);
              if (previous >= 0) session.operations[previous] = event.operation;
              else session.operations.push(event.operation);
            }
          }
        }
        const legacyKeys = new Set([session.requestId, ...(session.sentRequestIds ?? [])].filter(Boolean));
        for (const key of legacyKeys) {
          if (session.operations.some((op) => op.operationKey === key)) continue;
          session.operations.push({
            requestId: key, operationKey: key, sessionId: session.id,
            kind: key === session.requestId ? "start" : "send", state: "unknown",
            queueOwner: null, legacy: true, createdAt: session.createdAt, updatedAt: session.updatedAt,
            proof: "legacy_registration_without_operation_receipt",
          });
        }
        for (const op of session.operations) this.operations.set(op.operationKey, op);
        if (activeStatuses.has(session.status)) session.status = "interrupted";
        session.connected = false;
        session.pendingInputRequests = (session.pendingInputRequests ?? []).map((request) => ({ ...request, resumable: false }));
        this.sessions.set(session.id, session);
      }
    }
    for (const op of [...this.operations.values()]) {
      if (TERMINAL_OPERATIONS.has(op.state) || op.state === "unknown") continue;
      const localOnly = !op.dispatchStartedAt && !op.acceptedAt;
      this.record(op.sessionId, {
        type: "operation", operationKey: op.operationKey,
        state: localOnly ? "cancelled" : "unknown",
        proof: localOnly ? "restart_before_native_dispatch" : "service_restart_without_native_terminal",
      });
    }
    this.save();
  }

  save() {
    const dest = path.join(this.directory, "sessions.json");
    fs.writeFileSync(`${dest}.tmp`, JSON.stringify([...this.sessions.values()], null, 2), { mode: 0o600 });
    fs.renameSync(`${dest}.tmp`, dest);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown conversation: ${id}`);
    return session;
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  inspect(input = {}) {
    const key = operationKey(input, false);
    const operation = key ? this.operations.get(key) : undefined;
    const session = input.sessionId ? this.sessions.get(input.sessionId) :
      operation ? this.sessions.get(operation.sessionId) : undefined;
    const base = protocol(session?.agent ?? input.agent);
    if (!key && !input.sessionId) return base;
    if (!session || (key && (!operation || operation.sessionId !== session.id))) return { ...base, found: false };
    return {
      ...base, found: true, session,
      ...(operation ? { operation } : { operations: session.operations }),
      pendingInputRequests: session.pendingInputRequests ?? [],
    };
  }

  reply(operation, extra = {}) {
    const current = this.operations.get(operation.operationKey);
    const session = this.get(current.sessionId);
    return { ...protocol(session.agent), session, operation: current, ...extra };
  }

  existing(key, kind, inputHash, sessionId) {
    const operation = this.operations.get(key);
    if (!operation) return null;
    if (operation.kind !== kind || (sessionId && operation.sessionId !== sessionId) ||
        (operation.inputHash && operation.inputHash !== inputHash)) {
      throw refusal("Operation key already belongs to a different request.");
    }
    return this.reply(operation, { duplicate: true, ...(operation.delivery ? { delivery: operation.delivery } : {}) });
  }

  register(id, key, kind, inputHash, fields = {}) {
    const now = new Date().toISOString();
    const operation = {
      requestId: key, operationKey: key, sessionId: id, kind,
      state: "registered", queueOwner: null, inputHash, createdAt: now, updatedAt: now, ...fields,
    };
    this.record(id, { type: "operation", operationKey: key, operation });
    return operation;
  }

  update(operation, fields) {
    return this.record(operation.sessionId, { type: "operation", operationKey: operation.operationKey, ...fields });
  }

  record(id, input) {
    const session = this.get(id);
    const seq = ++session.cursor;
    const event = { ...input, sessionId: id, seq, providerEventId: `${id}:${seq}`, at: new Date().toISOString() };
    if (event.type === "operation") {
      const previous = this.operations.get(event.operationKey);
      const operation = event.operation ?? (previous ? operationUpdate(previous, event, event.at) : null);
      if (operation) {
        event.operation = operation;
        event.state = operation.state;
        this.operations.set(operation.operationKey, operation);
        const index = session.operations.findIndex((op) => op.operationKey === operation.operationKey);
        if (index < 0) session.operations.push(operation);
        else session.operations[index] = operation;
        if (operation.nativeSessionId) session.nativeSessionId = operation.nativeSessionId;
      }
    }
    if (!event.operationKeys?.length && event.turnId) {
      event.operationKeys = session.operations.filter((op) => op.turnId === event.turnId && op.kind !== "stop").map((op) => op.operationKey);
    }
    if (!event.operationKey && event.operationKeys?.length === 1) event.operationKey = event.operationKeys[0];
    applySessionEvent(session, event);
    fs.appendFileSync(path.join(this.directory, `${id}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (event.type !== "text") this.save();
    this.emit("event", event);
    return event;
  }

  async connect(id) {
    const session = this.get(id);
    if (session.agent === "codex" && session.connected === false && this.connections.has(id)) {
      const previous = this.connections.get(id);
      this.connections.delete(id);
      await previous.close();
    }
    if (this.connections.has(id)) return this.connections.get(id);
    if (this.connecting.has(id)) return this.connecting.get(id);
    const pending = this.adapters[session.agent]({
      cwd: session.cwd,
      model: session.model,
      nativeSessionId: session.nativeSessionId,
      env: this.env,
      onEvent: (event) => this.record(id, event),
    }).then((adapter) => {
      this.connections.set(id, adapter);
      return adapter;
    }).finally(() => this.connecting.delete(id));
    this.connecting.set(id, pending);
    return pending;
  }

  async start({ agent, cwd, message, title, model, requestId, operationKey: alias }) {
    if (this.closing) throw refusal("The phone service is closing.");
    if (!this.adapters[agent]) throw new Error("Agent must be codex or claude");
    if (typeof message !== "string" || !message.trim()) throw new Error("A message is required");
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("cwd must be an existing absolute directory");
    const key = operationKey({ requestId, operationKey: alias });
    const inputHash = fingerprint({ agent, cwd: fs.realpathSync(cwd), message, model });
    const existing = this.existing(key, "start", inputHash);
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    const session = {
      id, agent, cwd: fs.realpathSync(cwd), title: title || message.slice(0, 60),
      ...(model ? { model } : {}), requestId: key, operations: [],
      status: "connecting", cursor: 0, createdAt: now, updatedAt: now,
    };
    this.sessions.set(id, session);
    this.record(id, { type: "created", agent, title: session.title });
    const operation = this.register(id, key, "start", inputHash);
    // The persistent service owns the launch; disconnecting an MCP caller does not kill it.
    void this.dispatch(operation, message, {}).catch(() => {});
    return this.reply(operation, { delivery: "connecting" });
  }

  async send(id, message, requestId, options = {}) {
    const session = this.get(id);
    if (options.inputRequestId == null && (typeof message !== "string" || !message.trim())) throw new Error("A message is required");
    const key = operationKey({ ...options, requestId });
    const kind = options.inputRequestId != null ? "input_response" : "send";
    const inputHash = fingerprint({ message, expectedTurnId: options.expectedTurnId, inputRequestId: options.inputRequestId, answers: options.answers });
    const existing = this.existing(key, kind, inputHash, id);
    if (existing) return existing;
    if (this.closing) throw refusal("The phone service is closing.");
    if (this.stopping.has(id)) throw refusal("The conversation is stopping; the message was not sent.", "stop_in_progress");
    if (kind === "input_response" && (!this.connections.has(id) || session.agent !== "codex")) {
      throw refusal("This input request cannot be answered on the current connection.", "input_response_unavailable");
    }
    const operation = this.register(id, key, kind, inputHash, {
      ...(options.expectedTurnId ? { expectedTurnId: options.expectedTurnId } : {}),
      ...(options.inputRequestId != null ? { inputRequestId: options.inputRequestId } : {}),
    });
    return this.dispatch(operation, message, options);
  }

  dispatch(operation, message, options) {
    const id = operation.sessionId;
    const session = this.get(id);
    const prior = this.sending.get(id) ?? Promise.resolve();
    this.update(operation, { state: "queued", queueOwner: "local", proof: "phone_dispatch_queue" });
    const send = prior.catch(() => {}).then(async () => {
      if (this.stopping.has(id) || this.closing) {
        this.update(operation, { state: "cancelled", proof: "local_queue_cancelled_before_dispatch" });
        return this.reply(operation);
      }
      this.record(id, { type: "user", text: message, requestId: operation.operationKey, operationKey: operation.operationKey });
      let dispatched = false;
      try {
        const adapter = await this.connect(id);
        if (this.stopping.has(id) || this.closing) {
          this.update(operation, { state: "cancelled", proof: "local_queue_cancelled_before_dispatch" });
          return this.reply(operation);
        }
        this.update(operation, { state: "dispatching", queueOwner: null, dispatchStartedAt: new Date().toISOString() });
        dispatched = true;
        const context = { ...options, operationKey: operation.operationKey };
        const receipt = operation.kind === "input_response"
          ? await adapter.respondInput(context)
          : await adapter.send(message, context);
        if (receipt.nativeSessionId) session.nativeSessionId = receipt.nativeSessionId;
        this.update(operation, {
          ...receipt, state: receipt.state ?? "unknown",
          proof: receipt.proof ?? "adapter_return_without_native_acceptance",
        });
        this.record(id, { type: "delivery", operationKey: operation.operationKey, ...receipt });
        return this.reply(operation, receipt);
      } catch (error) {
        this.update(operation, { state: !dispatched || error.confirmed ? "failed" : "unknown", error: error.message });
        this.record(id, { type: "error", operationKey: operation.operationKey, message: error.message });
        error.operation = this.operations.get(operation.operationKey);
        throw error;
      }
    });
    this.sending.set(id, send);
    void send.finally(() => { if (this.sending.get(id) === send) this.sending.delete(id); }).catch(() => {});
    return send;
  }

  async read(id, after = 0, limit = 100) {
    const session = this.get(id);
    const events = [];
    const file = path.join(this.directory, `${id}.jsonl`);
    if (fs.existsSync(file)) {
      const input = fs.createReadStream(file);
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line);
          event.providerEventId ??= `${id}:${event.seq}`;
          if (event.seq > after) events.push(event);
          if (events.length >= limit) break;
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
    const cursor = events.at(-1)?.seq ?? after;
    return { session, events, cursor, hasMore: cursor < session.cursor };
  }

  async watch(id, after = 0, waitMs = 20000, limit = 100, signal) {
    this.get(id);
    if (this.get(id).cursor <= after && waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.off("event", listener);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const listener = (event) => { if (event.sessionId === id && event.seq > after) done(); };
        const timer = setTimeout(done, Math.min(waitMs, 25000));
        this.on("event", listener);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted || this.get(id).cursor > after) done();
      });
    }
    return this.read(id, after, limit);
  }

  async stop(id, options = {}) {
    const session = this.get(id);
    const key = operationKey(options);
    const inputHash = fingerprint({ expectedTurnId: options.expectedTurnId, targetRequestId: options.targetRequestId });
    const existing = this.existing(key, "stop", inputHash, id);
    if (existing) return existing;
    if (this.stopping.has(id)) throw refusal("A stop is already settling; inspect its receipt.", "stop_in_progress");
    const target = options.targetRequestId ? this.operations.get(options.targetRequestId) : null;
    if (options.targetRequestId && (!target || target.sessionId !== id || target.kind === "stop")) throw refusal("Unknown target operation.");
    const operation = this.register(id, key, "stop", inputHash, {
      expectedTurnId: options.expectedTurnId ?? (target ? target.turnId : this.sending.has(id) ? null : session.turnId) ?? null,
      ...(target ? { targetRequestId: target.operationKey } : {}),
    });
    // Claude can finish its foreground result while native background work
    // remains active. A terminal input is not proof that that process stopped.
    const targetIsSettled = (op) => op && TERMINAL_OPERATIONS.has(op.state) &&
      !(op.turnId && op.turnId === session.turnId && activeStatuses.has(session.status));
    if (targetIsSettled(target)) {
      this.update(operation, { state: "completed", stopConfirmed: true, proof: "target_already_terminal" });
      return this.reply(operation);
    }
    if (operation.expectedTurnId && session.turnId && operation.expectedTurnId !== session.turnId) {
      this.update(operation, { state: "failed", error: "Stop target does not match the current turn." });
      throw Object.assign(refusal("Stop target does not match the current turn.", "turn_mismatch"), {
        operation: this.operations.get(key),
      });
    }
    if (target?.state === "unknown" && !target.turnId && !options.expectedTurnId) {
      this.update(operation, { state: "unknown", error: "The target operation has no confirmed native turn to cancel." });
      throw Object.assign(new Error("The target operation has no confirmed native turn to cancel."), {
        operation: this.operations.get(key),
      });
    }
    const prior = this.sending.get(id);
    const pending = Promise.resolve().then(async () => {
      try {
        if (prior) await prior.catch(() => {});
        const currentTarget = target ? this.operations.get(target.operationKey) : null;
        if (targetIsSettled(currentTarget)) {
          this.update(operation, { state: "completed", stopConfirmed: true, proof: "target_already_terminal" });
          return this.reply(operation);
        }
        if (currentTarget && !currentTarget.turnId && !options.expectedTurnId) {
          throw new Error("The target operation has no confirmed native turn to cancel.");
        }
        const adapter = this.connections.get(id) ?? await this.connecting.get(id);
        if (!adapter) {
          if (session.status === "interrupted" || session.operations.some((op) => op.kind !== "stop" && op.state === "unknown")) {
            throw new Error("The service restarted. Native execution cannot be confirmed stopped from the saved journal.");
          }
          this.update(operation, { state: "completed", stopConfirmed: true, proof: "no_native_dispatch" });
          return this.reply(operation);
        }
        const expectedTurnId = options.expectedTurnId ?? currentTarget?.turnId ??
          operation.expectedTurnId ?? (target ? undefined : session.turnId);
        if (expectedTurnId && session.turnId && expectedTurnId !== session.turnId) throw refusal("Stop target does not match the current turn.", "turn_mismatch");
        this.update(operation, { state: "dispatching", dispatchStartedAt: new Date().toISOString() });
        const receipt = await adapter.stop({ expectedTurnId, operationKey: key });
        if (!receipt?.stopConfirmed) throw new Error("The adapter has not confirmed that execution stopped.");
        this.update(operation, { ...receipt, state: "completed" });
        return this.reply(operation, receipt);
      } catch (error) {
        this.update(operation, { state: error.confirmed ? "failed" : "unknown", error: error.message });
        error.operation = this.operations.get(key);
        throw error;
      }
    }).finally(() => { if (this.stopping.get(id) === pending) this.stopping.delete(id); });
    this.stopping.set(id, pending);
    return pending;
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.allSettled([...this.connections.values()].map((adapter) => adapter.close()));
    await Promise.allSettled([...this.sending.values()]);
    this.save();
  }
}
