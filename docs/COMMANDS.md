# Command reference

Every command also has `--help`.

- [Convert and check](#convert-and-check): `convert`, `validate`, `schema`,
  `link`, `ai convert`
- [Login and reading](#login-and-reading): `login`, `logout`, `whoami`,
  `entries`, `people`, `aircraft`, `export`
- [Flight times](#flight-times): `times`, `totals`
- [Importing](#importing): `import`, `batches`
- [Proposed changes](#proposed-changes): `changes`
- [Partner API](#partner-api): `push`
- [Environment variables](#environment-variables)

The MCP server (`jetlog mcp`) is described in [AI.md](AI.md).

## Convert and check

### `jetlog convert`

Convert a logbook export to Jetlog JSON. Runs offline.

```sh
jetlog convert flights.csv --from csv -o jetlog-import.json
jetlog convert foreflight-export.csv --from foreflight --self-role PIC
jetlog convert logten-export.txt --from logten
jetlog convert statement.pdf --from chrono
jetlog convert some-export.txt --from auto
jetlog convert rb_flights.csv rb_aircraft.csv rb_people.csv --from rblogbook
```

Rows that cannot be converted (no date, unparsable date) are skipped and
reported on stderr with a reason. The rest of the file still converts. The
output is validated before it is written.

Formats:

| `--from` | Reads | Notes |
| --- | --- | --- |
| `logten` | LogTen Pro tab-separated export | Includes simulator sessions. LogTen does not mark which crew member is you, see `--self` below. |
| `pilotlog` | mccPILOTLOG / CrewLounge PILOTLOG CSV | Classic and raw/web CSV variants, and the zipped backup. |
| `flylog` | Flylog CSV | |
| `safelog` | SafeLog tab-delimited CSV | |
| `skylife` | Skylife semicolon-delimited CSV | |
| `rblogbook` | RB Logbook (RosterBuster) CSVs | Pass the flights, aircraft and people files together, in any order. With one file only the flights are read. |
| `flightlogger` | FlightLogger CSV | |
| `chrono` | KLM "Chronologisch overzicht vlieguren" | A PDF, or text already extracted from it. |
| `monthly-overview` | KLM Cityhopper "Monthly Overview" | A PDF, or text already extracted from it. |
| `excel` | Jetlog's own `.xlsx` export | |
| `jetlog-csv` | Jetlog's own CSV export | Loose CSV files or the ZIP archive. |
| `deeplink-json` | A Jetlog import payload | Read as a logbook export, so it can be imported. |
| `jetlog` | A Jetlog import payload | Passthrough: parse and validate only. |
| `foreflight` | ForeFlight CSV | Best effort. The header names come from ForeFlight's documentation and were not checked against a live export. Use `--map` if a column is missed. |
| `csv` | Any CSV | Headers are matched case-insensitively (`Date`, `Flight No`, `From`/`Dep`/`Departure`, and so on). |
| `auto` | | Detects the format from the file content. Fails with a request for an explicit `--from` when nothing matches with confidence. |

Options:

- `-o, --output <file>`: write to a file instead of stdout.
- `--self-role <role>`: add you to every entry with this role. Needed for
  `csv` and `foreflight`, which have no crew.
- `--self <name>`: for LogTen, which crew name is you. The default is the
  name that appears most often, and the command prints which one it picked.
- `--map field=Header,field2=Header2`: override column names (`csv`,
  `foreflight`).
- `--date-format YMD|DMY|MDY`: for ambiguous slash dates. `YYYY-MM-DD`,
  `DD-MM-YYYY` and `DD/MM/YYYY` are recognised without it. Times accept
  `HHMM`, `H:MM` and `HH:MM`.
- `--include-future`: keep rows dated after today. Formats that can contain
  rostered flights that have not been flown yet drop those rows by default.
- `--offline`: do not fetch the airport catalog, so no airports are resolved
  and codes pass through as written. When you are logged in, the default is
  your account's airport catalog and your own places.

The importers for the logbook apps read more than the public payload can
hold (simulator sessions, approaches, manual time overrides, the IFR flag).
`jetlog convert` drops those fields and prints a warning count.
`jetlog import`, `jetlog times` and `jetlog totals` use them. See
[IMPORTERS.md](IMPORTERS.md).

### `jetlog validate`

```sh
jetlog validate payload.json
jetlog validate payload.json --mode api        # also require from and to
jetlog validate payload.json --mode deeplink   # also require a flight number or registration
cat payload.json | jetlog validate - --json    # machine-readable
```

Exits 1 on any validation error.

### `jetlog schema`

Print the JSON Schema of the import payload, for a tool or a model that needs
the shape of the data.

```sh
jetlog schema                     # JSON Schema
jetlog schema --format markdown
```

The payload format itself is documented in
[JetlogAPI](https://github.com/jvdvleuten/JetlogAPI).

### `jetlog link`

Build `jetlog.app` import links from a payload.

```sh
jetlog link payload.json
jetlog link payload.json --scheme jetlog      # jetlog://import?data=...
jetlog link payload.json --max-length 4000    # more, shorter links
jetlog link payload.json --open               # open the first link
```

A payload that is too long for one link is split over several. An entry and
its crew always stay in the same link. Opening a link writes nothing: the
Jetlog app shows an import preview that the pilot confirms.

### `jetlog ai convert`

Reads unstructured logbook data (csv, tsv, txt, json, md) and asks an LLM to
produce a Jetlog payload. You bring your own API key.

```sh
export ANTHROPIC_API_KEY=...
jetlog ai convert notes.txt
jetlog ai convert notes.txt --provider openai --model <model>
jetlog ai convert notes.txt --instructions "times are already zulu"
```

Needs `ANTHROPIC_API_KEY` (provider `anthropic`, the default) or
`OPENAI_API_KEY` (provider `openai`). Pick a model with `--model` or
`JETLOG_AI_MODEL`. Large inputs are sent in chunks. The result goes through
the same validator as every other command. If it fails, the model gets its
own errors back for one repair attempt. This command never writes to Jetlog.
It prints a summary and you continue with `jetlog link` or `jetlog push`.

## Login and reading

### `jetlog login`

```sh
jetlog login                    # read-only access
jetlog login --scope write      # read and write
jetlog login --profile work     # a second account or token next to the first
jetlog login --no-qr            # no QR code, only the number, code and link
jetlog login --open             # also open the sign-in link in a browser
```

The command prints a QR code (when the terminal is wide enough), a two-digit
number, a code and a link. Scan the QR code with your iPhone camera, or open
Jetlog and go to Settings > Connected Apps > Scan QR Code. Pick the number
from the terminal in the app and confirm with Face ID. Picking a different
number denies the login, so run `jetlog login` again if that happens. Without
a camera, open the link or enter the code on the approval page.

The result is a personal access token, stored in
`~/.config/jetlog/credentials.json` (`%APPDATA%\jetlog` on Windows,
`$XDG_CONFIG_HOME/jetlog` when set), mode `0600` in a `0700` directory.

A token is either `read` or `read write`. An `insufficient_scope` or
`route_not_available_to_token` error means the token does not allow what you
asked. Run `jetlog login` again with the right `--scope`.

`jetlog logout` deletes the local credential only. The token itself stays
valid until it expires or you revoke it in the Jetlog app, under Settings >
Connected Apps.

`jetlog whoami` shows the account and token behind the active login.
`jetlog token print` prints the stored token, for use in a script.

### `jetlog entries`, `people`, `aircraft`

```sh
jetlog entries list --from 2026-01-01 --to 2026-03-31
jetlog entries list --registration PH-ABC --json
jetlog entries search --flight-number KL1023 --csv
jetlog people list
jetlog aircraft list
```

The default output is a table. Pass `--json` or `--csv` for machine-readable
output. `entries list` filters on `--from`, `--to`, `--type`,
`--registration`, `--airport`, `--flight-number`, `--person-id` and `--role`.
It returns one page (`--limit`, at most 200) unless you pass `--all`.

### `jetlog export`

```sh
jetlog export -o logbook.json
jetlog export -o logbook.csv --format csv --include-deleted
```

Pages through the whole logbook and streams it to disk, with progress on
stderr. An interrupted JSON export continues where it stopped when you run
the same command with the same `-o` path again.

## Flight times

### `jetlog times`

Computes flight times per entry for a logbook file: PIC, co-pilot, dual,
PICUS/SPIC, night, IFR, cross-country, simulator, and the EASA FCL.050
columns. Flight times are computed locally. It is a port of the calculator in the Jetlog app and
is tested against a corpus of results from the app.

```sh
jetlog times logbook.csv --from csv --self-role PIC
jetlog times logbook.txt --from logten --self "Jane Doe"
jetlog times logbook.csv --from csv --self-role PIC --json
```

The default output is a table with one row per entry. `--json` prints the
full calculation. `--from` takes the same formats as `jetlog convert`.

Night time and cross-country by distance need airport positions, and those
come from your Jetlog account. Without a login (or with `--offline`) they are
not computed, the night column is blank, and one `note:` line on stderr says
so. Run `jetlog login` to use your airport catalog.

Entries without a person marked as you are skipped, and the command says what
to pass. For LogTen that is `--self "<name>"` (the default is the most
frequent crew name; a tie is not guessed). For `csv` and `foreflight` it is
`--self-role <role>`. When every entry is skipped the command exits 1.

### `jetlog totals`

The same calculation, summed: block, air and taxi time, PIC, PICUS, SPIC,
co-pilot, dual and instructor time, night, IFR and cross-country, aircraft
class, simulator time, and the ATPL credit figures.

```sh
jetlog totals logbook.csv --from csv --self-role PIC
jetlog totals logbook.txt --from logten --since 2026-01-01 --until 2026-12-31
jetlog totals                    # your own Jetlog data, needs a login
jetlog totals logbook.csv --from csv --self-role PIC --json   # minutes
```

For a file, night time and distance-based figures need a login for airport
positions. Without one they are not computed and a `note:` line on stderr
says so. Do not read the night total as zero hours flown at night.

Without a file argument the totals come from your logged-in account. That
path also classifies aircraft (single/multi engine, multi pilot), which a
file alone cannot do.

`--since` and `--until` filter on the entry's derived date, both ends
inclusive. Known limitations are listed in [TIMES.md](TIMES.md).

## Importing

### `jetlog import`

Writes a logbook file into your Jetlog account, after a preview and your
confirmation. Needs `jetlog login --scope write`.

```sh
jetlog import pilotlog-export.csv --from pilotlog
jetlog import logten-export.txt --from logten --dry-run     # preview only
jetlog import rb_flights.csv rb_aircraft.csv rb_people.csv --from rblogbook --yes
jetlog import export.json --from deeplink-json --label "2026 backup restore"
```

Accepted formats: `logten`, `pilotlog`, `flylog`, `safelog`, `skylife`,
`chrono`, `rblogbook`, `flightlogger`, `excel`, `monthly-overview`,
`jetlog-csv`, `deeplink-json`, or `auto` when it resolves to one of those.
`csv`, `foreflight` and `jetlog` are convert-only.

What a run does:

1. Parses the file.
2. Fetches your existing entries, people, aircraft and simulators, and
   matches each row against them (flight number and date, registration and
   date, or simulator and date). A matched row is updated, never duplicated.
3. Prints a preview: new and updated entry counts, people and aircraft to
   create, the date range, and warnings with their source row, for example
   `row 5 (2026-01-13 KL1004): Registration missing`. Then asks you to
   confirm. `--yes` skips the question. Importing an unchanged file again
   shows `0 updated` and sends nothing.
4. Opens an import batch and writes people, aircraft, simulators and entries.
5. Prints the batch id and how to undo it.

Entries the import creates are marked as created by the CLI and grouped under
the batch. Entries it only updates keep their original source.

### `jetlog batches`

```sh
jetlog batches list
jetlog batches remove <id>
jetlog batches remove --all-cli
```

`remove` shows what would be removed and asks you to confirm (`--yes` to
skip). It soft-deletes the entries that batch created, and people it created
that are no longer used. Entries the batch only edited are kept. A signed
entry is never deleted. `--all-cli` does the same for every CLI import.

The Jetlog app lists the same batches under Settings > Imports, with the same
preview before deleting.

## Proposed changes

An AI assistant connected through `jetlog mcp` proposes changes and applies
them after you confirm (see [AI.md](AI.md)). These two commands do the same
from a terminal:

```sh
jetlog changes show <id>     # preview and status of a proposal
jetlog changes apply <id>    # preview, confirm, apply
```

There is no command to propose a change. That is done through the MCP server.

## Partner API

### `jetlog push`

Sends a payload to Jetlog's External Partner API. For partners that hold a
partner key. As a pilot you want `jetlog import`.

```sh
export JETLOG_USER_KEY=...
export JETLOG_PARTNER_KEY=...
jetlog push payload.json
jetlog push payload.json --dry-run    # validate only, nothing sent
```

Validates in API mode (`from` and `to` required), sends at most 500 entries
per request, and prints `skipped` and `warnings` from each response.

## Environment variables

| Variable | Effect |
| --- | --- |
| `JETLOG_TOKEN` | Use this token instead of the stored login. Useful in CI. |
| `JETLOG_BASE_URL` | API base URL, same as `--base-url`. |
| `JETLOG_PROFILE` | Which login profile `jetlog mcp` uses. |
| `JETLOG_USER_KEY`, `JETLOG_PARTNER_KEY` | Partner API keys for `jetlog push` and the MCP tool `push_payload`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Keys for `jetlog ai convert`. |
| `JETLOG_AI_MODEL` | Model for `jetlog ai convert`. |
