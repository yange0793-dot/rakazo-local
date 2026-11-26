import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createClaudeAdapter } from "./claude.mjs";

const SESSION = "9d70ca17-bd0b-49c0-bf81-f12f9ad689cd";

function nativeProcess({ interrupt = true, initializeError, onInput } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.messages = [];
  child.signals = [];
  child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.finish = (code = 0, signal = null) => {
    if (child.finished) return;
    child.finished = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  };
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => child.finish(null, signal));
    return true;
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split("\n")) {
        const message = JSON.parse(line);
        child.messages.push(message);
        queueMicrotask(() => {
          if (message.type === "control_request") {
            if (message.request.subtype === "initialize") {
              child.send({
                type: "control_response",
                response: initializeError
                  ? { subtype: "error", request_id: message.request_id, error: initializeError }
                  : { subtype: "success", request_id: message.request_id, response: {} },
              });
            } else if (message.request.subtype === "interrupt" && interrupt) {
              child.send({
                type: "control_response",
                response: { subtype: "success", request_id: message.request_id, response: {} },
              });
            }
          } else if (message.type === "user") onInput?.(message, child);
        });
      }
      callback();
    },
    final(callback) {
      callback();
      queueMicrotask(() => child.finish());
    },
  });
  return child;
}

async function fixture(t, options = {}) {
  const events = [];
  const processes = [];
  const calls = [];
  t.mock.method(childProcess, "spawn", (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const child = nativeProcess(options);
    processes.push(child);
    return child;
  });
  const adapter = await createClaudeAdapter({
    cwd: "/tmp", onEvent: (event) => events.push(event),
    ...options.adapter,
  });
  t.after(() => adapter.close());
  return { adapter, events, processes, calls };
}

const turnResult = (sessionId, fields = {}) => ({
  type: "result", subtype: "success", is_error: false,
  session_id: sessionId, result: "done", ...fields,
});

test("starts the native duplex CLI without replacing local model or settings", async (t) => {
  const { adapter, calls, processes, events } = await fixture(t, {
    adapter: { env: { CLAUDECODE: "parent", CLAUDE_TEST_MARKER: "passed" } },
  });
  const call = calls[0];
  assert.equal(call.command, "claude");
  for (const flag of ["-p", "--input-format", "--output-format", "--verbose",
    "--include-partial-messages", "--replay-user-messages", "--dangerously-skip-permissions"]) {
    assert.ok(call.args.includes(flag));
  }
  assert.ok(!call.args.includes("--model"));
  assert.ok(!call.args.includes("--settings"));
  assert.deepEqual(call.args.slice(call.args.indexOf("--disallowedTools") + 1,
    call.args.indexOf("--disallowedTools") + 3), ["WebSearch", "WebFetch"]);
  assert.equal(call.options.env.CLAUDECODE, undefined);
  assert.equal(call.options.env.CLAUDE_TEST_MARKER, "passed");
  assert.equal(call.options.env.CLAUDE_CODE_SDK_READS_SESSION_STATE, "1");
  assert.equal(processes[0].messages[0].request.subtype, "initialize");
  const response = await adapter.send("first\nsecond");
  assert.equal(response.delivery, "started");
  assert.ok(call.args.includes(`--session-id=${response.nativeSessionId}`));
  const input = processes[0].messages.find((message) => message.type === "user");
  assert.equal(input.message.content, "first\nsecond");
  assert.equal(input.uuid, response.messageId);
  assert.equal(input.session_id, response.nativeSessionId);
  assert.ok(events.some((event) => event.status === "idle"));
});

test("running sends reach stdin immediately as queued, with individual acknowledgments", async (t) => {
  const { adapter, processes, events } = await fixture(t);
  const child = processes[0];
  const first = await adapter.send("original task");
  const second = await adapter.send("additional instruction");
  assert.equal(second.delivery, "queued");
  const inputs = child.messages.filter((message) => message.type === "user");
  assert.deepEqual(inputs.map((message) => message.message.content), ["original task", "additional instruction"]);
  for (const input of inputs) child.send(input);
  assert.deepEqual(
    events.filter((event) => event.acknowledged).map((event) => event.messageId),
    [first.messageId, second.messageId],
  );
  child.send(turnResult(first.nativeSessionId));
  assert.equal(events.at(-1).status, "running");
  child.send(turnResult(first.nativeSessionId, { result: "follow-up done" }));
  assert.equal(events.at(-1).status, "idle");
  const next = await adapter.send("continue");
  assert.equal(next.delivery, "started");
  assert.equal(processes.length, 1);
});

test("streams UTF-8 fragments, deduplicates final assistant text, and reports real tool results", async (t) => {
  const { adapter, processes, events } = await fixture(t);
  const child = processes[0];
  const { nativeSessionId } = await adapter.send("work");
  const partial = (event) => ({ type: "stream_event", session_id: nativeSessionId, event });
  child.send(partial({ type: "message_start", message: { id: "assistant-1" } }));
  const bytes = Buffer.from(`${JSON.stringify(partial({
    type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\u4f60\u597d" },
  }))}\n`);
  const split = bytes.indexOf(Buffer.from("\u4f60")) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  child.send(partial({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "Read" } }));
  child.send({
    type: "assistant", session_id: nativeSessionId,
    message: { id: "assistant-1", content: [
      { type: "text", text: "\u4f60\u597d!" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/file" } },
    ] },
  });
  child.send({
    type: "user", session_id: nativeSessionId,
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file bytes" }] },
  });
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "\u4f60\u597d!");
  assert.deepEqual(events.filter((event) => event.type === "tool").map((event) => [event.name, event.status]), [
    ["Read", "running"], ["Read", "completed"],
  ]);
  child.send(turnResult(nativeSessionId, { usage: { input_tokens: 23 }, total_cost_usd: 0.01 }));
  const result = events.find((event) => event.type === "result");
  assert.equal(result.usage.input_tokens, 23);
  assert.equal(result.usage.total_cost_usd, 0.01);
});

test("result does not claim idle while native background work is still running", async (t) => {
  const { adapter, processes, events } = await fixture(t);
  const child = processes[0];
  const sent = await adapter.send("work");
  child.send(child.messages.find((message) => message.type === "user"));
  child.send({ type: "system", subtype: "session_state_changed", state: "running" });
  child.send(turnResult(sent.nativeSessionId));
  assert.equal(events.at(-1).status, "running");
  child.send({ type: "system", subtype: "session_state_changed", state: "idle" });
  assert.equal(events.at(-1).status, "idle");
  assert.equal(child.stdin.writableEnded, false);
});

test("stop interrupts, confirms own process exit, then resumes only a new explicit message", async (t) => {
  const { adapter, processes, calls, events } = await fixture(t, {
    adapter: { nativeSessionId: SESSION, model: "chosen-model" },
  });
  await adapter.send("do not replay this");
  await adapter.send("queued input");
  await adapter.stop();
  assert.ok(processes[0].messages.some((message) => message.request?.subtype === "interrupt"));
  assert.equal(processes[0].finished, true);
  assert.equal(events.at(-1).status, "stopped");
  assert.equal(events.at(-1).pendingMessages.length, 2);
  const sent = await adapter.send("inspect current state");
  assert.equal(sent.nativeSessionId, SESSION);
  assert.ok(calls[1].args.includes(`--resume=${SESSION}`));
  assert.ok(calls[1].args.includes("chosen-model"));
  assert.deepEqual(processes[1].messages.filter((message) => message.type === "user")
    .map((message) => message.message.content), ["inspect current state"]);
  await adapter.close();
  await assert.rejects(adapter.send("closed"), /closed/);
});

test("unexpected exit reports uncertain inputs and never replays them", async (t) => {
  const { adapter, processes, calls, events } = await fixture(t);
  const sent = await adapter.send("maybe executed");
  processes[0].finish(2);
  assert.ok(events.some((event) => event.type === "error" && event.deliveryUnknown));
  assert.equal(calls.length, 1);
  await adapter.send("explicit new instruction");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes(`--resume=${sent.nativeSessionId}`));
  assert.equal(processes[1].messages.filter((message) => message.type === "user").length, 1);
});

test("error results surface errors instead of successful completion", async (t) => {
  const { adapter, processes, events } = await fixture(t);
  const sent = await adapter.send("work");
  processes[0].send(turnResult(sent.nativeSessionId, {
    is_error: true, result: "", errors: ["upstream unavailable"],
  }));
  assert.ok(events.some((event) => event.type === "error" && event.message === "upstream unavailable"));
  assert.equal(events.at(-1).status, "failed");
  assert.equal((await adapter.send("new instruction after the error")).delivery, "started");
  await adapter.stop();
  assert.equal(events.at(-1).status, "stopped");
});

test("initialization rejection cleans up and rejects construction", async (t) => {
  const child = nativeProcess({ initializeError: "resume unavailable" });
  t.mock.method(childProcess, "spawn", () => child);
  const events = [];
  await assert.rejects(createClaudeAdapter({
    cwd: "/tmp", nativeSessionId: SESSION, onEvent: (event) => events.push(event),
  }), /resume unavailable/);
  assert.equal(child.finished, true);
  assert.ok(events.some((event) => event.status === "failed"));
});

test("malformed protocol is reported and terminates only the owned process", async (t) => {
  const { processes, events } = await fixture(t);
  const child = processes[0];
  const ended = once(child, "close");
  child.stdout.write("not json\n");
  await ended;
  assert.ok(events.some((event) => event.message === "Claude Code emitted invalid stream JSON."));
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("permission requests use the selected bypass behavior without a confirmation flow", async (t) => {
  const { processes } = await fixture(t);
  const child = processes[0];
  child.send({
    type: "control_request", request_id: "permission-1",
    request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/tmp/a", content: "a" } },
  });
  const reply = child.messages.find((message) => message.type === "control_response");
  assert.equal(reply.response.response.behavior, "allow");
  assert.deepEqual(reply.response.response.updatedInput, { file_path: "/tmp/a", content: "a" });
});

test("clean idle process exit resumes the same session on the same adapter", async (t) => {
  const { adapter, processes, calls, events } = await fixture(t);
  const first = await adapter.send("task");
  processes[0].send(turnResult(first.nativeSessionId));
  processes[0].finish();
  assert.equal(events.at(-1).status, "idle");
  const next = await adapter.send("continue");
  assert.equal(next.nativeSessionId, first.nativeSessionId);
  assert.equal(next.delivery, "started");
  assert.ok(calls[1].args.includes(`--resume=${first.nativeSessionId}`));
});

test("interrupt ACK alone is not exposed as stopped before process exit", async (t) => {
  const { adapter, processes, events } = await fixture(t, { interrupt: false });
  await adapter.send("first");
  await adapter.send("second");
  const pending = adapter.stop();
  await assert.rejects(adapter.send("during stop"), /stopping/);
  assert.equal(events.at(-1).status, "stopping");
  const request = processes[0].messages.find((message) => message.request?.subtype === "interrupt");
  processes[0].send({
    type: "control_response",
    response: { subtype: "success", request_id: request.request_id, response: {} },
  });
  assert.equal(events.at(-1).status, "stopping");
  await pending;
  assert.equal(events.at(-1).status, "stopped");
  assert.equal(processes[0].finished, true);
  assert.deepEqual(processes[0].signals, ["SIGTERM"]);
});

test("unacknowledged interrupt reports the timeout and stops only its own process", async (t) => {
  const { adapter, processes, events } = await fixture(t, { interrupt: false });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await adapter.send("work");
  const pending = adapter.stop();
  t.mock.timers.tick(5_000);
  await pending;
  assert.ok(events.some((event) => event.type === "error" && /not acknowledged/.test(event.message)));
  assert.equal(events.at(-1).status, "stopped");
  assert.deepEqual(processes[0].signals, ["SIGTERM"]);
});

test("concurrent sends preserve order and distinguish started from queued", async (t) => {
  const { adapter, processes } = await fixture(t);
  const receipts = await Promise.all([adapter.send("one"), adapter.send("two"), adapter.send("three")]);
  assert.deepEqual(receipts.map((receipt) => receipt.delivery), ["started", "queued", "queued"]);
  assert.deepEqual(processes[0].messages.filter((message) => message.type === "user")
    .map((message) => message.message.content), ["one", "two", "three"]);
});

test("stdin completion is dispatching until native input replay acknowledges it", async (t) => {
  const { adapter, processes, events } = await fixture(t);
  const sent = await adapter.send("work", { operationKey: "first" });
  assert.equal(sent.state, "dispatching");
  assert.equal(sent.queueOwner, null);
  assert.equal(sent.turnIdSource, "input");
  const first = processes[0].messages.find((message) => message.type === "user");
  processes[0].send(first);
  assert.equal(events.findLast((event) => event.operationKey === "first").state, "accepted");
  processes[0].send(turnResult(sent.nativeSessionId));
  assert.equal(events.findLast((event) => event.operationKey === "first").state, "completed");
});

test("queued input requires native ACK and ambiguous results never mark both inputs completed", async (t) => {
  const { adapter, processes, events } = await fixture(t);
  const first = await adapter.send("first", { operationKey: "one" });
  const second = await adapter.send("second", { operationKey: "two" });
  assert.equal(second.delivery, "queued");
  assert.equal(second.state, "dispatching");
  for (const input of processes[0].messages.filter((message) => message.type === "user")) processes[0].send(input);
  const queued = events.findLast((event) => event.operationKey === "two");
  assert.equal(queued.state, "queued");
  assert.equal(queued.queueOwner, "native");
  processes[0].send(turnResult(first.nativeSessionId));
  assert.equal(events.some((event) => event.type === "operation" && event.state === "completed"), false);
  assert.equal(events.findLast((event) => event.operationKey === "two").state, "unknown");
});

test("stale cancellation cannot terminate a different active Claude input", async (t) => {
  const { adapter, processes } = await fixture(t);
  const first = await adapter.send("first", { operationKey: "first" });
  processes[0].send(turnResult(first.nativeSessionId));
  await adapter.send("next", { operationKey: "next" });
  await assert.rejects(adapter.stop({ expectedTurnId: first.turnId }), /does not match/);
  assert.equal(processes[0].signals.length, 0);
});
