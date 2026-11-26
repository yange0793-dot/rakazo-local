import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PhoneStore } from "./store.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-phone-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const emissions = new Map();
  const adapter = async ({ cwd, onEvent, nativeSessionId }) => {
    const id = nativeSessionId || `native-${calls.length}`;
    const turnId = `turn-${id}`;
    const active = new Set();
    emissions.set(id, onEvent);
    return {
      async send(message, { operationKey }) {
        calls.push({ cwd, message, id });
        active.add(operationKey);
        onEvent({ type: "operation", operationKey, state: "running", turnId, nativeSessionId: id, proof: "native_ack" });
        onEvent({ type: "status", status: "running", nativeSessionId: id, turnId });
        return { delivery: "started", nativeSessionId: id, turnId, state: "running", proof: "native_ack" };
      },
      async stop() {
        for (const operationKey of active) onEvent({ type: "operation", operationKey, state: "cancelled", turnId, proof: "native_terminal" });
        active.clear();
        onEvent({ type: "status", status: "stopped", turnId });
        return { stopConfirmed: true, turnId, proof: "native_terminal" };
      },
      async close() {},
    };
  };
  const options = { directory, adapters: { codex: adapter, claude: adapter } };
  return { directory, calls, emissions, options, store: new PhoneStore(options) };
}

test("a launch returns independently; follow-ups keep the native conversation", async (t) => {
  const { store, directory, calls } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "first", requestId: "task-1" });
  await store.sending.get(session.id);
  await store.send(session.id, "second");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, calls[1].id);
  assert.equal(store.get(session.id).status, "running");
});

test("duplicate launches and messages do not repeat native work", async (t) => {
  const { store, directory, calls } = fixture(t);
  const input = { agent: "codex", cwd: directory, message: "first", requestId: "task-1" };
  const { session } = await store.start(input);
  const repeat = await store.start(input);
  await store.sending.get(session.id);
  assert.equal(repeat.session.id, session.id);
  await Promise.all([store.send(session.id, "follow-up", "m2"), store.send(session.id, "follow-up", "m2")]);
  assert.deepEqual(calls.map((call) => call.message), ["first", "follow-up"]);
});

test("long polling resolves on progress with an incremental cursor", async (t) => {
  const { store, directory, emissions } = fixture(t);
  const { session } = await store.start({ agent: "claude", cwd: directory, message: "first" });
  await store.sending.get(session.id);
  const cursor = session.cursor;
  const waiting = store.watch(session.id, cursor, 5000);
  emissions.get(session.nativeSessionId)({ type: "text", text: "live progress" });
  const result = await waiting;
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].text, "live progress");
  assert.equal(result.cursor, cursor + 1);
  assert.equal(store.listenerCount("event"), 0);
});

test("restart preserves native identity and log cursor without replaying work", async (t) => {
  const { store, directory, options, emissions, calls } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "first" });
  await store.sending.get(session.id);
  emissions.get(session.nativeSessionId)({ type: "text", text: "unsnapshotted delta" });
  const cursor = session.cursor;
  const resumed = new PhoneStore(options);
  assert.equal(resumed.get(session.id).status, "interrupted");
  assert.equal(resumed.get(session.id).cursor, cursor + 1);
  const restartEvent = (await resumed.read(session.id, cursor)).events[0];
  assert.equal(restartEvent.operation.state, "unknown");
  assert.equal(restartEvent.operation.lastKnownState, "running");
  assert.equal(calls.length, 1);
  await resumed.send(session.id, "continue explicitly");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, calls[1].id);
});

test("stopping confirms adapter status and retains conversation history", async (t) => {
  const { store, directory } = fixture(t);
  const { session } = await store.start({ agent: "claude", cwd: directory, message: "first" });
  await store.sending.get(session.id);
  await store.stop(session.id);
  assert.equal(store.get(session.id).status, "stopped");
  assert.ok((await store.read(session.id)).events.some((event) => event.type === "user"));
});

test("cancelling a monitor does not cancel the native task", async (t) => {
  const { store, directory } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "first" });
  await store.sending.get(session.id);
  const controller = new AbortController();
  const waiting = store.watch(session.id, session.cursor, 5000, 100, controller.signal);
  controller.abort();
  await waiting;
  assert.equal(store.get(session.id).status, "running");
  assert.equal(store.listenerCount("event"), 0);
});

test("inspect finds a lost launch response by its key and never connects or resends", async (t) => {
  const { store, directory, calls } = fixture(t);
  assert.equal(store.inspect().protocolVersion, 1);
  assert.equal(store.inspect().capabilities.operationLookup, true);
  assert.equal(store.inspect().capabilities.inputResponse, false);
  assert.equal(store.inspect({ agent: "codex" }).capabilities.inputResponse, true);
  assert.equal(store.inspect({ requestId: "missing" }).found, false);
  assert.equal(calls.length, 0);
  const started = await store.start({ agent: "codex", cwd: directory, message: "work", operationKey: "launch-key" });
  const saved = store.inspect({ requestId: "launch-key" });
  assert.equal(saved.found, true);
  assert.equal(saved.session.id, started.session.id);
  assert.equal(saved.operation.state, "queued");
  assert.equal(saved.operation.queueOwner, "local");
  assert.equal(saved.operation.acceptedAt, undefined);
  const duplicate = await store.start({ agent: "codex", cwd: directory, message: "work", requestId: "launch-key" });
  assert.equal(duplicate.duplicate, true);
  await store.sending.get(started.session.id);
  assert.equal(calls.length, 1);
  assert.equal(store.inspect({ operationKey: "launch-key" }).operation.state, "running");
});

test("an operation key cannot be repurposed across payloads, kinds or sessions", async (t) => {
  const { store, directory, calls } = fixture(t);
  const input = { agent: "codex", cwd: directory, message: "one", requestId: "unique" };
  const { session } = await store.start(input);
  await store.sending.get(session.id);
  await assert.rejects(store.start({ ...input, message: "different" }), /different request/);
  await assert.rejects(store.send(session.id, "one", "unique"), /different request/);
  await assert.rejects(store.start({ ...input, operationKey: "mismatch" }), /must match/);
  assert.equal(store.inspect({ sessionId: "not-this-session", requestId: "unique" }).found, false);
  assert.equal(calls.length, 1);
});

test("a lost send acknowledgement remains unknown on duplicate and restart", async (t) => {
  const { directory } = fixture(t);
  let calls = 0;
  const options = {
    directory,
    adapters: { codex: async () => ({
      async send() { calls++; throw new Error("ACK lost after native transmission"); },
      async close() {},
    }) },
  };
  const store = new PhoneStore(options);
  const input = { agent: "codex", cwd: directory, message: "do once", requestId: "uncertain" };
  const { session } = await store.start(input);
  await store.sending.get(session.id).catch(() => {});
  assert.equal(store.inspect({ requestId: "uncertain" }).operation.state, "unknown");
  const again = await store.start(input);
  assert.equal(again.operation.state, "unknown");
  const restored = new PhoneStore(options);
  assert.equal((await restored.start(input)).operation.state, "unknown");
  assert.equal(calls, 1);
  await assert.rejects(restored.stop(session.id, { requestId: "stop-uncertain" }), /cannot be confirmed stopped/);
  assert.equal(restored.inspect({ requestId: "stop-uncertain" }).operation.state, "unknown");
});

test("confirmed acceptance survives restart as evidence, not as a claim work is still running", async (t) => {
  const { store, directory, options, calls } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "work", requestId: "accepted" });
  await store.sending.get(session.id);
  const before = store.inspect({ requestId: "accepted" }).operation;
  const restored = new PhoneStore(options);
  const after = restored.inspect({ requestId: "accepted" }).operation;
  assert.equal(after.state, "unknown");
  assert.equal(after.acceptedAt, before.acceptedAt);
  assert.equal(after.turnId, before.turnId);
  assert.equal(after.lastKnownState, "running");
  assert.equal(calls.length, 1);
});

test("a terminal event preceding the adapter return is not overwritten by its start receipt", async (t) => {
  const { directory } = fixture(t);
  const store = new PhoneStore({
    directory, adapters: { codex: async ({ onEvent }) => ({
      async send(_text, { operationKey }) {
        onEvent({ type: "operation", operationKey, state: "completed", turnId: "quick", proof: "native_terminal" });
        return { state: "running", turnId: "quick", proof: "native_ack" };
      },
    }) },
  });
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "fast", requestId: "fast" });
  await store.sending.get(session.id);
  assert.equal(store.inspect({ requestId: "fast" }).operation.state, "completed");
  const events = (await store.read(session.id)).events;
  assert.equal(new Set(events.map((event) => event.providerEventId)).size, events.length);
  assert.equal(events.findLast((event) => event.operation)?.operation.state, "completed");
});

test("repeating an old stop returns its receipt without cancelling later explicit work", async (t) => {
  const { store, directory, calls } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "work", requestId: "first" });
  await store.sending.get(session.id);
  const stop = await store.stop(session.id, { requestId: "stop-first", targetRequestId: "first" });
  assert.equal(stop.operation.stopConfirmed, true);
  assert.equal(stop.operation.state, "completed");
  await store.send(session.id, "continue", "next");
  const repeat = await store.stop(session.id, { requestId: "stop-first", targetRequestId: "first" });
  assert.equal(repeat.duplicate, true);
  assert.equal(store.get(session.id).status, "running");
  assert.equal(store.inspect({ requestId: "next" }).operation.state, "running");
  assert.equal(calls.length, 2);
});

test("a stale expected turn is rejected before the native stop", async (t) => {
  const { store, directory } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "work" });
  await store.sending.get(session.id);
  await assert.rejects(store.stop(session.id, { requestId: "stale-stop", expectedTurnId: "older-turn" }), /does not match/);
  assert.equal(store.inspect({ requestId: "stale-stop" }).operation.state, "failed");
  assert.equal(session.status, "running");
});

test("stop before local dispatch cancels the queued launch without native work", async (t) => {
  const { store, directory, calls } = fixture(t);
  const started = store.start({ agent: "codex", cwd: directory, message: "never run", requestId: "queued" });
  const session = store.inspect({ requestId: "queued" }).session;
  const stopping = store.stop(session.id, { requestId: "cancel-local", targetRequestId: "queued" });
  await started;
  const stopped = await stopping;
  assert.equal(stopped.operation.stopConfirmed, true);
  assert.equal(store.inspect({ requestId: "queued" }).operation.state, "cancelled");
  assert.equal(calls.length, 0);
});

test("an unconfirmed stop does not become stopped merely because the adapter returned", async (t) => {
  const { store, directory } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "work" });
  await store.sending.get(session.id);
  store.connections.get(session.id).stop = async () => ({ acknowledgement: true });
  await assert.rejects(store.stop(session.id, { requestId: "no-proof" }), /not confirmed/);
  assert.equal(store.inspect({ requestId: "no-proof" }).operation.state, "unknown");
  assert.equal(store.inspect({ requestId: "no-proof" }).operation.stopConfirmed, undefined);
});

test("journal replay repairs an index behind terminal evidence without replaying work", async (t) => {
  const { store, directory, options, calls } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "work", requestId: "journal" });
  await store.sending.get(session.id);
  const beforeTerminal = fs.readFileSync(path.join(directory, "sessions.json"));
  store.record(session.id, { type: "operation", operationKey: "journal", state: "completed", proof: "native_terminal" });
  store.record(session.id, { type: "status", status: "idle" });
  fs.writeFileSync(path.join(directory, "sessions.json"), beforeTerminal);
  fs.appendFileSync(path.join(directory, `${session.id}.jsonl`), '{"partial":');
  const restored = new PhoneStore(options);
  assert.equal(restored.inspect({ requestId: "journal" }).operation.state, "completed");
  assert.equal(restored.get(session.id).status, "idle");
  assert.equal(calls.length, 1);
  assert.ok((await restored.read(session.id)).events.every((event) => event.providerEventId));
});

test("legacy sentRequestIds migrate to unknown receipts and are not replayed", async (t) => {
  const { directory, options, calls } = fixture(t);
  const legacy = {
    id: "legacy-session", agent: "codex", cwd: directory, status: "idle", cursor: 0,
    requestId: "old-launch", sentRequestIds: ["old-launch", "old-send"],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(directory, "sessions.json"), JSON.stringify([legacy]));
  const store = new PhoneStore(options);
  assert.equal(store.inspect({ requestId: "old-launch" }).operation.state, "unknown");
  const duplicate = await store.send(legacy.id, "do not replay", "old-send");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.operation.state, "unknown");
  assert.equal(calls.length, 0);
});

test("an unknown older input without a turn cannot cancel newer work", async (t) => {
  const { store, directory } = fixture(t);
  const { session } = await store.start({ agent: "codex", cwd: directory, message: "current", requestId: "current" });
  await store.sending.get(session.id);
  const older = store.register(session.id, "older-unknown", "send", "hash");
  store.update(older, { state: "unknown", proof: "lost_ack" });
  await assert.rejects(store.stop(session.id, {
    requestId: "late-cancel", targetRequestId: "older-unknown",
  }), /no confirmed native turn/);
  assert.equal(store.inspect({ requestId: "current" }).operation.state, "running");
  assert.equal(session.status, "running");
});

test("a completed foreground input does not bypass stopping live background work", async (t) => {
  const { store, directory } = fixture(t);
  const { session } = await store.start({ agent: "claude", cwd: directory, message: "work", requestId: "foreground" });
  await store.sending.get(session.id);
  store.update(store.operations.get("foreground"), { state: "completed", proof: "foreground_result" });
  assert.equal(session.status, "running");
  const stopped = await store.stop(session.id, { requestId: "stop-background", targetRequestId: "foreground" });
  assert.equal(stopped.operation.stopConfirmed, true);
  assert.equal(session.status, "stopped");
  assert.equal(store.inspect({ requestId: "foreground" }).operation.state, "completed");
});

test("close prevents a queued native dispatch after service shutdown starts", async (t) => {
  const { store, directory, calls } = fixture(t);
  const started = store.start({ agent: "codex", cwd: directory, message: "queued", requestId: "shutdown" });
  await store.close();
  await started;
  assert.equal(calls.length, 0);
  assert.equal(store.inspect({ requestId: "shutdown" }).operation.state, "cancelled");
});
