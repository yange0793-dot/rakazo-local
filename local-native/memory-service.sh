#!/bin/bash
# Native local-memory lifecycle; never touches PostgreSQL or app processes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${RAKAZO_SRC:-$(cd "$ROOT/.." && pwd)}"
PYTHON="$ROOT/memory-runtime/python/bin/python"
CACHE="$ROOT/memory-runtime/hf-cache/hub"
PALACE="$ROOT/data/semantic-memory-index"
TOKEN="$ROOT/run/semantic-memory.token"
LOG="$ROOT/logs/semantic-memory.log"
SCRIPT="$SRC/scripts/local-memory-index.py"
PORT=17676
LABEL=ai.rakazo.memory
SERVICE="gui/$(id -u)/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

job_loaded() {
  launchctl print "$SERVICE" >/dev/null 2>&1
}

# The service itself writes almost nothing to its log, so every start and failure this script
# drives is recorded here: "see $LOG" must not point at an empty file.
log() { printf '%s [memory-service] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

owned_pid() {
  local pid command
  pid="$(launchctl print "$SERVICE" 2>/dev/null | "$PYTHON" -I -c '
import re, sys
match = re.search(r"^\s*pid = ([0-9]+)$", sys.stdin.read(), re.MULTILINE)
if not match:
    sys.exit(1)
print(match.group(1))
')" || return 1
  case "$pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(/bin/ps -p "$pid" -o command=)"
  case "$command" in
    *"$SCRIPT"*"--palace-dir $PALACE"*"--token-file $TOKEN"*"--cache-dir $CACHE"*) printf '%s' "$pid" ;;
    *) printf '%s\n' 'Refusing an unrelated process in the memory launch job.' >&2; return 2 ;;
  esac
}

health() {
  "$PYTHON" -I - "$TOKEN" "$PORT" <<'PY'
import json
import pathlib
import sys
import urllib.request
token = pathlib.Path(sys.argv[1]).read_text().strip()
request = urllib.request.Request('http://127.0.0.1:' + sys.argv[2] + '/health', headers={'Authorization': 'Bearer ' + token})
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=3) as response:
        if response.status != 200 or json.load(response).get('ok') is not True:
            raise RuntimeError('unhealthy')
except Exception:
    sys.exit(1)
PY
}

start() {
  [ -x "$PYTHON" ] && [ -f "$SCRIPT" ] && [ -d "$CACHE" ] && [ -f "$PLIST" ] || { log 'start refused: memory runtime, source, offline cache or launch job is missing'; printf '%s\n' 'Memory runtime, source, offline cache or launch job is missing.' >&2; return 1; }
  [ -f "$TOKEN" ] || { log "start refused: token file $TOKEN is missing"; printf '%s\n' 'Create the private token file before starting memory.' >&2; return 1; }
  local pid status i
  if pid="$(owned_pid)"; then
    health || { log "process $pid is running but not healthy; left it untouched"; printf '%s\n' "Memory process $pid is running but not healthy; left it untouched. See $LOG." >&2; return 1; }
    log "already running (pid $pid)"
    printf '%s\n' "Memory already running (pid $pid)."
    return 0
  else
    status=$?
    [ "$status" -ne 2 ] || return 1
  fi
  if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    log "start refused: port $PORT is already occupied; no process was stopped"
    printf '%s\n' "Port $PORT is already occupied; no process was stopped." >&2
    return 1
  fi
  if job_loaded; then
    log "starting with launchctl kickstart $SERVICE"
    launchctl kickstart "$SERVICE" || return 1
  else
    log "starting with launchctl bootstrap $PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || return 1
  fi
  for ((i=0; i<60; i++)); do
    if pid="$(owned_pid)"; then
      if health; then log "ready (pid $pid, loopback port $PORT)"; printf '%s\n' "Memory ready (pid $pid, loopback port $PORT)."; return 0; fi
    else
      status=$?
      [ "$status" -ne 2 ] || return 1
    fi
    sleep 1
  done
  log "startup did not become healthy within 60 seconds; launch job left for inspection"
  printf '%s\n' "Memory startup did not become healthy; see $LOG. Launch job left for inspection." >&2
  return 1
}

stop() {
  if ! job_loaded; then log 'stop: launch job is not loaded'; printf '%s\n' 'Memory is not running.'; return 0; fi
  local pid status i
  if pid="$(owned_pid)"; then :; else
    status=$?
    [ "$status" -ne 2 ] || return 1
    pid=''
  fi
  log "stopping with launchctl bootout $SERVICE"
  launchctl bootout "$SERVICE" || return 1
  for ((i=0; i<30; i++)); do
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then log 'stopped'; printf '%s\n' 'Memory stopped.'; return 0; fi
    sleep 1
  done
  log 'stop: process did not exit within 30 seconds; not force-killed'
  printf '%s\n' 'Memory did not exit within 30 seconds; not force-killed.' >&2
  return 1
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status)
    if pid="$(owned_pid)" && health; then printf '%s\n' "Memory healthy (pid $pid, launch job $LABEL)."; else log 'status: stopped or unhealthy'; printf '%s\n' "Memory is stopped or unhealthy; see $LOG."; exit 1; fi
    ;;
  *) printf '%s\n' 'Usage: bash memory-service.sh start|stop|restart|status' >&2; exit 2 ;;
esac
