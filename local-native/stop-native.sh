#!/bin/bash
# Stops the Rakazo native stack in reverse order: web, worker, api, then PostgreSQL.
# Each service gets SIGTERM and a grace period, then SIGKILL. PostgreSQL is stopped with
# pg_ctl -m fast (via pg-setup.sh stop when present), so its data is flushed and kept.
# Usage: ./stop-native.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${RAKAZO_SRC:-$(cd "$ROOT/.." && pwd)}"

PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

RUN_DIR="$ROOT/run"
LOCK_DIR="$RUN_DIR/start.lock"
PAUSE_FILE="$RUN_DIR/watchdog.disabled"
PGDATA="$ROOT/pgdata"
PG_BIN="$ROOT/postgres/bin"

# The API drains in-flight requests for 20s before exiting; the worker may be finishing a job.
WEB_GRACE=10
API_GRACE=30
WORKER_GRACE=30

log() { printf '%s [native] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '%s [native] WARNING: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

read_pid() {
  local file="$RUN_DIR/$1.pid" pid
  [ -f "$file" ] || return 1
  pid="$(tr -d '[:space:]' <"$file" 2>/dev/null || true)"
  case "$pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$pid"
}

alive() { kill -0 "$1" 2>/dev/null; }

# Only stop a process whose working directory is this service's app directory, so a re-used pid
# from a stale file never kills something unrelated.
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

stop_service() {
  local name="$1" grace="$2" file="$RUN_DIR/$1.pid" pid waited

  pid="$(read_pid "$name")" || {
    log "$name: not running (no pid file)"
    return 0
  }
  if ! alive "$pid"; then
    log "$name: already stopped (stale pid file removed)"
    rm -f "$file"
    return 0
  fi
  if ! pid_belongs "$pid" "$name"; then
    warn "$name: pid $pid does not belong to this stack's $name; leaving it alone and removing the stale pid file"
    rm -f "$file"
    return 0
  fi

  log "$name: sending SIGTERM to pid $pid"
  kill -TERM "$pid" 2>/dev/null || true
  waited=0
  while alive "$pid" && [ "$waited" -lt "$grace" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if alive "$pid"; then
    log "$name: still running after ${grace}s, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    waited=0
    while alive "$pid" && [ "$waited" -lt 5 ]; do
      sleep 1
      waited=$((waited + 1))
    done
  fi
  if alive "$pid"; then
    warn "$name: pid $pid is still alive after SIGKILL; keeping $file"
    return 1
  fi

  rm -f "$file"
  log "$name: stopped"
  return 0
}

stop_postgres() {
  if [ ! -d "$PGDATA" ]; then
    log "postgres: no data directory at $PGDATA, nothing to stop"
    return 0
  fi
  if ! [ -x "$PG_BIN/pg_ctl" ]; then
    warn "postgres: $PG_BIN/pg_ctl not found; cannot check or stop the server"
    return 1
  fi
  if ! "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    log "postgres: not running"
    return 0
  fi

  log "postgres: stopping with pg_ctl -m fast"
  local stopped=0
  if [ -f "$ROOT/pg-setup.sh" ]; then
    bash "$ROOT/pg-setup.sh" stop || stopped=1
  else
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w -t 60 stop || stopped=1
  fi
  if "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    warn "postgres: still running after stop"
    return 1
  fi
  [ "$stopped" -eq 0 ] || return 1
  log "postgres: stopped"
  return 0
}

main() {
  local failed=0
  log "stopping Rakazo native stack"

  # The watchdog restarts anything unhealthy; pause it so a deliberate stop stays stopped.
  mkdir -p "$RUN_DIR" || exit 1
  mkdir "$LOCK_DIR" 2>/dev/null || { warn "another native operation holds $LOCK_DIR"; exit 1; }
  trap 'rm -rf "$LOCK_DIR"' EXIT
  printf '%s\n' "$$" >"$LOCK_DIR/pid" || exit 1
  if ! (set -o noclobber; : >"$PAUSE_FILE") 2>/dev/null; then
    if [ ! -f "$PAUSE_FILE" ] || [ -s "$PAUSE_FILE" ]; then
      warn "cannot pause the watchdog while run/watchdog.disabled is owned by another operation"
      exit 1
    fi
  fi
  log "watchdog paused (start-native.sh resumes it)"

  stop_service web "$WEB_GRACE" || failed=1
  stop_service worker "$WORKER_GRACE" || failed=1
  stop_service api "$API_GRACE" || failed=1
  stop_postgres || failed=1

  if [ "$failed" -ne 0 ]; then
    log "some components did not stop cleanly (see warnings above)"
    exit 1
  fi
  log "all components stopped"
}

main "$@"
