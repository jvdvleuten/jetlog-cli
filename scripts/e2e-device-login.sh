#!/usr/bin/env bash
#
# End-to-end test for the "log in with the Jetlog app" device flow (QR + 2-digit
# number matching). For maintainers: it needs a local checkout of the (private)
# Jetlog backend plus a reachable Postgres, so it cannot run from this repo alone.
# Nothing is mocked, and it never touches your development database.
#
# It boots the backend's `JETLOG_E2E=1` scratch-server mode on its own scratch
# database and port (so it can run next to scripts/e2e-local.sh and next to a
# normal dev server on :4000), seeds one user, mints that user's app JWT (the
# approval endpoints are JWT-only, exactly like the iOS app), then checks:
#
#   1. approve WITHOUT a number              -> 422 match_number_required (stays pending)
#   2. approve with a WRONG number           -> 422 number_mismatch, and the request is now
#                                               dead: /oauth/token says access_denied/number_mismatch,
#                                               a second approve is 404
#   3. `jetlog login` + a wrong number       -> exits 1, tells the user the number did not match
#   4. `jetlog login` + the RIGHT number     -> exits 0, credentials saved, `jetlog whoami` works
#
# The CLI is driven exactly like a user would drive it (its own stdout is parsed for
# the number and the user code); only the "app" side is played with curl + the JWT.
#
# Usage:
#   scripts/e2e-device-login.sh
#
# Env overrides:
#   JETLOG_BACKEND_DIR       backend checkout (default: ~/git/jetlog-worktrees/integration)
#   JETLOG_E2E_LOGIN_DB_NAME scratch Postgres database (default: jetlog_cli_login_e2e), always dropped
#                            and recreated, and dropped again at the end (JETLOG_E2E_KEEP_DB=1 keeps it).
#                            Never your development database.
#   JETLOG_E2E_LOGIN_PORT    scratch server port (default: 4101; e2e-local.sh uses 4100)
#   JETLOG_E2E_EMAIL         synthetic user's email (default: cli-login-e2e@test.local)
#
# Like e2e-local.sh this starts the endpoint directly instead of `mix phx.server`
# (whose alias can start or stop shared Docker containers) and never runs docker
# itself: a '*-db-1' Postgres container must already be up. Not part of `npm test`.

set -euo pipefail

unset FORCE_COLOR || true
export NO_COLOR=1

echo "=== jetlog-cli device-login E2E starting ==="

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${JETLOG_BACKEND_DIR:-$HOME/git/jetlog-worktrees/integration}"
DB_NAME="${JETLOG_E2E_LOGIN_DB_NAME:-jetlog_cli_login_e2e}"
PORT="${JETLOG_E2E_LOGIN_PORT:-4101}"
BASE_URL="http://localhost:${PORT}"
EMAIL="${JETLOG_E2E_EMAIL:-cli-login-e2e@test.local}"

case "$DB_NAME" in
  jetlog_dev | jetlog_test* | jetlog_prod* | jetlog)
    echo "refusing to run against '$DB_NAME' - set JETLOG_E2E_LOGIN_DB_NAME to a scratch name" >&2
    exit 1
    ;;
esac

if [ ! -d "$BACKEND_DIR" ]; then
  echo "backend checkout not found at $BACKEND_DIR (set JETLOG_BACKEND_DIR)" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t jetlog_login_e2e)"
SERVER_LOG="$WORK_DIR/server.log"
SEED_SCRIPT="$WORK_DIR/seed.exs"
export XDG_CONFIG_HOME="$WORK_DIR/config"
export XDG_CACHE_HOME="$WORK_DIR/cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
# A stray token or base URL from the calling shell must not leak into the run.
unset JETLOG_TOKEN || true
unset JETLOG_BASE_URL || true

SERVER_PID=""
LOGIN_PID=""
DB_CREATED=""

cleanup() {
  run_state=$?
  if [ -n "$LOGIN_PID" ]; then
    kill "$LOGIN_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ]; then
    echo "--- stopping scratch server (pid ${SERVER_PID}) ---"
    kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  # The beam's pid does not always match `$!`; kill by LISTENING PORT too, so a leftover
  # scratch server never blocks the next run with EADDRINUSE. Only this script's own port.
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  fi
  if [ -n "$DB_CREATED" ] && [ "${JETLOG_E2E_KEEP_DB:-}" != "1" ]; then
    sleep 1
    echo "--- dropping scratch database '${DB_NAME}' ---"
    (cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.drop --quiet >/dev/null 2>&1) \
      || echo "warning: could not drop scratch database '${DB_NAME}' - drop it by hand" >&2
  fi
  echo "=== jetlog-cli device-login E2E finished (exit ${run_state}); work dir kept at ${WORK_DIR} ==="
  exit "$run_state"
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if command -v docker >/dev/null 2>&1 && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '\-db-1$'; then
  echo "no running '*-db-1' Postgres container found - start one yourself first." >&2
  echo "this script never runs docker compose/start/stop itself." >&2
  exit 1
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port ${PORT} is already in use - set JETLOG_E2E_LOGIN_PORT to a free port" >&2
  exit 1
fi

echo "--- (re)creating scratch database '${DB_NAME}' (never jetlog_dev) ---"
(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.drop --quiet >/dev/null 2>&1) || true
(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.create)
DB_CREATED=1
(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.migrate)

echo "--- starting the scratch server on port ${PORT} (NOT via 'mix phx.server') ---"
(cd "$BACKEND_DIR" && JETLOG_E2E=1 JETLOG_DB_NAME="$DB_NAME" PORT="$PORT" MIX_ENV=dev \
  nohup elixir --erl "-phoenix serve_endpoints true" -S mix run --no-halt >"$SERVER_LOG" 2>&1 &
  echo $! >"$SERVER_LOG.pid")
SERVER_PID="$(cat "$SERVER_LOG.pid")"
rm -f "$SERVER_LOG.pid"

echo "--- waiting for the server to come up (pid ${SERVER_PID}) ---"
ready=""
i=0
while [ "$i" -lt 90 ]; do
  if grep -q "Running JetlogWeb.Endpoint" "$SERVER_LOG" 2>/dev/null; then
    ready=1
    break
  fi
  if grep -qE '\*\* \(Mix\)|CompileError|does not exist' "$SERVER_LOG" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 2
done
if [ -z "$ready" ]; then
  echo "server did not come up in time - last 80 lines of ${SERVER_LOG}:" >&2
  tail -80 "$SERVER_LOG" >&2
  exit 1
fi

echo "--- seeding a user and minting its app JWT (what the iOS app sends) ---"
cat >"$SEED_SCRIPT" <<'EXS'
alias Jetlog.{Guardian, Repo, User}

email = System.get_env("JETLOG_E2E_EMAIL", "cli-login-e2e@test.local")

user =
  case Repo.get_by(User, email: email) do
    nil -> Repo.insert!(User.changeset(%User{}, %{email: email}))
    existing -> existing
  end

{:ok, token, _claims} = Guardian.encode_and_sign(user)

IO.puts("E2E_USER_ID:#{user.id}")
IO.puts("E2E_JWT:#{token}")
EXS

SEED_OUTPUT="$(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" JETLOG_E2E_EMAIL="$EMAIL" MIX_ENV=dev mix run "$SEED_SCRIPT")"
JWT="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_JWT://p')"
E2E_USER_ID="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_USER_ID://p')"
if [ -z "$JWT" ] || [ -z "$E2E_USER_ID" ]; then
  echo "failed to mint the app JWT:" >&2
  echo "$SEED_OUTPUT" >&2
  exit 1
fi

echo "--- building the CLI ---"
(cd "$CLI_DIR" && npm run build >/dev/null)
CLI_JS="$CLI_DIR/dist/cli.js"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

json_field() {
  # json_field <name>: prints a top-level field of the JSON on stdin ("" when absent).
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      try {
        const v = JSON.parse(d)[process.argv[1]];
        process.stdout.write(v === undefined || v === null ? "" : String(v));
      } catch (e) {}
    });
  ' "$1"
}

HTTP_BODY=""
HTTP_STATUS=""
# http <method> <path> [json-body] [bearer]; sets HTTP_STATUS and HTTP_BODY.
http() {
  method="$1"
  path="$2"
  body="${3:-}"
  bearer="${4:-}"
  empty_json='{}'
  out="$WORK_DIR/http.body"
  if [ -n "$bearer" ] && [ -n "$body" ]; then
    HTTP_STATUS="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H "Authorization: Bearer ${bearer}" -H "Content-Type: application/json" -d "$body")"
  elif [ -n "$bearer" ]; then
    HTTP_STATUS="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H "Authorization: Bearer ${bearer}")"
  else
    HTTP_STATUS="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H "Content-Type: application/json" -d "${body:-$empty_json}")"
  fi
  HTTP_BODY="$(cat "$out")"
}

expect_http() {
  # expect_http <label> <status> <error-or-empty>
  if [ "$HTTP_STATUS" != "$2" ]; then
    fail "$1: expected HTTP $2, got ${HTTP_STATUS} (${HTTP_BODY})"
  fi
  if [ -n "${3:-}" ]; then
    got="$(printf '%s' "$HTTP_BODY" | json_field error)"
    if [ "$got" != "$3" ]; then
      fail "$1: expected error '$3', got '${got}' (${HTTP_BODY})"
    fi
  fi
  echo "ok: $1 -> HTTP ${HTTP_STATUS} ${3:-}"
}

# A number guaranteed to differ from $1 and to stay inside 10..99.
wrong_number() {
  echo $((10 + ($1 - 10 + 1) % 90))
}

approve() {
  # approve <user_code> <json-body>
  http POST "/api/device_authorizations/$1/approve" "$2" "$JWT"
}

# ---------------------------------------------------------------------------
# 1 + 2: protocol level (curl plays both the CLI and the app)
# ---------------------------------------------------------------------------

echo "--- 1+2: protocol checks (missing number, wrong number) ---"
http POST /oauth/device_authorization '{"client_id":"jetlog-cli","client_name":"jetlog-cli e2e","scope":"read"}'
expect_http "device_authorization" 200
DEVICE_CODE="$(printf '%s' "$HTTP_BODY" | json_field device_code)"
USER_CODE="$(printf '%s' "$HTTP_BODY" | json_field user_code)"
MATCH_NUMBER="$(printf '%s' "$HTTP_BODY" | json_field match_number)"
[ -n "$DEVICE_CODE" ] && [ -n "$USER_CODE" ] || fail "device_authorization response had no device_code/user_code: ${HTTP_BODY}"
case "$MATCH_NUMBER" in
  [1-9][0-9]) echo "ok: device_authorization returned match_number ${MATCH_NUMBER}" ;;
  *) fail "match_number must be 10..99, got '${MATCH_NUMBER}'" ;;
esac

SCOPES='"scopes":["read"]'

approve "$USER_CODE" "{${SCOPES}}"
expect_http "approve without a number" 422 match_number_required

WRONG="$(wrong_number "$MATCH_NUMBER")"
approve "$USER_CODE" "{\"match_number\":${WRONG},${SCOPES}}"
expect_http "approve with the wrong number (${WRONG}, real ${MATCH_NUMBER})" 422 number_mismatch

# The mismatch spent the request: a retry with the RIGHT number must not revive it.
approve "$USER_CODE" "{\"match_number\":${MATCH_NUMBER},${SCOPES}}"
expect_http "approve after a mismatch (request is dead)" 404 not_found

# The device_code holder sees the denial (poll until it is no longer pending/slow_down).
TOKEN_BODY='{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"'"$DEVICE_CODE"'","client_id":"jetlog-cli"}'
tries=0
while :; do
  http POST /oauth/token "$TOKEN_BODY"
  err="$(printf '%s' "$HTTP_BODY" | json_field error)"
  if [ "$err" != "authorization_pending" ] && [ "$err" != "slow_down" ]; then
    break
  fi
  tries=$((tries + 1))
  [ "$tries" -lt 6 ] || fail "token endpoint never settled: ${HTTP_BODY}"
  sleep 5
done
expect_http "token poll after a mismatch" 400 access_denied
DESC="$(printf '%s' "$HTTP_BODY" | json_field error_description)"
[ "$DESC" = "number_mismatch" ] || fail "expected error_description number_mismatch, got '${DESC}' (${HTTP_BODY})"
echo "ok: token poll reports number_mismatch"

# ---------------------------------------------------------------------------
# 3 + 4: the real CLI (`jetlog login`), the app side played with curl
# ---------------------------------------------------------------------------

# start_login <name>: starts `jetlog login` in the background and waits until it printed the
# number and the user code. Sets LOGIN_OUT, LOGIN_PID, CLI_NUMBER and CLI_USER_CODE.
start_login() {
  LOGIN_OUT="$WORK_DIR/login-$1.out"
  : >"$LOGIN_OUT"
  node "$CLI_JS" login --base-url "$BASE_URL" --no-qr >"$LOGIN_OUT" 2>&1 &
  LOGIN_PID=$!
  CLI_NUMBER=""
  CLI_USER_CODE=""
  waited=0
  while [ "$waited" -lt 30 ]; do
    CLI_NUMBER="$(sed -n 's/.*Your number: *\([0-9][0-9]*\).*/\1/p' "$LOGIN_OUT" | head -1)"
    CLI_USER_CODE="$(sed -n 's/.* and enter \([A-Z0-9-][A-Z0-9-]*\)$/\1/p' "$LOGIN_OUT" | head -1)"
    if [ -n "$CLI_NUMBER" ] && [ -n "$CLI_USER_CODE" ]; then
      return 0
    fi
    waited=$((waited + 1))
    sleep 1
  done
  echo "--- jetlog login output ---" >&2
  cat "$LOGIN_OUT" >&2
  fail "jetlog login ($1) did not print a number and a user code"
}

# finish_login: waits (up to ~90 s, the CLI polls every 5 s) for the backgrounded login and
# sets LOGIN_RC to its exit code.
finish_login() {
  waited=0
  while kill -0 "$LOGIN_PID" >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -gt 90 ]; then
      kill "$LOGIN_PID" >/dev/null 2>&1 || true
      echo "--- jetlog login output ---" >&2
      cat "$LOGIN_OUT" >&2
      fail "jetlog login did not finish in time"
    fi
    sleep 1
  done
  LOGIN_RC=0
  wait "$LOGIN_PID" || LOGIN_RC=$?
  LOGIN_PID=""
}

echo "--- 3: jetlog login, wrong number picked in the app ---"
start_login wrong
echo "CLI shows number ${CLI_NUMBER}, user code ${CLI_USER_CODE}"
grep -q "Link:" "$LOGIN_OUT" || { cat "$LOGIN_OUT" >&2; fail "login output has no sign-in link (it prints the QR/number/link and does not open a browser by default)"; }
WRONG="$(wrong_number "$CLI_NUMBER")"
approve "$CLI_USER_CODE" "{\"match_number\":${WRONG},${SCOPES}}"
expect_http "app picks the wrong number (${WRONG})" 422 number_mismatch
finish_login
if [ "$LOGIN_RC" = "0" ]; then
  cat "$LOGIN_OUT" >&2
  fail "jetlog login succeeded although the wrong number was picked"
fi
grep -q "didn't match" "$LOGIN_OUT" || { cat "$LOGIN_OUT" >&2; fail "login output does not say the number did not match"; }
echo "ok: jetlog login exited ${LOGIN_RC} and reported the mismatch"
if [ -e "$XDG_CONFIG_HOME/jetlog/credentials.json" ]; then
  fail "credentials were saved after a failed login"
fi

echo "--- 4: jetlog login, right number picked in the app ---"
start_login right
echo "CLI shows number ${CLI_NUMBER}, user code ${CLI_USER_CODE}"
approve "$CLI_USER_CODE" "{\"match_number\":${CLI_NUMBER},${SCOPES}}"
expect_http "app picks the right number (${CLI_NUMBER})" 200
[ "$(printf '%s' "$HTTP_BODY" | json_field kind)" = "cli_token" ] || fail "approve did not return kind cli_token: ${HTTP_BODY}"
finish_login
if [ "$LOGIN_RC" != "0" ]; then
  cat "$LOGIN_OUT" >&2
  fail "jetlog login failed (exit ${LOGIN_RC}) although the right number was picked"
fi
echo "ok: jetlog login exited 0"

echo "--- jetlog whoami (uses the credential the login saved) ---"
export JETLOG_BASE_URL="$BASE_URL"
WHOAMI="$(node "$CLI_JS" whoami --json)"
echo "$WHOAMI"
[ "$(printf '%s' "$WHOAMI" | json_field user_id)" = "$E2E_USER_ID" ] || fail "whoami returned a different user than the one that approved"
[ "$(printf '%s' "$WHOAMI" | json_field email)" = "$EMAIL" ] || fail "whoami returned a different email"
echo "ok: whoami is ${EMAIL}"

echo "--- the saved token can read the logbook ---"
node "$CLI_JS" entries search --json >/dev/null

echo "=== jetlog-cli device-login E2E PASSED ==="
