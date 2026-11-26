#!/bin/bash
# Keeps the native stack answering. Every 45s it probes what the product actually needs:
# PostgreSQL accepting connections, api /ready (which opens a database connection), web /,
# the worker heartbeat, and the local memory index /health. Two consecutive failures of the
# same probe restart the affected piece through start-native.sh (or memory-service.sh for the
# index). The LaunchAgent that runs this has KeepAlive, so the loop itself comes back if it dies.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${RAKAZO_SRC:-$(cd "$ROOT/.." && pwd)}"
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

LOG="$ROOT/logs/watchdog.log"
RUN_DIR="$ROOT/run"
LOCK_DIR="$RUN_DIR/start.lock"
PAUSE_FILE="$RUN_DIR/watchdog.disabled"
API_PORT=3100
WEB_PORT=5173
PG_PORT=55432
INDEX_PORT=17676
CURL=/usr/bin/curl
LSOF=/usr/sbin/lsof
PG_ISREADY="$ROOT/postgres/bin/pg_isready"
WORKER_HEALTH="$SRC/apps/worker/dist/health-check.js"
MEMORY_SERVICE="$ROOT/memory-service.sh"
TOKEN_FILE="$RUN_DIR/semantic-memory.token"

log() { printf '%s [watchdog] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

ok() { "$CURL" -fsS --noproxy '*' --max-time 8 -o /dev/null "$1" 2>/dev/null; }

pg_ok() { [ -x "$PG_ISREADY" ] && "$PG_ISREADY" -h 127.0.0.1 -p "$PG_PORT" -q; }

read_pid() {
  local file="$RUN_DIR/$1.pid" pid
  [ -f "$file" ] || return 1
  pid="$(tr -d '[:space:]' <"$file" 2>/dev/null)" || return 1
  case "$pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$pid"
}

owned_process() {
  local name="$1" pid="$2" cwd expected
  kill -0 "$pid" 2>/dev/null || return 1
  expected="$(cd "$SRC/apps/$name" && pwd -P)" || return 1
  cwd="$("$LSOF" -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ "$cwd" = "$expected" ]
}

# The build's checker knows the freshness limits. A leftover heartbeat is insufficient.
worker_ok() {
  local pid node
  pid="$(read_pid worker)" && owned_process worker "$pid" || return 1
  node="$(command -v node || true)"
  [ -n "$node" ] && [ -f "$WORKER_HEALTH" ] &&
    WORKER_HEALTH_FILE="$RUN_DIR/worker-health.json" WORKER_HEALTH_PID="$pid" \
    "$node" "$WORKER_HEALTH" >/dev/null 2>&1
}

# The token stays out of the argument list: curl reads the header from a pipe fed by a
# shell builtin, so no process ever shows "Bearer <token>" in `ps`.
index_ok() {
  local token
  [ -r "$TOKEN_FILE" ] || return 1
  token="$(tr -d '[:space:]' <"$TOKEN_FILE")"
  [ -n "$token" ] || return 1
  "$CURL" -fsS --noproxy '*' --max-time 5 \
    --header @<(printf 'Authorization: Bearer %s\n' "$token") \
    -o /dev/null "http://127.0.0.1:$INDEX_PORT/health" 2>/dev/null
}

port_busy() { [ -n "$("$LSOF" -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null)" ]; }

# start-native.sh holds run/start.lock for the whole startup window, and deploy-stack.cjs holds
# run/watchdog.disabled around it. Probing a half-started stack is how a deployment used to end
# up fighting the watchdog, so both states reset the counters instead of counting a failure.
start_in_progress() {
  local pid
  [ -d "$LOCK_DIR" ] || return 1
  pid="$(tr -d '[:space:]' <"$LOCK_DIR/pid" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

kill_service() {
  local name="$1" pidfile="$RUN_DIR/$1.pid" pid
  [ -f "$pidfile" ] || return 0
  pid="$(read_pid "$name")" || { rm -f "$pidfile"; return 0; }
  if owned_process "$name" "$pid"; then
    log "stopping $name (pid $pid)"
    kill -TERM "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    owned_process "$name" "$pid" && kill -KILL "$pid" 2>/dev/null
  elif kill -0 "$pid" 2>/dev/null; then
    log "ignoring stale $name PID $pid outside this stack"
  fi
  rm -f "$pidfile"
}

wait_port_free() {
  local port="$1" waited=0
  while port_busy "$port" && [ "$waited" -lt 15 ]; do sleep 1; waited=$((waited + 1)); done
}

main() {
  mkdir -p "$ROOT/logs" "$RUN_DIR"
  log "watching postgres :$PG_PORT, api :$API_PORT/ready, web :$WEB_PORT, worker heartbeat, memory index :$INDEX_PORT"
  local pg_fail=0 api_fail=0 web_fail=0 worker_fail=0 index_fail=0 need_stack
  while :; do
    # stop-native.sh raises this so a deliberate stop is not undone; a deployment keeps it for
    # its whole window. A plain start-native.sh lifts it.
    if [ -f "$PAUSE_FILE" ]; then
      pg_fail=0; api_fail=0; web_fail=0; worker_fail=0; index_fail=0
      sleep 60
      continue
    fi
    if start_in_progress; then
      pg_fail=0; api_fail=0; web_fail=0; worker_fail=0; index_fail=0
      sleep 45
      continue
    fi

    if pg_ok; then pg_fail=0; else pg_fail=$((pg_fail + 1)); fi
    if ok "http://127.0.0.1:$API_PORT/ready"; then api_fail=0; else api_fail=$((api_fail + 1)); fi
    if ok "http://127.0.0.1:$WEB_PORT/"; then web_fail=0; else web_fail=$((web_fail + 1)); fi
    if worker_ok; then worker_fail=0; else worker_fail=$((worker_fail + 1)); fi
    if index_ok; then index_fail=0; else index_fail=$((index_fail + 1)); fi

    # A database outage also makes /ready fail; restarting the api would not help it.
    need_stack=0
    [ "$pg_fail" -ge 2 ] || [ "$web_fail" -ge 2 ] || [ "$worker_fail" -ge 2 ] && need_stack=1
    [ "$pg_fail" -lt 2 ] && [ "$api_fail" -ge 2 ] && need_stack=1
    [ "$need_stack" -eq 0 ] && [ "$index_fail" -lt 2 ] && { sleep 45; continue; }

    # Probes can finish after startup, stop or deployment has begun. Reserve
    # this stack's lifecycle before sending signals or invoking a restart.
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      sleep 45
      continue
    fi
    trap 'rm -rf "$LOCK_DIR"' EXIT
    printf '%s\n' "$$" >"$LOCK_DIR/pid" || exit 1
    if [ -f "$PAUSE_FILE" ]; then
      rm -rf "$LOCK_DIR"
      trap - EXIT
      continue
    fi

    log "unhealthy (pg=$pg_fail api=$api_fail web=$web_fail worker=$worker_fail index=$index_fail) — restarting"
    if [ "$need_stack" -eq 1 ]; then
      if [ "$pg_fail" -lt 2 ] && [ "$api_fail" -ge 2 ]; then kill_service api; wait_port_free "$API_PORT"; fi
      if [ "$web_fail" -ge 2 ]; then kill_service web; wait_port_free "$WEB_PORT"; fi
      if [ "$worker_fail" -ge 2 ]; then kill_service worker; fi
      if RAKAZO_KEEP_WATCHDOG_PAUSED=1 RAKAZO_START_LOCK_PID="$$" \
        bash "$ROOT/start-native.sh" >>"$ROOT/logs/supervisor.log" 2>&1; then
        log "restart finished"
      else
        log "restart failed — backing off 5 minutes"
      fi
    fi
    if [ "$index_fail" -ge 2 ]; then
      if bash "$MEMORY_SERVICE" restart >>"$ROOT/logs/semantic-memory.log" 2>&1; then
        log "memory index restarted"
      else
        log "memory index restart failed — see $ROOT/logs/semantic-memory.log"
      fi
    fi
    rm -rf "$LOCK_DIR"
    trap - EXIT
    pg_fail=0; api_fail=0; web_fail=0; worker_fail=0; index_fail=0
    sleep 300
  done
}

main "$@"
