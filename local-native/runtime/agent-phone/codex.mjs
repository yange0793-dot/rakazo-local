import childProcess from "node:child_process";
import { createInterface } from "node:readline";
import { refusal } from "./operations.mjs";

const COMMAND = "codex";
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const TOOL_TYPES = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
  "collabAgentToolCall", "webSearch", "imageView", "imageGeneration", "contextCompaction",
]);

/**
 * Owns one app-server process and one persistent native thread. A service
 * connection may override the model/provider while other native settings remain.
 * After process exit, recreate the adapter with its last nativeSessionId.
 */
export async function createCodexAdapter({
  cwd = process.cwd(), model, modelProvider, config, nativeSessionId, onEvent, env,
}) {
  let threadId = nativeSessionId;
  let active = null;
  let lastFinishedId = null;
  let lastFinishedState = null;
  let starting = false;
  let startNotifications = null;
  let dispatchUnknown = false;
  let connected = false;
  let closing = false;
  let exited = false;
  let transportError = null;
  let nextId = 0;
  let operations = Promise.resolve();
  let stopPromise = null;
  let closePromise = null;
  const pending = new Map();
  const userRequests = new Map();
  const emit = (event) => onEvent({
    nativeSessionId: threadId,
    ...(event.turnId ? { turnIdSource: "native",
      operationKeys: active?.id === event.turnId ? [...active.operationKeys] : [] } : {}),
    ...event,
  });
  function operation(key, state, turnId, fields = {}) {
    if (key) emit({ type: "operation", operationKey: key, state, ...(turnId ? { turnId } : {}), ...fields });
  }
  function settleInput(request, state, proof) {
    if (!request?.responseOperationKey) return;
    operation(request.responseOperationKey, state, request.turnId, { proof });
    request.resolveResponse?.({ state, proof });
  }
  function invalidateInputs(proof) {
    for (const [id, request] of userRequests) {
      settleInput(request, "unknown", proof);
      emit({ type: "input_resolved", inputRequestId: String(id), turnId: request.turnId, proof });
    }
    userRequests.clear();
  }
  const status = (value, turnId = active?.id) =>
    emit({
      type: "status", status: value, connected, deliveryUnknown: dispatchUnknown,
      ...(turnId ? { turnId } : {}),
    });
  status("connecting");

  const child = childProcess.spawn(COMMAND, ["app-server", "--listen", "stdio://"], {
    cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  // Native diagnostics can contain local configuration; drain them without logging.
  child.stderr.resume();
  child.stdin.on("error", () => failTransport(new Error("Codex input stream closed.")));
  child.stdout.on("error", () => failTransport(new Error("Codex output stream failed.")));
  child.on("error", (error) => {
    failTransport(new Error(`Could not run Codex: ${error.code ?? "spawn failed"}.`));
    if (!child.pid) {
      exited = true;
      resolveExit();
    }
  });
  child.on("exit", (code, signal) => {
    exited = true;
    resolveExit();
    failTransport(new Error(`Codex exited (${signal ?? code ?? "unknown"}).`));
  });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failTransport(new Error("Codex returned invalid JSON."));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      failTransport(new Error("Codex returned an invalid protocol message."));
      return;
    }
    if (message.method) {
      if (Object.hasOwn(message, "id")) handleServerRequest(message);
      else handleNotification(message.method, message.params ?? {});
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) {
      const error = new Error(message.error.message ?? "Codex rejected the request.");
      error.code = message.error.code;
      error.confirmed = true;
      waiting.reject(error);
    } else if (Object.hasOwn(message, "result")) {
      waiting.resolve(message.result);
    } else {
      waiting.reject(new Error("Codex returned a response without result or error."));
    }
  });
  lines.on("close", () => {
    if (!closing && !exited) failTransport(new Error("Codex output stream closed."));
  });

  function failTransport(error) {
    connected = false;
    dispatchUnknown ||= Boolean(active || starting);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    if (transportError) return;
    transportError = error;
    for (const key of active?.operationKeys ?? []) operation(key, "unknown", active.id, {
      proof: "native_transport_lost", error: error.message,
    });
    invalidateInputs("native_transport_lost");
    active?.settle(error);
    if (!closing) {
      emit({ type: "error", message: error.message });
      status("failed");
    }
  }

  function write(message) {
    if (exited || transportError) throw transportError ?? new Error("Codex is closed.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function rpc(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} acknowledgement timed out; nothing was resent.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        write({ id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function serialize(work) {
    const next = operations.then(work);
    operations = next.catch(() => {});
    return next;
  }

  function begin(turn, key) {
    if (!turn?.id || turn.id === lastFinishedId) return null;
    if (active?.id === turn.id) return active;
    if (active) return null;
    let settle;
    active = {
      id: turn.id, messages: new Map(), tools: new Map(), usage: undefined,
      operationKeys: new Set(key ? [key] : []),
      finished: new Promise((resolve) => { settle = resolve; }),
      settle: (error) => settle(error),
    };
    if (key) operation(key, "running", turn.id, { proof: "turn_start_ack" });
    status("running", turn.id);
    return active;
  }

  function current(turnId) {
    return active?.id === turnId ? active : null;
  }

  function recordMessage(turn, item, stream = true) {
    const previous = turn.messages.get(item.id);
    const text = typeof item.text === "string" ? item.text : previous?.text ?? "";
    turn.messages.set(item.id, { text, phase: item.phase ?? previous?.phase });
    if (!stream || text === previous?.text || !text) return;
    const prefix = previous?.text ?? "";
    emit({
      type: "text", text: text.startsWith(prefix) ? text.slice(prefix.length) : text,
      turnId: turn.id, itemId: item.id,
      ...(text.startsWith(prefix) ? {} : { replace: true }),
    });
  }

  function toolEvent(turn, item, completed) {
    if (!TOOL_TYPES.has(item.type)) return;
    const name = item.type === "mcpToolCall"
      ? `${item.server}/${item.tool}` : item.tool ?? item.type;
    turn.tools.set(item.id, name);
    const detail = item.command ?? item.query ?? item.path ??
      item.changes?.map((change) => change.path).join("\n") ?? item.error?.message;
    emit({
      type: "tool", name,
      status: item.status === "inProgress" ? "running" :
        item.status ?? (completed ? "completed" : "running"),
      ...(detail ? { detail } : {}), turnId: turn.id, itemId: item.id,
      ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
      ...(completed && item.type === "commandExecution" && typeof item.aggregatedOutput === "string"
        ? { output: item.aggregatedOutput } : {}),
    });
  }

  function finish(turn) {
    if (!TERMINAL.has(turn?.status) || turn.id === lastFinishedId) return;
    const running = current(turn.id);
    if (!running) return;
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage") recordMessage(running, item);
    }
    const messages = [...running.messages.values()];
    const final = messages.findLast((item) => item.phase === "final_answer") ?? messages.at(-1);
    lastFinishedId = turn.id;
    lastFinishedState = turn.status === "interrupted" ? "cancelled" : turn.status;
    for (const key of running.operationKeys) operation(key, lastFinishedState, turn.id, {
      proof: "native_turn_terminal", ...(turn.error ? { error: turn.error.message } : {}),
    });
    active = null;
    dispatchUnknown = false;
    for (const [id, request] of userRequests) {
      if (request.turnId === turn.id) {
        settleInput(request, lastFinishedState, "native_turn_terminal");
        emit({ type: "input_resolved", inputRequestId: String(id), turnId: turn.id });
        userRequests.delete(id);
      }
    }
    running.settle();
    if (turn.status === "completed") {
      emit({ type: "result", text: final?.text ?? "", usage: running.usage, turnId: turn.id });
      status("idle", turn.id);
    } else if (turn.status === "interrupted") {
      status("stopped", turn.id);
    } else {
      emit({ type: "error", message: turn.error?.message ?? "Codex turn failed.", turnId: turn.id });
      status("failed", turn.id);
    }
  }

  function handleNotification(method, params) {
    if (closing || transportError || params.threadId !== threadId) return;
    if (startNotifications) {
      startNotifications.push({ method, params });
      return;
    }
    if (method === "turn/started") {
      // Resume can replay historical starts. Only an ACK or a live snapshot
      // establishes the active turn; a notification cannot take its place.
      return;
    }
    if (method === "turn/completed") {
      finish(params.turn);
      return;
    }
    if (method === "serverRequest/resolved") {
      const request = userRequests.get(params.requestId);
      settleInput(request, "completed", "server_request_resolved");
      emit({ type: "input_resolved", inputRequestId: String(params.requestId), turnId: request?.turnId });
      userRequests.delete(params.requestId);
      return;
    }
    const turn = current(params.turnId);
    if (!turn) return;
    if (method === "item/agentMessage/delta") {
      recordMessage(turn, {
        id: params.itemId,
        text: (turn.messages.get(params.itemId)?.text ?? "") + params.delta,
      });
    } else if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      if (!item) return;
      if (item.type === "agentMessage") {
        recordMessage(turn, item);
      } else {
        toolEvent(turn, item, method === "item/completed");
      }
    } else if (method === "thread/tokenUsage/updated") {
      turn.usage = { ...params.tokenUsage, costUsd: null, source: "codex_app_server" };
    } else if (
      method === "item/commandExecution/outputDelta" ||
      method === "item/fileChange/outputDelta" ||
      method === "item/mcpToolCall/progress"
    ) {
      emit({
        type: "tool", name: turn.tools.get(params.itemId) ?? method.split("/")[1],
        status: "running", detail: params.delta ?? params.message,
        turnId: turn.id, itemId: params.itemId,
      });
    } else if (method === "turn/plan/updated") {
      emit({
        type: "tool", name: "plan", status: "updated",
        detail: params.explanation, plan: params.plan, turnId: turn.id,
      });
    } else if (method === "error") {
      // Native retry notifications do not terminate a turn.
      emit({
        type: "error", message: params.error?.message ?? "Codex reported an error.",
        willRetry: params.willRetry, turnId: turn.id,
      });
    }
  }

  function handleServerRequest({ id, method, params = {} }) {
    if (closing || transportError) return;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      write({ id, result: { decision: "accept" } });
    } else if (method === "item/permissions/requestApproval") {
      write({ id, result: { permissions: params.permissions, scope: "session" } });
    } else if (
      method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request"
    ) {
      userRequests.set(id, { ...params, method });
      emit({
        type: "tool",
        name: method === "item/tool/requestUserInput" ? "request_user_input" : "mcp_elicitation",
        status: "waiting_input", requestId: id, turnId: params.turnId,
        inputRequestId: String(id), resumable: method === "item/tool/requestUserInput",
        inputResponseSupported: method === "item/tool/requestUserInput",
        detail: params.questions?.map((question) => question.question).join("\n") ?? params.message,
        questions: params.questions, request: params, sourceThreadId: params.threadId,
      });
    } else {
      write({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } });
      emit({ type: "error", message: `Codex requested unsupported client method: ${method}` });
    }
  }

  async function findActiveTurn() {
    const snapshot = await rpc("thread/turns/list", {
      threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
    });
    const turn = snapshot.data?.[0];
    if (turn?.status === "inProgress") return begin(turn);
    return null;
  }

  async function send(text, options = {}) {
    if (typeof text !== "string" || !text.trim()) throw new Error("Message text is required.");
    if (stopPromise) throw refusal("Codex is stopping; wait for its terminal status.");
    return serialize(async () => {
      if (closing || exited || transportError) throw transportError ?? new Error("Codex is closed.");
      if (dispatchUnknown) throw refusal("Codex delivery is unconfirmed; resume and inspect before sending again.");
      if (options.expectedTurnId && active?.id !== options.expectedTurnId) throw refusal("Codex expectedTurnId does not match the active turn.", "turn_mismatch");
      const input = [{ type: "text", text }];
      const steering = active;
      starting = !steering;
      if (starting) startNotifications = [];
      try {
        let turnId;
        if (steering) {
          await rpc("turn/steer", { threadId, expectedTurnId: steering.id, input });
          if (transportError || exited) throw transportError ?? new Error("Codex exited after accepting the input.");
          turnId = steering.id;
          if (options.operationKey) steering.operationKeys.add(options.operationKey);
          operation(options.operationKey, turnId === lastFinishedId ? lastFinishedState : "running", turnId, {
            proof: turnId === lastFinishedId ? "steer_ack_and_native_terminal" : "turn_steer_ack",
          });
        } else {
          const response = await rpc("turn/start", {
            threadId, input, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
          });
          if (transportError || exited) throw transportError ?? new Error("Codex exited after accepting the input.");
          if (!response.turn?.id) throw new Error("Codex did not return a turn id.");
          turnId = response.turn.id;
          begin(response.turn, options.operationKey);
          const notifications = startNotifications;
          startNotifications = null;
          for (const { method, params } of notifications) {
            const eventTurnId = params.turnId ?? params.turn?.id;
            if (eventTurnId === response.turn.id) handleNotification(method, params);
          }
          if (TERMINAL.has(response.turn.status)) finish(response.turn);
        }
        return {
          delivery: steering ? "steered" : "started", nativeSessionId: threadId,
          turnId, turnIdSource: "native", state: turnId === lastFinishedId ? lastFinishedState : "running",
          proof: turnId === lastFinishedId ? "native_turn_terminal" : steering ? "turn_steer_ack" : "turn_start_ack",
        };
      } catch (error) {
        if (!error.confirmed) dispatchUnknown = true;
        emit({ type: "error", message: error.message, deliveryUnknown: !error.confirmed });
        if (dispatchUnknown) status("failed");
        throw error;
      } finally {
        starting = false;
        startNotifications = null;
      }
    });
  }

  async function respondInput({ inputRequestId, answers, expectedTurnId, operationKey }) {
    if (closing || transportError || stopPromise) throw refusal("Codex input response is unavailable.");
    const entry = [...userRequests.entries()].find(([id]) => String(id) === String(inputRequestId));
    if (!entry || entry[1].method !== "item/tool/requestUserInput") throw refusal("The original input request is unavailable or unsupported.");
    const [id, request] = entry;
    if (!active || request.threadId !== threadId || request.turnId !== active.id ||
        (expectedTurnId && expectedTurnId !== active.id)) throw refusal("The input request belongs to an expired turn.", "turn_mismatch");
    if (request.responseOperationKey) throw refusal("This input request already has a response operation.");
    if (!answers || typeof answers !== "object" || Array.isArray(answers) ||
        Object.values(answers).some((value) => !value || !Array.isArray(value.answers) || value.answers.some((answer) => typeof answer !== "string"))) {
      throw refusal("answers must map question IDs to {answers: string[]}.");
    }
    const questionIds = new Set((request.questions ?? []).map((question) => question.id));
    if (Object.keys(answers).some((id) => !questionIds.has(id)) ||
        [...questionIds].some((id) => !Object.hasOwn(answers, id))) {
      throw refusal("answers must match the original input question IDs.");
    }
    request.responseOperationKey = operationKey;
    const turnId = active.id;
    const acknowledged = new Promise((resolve) => { request.resolveResponse = resolve; });
    let timer;
    try {
      write({ id, result: { answers } });
      // A pipe write is not native acceptance; wait for the matching request resolution.
      const receipt = await Promise.race([
        acknowledged,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({
            state: "dispatching", proof: "input_response_written_without_native_ack",
          }), 10_000);
        }),
      ]);
      return { ...receipt, nativeSessionId: threadId, turnId,
        turnIdSource: "native", inputRequestId: String(id) };
    } finally {
      clearTimeout(timer);
      delete request.resolveResponse;
    }
  }

  function stop(options = {}) {
    if (stopPromise) return stopPromise;
    stopPromise = serialize(async () => {
      if (closing || exited) throw new Error("Codex connection is closed; inspect the saved execution.");
      if (transportError) throw transportError;
      if (!active && dispatchUnknown) await findActiveTurn();
      if (options.expectedTurnId && active && active.id !== options.expectedTurnId) {
        throw refusal("Codex stop expectedTurnId does not match the active turn.", "turn_mismatch");
      }
      if (!active) {
        if (dispatchUnknown) throw new Error("Codex execution state is still unknown.");
        if (options.expectedTurnId && options.expectedTurnId !== lastFinishedId) throw refusal("The expected turn has no confirmed terminal state.", "turn_mismatch");
        status("stopped");
        return { stopConfirmed: true, proof: lastFinishedId ? "native_turn_terminal" : "native_idle_snapshot", turnId: lastFinishedId, turnIdSource: "native" };
      }
      const stopping = active;
      status("stopping");
      try {
        await rpc("turn/interrupt", { threadId, turnId: stopping.id });
      } catch (error) {
        // A completion can win the race against the interrupt's rejection.
        if (lastFinishedId !== stopping.id) throw error;
      }
      let timer;
      const error = await Promise.race([
        stopping.finished,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(new Error("Codex has not confirmed that the turn stopped.")), 30_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (error) throw error;
      return { stopConfirmed: true, proof: "native_turn_terminal", turnId: stopping.id, turnIdSource: "native" };
    }).catch((error) => {
      emit({ type: "error", message: error.message });
      if (!error.confirmed) status("failed");
      throw error;
    }).finally(() => { stopPromise = null; });
    return stopPromise;
  }

  async function waitForExit(ms) {
    if (exited) return;
    let timer;
    await Promise.race([
      exitPromise, new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (active && !exited && !transportError) {
        await rpc("turn/interrupt", { threadId, turnId: active.id }, 2_000).catch(() => {});
      }
      child.stdin.end();
      await waitForExit(1_000);
      if (!exited) {
        child.kill("SIGTERM");
        await waitForExit(2_000);
      }
      for (const key of active?.operationKeys ?? []) operation(key, "unknown", active.id, {
        proof: "owned_transport_closed_without_turn_terminal",
      });
      if (!exited) {
        child.kill("SIGKILL");
        await exitPromise;
      }
      lines.close();
      invalidateInputs("owned_transport_closed_without_input_resolution");
      status("stopped");
    })();
    return closePromise;
  }

  try {
    await rpc("initialize", {
      clientInfo: { name: "rakazo_agent_phone", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized", params: {} });
    const options = {
      cwd, approvalPolicy: "never", sandbox: "danger-full-access",
      ...(model ? { model } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      config: { ...config, web_search: "disabled" },
    };
    const response = nativeSessionId
      ? await rpc("thread/resume", { ...options, threadId: nativeSessionId, excludeTurns: true }, 60_000)
      : await rpc("thread/start", options, 60_000);
    if (!response.thread?.id) throw new Error("Codex did not return a thread id.");
    threadId = response.thread.id;
    connected = true;
    if (response.thread.status?.type === "active") {
      if (!await findActiveTurn()) throw new Error("Codex reports an active thread without an identifiable turn.");
    } else if (response.thread.status?.type === "systemError") {
      throw new Error("Codex could not restore the thread.");
    } else {
      status("idle");
    }
    return { send, stop, close, respondInput };
  } catch (error) {
    emit({ type: "error", message: error.message });
    status("failed");
    await close();
    throw error;
  }
}
