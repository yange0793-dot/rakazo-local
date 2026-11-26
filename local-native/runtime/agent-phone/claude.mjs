import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { refusal } from "./operations.mjs";

const CLAUDE = "claude";
const INITIALIZE_TIMEOUT = 60_000;
const STOP_TIMEOUT = 5_000;

// Wire shapes follow Anthropic's claude-agent-sdk-python:
// _internal/query.py (initialize, interrupt, control responses), client.py (user),
// types.py (stream_event, result, terminal_reason), and subprocess_cli.py (close).
export async function createClaudeAdapter({ cwd, model, nativeSessionId, onEvent, env }) {
  const sessionId = nativeSessionId || randomUUID();
  let resume = Boolean(nativeSessionId);
  let connection;
  let connecting;
  let stopping;
  let closed = false;

  function emit(event) {
    onEvent({ nativeSessionId: sessionId, ...event });
  }

  function status(value, fields = {}) {
    const turnId = connection?.inputs.keys().next().value ?? connection?.lastTurnId;
    emit({ type: "status", status: value, ...(turnId ? { turnId, turnIdSource: "input" } : {}), ...fields });
  }

  function report(message, fields = {}) {
    emit({ type: "error", message, ...fields });
  }

  function operation(input, state, fields = {}) {
    if (input?.operationKey) emit({
      type: "operation", operationKey: input.operationKey, state,
      turnId: input.messageId, turnIdSource: "input", nativeMessageId: input.messageId, ...fields,
    });
  }

  function inputContext(conn) {
    const inputs = [...conn.inputs.values()];
    const unambiguous = inputs.length === 1 && inputs[0].acknowledged && !conn.ambiguousInputs;
    return {
      ...(unambiguous ? {
        operationKeys: inputs.map((input) => input.operationKey).filter(Boolean),
        turnId: inputs[0].messageId, turnIdSource: "input",
      } : inputs.length ? {
        candidateOperationKeys: inputs.map((input) => input.operationKey).filter(Boolean),
        association: "pending_inputs",
      } : {}),
    };
  }

  function write(conn, message) {
    return new Promise((resolve, reject) => {
      if (conn.exited || conn.child.stdin.destroyed || conn.child.stdin.writableEnded) {
        reject(new Error("Claude Code input is closed; the message was not retried."));
        return;
      }
      conn.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new Error(`Claude Code input failed (${error.code || "write error"}); delivery is unknown.`));
        else resolve();
      });
    });
  }

  function request(conn, body, timeout) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.controls.delete(id);
        reject(new Error(`Claude Code ${body.subtype} was not acknowledged within ${timeout}ms.`));
      }, timeout);
      const finish = (error, value) => {
        clearTimeout(timer);
        conn.controls.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      conn.controls.set(id, finish);
      write(conn, { type: "control_request", request_id: id, request: body })
        .catch((error) => finish(error));
    });
  }

  function tool(conn, block, parentToolUseId) {
    if (block.type === "tool_use") {
      const previous = conn.tools.get(block.id);
      conn.tools.set(block.id, block.name);
      if (!previous) emit({
        type: "tool", name: block.name, status: "running",
        toolUseId: block.id, parentToolUseId, ...inputContext(conn),
      });
      if (!previous && block.name === "AskUserQuestion") emit({
        type: "tool", name: block.name, status: "waiting_input", ...inputContext(conn),
        inputRequestId: block.id, questions: block.input?.questions,
        inputResponseSupported: false, resumable: false,
      });
    } else if (block.type === "tool_result") {
      if (conn.tools.get(block.tool_use_id) === "AskUserQuestion") {
        emit({ type: "input_resolved", inputRequestId: block.tool_use_id, ...inputContext(conn) });
      }
      emit({
        type: "tool",
        name: conn.tools.get(block.tool_use_id) || "tool",
        status: block.is_error ? "failed" : "completed",
        toolUseId: block.tool_use_id,
        parentToolUseId,
        ...inputContext(conn),
        detail: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? []),
      });
      conn.tools.delete(block.tool_use_id);
    }
  }

  function receive(conn, message) {
    if (message.session_id && message.session_id !== sessionId) {
      throw new Error("Claude Code returned a different session ID; refusing to switch conversations.");
    }
    if (message.type === "control_response") {
      const response = message.response;
      conn.controls.get(response?.request_id)?.(
        response?.subtype === "error" ? new Error(String(response.error)) : null,
        response?.response,
      );
      return;
    }
    if (message.type === "control_request") {
      // This host has explicitly selected bypassPermissions. No approval UI is added.
      const supported = message.request?.subtype === "can_use_tool";
      if (!supported) report(`Unsupported Claude Code control request: ${message.request?.subtype || "unknown"}.`);
      void write(conn, {
        type: "control_response",
        response: supported
          ? {
              subtype: "success", request_id: message.request_id,
              response: { behavior: "allow", updatedInput: message.request.input },
            }
          : {
              subtype: "error", request_id: message.request_id,
              error: "This host did not register a handler for this control request.",
            },
      }).catch((error) => report(error.message));
      return;
    }
    if (message.type === "system") {
      if (message.subtype === "init") {
        conn.initializedSession = true;
        status(conn.expectedExit ? "stopping" : conn.busy ? "running" : "idle", { model: message.model });
      } else if (message.subtype === "session_state_changed") {
        conn.nativeState = message.state;
        if (message.state === "running") conn.busy = true;
        if (message.state === "idle" && conn.sawResult) {
          // A native idle marker settles acknowledged inputs, including inputs
          // the CLI coalesced into one turn. Never erase an unacknowledged input.
          for (const [id, input] of conn.inputs) if (input.acknowledged) conn.inputs.delete(id);
          conn.busy = conn.inputs.size > 0;
        }
        if (!conn.expectedExit && !conn.failed) status(conn.busy ? "running" : "idle", {
          nativeStatus: message.state,
          pendingMessageIds: [...conn.inputs.keys()],
        });
      } else if (message.subtype === "status" && message.status) {
        status(conn.expectedExit ? "stopping" : "running", { nativeStatus: message.status });
      } else if (["task_started", "task_progress", "task_notification"].includes(message.subtype)) {
        emit({
          type: "tool", name: message.task_type || "Agent",
          status: message.status || "running", taskId: message.task_id,
          detail: message.description || message.summary,
        });
      }
      return;
    }
    if (message.type === "user") {
      const input = conn.inputs.get(message.uuid);
      if (input) {
        input.acknowledged = true;
        operation(input, input.delivery === "queued" ? "queued" : "accepted", {
          queueOwner: input.delivery === "queued" ? "native" : null, proof: "native_user_message_echo",
        });
        status(conn.expectedExit ? "stopping" : "running", {
          messageId: message.uuid, acknowledged: true, delivery: input.delivery,
        });
      }
      for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
        tool(conn, block, message.parent_tool_use_id);
      }
      return;
    }
    if (message.type === "stream_event") {
      const event = message.event;
      const parent = message.parent_tool_use_id || "";
      if (event?.type === "message_start") {
        const id = event.message.id;
        conn.streamIds.set(parent, id);
        conn.streamText.set(id, "");
        conn.busy = true;
        const candidates = [...conn.inputs.values()];
        if (candidates.length === 1 && candidates[0].acknowledged) {
          operation(candidates[0], "running", { proof: "native_output_after_input_ack" });
        }
      }
      if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
        tool(conn, event.content_block, message.parent_tool_use_id);
      }
      const text = event?.type === "content_block_delta" && event.delta?.type === "text_delta"
        ? event.delta.text
        : event?.type === "content_block_start" && event.content_block?.type === "text"
          ? event.content_block.text
          : "";
      if (text) {
        const id = conn.streamIds.get(parent);
        if (id) conn.streamText.set(id, (conn.streamText.get(id) || "") + text);
        emit({ type: "text", text, nativeMessageId: id, parentToolUseId: message.parent_tool_use_id, ...inputContext(conn) });
      }
      return;
    }
    if (message.type === "assistant") {
      const content = message.message?.content || [];
      const text = content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const id = message.message?.id;
      const streamed = conn.streamText.get(id) || "";
      const remainder = text.startsWith(streamed) ? text.slice(streamed.length) : streamed ? "" : text;
      if (remainder) emit({ type: "text", text: remainder, nativeMessageId: id, parentToolUseId: message.parent_tool_use_id, ...inputContext(conn) });
      if (!message.parent_tool_use_id) conn.lastText = text;
      conn.streamText.delete(id);
      for (const block of content) tool(conn, block, message.parent_tool_use_id);
      return;
    }
    if (message.type === "tool_progress") {
      emit({
        type: "tool", name: message.tool_name, status: "running",
        toolUseId: message.tool_use_id, elapsedSeconds: message.elapsed_time_seconds,
        ...inputContext(conn),
      });
      return;
    }
    if (message.type === "result") {
      conn.sawResult = true;
      const text = typeof message.result === "string" ? message.result : conn.lastText;
      const failed = message.is_error === true || String(message.subtype || "").startsWith("error");
      const cancelled = ["aborted_streaming", "aborted_tools"].includes(message.terminal_reason);
      const resultContext = inputContext(conn);
      const candidates = [...conn.inputs.values()];
      // Injected background-agent turns need not correspond to a host input.
      if (!message.origin || message.origin.kind === "human") {
        if (candidates.length === 1 && candidates[0].acknowledged && !conn.ambiguousInputs) {
          operation(candidates[0], cancelled ? "cancelled" : failed ? "failed" : "completed", {
            proof: "native_result_for_single_acknowledged_input",
          });
        } else {
          // A result has no input ID in this wire format. Coalesced or unacked
          // inputs must not inherit another input's successful completion.
          for (const input of candidates) operation(input, "unknown", { proof: "native_result_without_unambiguous_input_identity" });
        }
        conn.lastTurnId = conn.inputs.keys().next().value ?? conn.lastTurnId;
        conn.inputs.delete(conn.inputs.keys().next().value);
        if (!conn.inputs.size) conn.ambiguousInputs = false;
      }
      conn.busy = conn.inputs.size > 0 || conn.nativeState === "running";
      conn.failed = failed && !cancelled;
      emit({
        type: "result", text, isError: failed, cancelled, ...resultContext,
        terminalReason: message.terminal_reason,
        nativeResultId: message.uuid,
        usage: {
          ...(message.usage || {}),
          total_cost_usd: message.total_cost_usd ?? null,
          modelUsage: message.modelUsage ?? message.model_usage ?? null,
          source: "claude-code-result",
        },
      });
      conn.lastText = "";
      if (conn.failed) {
        const error = Array.isArray(message.errors) && message.errors.length
          ? message.errors.join("\n")
          : text || `Claude Code returned ${message.subtype || "an error"}.`;
        report(error);
        for (const finish of [...conn.controls.values()]) finish(new Error(error));
      }
      if (!conn.expectedExit) status(conn.failed ? "failed" : conn.busy ? "running" : cancelled ? "stopped" : "idle");
      return;
    }
    if (message.type === "error") throw new Error(String(message.message || message.error || "Claude Code reported an error."));
  }

  async function waitExit(conn, timeout) {
    if (conn.exited) return true;
    let timer;
    try {
      return await Promise.race([
        conn.exit.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function shutdown(conn, terminate = false) {
    if (conn.exited) return;
    conn.expectedExit = true;
    conn.child.stdin.end();
    // An interrupt ACK does not prove queued inputs were discarded. Stop the
    // owned process instead of allowing its input queue to run during EOF grace.
    if (terminate) conn.child.kill("SIGTERM");
    if (await waitExit(conn, STOP_TIMEOUT)) return;
    if (!terminate) {
      conn.child.kill("SIGTERM");
      if (await waitExit(conn, STOP_TIMEOUT)) return;
    }
    conn.child.kill("SIGKILL");
    if (!(await waitExit(conn, STOP_TIMEOUT))) throw new Error("Claude Code process exit could not be confirmed.");
  }

  async function connect() {
    status("connecting");
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--include-partial-messages", "--replay-user-messages", "--verbose",
      "--dangerously-skip-permissions",
      "--disallowedTools", "WebSearch", "WebFetch",
      resume ? `--resume=${sessionId}` : `--session-id=${sessionId}`,
    ];
    if (model) args.push("--model", model);
    const childEnv = { ...process.env, ...env };
    delete childEnv.CLAUDECODE;
    // Same opt-in as the official SDK, for background work that outlives a result.
    childEnv.CLAUDE_CODE_SDK_READS_SESSION_STATE ??= "1";
    const child = childProcess.spawn(CLAUDE, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const conn = {
      child, controls: new Map(), inputs: new Map(), tools: new Map(),
      streamIds: new Map(), streamText: new Map(), lastText: "",
      busy: false, failed: false, sawResult: false, nativeState: null,
      exited: false, expectedExit: false, initializedSession: false, ambiguousInputs: false, lastTurnId: null,
    };
    connection = conn;
    let resolveExit;
    conn.exit = new Promise((resolve) => { resolveExit = resolve; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        receive(conn, JSON.parse(line));
      } catch (error) {
        conn.failed = true;
        report(error instanceof SyntaxError ? "Claude Code emitted invalid stream JSON." : error.message);
        status("failed");
        for (const finish of [...conn.controls.values()]) finish(error);
        conn.expectedExit = true;
        child.kill("SIGTERM");
      }
    });
    // Drain diagnostic output without forwarding credentials/configuration dumps.
    child.stderr.resume();
    child.stdin.on("error", (error) => {
      if (!conn.expectedExit) report(`Claude Code stdin failed (${error.code || "stream error"}); delivery is unknown.`);
    });
    child.on("error", (error) => {
      conn.failed = true;
      const failure = new Error(`Claude Code process failed (${error.code || "spawn error"}).`);
      report(failure.message);
      status("failed");
      for (const finish of [...conn.controls.values()]) finish(failure);
    });
    child.on("close", (code, signal) => {
      conn.exited = true;
      lines.close();
      if (connection === conn) connection = undefined;
      const error = new Error(`Claude Code exited (${signal || code}); unfinished inputs were not retried.`);
      for (const finish of [...conn.controls.values()]) finish(error);
      const unsettled = [...conn.inputs].map(([messageId, input]) => ({ messageId, acknowledged: input.acknowledged }));
      for (const input of conn.inputs.values()) operation(input, conn.stopRequested ? "cancelled" : "unknown", {
        proof: conn.stopRequested ? "owned_process_exit" : "native_process_exit_without_input_terminal",
      });
      for (const [inputRequestId, name] of conn.tools) {
        if (name === "AskUserQuestion") emit({ type: "input_resolved", inputRequestId, proof: "owned_process_exit" });
      }
      if (!conn.expectedExit && (code !== 0 || conn.busy || unsettled.length)) {
        if (!conn.failed) report(error.message, { pendingMessages: unsettled, deliveryUnknown: true });
        status("failed", { connected: false });
      } else if (conn.expectedExit) {
        status(conn.failed && !conn.stopRequested ? "failed" : "stopped", {
          connected: false, stopScope: "process", pendingMessages: unsettled,
        });
      } else status(conn.failed ? "failed" : "idle", { connected: false });
      resolveExit();
    });
    try {
      await request(conn, { subtype: "initialize", hooks: null }, INITIALIZE_TIMEOUT);
      if (conn.exited || conn.failed) throw new Error("Claude Code initialization failed.");
      status("idle", { connected: true });
      return conn;
    } catch (error) {
      if (!conn.failed) {
        conn.failed = true;
        report(error.message);
        status("failed");
      }
      await shutdown(conn);
      throw error;
    }
  }

  function ensureConnected() {
    if (connecting) return connecting;
    if (connection && !connection.exited) return Promise.resolve(connection);
    connecting = connect().finally(() => { connecting = undefined; });
    return connecting;
  }

  async function stop(options = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      const conn = connecting ? await connecting.catch(() => null) : connection;
      if (!conn || conn.exited) {
        if (options.expectedTurnId) throw refusal("The expected Claude input has no live process to confirm.", "turn_mismatch");
        status("stopped", { connected: false });
        return { stopConfirmed: true, proof: "owned_process_already_exited" };
      }
      const turnId = conn.inputs.keys().next().value ?? conn.lastTurnId;
      if (options.expectedTurnId && options.expectedTurnId !== turnId) throw refusal("Claude stop expectedTurnId does not match the active input.", "turn_mismatch");
      conn.expectedExit = true;
      conn.stopRequested = true;
      status("stopping");
      try {
        await request(conn, { subtype: "interrupt" }, STOP_TIMEOUT);
      } catch (error) {
        report(`${error.message} Closing only this adapter's process.`);
      }
      await shutdown(conn, conn.busy || conn.inputs.size > 0);
      return { stopConfirmed: true, proof: "owned_process_exit", turnId, turnIdSource: "input" };
    })().finally(() => { stopping = undefined; });
    return stopping;
  }

  await ensureConnected();
  return {
    async send(text, options = {}) {
      if (closed) throw new Error("Claude Code adapter is closed.");
      if (stopping) throw refusal("Claude Code is stopping; the message was not sent.");
      if (typeof text !== "string" || !text.trim()) throw new Error("Message text must not be empty.");
      const conn = await ensureConnected();
      if (closed || stopping || conn.exited || conn.expectedExit) throw refusal("Claude Code is not ready; the message was not sent.");
      if (options.expectedTurnId && options.expectedTurnId !== conn.inputs.keys().next().value) throw refusal("Claude expectedTurnId does not match the active input.", "turn_mismatch");
      const delivery = conn.busy ? "queued" : "started";
      const messageId = randomUUID();
      const input = { delivery, acknowledged: false, messageId, operationKey: options.operationKey };
      conn.ambiguousInputs ||= conn.inputs.size > 0;
      conn.inputs.set(messageId, input);
      conn.busy = true;
      conn.failed = false;
      conn.sawResult = false;
      // Once bytes may have reached the CLI, subsequent connections must resume,
      // never replay this prompt or silently start a replacement conversation.
      resume = true;
      operation(input, "dispatching", { delivery, proof: "native_input_write_started" });
      status("running", { messageId, delivery, acknowledged: false });
      try {
        await write(conn, {
          type: "user", uuid: messageId, session_id: sessionId,
          message: { role: "user", content: text }, parent_tool_use_id: null,
        });
      } catch (error) {
        report(error.message, { messageId, deliveryUnknown: true });
        conn.failed = true;
        status("failed");
        await shutdown(conn);
        throw error;
      }
      if (conn.exited) throw new Error("Claude Code exited before delivery could be confirmed; the input was not retried.");
      return {
        delivery, nativeSessionId: sessionId, messageId, nativeMessageId: messageId,
        turnId: messageId, turnIdSource: "input",
        state: input.acknowledged ? delivery === "queued" ? "queued" : "accepted" : "dispatching",
        queueOwner: input.acknowledged && delivery === "queued" ? "native" : null,
        proof: input.acknowledged ? "native_user_message_echo" : "stdin_write_without_native_ack",
      };
    },
    stop,
    async close() {
      closed = true;
      await stop();
    },
  };
}
