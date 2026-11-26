const $ = (id) => document.getElementById(id);
const labels = { connecting: "连接中", running: "执行中", idle: "可继续", stopping: "正在停止", stopped: "已停止", failed: "出错", interrupted: "连接中断" };
let selected = null;
let sessions = [];
let cursor = 0;
let loading = null;
let pendingRead = false;
let lastText = null;
const icons = () => window.lucide.createIcons();
const showError = (message) => { $("error").textContent = message; $("error").hidden = !message; };

async function api(url, data) {
  const response = await fetch(url, data ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}

function renderList() {
  $("sessions").replaceChildren();
  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = `session${selected === session.id ? " selected" : ""}`;
    button.dataset.id = session.id;
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title;
    const meta = document.createElement("span");
    meta.className = "session-meta";
    const agent = document.createElement("span");
    agent.textContent = session.agent === "codex" ? "Codex" : "Claude Code";
    const status = document.createElement("span");
    status.textContent = labels[session.status] || session.status;
    meta.append(agent, status);
    button.append(title, meta);
    button.onclick = () => select(session.id);
    $("sessions").append(button);
  }
  renderHeader();
}

function renderHeader() {
  const session = sessions.find((s) => s.id === selected);
  $("title").textContent = session?.title || "新建会话";
  $("meta").textContent = session ? `${session.agent === "codex" ? "Codex" : "Claude Code"} · ${session.cwd}` : "Codex · Claude Code";
  $("status").textContent = session ? labels[session.status] || session.status : "";
  $("new-fields").hidden = !!session;
  $("copy-id").disabled = !session;
  $("stop").disabled = !session || !["connecting", "running"].includes(session.status);
}

async function refresh() {
  sessions = (await api("/api/sessions")).sessions;
  renderList();
}

function append(event) {
  if (event.seq <= cursor) return;
  cursor = event.seq;
  if (event.type === "created" || event.type === "native") return;
  const pane = $("events");
  const stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 90;
  pane.querySelector(".empty")?.remove();
  if (event.type === "result" && lastText?.textContent === event.text) {
    lastText.parentElement.querySelector(".event-head span").textContent = "本轮结果";
    lastText = null;
    return;
  }
  if (event.type === "text" && lastText) {
    lastText.textContent += event.text || "";
  } else {
    lastText = null;
    const row = document.createElement("article");
    row.className = `event ${event.type}`;
    const head = document.createElement("div");
    head.className = "event-head";
    const name = document.createElement("span");
    name.textContent = ({ user: "你", text: "回复", tool: event.name || "工具", result: "本轮结果", status: "状态", delivery: "消息", error: "错误", input: "需要信息" })[event.type] || event.type;
    const time = document.createElement("time");
    time.textContent = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    head.append(name, time);
    const content = document.createElement("div");
    content.className = "event-body";
    content.textContent = event.type === "status" ? labels[event.status] || event.status
      : event.type === "delivery" && ["dispatching", "unknown"].includes(event.state) ? "送达待确认"
      : event.type === "delivery" ? ({ started: "已开始", steered: "已追加到当前任务", queued: "已送达，等待处理", connecting: "正在连接" })[event.delivery] || "已送达"
      : event.type === "tool" ? `${event.status || ""}${event.detail ? ` · ${typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail)}` : ""}`
      : event.text || event.message || "";
    if (event.type === "tool" && typeof event.output === "string") {
      content.textContent += `\n${event.output}`;
    }
    row.append(head, content);
    pane.append(row);
    if (event.type === "text") lastText = content;
  }
  if (stick) pane.scrollTop = pane.scrollHeight;
}

async function catchUp() {
  if (!selected) return;
  if (loading) { pendingRead = true; return; }
  const id = selected;
  loading = id;
  try {
    let more = true;
    while (more && selected === id) {
      const result = await api(`/api/sessions/${id}/read?after=${cursor}`);
      if (selected !== id) break;
      for (const event of result.events) append(event);
      sessions = sessions.map((s) => s.id === id ? result.session : s);
      more = result.hasMore;
    }
    renderList();
  } catch (error) { showError(error.message); }
  finally {
    loading = null;
    if (pendingRead) { pendingRead = false; void catchUp(); }
  }
}

async function select(id) {
  selected = id;
  cursor = 0;
  lastText = null;
  $("events").replaceChildren();
  showError("");
  renderList();
  await catchUp();
  $("events").scrollTop = $("events").scrollHeight;
}

$("new-session").onclick = () => {
  selected = null;
  cursor = 0;
  lastText = null;
  $("events").replaceChildren();
  renderList();
  $("message").focus();
};
$("compose").onsubmit = async (event) => {
  event.preventDefault();
  const message = $("message").value.trim();
  if (!message) return;
  $("send").disabled = true;
  showError("");
  try {
    const result = selected
      ? await api(`/api/sessions/${selected}/send`, { message, requestId: crypto.randomUUID() })
      : await api("/api/start", { agent: $("agent").value, cwd: $("cwd").value, message, requestId: crypto.randomUUID() });
    $("message").value = "";
    await refresh();
    if (selected !== result.session.id) await select(result.session.id);
    else await catchUp();
  } catch (error) { showError(error.message); }
  finally { $("send").disabled = false; }
};
$("stop").onclick = async () => {
  if (!selected) return;
  try { await api(`/api/sessions/${selected}/stop`, {}); await refresh(); }
  catch (error) { showError(error.message); }
};
$("copy-id").onclick = async () => { if (selected) await navigator.clipboard.writeText(selected); };
const events = new EventSource("/api/events");
events.addEventListener("ready", async () => {
  $("connection").textContent = "实时连接";
  $("connection").className = "online";
  await refresh();
  if (selected) await catchUp();
});
events.onerror = () => { $("connection").textContent = "正在重连"; $("connection").className = ""; };
events.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.sessionId === selected) {
    if (!loading) append(event);
    else pendingRead = true;
  }
  if (["status", "created", "result", "delivery"].includes(event.type)) void refresh().catch((error) => showError(error.message));
};
icons();
void refresh().catch((error) => showError(error.message));
