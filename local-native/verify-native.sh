#!/bin/bash
# verify-native.sh — read-only verification of the native Rakazo stack.
#
# Checks PostgreSQL (127.0.0.1:55432), API liveness and readiness (127.0.0.1:3100),
# the web origin (127.0.0.1:5173): app shell + CSP + assets, the desktop stack
# probe, the /rpc proxy, the worker process and heartbeat, the migrated tables, the
# listening processes, local identity, and the desktop app's setup.json. Nothing is written.
#
# Usage: ./verify-native.sh [--quick]
#   --quick   skip the desktop app checks (use before the app is relaunched)
# Exit: 0 when every check passes, 1 when any check fails.

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${RAKAZO_SRC:-$(cd "$ROOT/.." && pwd)}"

PG_HOST=127.0.0.1
PG_PORT=55432
PG_USER=rakazo
PG_DB=rakazo

API_URL="http://127.0.0.1:3100/health"
WEB_HOST=127.0.0.1
WEB_PORT=5173
WEB_URL="http://$WEB_HOST:$WEB_PORT/"

APP_DIR="/Applications/Rakazo.app"
SETUP_JSON="$HOME/Library/Application Support/Rakazo/setup.json"

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
  GREEN=; RED=; DIM=; NC=
fi

PASSED=0
FAILED=0
SKIPPED=0
FAILED_ANY=0

run_check() {
  local title="$1" fn="$2" out rc
  out="$("$fn" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s[PASS]%s %s\n' "$GREEN" "$NC" "$title"
    PASSED=$((PASSED + 1))
  else
    printf '%s[FAIL]%s %s\n' "$RED" "$NC" "$title"
    FAILED=$((FAILED + 1)); FAILED_ANY=1
  fi
  if [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/       /'; fi
  return 0
}

skip_check() {
  printf '%s[SKIP]%s %s\n' "$DIM" "$NC" "$1"
  SKIPPED=$((SKIPPED + 1))
}

# --noproxy '*': a system/VPN proxy would answer for a loopback address or fail the request.
local_curl() {
  curl --noproxy '*' --silent --connect-timeout 2 --max-time 5 "$@"
}

# The bundled psql/pg_isready first, then whatever PATH offers.
pg_tool() {
  local name="$1"
  if [ -x "$BASE/postgres/bin/$name" ]; then
    printf '%s\n' "$BASE/postgres/bin/$name"
    return 0
  fi
  command -v "$name" 2>/dev/null
}

# A KEY=VALUE line from env.native with one quote pair stripped, never printed.
# Mirrors start-native.sh's loader for the shapes that file tolerates.
read_env_value() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$key=" "$file" 2>/dev/null | head -n 1)"
  [ -n "$line" ] || return 1
  line="${line#*=}"
  case "$line" in
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
  esac
  printf '%s\n' "$line" | tr -d '\r'
}

# 1. PostgreSQL is up and this database accepts a query.
check_postgres() {
  local problems=0 isready psql out rc
  isready="$(pg_tool pg_isready)"
  psql="$(pg_tool psql)"

  if [ -z "$isready" ]; then
    echo "pg_isready: not found in $BASE/postgres/bin or PATH"
    problems=1
  else
    out="$("$isready" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "pg_isready: $out"
    else
      echo "pg_isready: ${out:-no output} (exit $rc)"
      problems=1
    fi
  fi

  if [ -z "$psql" ]; then
    echo "psql: not found in $BASE/postgres/bin or PATH"
    problems=1
  else
    out="$(PGCONNECT_TIMEOUT=5 "$psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" \
      -d "$PG_DB" -w -tA -c 'select 1' 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ] && [ "$out" = "1" ]; then
      echo "psql: select 1 -> 1"
    else
      echo "psql: ${out:-no output} (exit $rc)"
      problems=1
    fi
  fi
  return "$problems"
}

# 2. API liveness and database readiness.
check_api() {
  local code rc url
  for url in "$API_URL" "${API_URL%/health}/ready"; do
    code="$(local_curl -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
    rc=$?
    if [ "$rc" -ne 0 ] || [ "$code" != "200" ]; then
      echo "GET $url -> ${code:-000} (curl exit $rc)"
      return 1
    fi
    echo "GET $url -> 200"
  done
  return 0
}

# 3. Web origin serves the built app: root div, CSP header, and a real /assets/ file.
check_web() {
  local tmp hdr code rc asset asset_code asset_type csp
  tmp="$(mktemp -t rakazo-verify-web)" || return 1
  hdr="$(mktemp -t rakazo-verify-web-hdr)" || { rm -f "$tmp"; return 1; }

  code="$(local_curl -D "$hdr" -o "$tmp" -w '%{http_code}' "$WEB_URL" 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ] || [ "$code" != "200" ]; then
    echo "GET $WEB_URL -> ${code:-000} (curl exit $rc)"
    rm -f "$tmp" "$hdr"
    return 1
  fi
  echo "GET $WEB_URL -> 200"

  if ! grep -q 'id="root"' "$tmp"; then
    echo 'index.html has no id="root" (not the Rakazo app shell?)'
    rm -f "$tmp" "$hdr"
    return 1
  fi
  echo 'index.html contains id="root"'

  csp="$(grep -i '^content-security-policy:' "$hdr" | head -n 1 | cut -d: -f2- \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$csp" ]; then
    echo 'response has no Content-Security-Policy header (plain static server?)'
    rm -f "$tmp" "$hdr"
    return 1
  fi
  echo "content-security-policy present (${#csp} chars)"
  rm -f "$hdr"

  asset="$(grep -oE '/assets/[A-Za-z0-9._~/-]+\.(js|css)' "$tmp" | head -n 1)"
  rm -f "$tmp"
  if [ -z "$asset" ]; then
    echo 'index.html references no /assets/ file (dev server, or the web build is not served)'
    return 1
  fi

  read -r asset_code asset_type <<EOF
$(local_curl -o /dev/null -w '%{http_code} %{content_type}' "http://$WEB_HOST:$WEB_PORT$asset" 2>/dev/null)
EOF
  if [ "$asset_code" != "200" ]; then
    echo "GET $asset -> ${asset_code:-000}"
    return 1
  fi
  case "$asset_type" in
    text/html*)
      echo "GET $asset -> 200 but content-type is $asset_type (SPA fallback, not a file)"
      return 1 ;;
  esac
  echo "GET $asset -> 200 (${asset_type:-unknown type})"
  return 0
}

# 4. The desktop stack probe: the token header must yield the JSON the app's stack gate reads.
check_desktop_probe() {
  local token tmp hdr code ctype body
  token="$(read_env_value "$BASE/env.native" RAKAZO_DESKTOP_STACK_TOKEN)" || token=""
  if [ -z "$token" ]; then
    echo "env.native: RAKAZO_DESKTOP_STACK_TOKEN is missing or empty"
    echo "the probe answers 404 without it; set it so web and App agree"
    return 1
  fi

  tmp="$(mktemp -t rakazo-verify-probe)" || return 1
  hdr="$(mktemp -t rakazo-verify-probe-hdr)" || { rm -f "$tmp"; return 1; }
  code="$(local_curl -H "x-rakazo-desktop-stack-token: $token" -D "$hdr" -o "$tmp" \
    -w '%{http_code}' "http://$WEB_HOST:$WEB_PORT/.well-known/rakazo-desktop-stack" 2>/dev/null)"
  ctype="$(grep -i '^content-type:' "$hdr" | head -n 1 | cut -d: -f2- | tr -d ' \r')"
  body="$(head -c 300 "$tmp" 2>/dev/null | tr -d '\n')"
  rm -f "$tmp" "$hdr"

  if [ "$code" != "200" ]; then
    echo "GET /.well-known/rakazo-desktop-stack -> ${code:-000}"
    if [ "$code" = "000" ]; then
      echo "web is not answering on port $WEB_PORT"
    else
      echo "404 means either the web host has no probe (static server) or the token in"
      echo "env.native does not match the running web process"
    fi
    return 1
  fi
  case "$ctype" in
    application/json*) ;;
    *)
      echo "GET /.well-known/rakazo-desktop-stack -> 200 but content-type is ${ctype:-missing}"
      return 1 ;;
  esac
  if ! printf '%s' "$body" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "probe body is not {ok:true,...}: $body"
    return 1
  fi
  if ! printf '%s' "$body" | grep -q '"imageTag"'; then
    echo "probe body has no imageTag: $body"
    return 1
  fi
  echo "GET /.well-known/rakazo-desktop-stack -> 200 JSON $body"
  return 0
}

# 5. The web origin proxies /rpc to the API: the bare path is rejected by the API (4xx),
# and the desktop app's own probe answers 200 with ok:true.
check_web_api_proxy() {
  local problems=0 code body tmp
  code="$(local_curl -o /dev/null -w '%{http_code}' "http://$WEB_HOST:$WEB_PORT/rpc" 2>/dev/null)"
  case "$code" in
    4*)
      echo "GET /rpc -> $code (the API rejects the bare prefix, as expected)" ;;
    *)
      echo "GET /rpc -> ${code:-000}; a 200 here is the SPA shell, not the API"
      problems=1 ;;
  esac

  tmp="$(mktemp -t rakazo-verify-rpc)" || return 1
  code="$(local_curl -X POST -H 'content-type: application/json' -d '{"json":{}}' \
    -o "$tmp" -w '%{http_code}' "http://$WEB_HOST:$WEB_PORT/rpc/health" 2>/dev/null)"
  body="$(head -c 200 "$tmp" 2>/dev/null | tr -d '\n')"
  rm -f "$tmp"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "POST /rpc/health -> 200 (ok:true)"
  else
    echo "POST /rpc/health -> ${code:-000} ${body}"
    echo "a static-only web server (serve-web.mjs) breaks local identity and this probe; use"
    echo "vite preview or apps/web/dist-server/index.js. See WEB.md."
    problems=1
  fi
  return "$problems"
}

# 6. Reuse the worker's health check; startup logs may have rotated away.
check_worker() {
  local pid
  pid="$(tr -d '[:space:]' 2>/dev/null <"$BASE/run/worker.pid")" || pid=""
  case "$pid" in
    ''|0|1|*[!0-9]*) echo "process: missing or invalid run/worker.pid"; return 1 ;;
  esac
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "process: worker pid $pid is not running"
    return 1
  fi
  if WORKER_HEALTH_FILE="$BASE/run/worker-health.json" WORKER_HEALTH_PID="$pid" \
     node "$SRC/apps/worker/dist/health-check.js"; then
    echo "health: worker $pid heartbeat and reconciliation are fresh"
  else
    echo "health: worker $pid heartbeat is stale or belongs to another PID"
    return 1
  fi
}

# 7. Tables exist and hold data: proof the data migration ran, not just the schema.
check_migration() {
  local problems=0 psql out table
  psql="$(pg_tool psql)"
  if [ -z "$psql" ]; then
    echo "psql: not found in $BASE/postgres/bin or PATH"
    return 1
  fi

  for table in space_model_role_choices spaces; do
    out="$(PGCONNECT_TIMEOUT=5 "$psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" \
      -d "$PG_DB" -w -tA -c "select count(*) from $table;" 2>&1)"
    case "$out" in
      ''|*[!0-9]*)
        echo "$table: query failed: $out"
        problems=1 ;;
      *)
        if [ "$out" -gt 0 ]; then
          echo "$table: $out rows"
        else
          echo "$table: 0 rows (schema present but no data - data migration not applied?)"
          problems=1
        fi ;;
    esac
  done
  return "$problems"
}

# 8. Desktop app present, running, and pointed at the native web origin.
check_app() {
  local problems=0 pid
  if [ -d "$APP_DIR" ]; then
    echo "app: $APP_DIR present"
  else
    echo "app: $APP_DIR missing"
    problems=1
  fi

  pid="$(pgrep -x Rakazo 2>/dev/null | head -n 1)"
  if [ -n "$pid" ]; then
    echo "process: Rakazo running (pid $pid)"
  else
    echo "process: no process named exactly 'Rakazo'"
    problems=1
  fi

  if [ -f "$SETUP_JSON" ]; then
    if grep -Eq '"mode"[[:space:]]*:[[:space:]]*"existing"' "$SETUP_JSON"; then
      echo "setup.json: mode=existing"
    else
      echo "setup.json: mode is not 'existing'"
      problems=1
    fi
    if grep -Eq '"serverUrl"[[:space:]]*:[[:space:]]*"http://127\.0\.0\.1:5173/?"' "$SETUP_JSON"; then
      echo "setup.json: serverUrl=http://127.0.0.1:5173"
    else
      echo "setup.json: serverUrl is not http://127.0.0.1:5173"
      problems=1
    fi
  else
    echo "setup.json: not found at $SETUP_JSON"
    problems=1
  fi
  return "$problems"
}

# 9. The loopback ports are held by this stack's own processes, not colima/Docker forwards.
check_listeners() {
  local problems=0 port pid comm lsof_bin
  lsof_bin=/usr/sbin/lsof
  [ -x "$lsof_bin" ] || lsof_bin="$(command -v lsof 2>/dev/null)"
  if [ -z "$lsof_bin" ]; then
    echo "lsof: not found, cannot identify the listeners"
    return 1
  fi
  for port in 3100 5173 55432; do
    pid="$("$lsof_bin" -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1)"
    if [ -z "$pid" ]; then
      echo "port $port: no listener"
      problems=1
      continue
    fi
    comm="$(ps -p "$pid" -o comm= 2>/dev/null)"
    case "$comm" in
      *docker*|*colima*|*limactl*|*vpnkit*|ssh*)
        echo "port $port: pid $pid ($comm) - forwarded by Docker/colima, not native"
        problems=1 ;;
      *)
        echo "port $port: pid $pid ($comm)" ;;
    esac
  done
  return "$problems"
}

# 10. Both origins expose the same local identity without account-login endpoints.
check_local_identity() {
  node --input-type=module - "$API_URL" "$WEB_URL" <<'NODE'
import assert from "node:assert/strict";

let identityId;
for (const target of process.argv.slice(2)) {
  const origin = new URL(target).origin;
  const response = await fetch(`${origin}/api/local-identity`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${origin}: local identity is unavailable`);
  const identity = await response.json();
  assert.ok(typeof identity.id === "string" && identity.id.length > 0, "Missing identity id");
  assert.equal(typeof identity.name, "string", "Missing identity name");
  assert.equal(typeof identity.email, "string", "Missing identity email");
  identityId ??= identity.id;
  assert.equal(identity.id, identityId, "API and web resolve different identities");
  assert.ok(
    response.headers.get("cache-control")?.split(",").map(value => value.trim()).includes("no-store"),
    "Local identity must not be cached",
  );
  console.log(`${origin}: local identity JSON, consistent id, no-store`);

  const retired = await fetch(`${origin}/api/auth/get-session`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(retired.status, 404, `${origin}: retired account-session route is still available`);
  const remote = await fetch(`${origin}/api/local-identity`, {
    headers: { "x-forwarded-for": "203.0.113.10" },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(remote.status, 403, `${origin}: remote forwarded request was accepted`);
  console.log(`${origin}: retired account-session route 404, remote forwarded request 403`);
}
NODE
}

printf 'Rakazo native cutover verification\n'
printf 'base: %s\n' "$BASE"
printf 'targets: postgres %s:%s, api %s, web %s\n' "$PG_HOST" "$PG_PORT" "$API_URL" "$WEB_URL"
if [ "$QUICK" -eq 1 ]; then printf 'mode: --quick (desktop app checks skipped)\n'; fi
printf '\n'

run_check "1. Postgres  $PG_HOST:$PG_PORT accepts connections and select 1" check_postgres
run_check "2. API       liveness and database readiness return 200" check_api
run_check "3. Web       GET $WEB_URL returns 200 with id=\"root\", CSP and a /assets/ file" check_web
run_check "4. Web probe /.well-known/rakazo-desktop-stack returns JSON with imageTag" check_desktop_probe
run_check "5. Proxy     GET /rpc reaches the API and POST /rpc/health returns 200" check_web_api_proxy
run_check "6. Worker    heartbeat and reconciliation are fresh and the process is alive" check_worker
run_check "7. Data      spaces and space_model_role_choices have rows" check_migration

if [ "$QUICK" -eq 1 ]; then
  skip_check "8. Desktop   Rakazo.app running, setup.json mode=existing -> $WEB_URL"
else
  run_check "8. Desktop   Rakazo.app running, setup.json mode=existing -> $WEB_URL" check_app
fi

run_check "9. Ports     3100/5173/55432 held by native processes, not colima/Docker" check_listeners
run_check "10. Identity API and web use the same local identity and reject remote access" check_local_identity

printf '\n'
printf 'Summary: %d passed, %d failed, %d skipped\n' "$PASSED" "$FAILED" "$SKIPPED"
if [ "$FAILED_ANY" -eq 0 ]; then
  printf '%sResult: PASS%s\n' "$GREEN" "$NC"
  exit 0
fi
printf '%sResult: FAIL%s\n' "$RED" "$NC"
exit 1
