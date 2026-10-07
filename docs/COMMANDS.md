# Command reference

Every command also has `--help`.

- [Convert and check](#convert-and-check): `convert`, `validate`, `schema`,
  `link`, `ai convert`
- [Login and reading](#login-and-reading): `login`, `logout`, `whoami`,
  `entries`, `people`, `aircraft`, `export`
- [Files, photos and signatures](#files-photos-and-signatures):
  `attachments`, `photos`, `signatures`
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
jetlog login                    # read-only access, plus downloading files
jetlog login --scope write      # read and write, plus files and signatures
jetlog login --profile work     # a second account or token next to the first
jetlog login --no-qr            # no QR code, only the number, code and link
jetlog login --open             # also open the sign-in link in a browser
```

The command prints a two-digit number first, then a QR code (when the
terminal is wide enough), a code and a link. Scan the QR code with your iPhone camera, or open
Jetlog and go to Settings > Connected Apps > Scan QR Code. Pick the number
from the terminal in the app and confirm with Face ID. Picking a different
number denies the login, so run `jetlog login` again if that happens. Without
a camera, open the link or enter the code on the approval page.

The result is a personal access token, stored in
`~/.config/jetlog/credentials.json` (`%APPDATA%\jetlog` on Windows,
`$XDG_CONFIG_HOME/jetlog` when set), mode `0600` in a `0700` directory.

A token carries up to four scopes:

- `read`: read your logbook, including whether an entry is signed, waived or
  unsigned, how many files an entry has and whether a person has a photo.
- `write`: create and edit entries, people and aircraft.
- `files`: with `read`, list and download entry files and person photos. With
  `write`, also upload files, attach them to entries, set person photos and
  create upload links.
- `signatures`: download signature images, and with `write`, attach, replace
  and remove a signature image, waive and unwaive a signature, and create
  signing links.

`jetlog login` asks for `read files signatures`, and `jetlog login --scope
write` asks for `read write files signatures`. A token made before `files` and
`signatures` existed keeps exactly the powers it had, so log in again to use
the file, photo and signature commands. Without the scope those commands say
so and change nothing. An `insufficient_scope` or
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
jetlog people
jetlog aircraft
```

The default output is a table. Pass `--json` or `--csv` for machine-readable
output. `entries list` filters on `--from`, `--to`, `--type`,
`--registration`, `--airport`, `--flight-number`, `--person-id` and `--role`.
It returns one page (`--limit`, at most 200) unless you pass `--all`.
`entries` also shows a `signature` column (none, waived or signed) and a
`files` column, and `people` shows a `photo` column.

### `jetlog export`

```sh
jetlog export -o logbook.json
jetlog export -o logbook.csv --format csv --include-deleted
```

Pages through the whole logbook and streams it to disk, with progress on
stderr. An interrupted JSON export continues where it stopped when you run
the same command with the same `-o` path again.

## Files, photos and signatures

Three command groups work with the files, photos and signatures in your
logbook. They need the `files` scope (and `signatures` for signatures), so log
in again if your token is older, see [Login and reading](#login-and-reading).
Anything that changes something needs a write login
(`jetlog login --scope write`), shows what it is about to do and asks for
confirmation (skip with `--yes`). Data goes to stdout, status and prompts to
stderr.

```sh
jetlog attachments list <entry-id>
jetlog attachments add <entry-id> loadsheet.pdf ramp.jpg
jetlog attachments get <attachment-id> -o ./loadsheet.pdf
jetlog attachments remove <entry-attachment-id>

jetlog photos set <person-id> portrait.png
jetlog photos get <person-id> -o ./portrait.png

jetlog signatures show <entry-id>
jetlog signatures get <entry-id> -o ./signature.png
jetlog signatures attach <entry-id> instructor.png
jetlog signatures attach-many <list.json> [--replace]
jetlog signatures remove <entry-id...>
jetlog signatures waive <entry-id...>
jetlog signatures unwaive <entry-id...>
jetlog signatures request <entry-id...>
jetlog signatures revoke <request-id>
```

Entry ids come from `jetlog entries list --json`, person ids from
`jetlog people`.

### Files on entries

`attachments add` uploads PNG, JPEG, HEIC or PDF files (up to 25 MiB each,
20 per entry) and attaches them to an entry in one go. The type is taken from
the file's content, not its name. `attachments list` prints the file rows: the
first column (`id`) is what `attachments remove` takes, `attachment_id` is what
`attachments get` takes. `get` never overwrites an existing file unless you
pass `--force`.

### Person photos

`photos set` takes a PNG or JPEG of up to 2 MiB and 8192 pixels per side and
replaces the current photo if there is one. `photos get` downloads it.

### Signatures

`signatures show` prints the state of an entry (`none`, `waived` or `signed`)
and the checksum of the signature image. `signatures get <entry-id>` downloads
the image itself. It needs the `signatures` scope, and `files` is not needed.
It works like `attachments get`: it saves into the current directory, or to
`-o` (a file or a directory), and never overwrites unless you pass `--force`.
If the entry is not signed it says so and exits with 1. If the login was made
without the `signatures` permission it says so and tells you to run
`jetlog login` again and keep that permission ticked.

- `signatures attach` sets a PNG (up to 5 MiB and 4096 pixels per side) as the
  signature of an entry. Dark ink on a transparent background, about 250
  pixels on the long edge, looks best in the app. On a signed entry it
  replaces the signature, and the preview then says "Will replace the existing
  signature with ..." and the prompt asks "Replace the existing signature?".
  Every change is recorded in your account's audit log and you get a push
  notification.
- `signatures attach-many <list.json>` attaches signature images to many
  entries in one write. The list is a JSON array, other keys in an item are
  ignored:

  ```json
  [
    { "entry_id": "<id>", "file": "signatures/2026-03-14_EHAM-EGLL.png" }
  ]
  ```

  A relative `file` is read relative to the folder the list is in. Entries that
  are already signed are skipped unless you pass `--replace`, and bulk entries
  are always skipped. The preview lists every entry, then you confirm (or pass
  `--yes`). One run is one write, so it is one line in `jetlog batches list`
  and one notification, however many signatures it carries. The server allows
  200 signature changes per hour, so one run attaches at most 200. When the list
  is longer, the first 200 are attached and the command says so; run the same
  command again an hour later, entries that are signed by then are skipped.
  The hourly limit counts for the write as a whole: when it does not leave
  room for all of them, nothing is attached and the command says when to try
  again.
- `signatures remove <entry-id...>` removes the signature image from signed
  entries. They go back to unsigned. The preview lists each entry with its
  state, skips entries that are not signed, and says the removal is recorded
  in your audit log. Confirm, or pass `--yes`.
- `signatures waive` and `unwaive` mark an unsigned entry as waived and undo
  that. A waiver records the hours as signed in your own totals, an authority
  does not accept it. A real signature can be added later and replaces it.
- `signatures request` creates a remote signing link for up to 20 entries,
  valid for 48 hours, and prints the URL once together with the request id.
  Anyone who has the link can sign those entries, and sees your email address
  and these flights. `signatures revoke <request-id>` kills a link. A login
  can only revoke links it created itself, and revoking the login in the app
  revokes its open links too. At most 5 links can be open at once.
- Bulk entries cannot be signed this way. The commands check the state first
  and skip or refuse what the server would reject.

A signed entry is not locked for tokens: a write token can still replace or
remove its signature, edit it or delete it. Those writes are recorded in the audit log and
reported to you by push notification, the same way signature changes are.

### Limits and retries

Uploads are counted per user across the CLI and AI connections: a daily and a
total byte quota, at most 50 uploads waiting to be confirmed, and one hourly
budget for signature actions. When a limit is hit the CLI says which and
stops. For a short per-minute limit it waits up to 60 seconds and retries. For
anything longer (an hourly limit, a quota) it fails at once with "try again in
N minutes" instead of sleeping. A signing link request is never retried after
a server error, because the link may already exist: check the open signing
links in the Jetlog app before trying again.

Everything these commands write belongs to an edit batch
(`jetlog batches list`). Removing a batch only deletes the entries that batch
created, never files or signatures added to entries that were already there.

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
With `--json`, `unresolvedAirports.entryCount` tells how many entries use an
airport that could not be placed, and `codes` lists them. When it is above
zero a `note:` line on stderr says the same.

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
that are no longer used. Entries the batch only edited are kept. An entry
signed in the app is kept. An entry a token signed by attaching an image
(`jetlog signatures attach`, an upload link) is deleted with the batch, and
the preview counts those ("signed by a token"). An entry signed through a
signing link a token created is kept by default ("kept (link-signed)"). Add
`--include-link-signed` to delete those too. `--all-cli` does the same for
every CLI import.

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
| `JETLOG_DOWNLOAD_DIR` | Folder where the MCP tool `download_attachment` saves files. Default `~/Downloads/jetlog`. |
| `JETLOG_USER_KEY`, `JETLOG_PARTNER_KEY` | Partner API keys for `jetlog push` and the MCP tool `push_payload`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Keys for `jetlog ai convert`. |
| `JETLOG_AI_MODEL` | Model for `jetlog ai convert`. |
