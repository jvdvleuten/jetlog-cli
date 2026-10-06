# Importers

`jetlog convert`, `jetlog import`, `jetlog times` and `jetlog totals` read
logbook exports from other apps through the importers in `src/import/`. They
are ports of the Jetlog iOS app's importers and aim to behave the same: same
column handling, same role rules, same warnings. This document describes the
intermediate model, the importer interface, the supported formats, and how to
add one.

## Intermediate model

The public payload (`src/schema.ts`) is narrow: no simulator
sessions, no per-function time buckets, no approaches. The importers do not
target it. They produce the richer model in `src/import/model.ts`
(`ImportedEntry`, `ImportedPerson`, `ImportedAircraft`, `ImportResult`):
flight or simulator session, manual time overrides, approaches and autolands,
crew with real roles. Field names match the iOS app's, so the two code bases
are easy to compare.

An importer run is one file in, one `ImportResult` out, with no knowledge of
what is already in the logbook. Fields that only matter when merging onto an
existing entry stay at their "brand new" defaults. Matching and merging is a
separate pass (see "Re-import comparison").

The model is consumed in three places:

- `src/import/to-payload.ts` maps it down to the public payload for `jetlog
  convert` and `jetlog link`. It is minimal and drops what the payload has no
  field for (simulator sessions, approaches, function-time buckets, crew
  beyond `ref_id` and role).
- `src/import/resolve.ts` turns it into the writes `jetlog import` sends.
- `src/times/importedEntryAdapter.ts` feeds it to the flight-times calculator
  (see `docs/TIMES.md`).

## Shared helpers

| Module | What it does |
| --- | --- |
| `time-parsing.ts` | `H:MM` and raw-minute durations, clock times. |
| `authoritative-times.ts` | Applies a per-format table of "this column is authoritative for this time field" onto `manualTimes`. |
| `normalization.ts` | Per-row logic: authoritative block/session duration to timeline, role-based manual-time clearing and expansion (including partial SIC), PICUS retagging, bulk (24 h or more) conversion. Call order matters, the doc comments say where. |
| `duplicate-detector.ts` | Flags rows that duplicate another row in the same file. Call `flagDuplicates(entries, importErrors)` once at the end of `parse()`. |
| `person-matcher.ts` | Merges crew names within one file by exact and fuzzy normalised-name matching. Also used against existing people on re-import. |
| `zip.ts` | ZIP reading on `fflate`: `looksLikeZip`, `unzipEntries`, `decodeZipText`. |
| `xlsx.ts` | Minimal `.xlsx` reader on `fflate`. |
| `pdf-layout.ts` | Line reconstruction from PDF text runs, used by `chrono`. |

## Importer interface

```ts
interface Importer {
  id: string;              // the --from value
  displayName: string;
  extensions: string[];
  detect(buffer: Buffer, filename: string | undefined): number; // 0..1
  parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult>;
  parseMany?(files: { buffer: Buffer; filename: string | undefined }[],
             options?: ImporterOptions): Promise<ImportResult>;
}
```

- `parse()` is async because PDF text extraction is promise based. Most
  importers are synchronous inside.
- `detect()` is content and extension sniffing for `--from auto`. The iOS app
  has the user pick a format, so this part is not a port. The two PDF formats
  return 0 for a raw PDF (telling them apart needs the expensive extraction
  step), so pass `--from monthly-overview` or `--from chrono` for PDFs.
- `parseMany()` is for formats whose export is several files (RB Logbook).
- A format with extra parameters extends `ImporterOptions` (LogTen takes an
  address-book file, a partial-SIC strategy and a custom switch mapping, see
  `LogTenImportOptions` in `src/import/importers/logten/logten.ts`).
- Options shared by several formats: `selfRole` (`--self-role`), `dateFormat`
  (`--date-format`), `selfName` (`--self`).

## Registry and detection

`IMPORTERS` in `src/import/registry.ts` lists every importer.
`detectImporter(buffer, filename)` returns the importer with the highest
`detect()` confidence; on a tie the one registered first wins, so list more
specific formats before generic ones. `getImporter(id)` backs `--from <id>`.

## Supported formats

| id | Reads |
| --- | --- |
| `deeplink-json` | Jetlog import payload JSON. |
| `jetlog-csv` | Jetlog's own CSV export, loose files or the ZIP archive. |
| `excel` | Jetlog's own `.xlsx` export, same schema as `jetlog-csv`. |
| `logten` | LogTen Pro flights export, plus the optional address-book export. |
| `pilotlog` | mccPILOTLOG: classic and raw/web CSV, and the zipped backup (first top-level `.csv`). |
| `flylog` | FlyLog CSV (fixed uppercase header). |
| `safelog` | SafeLog tab-delimited CSV. Clock columns may carry a unit suffix (`14:55 LOCAL`, `08:00 UTC`), which is stripped. |
| `skylife` | Skylife semicolon-delimited CSV. |
| `flightlogger` | FlightLogger CSV (no flight number column). |
| `rblogbook` | RosterBuster export: flights file required, aircraft and people files optional. |
| `monthly-overview` | KLC "Monthly Overview" duty-roster PDF (or its extracted text). |
| `chrono` | KLM "Chronologisch overzicht Vlieguren" PDF. |

Who is "you": LogTen does not mark the logbook holder. The most frequent crew name
becomes `SELF`, with its role derived from the function columns, and
`ImportResult.notes` names the person picked. `--self <name>` overrides this.
On a tie for first place nobody is picked and an `importErrors` entry asks for
`--self`. A `--self` name that is not in the file is reported.

## Multi-file input (RB Logbook)

`jetlog convert` accepts several files. If the resolved importer declares
`parseMany`, it is called instead of `parse()`. Only `rblogbook` does, and it
identifies each file by content, so the order does not matter:

```sh
jetlog convert rb_logbook_flights.csv rb_logbook_aircraft.csv \
  rb_logbook_people.csv --from rblogbook
```

A single file goes through `parse()`. Several files for a format without
`parseMany` is an error ("<id> does not support multiple input files").

## Future-dated rows

Exports from other apps can contain rostered flights that have not happened
yet. `convertFile` and `convertFiles` drop rows dated after today for
`pilotlog`, `safelog`, `flightlogger`, `flylog`, `skylife`, `logten` and
`rblogbook` (`EXCLUDES_FUTURE_ENTRIES_BY_DEFAULT` in `src/convert/index.ts`).
`--include-future` on `convert` and `import` keeps them.

The Jetlog formats (`excel`, `jetlog-csv`, `deeplink-json`) and the PDF
statements (`monthly-overview`, `chrono`) are never filtered, matching the iOS
app. The dropped count is printed on stderr and exposed as
`ConvertFileResult.futureEntriesExcludedCount` (`undefined`, not `0`, for a
format the filter does not apply to).

## Dependencies

- `fflate` (MIT, no dependencies): ZIP reading, and the container layer under
  the `.xlsx` reader. Small, synchronous, no native build.
- `unpdf` (MIT, over `pdfjs-dist`): PDF text extraction.
- `pdf-lib` (MIT, dev only): builds small synthetic PDFs for tests.

There is no full xlsx library. `src/import/xlsx.ts` is a purpose-built reader
for the flat header-row-then-data shape of Jetlog's export, which keeps the
dependency list short.

## Excel (`.xlsx`): scope and gaps

The reader handles shared strings, inline strings, formula result strings (the
cached value, formulas are never evaluated), booleans, error cells (read as
empty), and numeric cells that are dates or times according to their style
(built-in date formats or a custom format with a date/time token). The epoch
is 1899-12-30 including Excel's 1900 leap-year quirk. Hand-edited sheets are
tolerated: decimal-hour durations (`1.5` is 1 h 30 min) and four-digit times
without a colon (`1435`).

Gaps:

- Non-finite numeric cells (`1e400`) read as empty. The iOS app clamps them to
  the epoch.
- A workbook from another producer, with merged headers or several header
  rows, may read incorrectly.

## PDF: scope and gaps

Both PDF importers accept a raw PDF buffer (detected by the `%PDF` magic
bytes) and are best-effort. They have been tested with synthetic PDFs, not
with real statements.

- `monthly-overview` extracts text with `unpdf`. The iOS app uses PDFKit, so
  line breaks and column spacing can differ for the same file. The row regexes
  are the same and tolerate two duty rows landing on one text line.
- `chrono` rebuilds lines from pdfjs text runs (top-to-bottom by Y band,
  left-to-right by X, gap-based spacing, a `K L` to `KL` kerning fix). The iOS
  app works per glyph and also drops watermark text by colour and by an
  allowed-character filter. pdfjs exposes whole runs without colour, so those
  two filters are not available here. A PDF with coloured watermark text may
  produce extra noise lines.

## Fixtures

All fixtures under `test/fixtures/ios/<importer>/` are synthetic or
anonymised: hand-built files with invented names, flight numbers and
registrations that exercise the same structural behaviour as real exports.
Never add a real person's logbook. Read a real export's header row to confirm
the column schema, then build a small file with fake data.

## Adding an importer

1. Pick the closest existing importer in `src/import/importers/` and reuse the
   shared helpers instead of re-deriving their logic.
2. Build rows with `newImportedEntry()` (`model.ts`). Call the
   `normalization.ts` functions in the order the closest existing importer
   does, then call `flagDuplicates()` once at the end.
3. Canonicalise every airport code with `canonicalCode` from `src/airports/`
   (`canonicalCode(x) ?? x`). It returns an unknown code trimmed and
   uppercased, so it is safe to call unconditionally.
4. Set `ImportedEntry.sourceRow` on line-oriented formats so warnings can name
   the row.
5. Write `src/import/importers/<name>.ts` exporting `<name>Importer:
   Importer` and add it to `IMPORTERS` in `src/import/registry.ts`.
6. Add tests in `test/import/<name>.test.ts` with synthetic fixtures under
   `test/fixtures/ios/<name>/`. Cover each distinct behaviour, not every
   column.
7. A new npm dependency needs a reason: small, maintained, permissive
   licence.
8. Update the `--from` help text in `src/cli.ts` and the supported-formats
   list in the README.
9. Touch `to-payload.ts` only if the new importer produces something the
   mapper miscounts as dropped.

## Warnings and row context

Importers report problems as `ImportError`s. `src/import/warnings.ts` resolves
each into an `ImportNotice` (`kind`, `message`, `row`, `date`, `flightNumber`,
`from`, `to`, `registration`, `identity`) and formats it for the terminal: one
line per row, several warnings of one row joined with `; `:

```
warning: row 5 (2026-01-13 KL1004): Registration missing; Origin airport missing
```

The row number is the line in the source file with the header as line 1,
taken from `ImportedEntry.sourceRow`. The line-oriented importers (`pilotlog`,
`safelog`, `skylife`, `flylog`, `flightlogger`, `rblogbook`, `logten`) set it.
PDF and JSON sources have no row and show the flight identity only. `convert`
(`ConvertFileResult.notices`), `import`, `times`, `totals` and the MCP tools
use the same notices (`convert_file` adds `warnings`, `import_preview` adds
`warningDetails`).

## Re-import comparison

`jetlog import` fetches the user's existing entries, people and aircraft over
the read API (`remote-mirror.ts`), then `match.ts` and `merge.ts` decide per
row whether it is new, an update or unchanged. `resolve.ts` assembles the
result into a write plan.

- Entries match on date plus flight number (normalised, with the airline
  prefix rewritten from the airline catalogue when logged in), falling back to
  date plus registration. Among same-day candidates the departure or arrival
  airport disambiguates; otherwise a single candidate, or one with no route,
  matches. A match found only through flight-number normalisation merges
  conservatively (fills gaps only).
- Simulator sessions match on date and device, preferring a start time match.
- People match on Jetlog id, employee number, exact normalised name, then a
  single confident fuzzy name.
- Exact duplicate rows within one file are skipped. `--as-new` writes every
  row that would have matched as a new entry instead.

The unchanged check compares what the importer would write with what the read
API returns. The server echoes some values in a different shape: times as
`HH:MM:SS`, `takeoffs_and_landings` always with all seven keys (unused ones
`null`), and map keys in its own order. Structured values are compared
canonically (sorted keys, `null` equal to absent), so an identical re-import
reports `0 new, 0 updated, N unchanged`.

Unlike the iOS app there is no per-row Merge or New review step.
