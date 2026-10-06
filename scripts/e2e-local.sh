#!/usr/bin/env bash
#
# End-to-end smoke test for `jetlog import`/`jetlog batches`. For maintainers:
# it needs a local checkout of the (private) Jetlog backend plus a reachable
# Postgres, so it cannot run from this repo alone.
#
# It boots the backend's `JETLOG_E2E=1` scratch-server mode against a
# throwaway database (never your development database), mints a synthetic
# user and a write-scoped personal access token directly in the backend, then
# drives the built CLI like a real user: login, import, re-import (expect
# updates/unchanged, never duplicates), list/remove a batch, verify it is gone.
#
# Usage:
#   scripts/e2e-local.sh
#
# Env overrides:
#   JETLOG_BACKEND_DIR   path to the Jetlog backend checkout (default:
#                        ~/git/jetlog-worktrees/integration). It must support
#                        personal access token writes, import batches,
#                        cleanup and the pending-changes propose/apply flow.
#   JETLOG_E2E_DB_NAME   scratch Postgres database name (default: jetlog_cli_e2e).
#                        Always dropped and recreated by this script, and
#                        dropped again when it finishes (see
#                        JETLOG_E2E_KEEP_DB). Never pass your development
#                        database here.
#   JETLOG_E2E_KEEP_DB   set to 1 to keep the scratch database after the run
#                        (default: it is dropped at the end, pass or fail)
#   JETLOG_E2E_PORT      scratch server port (default: 4100)
#   JETLOG_E2E_EMAIL     synthetic user's email (default: cli-e2e@test.local)
#
# Requires: the backend's deps fetched (`mix deps.get` in JETLOG_BACKEND_DIR)
# and a reachable Postgres on the connection the backend's dev config points
# at (host/user/password; only the database name is overridden here). The
# script starts the endpoint directly via `elixir -S mix run --no-halt`
# instead of `mix phx.server`, because the latter's alias may start or stop
# Docker containers that other checkouts share. It never runs docker itself:
# if Postgres is not reachable, start it yourself first.
#
# Not part of `npm test`: it boots a real Phoenix server and takes a couple
# of minutes (the first run compiles the backend).

set -euo pipefail

# Node's console.log colorizes a bare number via util.inspect when it thinks
# stdout supports color, which silently broke this script's numeric
# comparisons before it switched to process.stdout.write. As a second
# safeguard, also force color off at the environment level (FORCE_COLOR, if
# set by the calling shell, otherwise overrides NO_COLOR and prints a warning).
unset FORCE_COLOR || true
export NO_COLOR=1

echo "=== jetlog-cli E2E (local backend) starting ==="

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${JETLOG_BACKEND_DIR:-$HOME/git/jetlog-worktrees/integration}"
DB_NAME="${JETLOG_E2E_DB_NAME:-jetlog_cli_e2e}"
PORT="${JETLOG_E2E_PORT:-4100}"
BASE_URL="http://localhost:${PORT}"
EMAIL="${JETLOG_E2E_EMAIL:-cli-e2e@test.local}"

if [ "$DB_NAME" = "jetlog_dev" ]; then
  echo "refusing to run against jetlog_dev (your development database), set JETLOG_E2E_DB_NAME to a scratch name" >&2
  exit 1
fi

if [ ! -d "$BACKEND_DIR" ]; then
  echo "backend checkout not found at $BACKEND_DIR (set JETLOG_BACKEND_DIR)" >&2
  exit 1
fi

SERVER_LOG="$(mktemp -t jetlog_e2e_server)"
CACHE_DIR="$(mktemp -d -t jetlog_e2e_cache)"
SEED_SCRIPT="$(mktemp -t jetlog_e2e_seed).exs"
SERVER_PID=""
DB_CREATED=""

cleanup() {
  status=$?
  if [ -n "$SERVER_PID" ]; then
    echo "--- stopping scratch server (pid $SERVER_PID) ---"
    kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  # Belt and suspenders: `mix phx.server`'s actual beam.smp pid doesn't
  # always match the `$!` captured right after backgrounding it (observed
  # off-by-one in practice, likely an intermediate wrapper process), so kill
  # by listening port too, so a leftover scratch server never survives this
  # script and blocks the next run with EADDRINUSE.
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  fi
  # Drop the scratch database once the server (its only client) is gone, so
  # runs don't leave jetlog_cli_e2e behind in the shared Postgres. Pass or
  # fail; JETLOG_E2E_KEEP_DB=1 keeps it for post-mortem poking. DB_NAME was
  # already checked against jetlog_dev above.
  if [ -n "$DB_CREATED" ] && [ "${JETLOG_E2E_KEEP_DB:-}" != "1" ]; then
    sleep 1
    echo "--- dropping scratch database '$DB_NAME' ---"
    (cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.drop --quiet >/dev/null 2>&1) \
      || echo "warning: could not drop scratch database '$DB_NAME', drop it by hand" >&2
  fi
  rm -rf "$CACHE_DIR" "$SEED_SCRIPT"
  echo "=== jetlog-cli E2E finished (exit $status), server log kept at $SERVER_LOG ==="
  exit "$status"
}
trap cleanup EXIT INT TERM

if command -v docker >/dev/null 2>&1 && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '\-db-1$'; then
  echo "no running '*-db-1' Postgres container found, start one yourself first (e.g. 'docker start cli-api-db-1')." >&2
  echo "this script never runs docker compose/start/stop itself (see scripts/e2e-local.sh's header comment)." >&2
  exit 1
fi

echo "--- (re)creating scratch database '$DB_NAME' (never jetlog_dev) ---"
(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.drop --quiet >/dev/null 2>&1) || true
(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.create)
DB_CREATED=1
(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" MIX_ENV=dev mix ecto.migrate)

echo "--- starting the scratch server on port $PORT (not via 'mix phx.server', see header comment) ---"
# `elixir -S mix run --no-halt` boots the full OTP app (Endpoint included)
# without going through the "phx.server" alias's "dev.start" Docker-services
# step, which can tear down a shared Postgres container. `-phoenix serve_endpoints
# true` is the same erl flag `mix phx.server` itself passes through.
(cd "$BACKEND_DIR" && JETLOG_E2E=1 JETLOG_DB_NAME="$DB_NAME" PORT="$PORT" MIX_ENV=dev \
  nohup elixir --erl "-phoenix serve_endpoints true" -S mix run --no-halt >"$SERVER_LOG" 2>&1 &
  echo $! >"$SERVER_LOG.pid")
SERVER_PID="$(cat "$SERVER_LOG.pid")"
rm -f "$SERVER_LOG.pid"

echo "--- waiting for the server to come up (pid $SERVER_PID) ---"
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
  echo "server did not come up in time, last 80 lines of $SERVER_LOG:" >&2
  tail -80 "$SERVER_LOG" >&2
  exit 1
fi

echo "--- seeding a synthetic user + write-scoped PAT ---"
cat >"$SEED_SCRIPT" <<'EXS'
# Mints a write-scoped CLI PAT directly, no device-flow HTTP round trip.
alias Jetlog.{ApiAccess, Repo, User}
alias Jetlog.Logbook.Person

email = System.get_env("JETLOG_E2E_EMAIL", "cli-e2e@test.local")

user =
  case Repo.get_by(User, email: email) do
    nil -> Repo.insert!(User.changeset(%User{}, %{email: email}))
    existing -> existing
  end

# Mirrors the backend's own minimal self-person
# shape (id only, no name). The sync/PAT write path never auto-creates this
# row (see src/import/resolve.ts's own defensive SELF-ensure on the CLI
# side), so a realistic seed creates it here, same as a real account that
# has opened the app at least once.
case Repo.get_by(Person, user_id: user.id, id: user.id) do
  nil ->
    {:ok, _} =
      Jetlog.Logbook.upsert_people(user.id, [
        %{id: user.id, timestamp: DateTime.utc_now() |> DateTime.to_iso8601()}
      ])

  _existing ->
    :ok
end

{:ok, plaintext, _token} =
  ApiAccess.issue_token(user.id, ["read", "write"], client_kind: "cli", name: "jetlog-cli e2e")

IO.puts("E2E_USER_ID:#{user.id}")
IO.puts("E2E_TOKEN:#{plaintext}")
EXS

SEED_OUTPUT="$(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" JETLOG_E2E_EMAIL="$EMAIL" MIX_ENV=dev mix run "$SEED_SCRIPT")"
TOKEN="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_TOKEN://p')"
E2E_USER_ID="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_USER_ID://p')"
if [ -z "$TOKEN" ] || [ -z "$E2E_USER_ID" ]; then
  echo "failed to mint a PAT:" >&2
  echo "$SEED_OUTPUT" >&2
  exit 1
fi

echo "--- building the CLI ---"
(cd "$CLI_DIR" && npm run build >/dev/null)

export JETLOG_TOKEN="$TOKEN"
export JETLOG_BASE_URL="$BASE_URL"
export XDG_CACHE_HOME="$CACHE_DIR"

CLI_JS="$CLI_DIR/dist/cli.js"
FIXTURE="$CLI_DIR/test/fixtures/ios/pilotlog/mcc-classic.csv"

count_entries() {
  # NO_COLOR + process.stdout.write (not console.log): console.log colorizes
  # a bare number with ANSI codes when it thinks stdout supports color, which
  # silently broke the numeric `[ "$COUNT1" != "4" ]` comparisons below.
  NO_COLOR=1 node "$CLI_JS" entries search --json | NO_COLOR=1 node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => process.stdout.write(String(JSON.parse(d).length)));
  '
}

echo "--- jetlog whoami ---"
node "$CLI_JS" whoami --json

echo "--- jetlog import (first run: expect every row new) ---"
node "$CLI_JS" import "$FIXTURE" --from pilotlog --yes --label "e2e-local"

COUNT1="$(count_entries)"
echo "entries after first import: $COUNT1"
if [ "$COUNT1" != "4" ]; then
  echo "expected 4 entries after the first import, got $COUNT1" >&2
  exit 1
fi

echo "--- jetlog import (second run: expect matches/unchanged, never duplicates) ---"
# The preview goes to stderr; capture both streams so the diff can be asserted, then show it.
IMPORT2_OUT="$(node "$CLI_JS" import "$FIXTURE" --from pilotlog --yes --label "e2e-local" 2>&1)"
echo "$IMPORT2_OUT"
# An identical re-import must be a no-op: nothing new, nothing "updated", every row unchanged and not re-sent.
if ! printf '%s\n' "$IMPORT2_OUT" | grep -Eq 'entries: +0 new, 0 updated, 4 unchanged'; then
  echo "identical re-import should preview '0 new, 0 updated, 4 unchanged' (the CLI diff reports changes the server never sees)" >&2
  exit 1
fi
if ! printf '%s\n' "$IMPORT2_OUT" | grep -Eq '0 entries written'; then
  echo "identical re-import should send no entries" >&2
  exit 1
fi

COUNT2="$(count_entries)"
echo "entries after re-import: $COUNT2"
if [ "$COUNT2" != "$COUNT1" ]; then
  echo "re-import changed the entry count ($COUNT1 -> $COUNT2), duplicates or a lost delete" >&2
  exit 1
fi

BATCH_ID="$(NO_COLOR=1 node "$CLI_JS" batches list --json | NO_COLOR=1 node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => process.stdout.write(JSON.parse(d)[0].id));
')"
echo "--- jetlog batches remove $BATCH_ID (preview, then real) ---"
node "$CLI_JS" batches remove "$BATCH_ID" --yes

COUNT3="$(count_entries)"
echo "entries after removal: $COUNT3"
if [ "$COUNT3" != "0" ]; then
  echo "expected 0 entries after batches remove, got $COUNT3" >&2
  exit 1
fi

echo "--- cross-format flight-number normalization (GET /api/cli/v1/airlines) ---"
# Two tiny deeplink-json fixtures, same flight/date/route, one with an
# ICAO-style flight-number prefix and one with the IATA-style prefix the
# airline catalog should rewrite the first one to. If the CLI fetched and
# applied the live /api/cli/v1/airlines catalog, the second import matches
# the first instead of creating a duplicate entry.
ICAO_FIXTURE="$(mktemp -t jetlog_e2e_icao).json"
IATA_FIXTURE="$(mktemp -t jetlog_e2e_iata).json"
cat >"$ICAO_FIXTURE" <<'JSON'
{
  "entries": [
    { "type": "flight", "date": "2026-02-01", "flight_number": "KLM2001", "from": "EHAM", "to": "LFPG", "people": [{ "ref_id": "SELF", "role": "PIC" }] }
  ]
}
JSON
cat >"$IATA_FIXTURE" <<'JSON'
{
  "entries": [
    { "type": "flight", "date": "2026-02-01", "flight_number": "KL2001", "from": "EHAM", "to": "LFPG", "people": [{ "ref_id": "SELF", "role": "PIC" }] }
  ]
}
JSON

echo "--- jetlog import with an ICAO-prefixed flight number (KLM2001) ---"
node "$CLI_JS" import "$ICAO_FIXTURE" --from deeplink-json --yes --label "e2e-airlines"

AIRLINE_COUNT1="$(count_entries)"
echo "entries after ICAO-prefixed import: $AIRLINE_COUNT1"
if [ "$AIRLINE_COUNT1" != "1" ]; then
  echo "expected 1 entry after the ICAO-prefixed import, got $AIRLINE_COUNT1" >&2
  exit 1
fi

echo "--- jetlog import with the IATA-prefixed equivalent (KL2001), expect a MATCH, not a duplicate ---"
node "$CLI_JS" import "$IATA_FIXTURE" --from deeplink-json --yes --label "e2e-airlines"

AIRLINE_COUNT2="$(count_entries)"
echo "entries after IATA-prefixed re-import: $AIRLINE_COUNT2"
if [ "$AIRLINE_COUNT2" != "$AIRLINE_COUNT1" ]; then
  echo "cross-format re-import created a duplicate instead of matching ($AIRLINE_COUNT1 -> $AIRLINE_COUNT2), the airline catalog wasn't applied" >&2
  exit 1
fi

AIRLINE_FLIGHT_NUMBER="$(NO_COLOR=1 node "$CLI_JS" entries search --json | NO_COLOR=1 node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => process.stdout.write(JSON.parse(d)[0].flight_number));
')"
echo "stored flight_number after the cross-format match: $AIRLINE_FLIGHT_NUMBER"
if [ "$AIRLINE_FLIGHT_NUMBER" != "KL2001" ]; then
  echo "expected the stored flight_number to end up IATA-normalized (KL2001), got $AIRLINE_FLIGHT_NUMBER" >&2
  exit 1
fi

rm -f "$ICAO_FIXTURE" "$IATA_FIXTURE"

echo "--- pending changes: propose -> apply -> verify -> batches remove ---"
# Earlier blocks leave their own entries behind (e.g. the airline case's
# KL2001), so every count below is relative to this baseline.
PENDING_BASE="$(count_entries)"
# There's no `jetlog changes propose` command by design (proposing is
# always done by an AI client via the MCP `propose_changes` tool, or
# directly against the REST endpoint), so this drives
# `POST /api/pending_changes` with curl, then exercises the CLI's own
# `jetlog changes apply`/`jetlog entries search`/`jetlog batches remove`
# exactly like a human confirming a Claude-proposed change would.
PROPOSE_RESPONSE="$(curl -sS -X POST "$BASE_URL/api/pending_changes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "summary": "e2e: add one flight",
        "operations": [
          {
            "op": "create",
            "resource": "entry",
            "data": {
              "type": "flight",
              "date": "2026-03-01",
              "flight_number": "KL1234",
              "from": "EHAM",
              "to": "EGLL",
              "off_blocks": "10:00",
              "airborne": "10:15",
              "touchdown": "11:15",
              "on_blocks": "11:30",
              "people": [{ "person_id": "'"$E2E_USER_ID"'", "role": "PIC" }]
            }
          }
        ]
      }')"

PENDING_ID="$(printf '%s' "$PROPOSE_RESPONSE" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const parsed = JSON.parse(d);
    if (!parsed.pending_change) { process.stderr.write(d); process.exit(1); }
    process.stdout.write(parsed.pending_change.id);
  });
')"
echo "proposed pending change: $PENDING_ID"

echo "--- jetlog changes show $PENDING_ID (preview, nothing written yet) ---"
node "$CLI_JS" changes show "$PENDING_ID" --json

PENDING_COUNT="$(count_entries)"
if [ "$PENDING_COUNT" != "$PENDING_BASE" ]; then
  echo "expected $PENDING_BASE entries after propose (nothing should be written), got $PENDING_COUNT" >&2
  exit 1
fi

echo "--- jetlog changes apply $PENDING_ID --yes (writes for real) ---"
node "$CLI_JS" changes apply "$PENDING_ID" --yes

APPLIED_COUNT="$(count_entries)"
echo "entries after apply: $APPLIED_COUNT"
if [ "$APPLIED_COUNT" != "$((PENDING_BASE + 1))" ]; then
  echo "expected $((PENDING_BASE + 1)) entries after applying the pending change, got $APPLIED_COUNT" >&2
  exit 1
fi

PENDING_BATCH_ID="$(NO_COLOR=1 node "$CLI_JS" changes show "$PENDING_ID" --json | NO_COLOR=1 node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => process.stdout.write(JSON.parse(d).applied_batch_id));
')"
echo "applied_batch_id: $PENDING_BATCH_ID"

echo "--- jetlog batches remove $PENDING_BATCH_ID --yes (undo the applied change) ---"
node "$CLI_JS" batches remove "$PENDING_BATCH_ID" --yes

REMOVED_COUNT="$(count_entries)"
echo "entries after removing the pending-change batch: $REMOVED_COUNT"
if [ "$REMOVED_COUNT" != "$PENDING_BASE" ]; then
  echo "expected $PENDING_BASE entries after batches remove, got $REMOVED_COUNT" >&2
  exit 1
fi

echo "--- pending changes: create with NO people gets the pilot added server-side ---"
# Needs the backend's add_self behavior: the server appends the pilot (default role) when `people`
# has no item for them. Preview only, nothing is applied.
SELF_PROPOSE="$(curl -sS -X POST "$BASE_URL/api/pending_changes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "summary": "e2e: flight without people",
        "operations": [
          { "op": "create", "resource": "entry",
            "data": { "type": "flight", "date": "2026-03-02", "flight_number": "KL4321", "from": "EHAM", "to": "EGLL" } }
        ]
      }')"
printf '%s' "$SELF_PROPOSE" | E2E_USER_ID="$E2E_USER_ID" node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const parsed = JSON.parse(d);
    const people = parsed.pending_change?.operations?.[0]?.data?.people;
    const hasPilot = Array.isArray(people) && people.some((p) => String(p.person_id) === process.env.E2E_USER_ID && p.role);
    if (!hasPilot) { process.stderr.write("expected the pilot with a role on operations[0].data.people, got: " + d + "\n"); process.exit(1); }
  });
'
echo "pilot was added to the entry without being sent"

echo "=== jetlog-cli E2E smoke run PASSED ==="
