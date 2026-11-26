#!/bin/bash
# Starts the Rakazo native stack: PostgreSQL, api, worker, web.
# Idempotent: services with a live pid file are left alone and their health is re-checked.
# Credentials and settings come from env.native (KEY=VALUE, chmod 600), never from a repo .env.
# Usage: ./start-native.sh        (also invoked by LaunchAgent ai.rakazo.native)

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${RAKAZO_SRC:-$(cd "$ROOT/.." && pwd)}"

PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

ENV_FILE="$ROOT/env.native"
LOG_DIR="$ROOT/logs"
RUN_DIR="$ROOT/run"
LOCK_DIR="$RUN_DIR/start.lock"
PAUSE_FILE="$RUN_DIR/watchdog.disabled"

API_HEALTH_TIMEOUT=60
WEB_HEALTH_TIMEOUT=60

log() { printf '%s [native] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { printf '%s [native] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

tail_log() {
  printf -- '---- last 12 lines of %s ----\n' "$LOG_DIR/$1.log" >&2
  tail -n 12 "$LOG_DIR/$1.log" 2>/dev/null >&2 || true
}

acquire_lock() {
  local other
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" >"$LOCK_DIR/pid" || die "cannot record lock owner"
    return 0
  fi
  other="$(tr -d '[:space:]' <"$LOCK_DIR/pid" 2>/dev/null || true)"
  case "$other" in ''|0|*[!0-9]*) die "another native operation is acquiring $LOCK_DIR" ;; esac
  if [ "$other" -gt 1 ] && kill -0 "$other" 2>/dev/null; then
    die "another start-native.sh is already running (pid $other)"
  fi
  log "removing stale start lock $LOCK_DIR"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || die "cannot create lock $LOCK_DIR"
  echo "$$" >"$LOCK_DIR/pid" || die "cannot record lock owner"
}

# KEY=VALUE lines only: comments and blanks skipped, an optional `export ` and one pair of
# surrounding quotes tolerated. Anything else is a hard error rather than shell-sourcing a file.
load_env_file() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — see README.md for configuration (KEY=VALUE, chmod 600)"
  [ -r "$ENV_FILE" ] || die "$ENV_FILE is not readable"

  local mode
  mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
  case "$mode" in
    ''|600|400) ;;
    *) log "WARNING: $ENV_FILE has mode $mode; expected 600 (run: chmod 600 $ENV_FILE)" ;;
  esac

  local line key value lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in 'export '*) line="${line#export }" ;; esac
    case "$line" in *=*) ;; *) die "$ENV_FILE line $lineno is not KEY=VALUE" ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      ''|0*|[!A-Za-z_]*|*[!A-Za-z0-9_]*) die "$ENV_FILE line $lineno has an invalid variable name: $key" ;;
    esac
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "$key=$value"
  done <"$ENV_FILE"
  log "loaded $ENV_FILE"
}

set_default() {
  local name="$1" value="$2" current
  eval "current=\${$name-}"
  if [ -z "$current" ]; then
    eval "export $name=\$value"
  fi
}

read_pid() {
  local file="$RUN_DIR/$1.pid" pid
  [ -f "$file" ] || return 1
  pid="$(tr -d '[:space:]' <"$file" 2>/dev/null || true)"
  case "$pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$pid"
}

# A stale pid can be re-used by an unrelated process; only trust one whose working directory is
# this service's app directory. If the process is gone, lsof prints nothing.
pid_belongs() {
  local pid="$1" name="$2" cwd expected
  [ -x /usr/sbin/lsof ] || return 0
  cwd="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{sub(/^n/,""); print; exit}')"
  [ -n "$cwd" ] || return 1
  expected="$(cd "$SRC/apps/$name" 2>/dev/null && pwd -P)" || expected="$SRC/apps/$name"
  case "$cwd" in
    "$expected"|"$expected"/*) return 0 ;;
    *) return 1 ;;
  esac
}

service_running() {
  local name="$1" pid
  pid="$(read_pid "$name")" || { rm -f "$RUN_DIR/$name.pid"; return 1; }
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$RUN_DIR/$name.pid"
    return 1
  fi
  if ! pid_belongs "$pid" "$name"; then
    log "WARNING: $RUN_DIR/$name.pid names pid $pid, which is not this stack's $name; starting a fresh one"
    rm -f "$RUN_DIR/$name.pid"
    return 1
  fi
  printf '%s\n' "$pid"
}

start_postgres() {
  if [ -f "$ROOT/pg-setup.sh" ]; then
    log "starting PostgreSQL via pg-setup.sh start"
    if ! ( cd "$ROOT" && bash "$ROOT/pg-setup.sh" start ); then
      tail_log postgres
      die "pg-setup.sh start failed"
    fi
    return 0
  fi

  local pg_bin="$ROOT/postgres/bin" pgdata="$ROOT/pgdata"
  [ -x "$pg_bin/pg_ctl" ] || die "PostgreSQL binaries missing at $pg_bin (see README.md)"
  [ -d "$pgdata" ] || die "PostgreSQL data directory missing at $pgdata (run pg-setup.sh setup first)"

  if "$pg_bin/pg_ctl" -D "$pgdata" status >/dev/null 2>&1; then
    log "PostgreSQL already running"
  else
    log "starting PostgreSQL on 127.0.0.1:55432"
    if ! "$pg_bin/pg_ctl" -D "$pgdata" -l "$LOG_DIR/postgres.log" -w -t 60 \
        -o "-p 55432 -k /tmp" start; then
      tail_log postgres
      die "pg_ctl start failed"
    fi
  fi
  "$pg_bin/pg_isready" -h 127.0.0.1 -p 55432 -q || {
    tail_log postgres
    die "PostgreSQL is not accepting connections on 127.0.0.1:55432"
  }
}

start_node_service() {
  local name="$1" entry="$2" logfile="$LOG_DIR/$1.log"
  printf '\n==== %s  start-native.sh starting %s ====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$name" >>"$logfile"
  (
    cd "$SRC/apps/$name" || exit 1
    exec nohup "$NODE_BIN" --enable-source-maps "$entry" >>"$logfile" 2>&1 </dev/null
  ) &
  echo "$!" >"$RUN_DIR/$name.pid"
  log "started $name (pid $!)"
}

port_in_use() {
  local port="$1"
  [ -x /usr/sbin/lsof ] || return 1
  [ -n "$(/usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" ]
}

start_api() {
  if service_running api >/dev/null; then
    log "api already running (pid $(read_pid api))"
    return 0
  fi
  [ -f "$SRC/apps/api/dist/index.js" ] ||
    die "api build missing: $SRC/apps/api/dist/index.js (build the server per BUILD.md)"
  if port_in_use "$API_PORT"; then
    die "port $API_PORT is already in use by another process — Docker/colima may still be running. Stop the Docker stack first (SWITCH.md 1.3), then rerun."
  fi
  start_node_service api "dist/index.js"
}

start_worker() {
  if service_running worker >/dev/null; then
    log "worker already running (pid $(read_pid worker))"
    return 0
  fi
  [ -f "$SRC/apps/worker/dist/index.js" ] ||
    die "worker build missing: $SRC/apps/worker/dist/index.js (build the server per BUILD.md)"
  # Busy runs allocate fast; a larger young generation cuts the worker's garbage collection.
  printf '\n==== %s  start-native.sh starting worker ====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$LOG_DIR/worker.log"
  (
    cd "$SRC/apps/worker" || exit 1
    export WORKER_HEALTH_FILE="$RUN_DIR/worker-health.json"
    exec nohup "$NODE_BIN" --enable-source-maps --max-semi-space-size=64 dist/index.js \
      >>"$LOG_DIR/worker.log" 2>&1 </dev/null
  ) &
  echo "$!" >"$RUN_DIR/worker.pid"
  log "started worker (pid $!)"
}

start_web() {
  if service_running web >/dev/null; then
    log "web already running (pid $(read_pid web))"
    return 0
  fi
  local logfile="$LOG_DIR/web.log"
  # The web host is the repo's standalone server (scripts/build-server-bundle.mjs output): it
  # proxies /api and /rpc, answers the desktop stack probe, and serves CSP and /novnc. A static
  # or plain file server cannot run the app.
  [ -f "$SRC/apps/web/dist-server/index.js" ] ||
    die "web server missing: $SRC/apps/web/dist-server/index.js — build it with scripts/build-server-bundle.mjs (see WEB.md / BUILD.md)"
  if port_in_use "$WEB_PORT"; then
    die "port $WEB_PORT is already in use — Docker/colima is likely still forwarding it. Stop the Docker stack and colima first (SWITCH.md 1.3), then rerun."
  fi

  printf '\n==== %s  start-native.sh starting web ====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$logfile"
  (
    cd "$SRC/apps/web" || exit 1
    exec nohup "$NODE_BIN" dist-server/index.js >>"$logfile" 2>&1 </dev/null
  ) &
  echo "$!" >"$RUN_DIR/web.pid"
  log "started web (pid $!)"
}

wait_for_http() {
  local name="$1" url="$2" timeout="$3" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if "$CURL_BIN" -fsS --max-time 3 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

main() {
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  chmod 700 "$RUN_DIR" 2>/dev/null || true
  if [ "${RAKAZO_START_LOCK_PID:-}" != "$PPID" ] ||
     [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$PPID" ]; then
    acquire_lock
    trap 'rm -rf "$LOCK_DIR"' EXIT
  fi

  # An empty pause is left by a deliberate stop. Only the owning deploy can
  # start services while the deployment pause is in force.
  if [ -f "$PAUSE_FILE" ]; then
    if [ -s "$PAUSE_FILE" ]; then
      [ -n "${RAKAZO_DEPLOY_PAUSE_OWNER:-}" ] &&
        [ "$(cat "$PAUSE_FILE")" = "$RAKAZO_DEPLOY_PAUSE_OWNER" ] ||
        die "a deployment holds run/watchdog.disabled"
      log "keeping the deployment's watchdog pause"
    elif [ "${RAKAZO_KEEP_WATCHDOG_PAUSED:-}" = "1" ]; then
      die "native stack is paused for maintenance"
    else
      rm -f "$PAUSE_FILE" || die "could not lift the watchdog pause"
      log "lifted the watchdog pause left by stop-native.sh"
    fi
  fi

  load_env_file

  # Settings the stack fixes for itself; env.native wins when it sets them.
  set_default API_HOST 127.0.0.1
  set_default API_PORT 3100
  set_default WEB_HOST 127.0.0.1
  set_default WEB_PORT 5173
  set_default NODE_ENV production
  export RAKAZO_ENV_FILE=none
  set_default API_URL "http://127.0.0.1:$API_PORT"
  set_default WEB_ORIGIN "http://127.0.0.1:$WEB_PORT"
  set_default API_PROXY_TARGET "$API_URL"
  set_default DATA_DIR "$ROOT/data"
  case "$DATA_DIR" in
    /*) ;;
    *) DATA_DIR="$ROOT/$DATA_DIR"; export DATA_DIR ;;
  esac
  mkdir -p "$DATA_DIR"

  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "node not found in PATH ($PATH)"
  CURL_BIN="$(command -v curl || true)"
  [ -n "$CURL_BIN" ] || die "curl not found in PATH ($PATH)"
  [ -d "$SRC" ] || die "Rakazo source checkout not found at $SRC (set RAKAZO_SRC)"

  start_postgres

  start_api
  start_worker

  log "waiting for api health at http://127.0.0.1:$API_PORT/health (max ${API_HEALTH_TIMEOUT}s)"
  wait_for_http api "http://127.0.0.1:$API_PORT/health" "$API_HEALTH_TIMEOUT" || {
    tail_log api
    die "api did not become healthy within ${API_HEALTH_TIMEOUT}s"
  }
  log "api is healthy"

  start_web

  log "waiting for web at http://127.0.0.1:$WEB_PORT/ (max ${WEB_HEALTH_TIMEOUT}s)"
  wait_for_http web "http://127.0.0.1:$WEB_PORT/" "$WEB_HEALTH_TIMEOUT" || {
    tail_log web
    die "web did not answer within ${WEB_HEALTH_TIMEOUT}s"
  }
  log "web is answering"

  if ! service_running worker >/dev/null; then
    tail_log worker
    die "worker is not running"
  fi

  log "ready: api http://127.0.0.1:$API_PORT/health  web http://127.0.0.1:$WEB_PORT/"
  log "logs: $LOG_DIR  pids: $RUN_DIR"
}

main "$@"
