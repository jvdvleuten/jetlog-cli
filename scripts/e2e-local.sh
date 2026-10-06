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
# A last section covers entry files, person photos, signatures and signing
# links with a token that holds the `files` and `signatures` scopes, and a
# legacy `read write` token that must keep its old powers only.
#
# Usage:
#   scripts/e2e-local.sh
#
# Env overrides:
#   JETLOG_BACKEND_DIR   path to the Jetlog backend checkout (default:
#                        ~/git/jetlog-worktrees/integration). It must support
#                        personal access token writes, import batches,
#                        cleanup and the pending-changes propose/apply flow,
#                        plus the `files` and `signatures` token scopes: the
#                        attachment store for tokens, entry file and photo
#                        writes, signature writes, signing links and
#                        link-signed batch cleanup.
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
AUDIT_SCRIPT="$(mktemp -t jetlog_e2e_audit).exs"
WORK_DIR="$(mktemp -d -t jetlog_e2e_files)"
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
  rm -rf "$CACHE_DIR" "$SEED_SCRIPT" "$AUDIT_SCRIPT" "$WORK_DIR"
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

echo "--- seeding a synthetic user + write-scoped PAT with files and signatures ---"
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

# A second person, for the photo commands.
crew_id = Ecto.UUID.generate()

{:ok, _} =
  Jetlog.Logbook.upsert_people(user.id, [
    %{
      id: crew_id,
      first_name: "Crew",
      last_name: "E2E",
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601()
    }
  ])

# What `jetlog login --scope write` asks for now.
{:ok, plaintext, _token} =
  ApiAccess.issue_token(user.id, ["read", "write", "files", "signatures"],
    client_kind: "cli",
    name: "jetlog-cli e2e"
  )

# A token from before the `files` and `signatures` scopes existed: it must keep
# exactly its old powers and no more.
{:ok, legacy_plaintext, _legacy} =
  ApiAccess.issue_token(user.id, ["read", "write"], client_kind: "cli", name: "jetlog-cli e2e legacy")

IO.puts("E2E_USER_ID:#{user.id}")
IO.puts("E2E_PERSON_ID:#{crew_id}")
IO.puts("E2E_TOKEN:#{plaintext}")
IO.puts("E2E_LEGACY_TOKEN:#{legacy_plaintext}")
EXS

SEED_OUTPUT="$(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" JETLOG_E2E_EMAIL="$EMAIL" MIX_ENV=dev mix run "$SEED_SCRIPT")"
TOKEN="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_TOKEN://p')"
E2E_USER_ID="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_USER_ID://p')"
E2E_PERSON_ID="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_PERSON_ID://p')"
LEGACY_TOKEN="$(printf '%s\n' "$SEED_OUTPUT" | sed -n 's/^E2E_LEGACY_TOKEN://p')"
if [ -z "$TOKEN" ] || [ -z "$E2E_USER_ID" ] || [ -z "$E2E_PERSON_ID" ] || [ -z "$LEGACY_TOKEN" ]; then
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

echo "--- attachments, photos and signatures (files and signatures scopes, token signing) ---"
# Written against a backend with the files and signatures scopes. Entry files, person photos and
# signatures go through the real presigned flow (the dev object-store shim), signing links through the REST routes, the
# public signing page through curl. Hosted-only pieces (upload links, pending change resources for files, signature
# flag for MCP) are not covered here.

e2e_fail() {
  echo "$1" >&2
  exit 1
}

# json_get '<js expression over d>' reads JSON from stdin and prints the value (empty for null, undefined or an error).
json_get() {
  NO_COLOR=1 node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      const d = JSON.parse(raw);
      let v;
      try {
        v = new Function("d", "return (" + process.argv[1] + ");")(d);
      } catch {
        v = undefined; // a missing element reads as empty, the caller reports it
      }
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });
  ' "$1"
}

entry_id_for() {
  # Newest entry with this flight number, as an id.
  NO_COLOR=1 node "$CLI_JS" entries search --json --flight-number "$1" | json_get 'd[0].id'
}

entry_count_for() {
  NO_COLOR=1 node "$CLI_JS" entries search --json --flight-number "$1" | json_get 'd.length'
}

signature_state() {
  NO_COLOR=1 node "$CLI_JS" signatures show "$1" --json | json_get 'd.signature'
}

expect_state() {
  # expect_state <entry-id> <state> <what>
  GOT_STATE="$(signature_state "$1")"
  if [ "$GOT_STATE" != "$2" ]; then
    e2e_fail "expected signature state '$2' after $3, got '$GOT_STATE'"
  fi
}

# Tiny valid PNGs (distinct bytes, so none dedupes against another) and a minimal PDF, written without any tool beyond node.
cat >"$WORK_DIR/gen.js" <<'JS'
const fs = require("fs");
const zlib = require("zlib");
const dir = process.argv[2];

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, shade) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, shade)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

fs.writeFileSync(dir + "/ramp.png", png(8, 8, 40));
fs.writeFileSync(dir + "/sig-token.png", png(16, 8, 20));
fs.writeFileSync(dir + "/sig-token-2.png", png(16, 8, 25));
fs.writeFileSync(dir + "/sig-link.png", png(12, 6, 30));
fs.writeFileSync(dir + "/photo-1.png", png(10, 10, 60));
fs.writeFileSync(dir + "/photo-2.png", png(10, 10, 90));
fs.writeFileSync(dir + "/loadsheet.pdf", "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
JS
node "$WORK_DIR/gen.js" "$WORK_DIR"

cat >"$WORK_DIR/files.json" <<'JSON'
{
  "entries": [
    { "type": "flight", "date": "2026-04-01", "flight_number": "KL3001", "from": "EHAM", "to": "EGLL", "people": [{ "ref_id": "SELF", "role": "PIC" }] },
    { "type": "flight", "date": "2026-04-02", "flight_number": "KL3002", "from": "EGLL", "to": "EHAM", "people": [{ "ref_id": "SELF", "role": "PIC" }] },
    { "type": "flight", "date": "2026-04-03", "flight_number": "KL3003", "from": "EHAM", "to": "LFPG", "people": [{ "ref_id": "SELF", "role": "PIC" }] }
  ]
}
JSON
cat >"$WORK_DIR/link.json" <<'JSON'
{
  "entries": [
    { "type": "flight", "date": "2026-04-04", "flight_number": "KL3004", "from": "EGLL", "to": "LFPG", "people": [{ "ref_id": "SELF", "role": "PIC" }] }
  ]
}
JSON

echo "--- jetlog import: three entries for files and token signatures, one for a signing link ---"
node "$CLI_JS" import "$WORK_DIR/files.json" --from deeplink-json --yes --label "e2e-files"
node "$CLI_JS" import "$WORK_DIR/link.json" --from deeplink-json --yes --label "e2e-link"
ENTRY_A="$(entry_id_for KL3001)"
ENTRY_B="$(entry_id_for KL3002)"
ENTRY_C="$(entry_id_for KL3003)"
ENTRY_D="$(entry_id_for KL3004)"
if [ -z "$ENTRY_A" ] || [ -z "$ENTRY_B" ] || [ -z "$ENTRY_C" ] || [ -z "$ENTRY_D" ]; then
  e2e_fail "could not find the four imported entries (A=$ENTRY_A B=$ENTRY_B C=$ENTRY_C D=$ENTRY_D)"
fi
expect_state "$ENTRY_A" none "import"

echo "--- a token from before the files and signatures scopes keeps its old powers only ---"
LEGACY_STATE="$(JETLOG_TOKEN="$LEGACY_TOKEN" node "$CLI_JS" signatures show "$ENTRY_A" --json | json_get 'd.signature')"
if [ "$LEGACY_STATE" != "none" ]; then
  e2e_fail "a read write token should still read the signature state (none), got '$LEGACY_STATE'"
fi
if LEGACY_FILES_OUT="$(JETLOG_TOKEN="$LEGACY_TOKEN" node "$CLI_JS" attachments add "$ENTRY_A" "$WORK_DIR/ramp.png" --yes 2>&1)"; then
  e2e_fail "a token without the files scope should not be able to add files: $LEGACY_FILES_OUT"
fi
if ! printf '%s\n' "$LEGACY_FILES_OUT" | grep -q "files scope"; then
  e2e_fail "expected a message about the missing files scope, got: $LEGACY_FILES_OUT"
fi
if LEGACY_WAIVE_OUT="$(JETLOG_TOKEN="$LEGACY_TOKEN" node "$CLI_JS" signatures waive "$ENTRY_A" --yes 2>&1)"; then
  e2e_fail "a token without the signatures scope should not be able to waive: $LEGACY_WAIVE_OUT"
fi
if ! printf '%s\n' "$LEGACY_WAIVE_OUT" | grep -q "jetlog login"; then
  e2e_fail "expected a 'log in again' message for the missing signatures scope, got: $LEGACY_WAIVE_OUT"
fi
expect_state "$ENTRY_A" none "the refused legacy waive"

echo "--- jetlog attachments add / list / get / remove ---"
ADD_OUT="$(node "$CLI_JS" attachments add "$ENTRY_A" "$WORK_DIR/loadsheet.pdf" "$WORK_DIR/ramp.png" --yes 2>&1)"
echo "$ADD_OUT"
if ! printf '%s\n' "$ADD_OUT" | grep -q "Uploaded 2 files"; then
  e2e_fail "expected 'Uploaded 2 files' from attachments add"
fi
LIST_JSON="$(node "$CLI_JS" attachments list "$ENTRY_A" --json)"
FILE_NAMES="$(printf '%s' "$LIST_JSON" | json_get 'd.map((r) => r.file_name).sort().join(",")')"
if [ "$FILE_NAMES" != "loadsheet.pdf,ramp.png" ]; then
  e2e_fail "expected the entry to list loadsheet.pdf and ramp.png, got '$FILE_NAMES'"
fi
PDF_ATTACHMENT_ID="$(printf '%s' "$LIST_JSON" | json_get 'd.find((r) => r.file_name === "loadsheet.pdf").attachment_id')"
PDF_ROW_ID="$(printf '%s' "$LIST_JSON" | json_get 'd.find((r) => r.file_name === "loadsheet.pdf").id')"

DOWNLOADED="$(node "$CLI_JS" attachments get "$PDF_ATTACHMENT_ID" -o "$WORK_DIR/downloaded.pdf")"
if ! cmp -s "$DOWNLOADED" "$WORK_DIR/loadsheet.pdf"; then
  e2e_fail "the downloaded file differs from the uploaded one"
fi
if OVERWRITE_OUT="$(node "$CLI_JS" attachments get "$PDF_ATTACHMENT_ID" -o "$WORK_DIR/downloaded.pdf" 2>&1)"; then
  e2e_fail "attachments get must not overwrite an existing file without --force: $OVERWRITE_OUT"
fi
node "$CLI_JS" attachments get "$PDF_ATTACHMENT_ID" -o "$WORK_DIR/downloaded.pdf" --force >/dev/null

node "$CLI_JS" attachments remove "$PDF_ROW_ID" --yes
AFTER_REMOVE="$(node "$CLI_JS" attachments list "$ENTRY_A" --json | json_get 'd.length')"
if [ "$AFTER_REMOVE" != "1" ]; then
  e2e_fail "expected 1 file left on the entry after remove, got $AFTER_REMOVE"
fi

echo "--- jetlog photos set / get ---"
node "$CLI_JS" photos set "$E2E_PERSON_ID" "$WORK_DIR/photo-1.png" --yes
HAS_PHOTO="$(node "$CLI_JS" people --json | json_get "d.find((p) => p.id === \"$E2E_PERSON_ID\").has_photo")"
if [ "$HAS_PHOTO" != "true" ]; then
  e2e_fail "expected has_photo true after photos set, got '$HAS_PHOTO'"
fi
PHOTO_OUT="$(node "$CLI_JS" photos get "$E2E_PERSON_ID" -o "$WORK_DIR/photo-downloaded.png")"
if ! cmp -s "$PHOTO_OUT" "$WORK_DIR/photo-1.png"; then
  e2e_fail "the downloaded photo differs from the uploaded one"
fi
REPLACE_OUT="$(node "$CLI_JS" photos set "$E2E_PERSON_ID" "$WORK_DIR/photo-2.png" --yes 2>&1)"
if ! printf '%s\n' "$REPLACE_OUT" | grep -q "replaces the current photo"; then
  e2e_fail "expected photos set to say it replaces the current photo, got: $REPLACE_OUT"
fi

echo "--- jetlog signatures: attach, get, replace and remove (B), waive and unwaive (C) ---"
file_sha256() {
  shasum -a 256 "$1" | cut -d' ' -f1
}
node "$CLI_JS" signatures attach "$ENTRY_B" "$WORK_DIR/sig-token.png" --yes
expect_state "$ENTRY_B" signed "signatures attach"
SIG_ATTACHMENT_ID="$(node "$CLI_JS" signatures show "$ENTRY_B" --json | json_get 'd.signature_attachment_id')"
if [ -z "$SIG_ATTACHMENT_ID" ]; then
  e2e_fail "a signed entry should show its signature_attachment_id"
fi
SIG_SHA_1="$(node "$CLI_JS" signatures show "$ENTRY_B" --json | json_get 'd.signature_sha256')"
if [ "$SIG_SHA_1" != "$(file_sha256 "$WORK_DIR/sig-token.png")" ]; then
  e2e_fail "the entry's signature_sha256 should match the uploaded file, got '$SIG_SHA_1'"
fi
SIG_GET_OUT="$(node "$CLI_JS" signatures get "$ENTRY_B" -o "$WORK_DIR/sig-downloaded-1.png")"
if ! cmp -s "$SIG_GET_OUT" "$WORK_DIR/sig-token.png"; then
  e2e_fail "the downloaded signature differs from the uploaded one"
fi
if [ "$(file_sha256 "$SIG_GET_OUT")" != "$SIG_SHA_1" ]; then
  e2e_fail "the sha256 of the downloaded signature should equal signature_sha256"
fi

# A second image replaces the signature. The preview says so.
REPLACE_SIG_OUT="$(node "$CLI_JS" signatures attach "$ENTRY_B" "$WORK_DIR/sig-token-2.png" --yes 2>&1)"
if ! printf '%s\n' "$REPLACE_SIG_OUT" | grep -q "Will replace the existing signature"; then
  e2e_fail "expected signatures attach on a signed entry to say it replaces the signature, got: $REPLACE_SIG_OUT"
fi
expect_state "$ENTRY_B" signed "replacing the signature"
SIG_SHA_2="$(node "$CLI_JS" signatures show "$ENTRY_B" --json | json_get 'd.signature_sha256')"
if [ "$SIG_SHA_2" = "$SIG_SHA_1" ] || [ "$SIG_SHA_2" != "$(file_sha256 "$WORK_DIR/sig-token-2.png")" ]; then
  e2e_fail "the signature should now be the second image, got sha '$SIG_SHA_2'"
fi
node "$CLI_JS" signatures get "$ENTRY_B" -o "$WORK_DIR/sig-downloaded-2.png" >/dev/null
if ! cmp -s "$WORK_DIR/sig-downloaded-2.png" "$WORK_DIR/sig-token-2.png"; then
  e2e_fail "the downloaded signature should be the second image after the replace"
fi

# Remove: the entry goes back to none, and signatures get says it is not signed.
node "$CLI_JS" signatures remove "$ENTRY_B" --yes
expect_state "$ENTRY_B" none "signatures remove"
if node "$CLI_JS" signatures get "$ENTRY_B" -o "$WORK_DIR/sig-none.png" >/dev/null 2>&1; then
  e2e_fail "signatures get on an unsigned entry must fail"
fi
# Sign B again with the first image, so the batch cleanup below still sees a token-signed entry.
node "$CLI_JS" signatures attach "$ENTRY_B" "$WORK_DIR/sig-token.png" --yes
expect_state "$ENTRY_B" signed "signing B again"
node "$CLI_JS" signatures waive "$ENTRY_B" --yes
expect_state "$ENTRY_B" signed "a waive attempt on a signed entry (it must be skipped)"

node "$CLI_JS" signatures waive "$ENTRY_C" --yes
expect_state "$ENTRY_C" waived "signatures waive"
node "$CLI_JS" signatures unwaive "$ENTRY_C" --yes
expect_state "$ENTRY_C" none "signatures unwaive"
node "$CLI_JS" signatures waive "$ENTRY_C" --yes
expect_state "$ENTRY_C" waived "a second waive"
# A real signature replaces the waiver, and the same image may be used on a second entry.
node "$CLI_JS" signatures attach "$ENTRY_C" "$WORK_DIR/sig-token.png" --yes
expect_state "$ENTRY_C" signed "attaching over a waiver"

SIG_BODY="$(mktemp -t jetlog_e2e_body)"
EDIT_BATCH="$(curl -sS -X POST "$BASE_URL/api/import_batches" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"edit","client":"jetlog-cli","label":"e2e-reuse"}' | json_get 'd.id')"
if [ -z "$EDIT_BATCH" ]; then
  e2e_fail "could not open an edit batch for the reuse check"
fi

echo "--- jetlog signatures request / revoke, then a real signing through the public API (D) ---"
LINK_ERR="$(mktemp -t jetlog_e2e_linkerr)"
LINK1_URL="$(node "$CLI_JS" signatures request "$ENTRY_D" --yes 2>"$LINK_ERR")"
LINK1_ID="$(sed -n 's/^Request id \([^,]*\),.*/\1/p' "$LINK_ERR")"
if [ -z "$LINK1_URL" ] || [ -z "$LINK1_ID" ]; then
  e2e_fail "signatures request should print the URL and a request id, got url='$LINK1_URL' id='$LINK1_ID' ($(cat "$LINK_ERR"))"
fi
LINK1_TOKEN="${LINK1_URL##*/}"
node "$CLI_JS" signatures revoke "$LINK1_ID"
REVOKED_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/signing/$LINK1_TOKEN")"
if [ "$REVOKED_CODE" != "410" ]; then
  e2e_fail "a revoked signing link should answer 410, got $REVOKED_CODE"
fi

LINK2_URL="$(node "$CLI_JS" signatures request "$ENTRY_D" --yes 2>/dev/null)"
LINK2_TOKEN="${LINK2_URL##*/}"
SIGN_B64="$(base64 <"$WORK_DIR/sig-link.png" | tr -d '\n')"
SIGN_CODE="$(curl -sS -o "$SIG_BODY" -w '%{http_code}' -X POST "$BASE_URL/api/signing/$LINK2_TOKEN/sign" \
  -H "Content-Type: application/json" \
  -d '{"signature":"'"$SIGN_B64"'","signer_name":"E2E Instructor","entry_ids":["'"$ENTRY_D"'"]}')"
if [ "$SIGN_CODE" != "200" ] || ! grep -q "$ENTRY_D" "$SIG_BODY"; then
  e2e_fail "signing through the link should answer 200 with the entry id, got $SIGN_CODE: $(cat "$SIG_BODY")"
fi
expect_state "$ENTRY_D" signed "the public signing"

# A signature captured through a signing link may be reused by a token (any signature image of the user): pointing the
# still unsigned entry A at it works. It is removed again right after, so the batch cleanup below is unchanged.
LINK_SIG_ID="$(node "$CLI_JS" signatures show "$ENTRY_D" --json | json_get 'd.signature_attachment_id')"
REUSE_CODE="$(curl -sS -o "$SIG_BODY" -w '%{http_code}' -X PUT "$BASE_URL/api/entries" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-jetlog-batch-id: $EDIT_BATCH" \
  -d '{"entries":[{"id":"'"$ENTRY_A"'","signature_attachment_id":"'"$LINK_SIG_ID"'"}]}')"
if [ "$REUSE_CODE" != "200" ]; then
  e2e_fail "reusing a link-signed image should be accepted (200), got $REUSE_CODE: $(cat "$SIG_BODY")"
fi
expect_state "$ENTRY_A" signed "reusing the link signature"
node "$CLI_JS" signatures get "$ENTRY_D" -o "$WORK_DIR/sig-link-downloaded.png" >/dev/null
node "$CLI_JS" signatures remove "$ENTRY_A" --yes
expect_state "$ENTRY_A" none "removing the reused link signature"
rm -f "$SIG_BODY" "$LINK_ERR"

echo "--- audit rows and attachment origins (read straight from the scratch database) ---"
cat >"$AUDIT_SCRIPT" <<'EXS'
import Ecto.Query
alias Jetlog.ApiAccess.ApiWriteEvent
alias Jetlog.Attachments.Attachment
alias Jetlog.Repo

user_id = System.fetch_env!("E2E_USER_ID")

from(e in ApiWriteEvent,
  where:
    e.user_id == ^user_id and
      e.resource_type in ["entry_signature", "entry_attachment", "signature_request"],
  group_by: [e.resource_type, e.op],
  select: {e.resource_type, e.op, count(e.id)}
)
|> Repo.all()
|> Enum.each(fn {type, op, n} -> IO.puts("AUDIT:#{type}:#{op}:#{n}") end)

# Who did it: the attribution columns of a token signature row.
from(e in ApiWriteEvent,
  where: e.user_id == ^user_id and e.op == "signature_attached",
  select: {e.client_kind, e.owner_key}
)
|> Repo.all()
|> Enum.map(fn {kind, owner_key} -> "ATTR:#{kind}|#{String.slice(owner_key || "", 0, 4)}" end)
|> Enum.uniq()
|> Enum.each(&IO.puts/1)

from(a in Attachment,
  where: a.user_id == ^user_id and a.kind == "signature",
  group_by: a.origin,
  select: {a.origin, count(a.id)}
)
|> Repo.all()
|> Enum.each(fn {origin, n} -> IO.puts("SIG_ORIGIN:#{origin}:#{n}") end)
EXS
AUDIT_OUT="$(cd "$BACKEND_DIR" && JETLOG_DB_NAME="$DB_NAME" E2E_USER_ID="$E2E_USER_ID" MIX_ENV=dev mix run "$AUDIT_SCRIPT")"
echo "$AUDIT_OUT" | grep -E '^(AUDIT|ATTR|SIG_ORIGIN):' || true

expect_audit_line() {
  if ! printf '%s\n' "$AUDIT_OUT" | grep -qx "$1"; then
    e2e_fail "expected the audit output to contain '$1'"
  fi
}
expect_audit_line "AUDIT:entry_attachment:created:2"
expect_audit_line "AUDIT:entry_signature:signature_attached:4"
expect_audit_line "AUDIT:entry_signature:signature_replaced:1"
expect_audit_line "AUDIT:entry_signature:signature_removed:2"
expect_audit_line "AUDIT:entry_signature:signature_waived:2"
expect_audit_line "AUDIT:entry_signature:signature_unwaived:1"
expect_audit_line "AUDIT:entry_signature:signed_via_link:1"
expect_audit_line "AUDIT:signature_request:created:2"
expect_audit_line "AUDIT:signature_request:revoked:1"
expect_audit_line "ATTR:cli|cli:"
# Token-origin images: the first (B, C, deduped by checksum) and the second one (the replace). D's came through
# the public signing page.
expect_audit_line "SIG_ORIGIN:token:2"
expect_audit_line "SIG_ORIGIN:remote_sign:1"

echo "--- jetlog batches remove: token-signed entries go with the batch, link-signed ones are kept ---"
FILES_BATCH="$(node "$CLI_JS" batches list --json | json_get 'd.find((b) => b.label === "e2e-files").id')"
LINK_BATCH="$(node "$CLI_JS" batches list --json | json_get 'd.find((b) => b.label === "e2e-link").id')"
if [ -z "$FILES_BATCH" ] || [ -z "$LINK_BATCH" ]; then
  e2e_fail "could not find the e2e-files and e2e-link batches (files='$FILES_BATCH' link='$LINK_BATCH')"
fi

FILES_REMOVE_OUT="$(node "$CLI_JS" batches remove "$FILES_BATCH" --yes 2>&1)"
echo "$FILES_REMOVE_OUT"
if ! printf '%s\n' "$FILES_REMOVE_OUT" | grep -Eq 'signed by a token: +2 entries'; then
  e2e_fail "the preview should count the 2 token-signed entries"
fi
if ! printf '%s\n' "$FILES_REMOVE_OUT" | grep -Eq 'deleted 3 entries'; then
  e2e_fail "expected all 3 entries of the e2e-files batch to be deleted, signed ones included"
fi
for FLIGHT in KL3001 KL3002 KL3003; do
  if [ "$(entry_count_for "$FLIGHT")" != "0" ]; then
    e2e_fail "entry $FLIGHT should be gone after batches remove"
  fi
done

LINK_KEEP_OUT="$(node "$CLI_JS" batches remove "$LINK_BATCH" --yes 2>&1)"
echo "$LINK_KEEP_OUT"
if ! printf '%s\n' "$LINK_KEEP_OUT" | grep -Eq 'kept \(link-signed\): +1 entry'; then
  e2e_fail "the preview should report the link-signed entry as kept"
fi
if [ "$(entry_count_for KL3004)" != "1" ]; then
  e2e_fail "the link-signed entry must survive batches remove without --include-link-signed"
fi
LINK_DELETE_OUT="$(node "$CLI_JS" batches remove "$LINK_BATCH" --include-link-signed --yes 2>&1)"
echo "$LINK_DELETE_OUT"
if ! printf '%s\n' "$LINK_DELETE_OUT" | grep -Eq 'deleted 1 entry'; then
  e2e_fail "expected --include-link-signed to delete the link-signed entry"
fi
if [ "$(entry_count_for KL3004)" != "0" ]; then
  e2e_fail "the link-signed entry should be gone after --include-link-signed"
fi

echo "=== jetlog-cli E2E smoke run PASSED ==="
