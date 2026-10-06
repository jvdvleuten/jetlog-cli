/**
 * Ported from the Jetlog iOS app's SafeLog importer (SafeLog export, a tab-delimited CSV
 * with EASA-style column names: "Holder's Operating Capacity", "Day
 * Single-Engine (SE) in Command", "Simulator Sim.Type", ...).
 *
 * SafeLog's per-function time columns are split four ways, day/night x
 * single/multi-engine, for each of the "in Command" (PIC), "P2"/"Co-Pilot"
 * (SIC), PICUS, and Dual groups. The authoritative-time table below sums
 * each group of four into the one `Times` field SafeLog logs it as; see
 * `authoritativeFlightTimeFields`.
 *
 * FSTD (simulator) rows are detected structurally, not by a dedicated
 * entry-type column: a row counts as FSTD when "Simulator Sim.Type" is
 * non-empty and both "Departure Time"/"Arrival Time" are blank
 * (`isSimulatorEntry`), ported verbatim.
 *
 * ## Not ported (no local store offline, see `model.ts`)
 *
 * The iOS app's import lookup context is database-backed; none of its
 * methods have an offline equivalent, so every call site is skipped:
 *  - Existing entry/FSTD entry/person/aircraft matching, every row here is
 *    produced as brand-new (`isExisting: { existing: false }`), same as every
 *    other importer in this CLI.
 *  - IATA->ICAO conversion is backed by the airport resolver (logged-in catalog only, none offline) in
 *    `../../airports/index.js` (`canonicalCode`): `from`/`to` resolve to ICAO
 *    for a known IATA code, otherwise pass through unchanged, same as
 *    `deeplink-json.ts`/`logten.ts`/`pilotlog.ts`.
 *  - The stored-user fetch, which the iOS importer does twice, both skipped:
 *    (1) `addPersonIfNeeded` seeds the "SELF" person from the signed-in
 *    user's own person record when one exists, falling back to a bare
 *    placeholder (default role PIC, no name) otherwise,
 *    offline there is no signed-in user, so "SELF" always gets the
 *    placeholder shape (same as `ensureSelfPerson` in `pilotlog.ts`/other
 *    importers); (2) the post-pass finds the "most
 *    frequently imported person" across all rows and, when a real user
 *    record exists, remaps that person's `ref_id` onto the user's database
 *    id (and flags rows that still lack a role for that id). This pass only
 *    ever matters for turning the placeholder into a real id, something
 *    with no offline meaning, so it's skipped entirely and "SELF" simply
 *    keeps that literal `refId` throughout, exactly like every other ported
 *    importer.
 *
 * In-file duplicate flagging is used by the iOS app and is ported here via
 * `flagDuplicates` from `duplicate-detector.ts`, called once at the end of
 * `parseSafeLogCsv`, same as every other importer. The authoritative-time
 * and time-parsing helpers are ported via
 * `authoritative-times.ts`/`time-parsing.ts`. SafeLog does not use the
 * shared person/in-file name matchers, its own person resolution is a
 * simple exact-string match on the "Name of PIC" column (`addPersonIfNeeded`
 * below), ported as-is.
 */
import type { Importer, ImporterOptions } from "../importer.js";
import { canonicalCode } from "../../airports/index.js";
import { flagDuplicates } from "../duplicate-detector.js";
import {
  fstdDeviceCategoryFromFreeText,
  newImportedEntry,
  time,
  truncatedRemarks,
  type DateOnly,
  type EntryPersonRole,
  type ImportError,
  type ImportResult,
  type ImportedAircraft,
  type ImportedEntry,
  type ImportedEntryCrewMember,
  type ImportedPerson,
  type TakeoffsAndLandings,
  type Time
} from "../model.js";
import { timeOfDay, colonDuration } from "../time-parsing.js";
import { single, sum, applyAuthoritativeTimes, type AuthoritativeTimeField } from "../authoritative-times.js";
import {
  applyAuthoritativeFlightBlockDuration,
  applyAuthoritativeFSTDSessionDuration,
  convertToBulkIfNeeded,
  normalizeImportedFlightManualTimes,
  retaggedLosslessPICUSRole
} from "../normalization.js";

// ---------------------------------------------------------------------------
// CSV tokenizing, ported from the iOS app's hand-rolled tab parser
// ---------------------------------------------------------------------------

/** Mirrors `splitCSVIntoProperLines`, RFC 4180 quoted-newline-aware line splitting. */
function splitCSVIntoProperLines(csvString: string): string[] {
  const lines: string[] = [];
  let currentLine = "";
  let inQuotes = false;
  const chars = Array.from(csvString);

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === "\r") continue;
    if (char === '"') {
      if (inQuotes && chars[i + 1] === '"') {
        currentLine += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "\n" && !inQuotes) {
      lines.push(currentLine);
      currentLine = "";
    } else {
      currentLine += char;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);
  return lines;
}

/** Mirrors `parseCSVRow`, tab-delimited, quote-aware, trims each column. */
function parseCSVRow(row: string): string[] {
  const columns: string[] = [];
  let current = "";
  let inQuotes = false;
  const chars = Array.from(row);

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === '"') {
      if (inQuotes && chars[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "\t" && !inQuotes) {
      columns.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  columns.push(current.trim());
  return columns;
}

/** Mirrors the header-row split in `parseCSVData`: a plain tab split (not
 * quote-aware like `parseCSVRow`), trimmed and stripped of surrounding
 * quote characters. */
function parseHeaderRow(row: string): string[] {
  return row.split("\t").map((h) => h.trim().replace(/^"+/, "").replace(/"+$/, ""));
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

/** Mirrors `getValue`, `undefined` for a missing header OR an empty cell. */
function getValue(name: string, columns: string[], headers: string[]): string | undefined {
  const idx = headers.indexOf(name);
  if (idx < 0) return undefined;
  const value = columns[idx];
  return value && value.length > 0 ? value : undefined;
}

/** Mirrors `getRemarksValue`, first of several header spellings seen across SafeLog exports. */
const REMARKS_HEADER_CANDIDATES = ["Remarks", "remarks", "Remarks and Endorsements", "remarks_and_endorsements"];

function getRemarksValue(columns: string[], headers: string[]): string | undefined {
  for (const header of REMARKS_HEADER_CANDIDATES) {
    const value = getValue(header, columns, headers);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Mirrors `hasExplicitValue`. */
function hasExplicitValue(name: string, columns: string[], headers: string[]): boolean {
  return getValue(name, columns, headers) !== undefined;
}

/** Mirrors `parseDuration`/`ImporterTimeParsing.colonDuration`. */
function parseDuration(raw: string | undefined): number {
  return colonDuration(raw);
}

/** Mirrors `durationIfPresent`. */
function durationIfPresent(name: string, columns: string[], headers: string[]): Time | undefined {
  if (!hasExplicitValue(name, columns, headers)) return undefined;
  return time(parseDuration(getValue(name, columns, headers)));
}

/** Mirrors `parseTime`, clock time with an optional " UTC"/" LOCAL" suffix (e.g. "14:55 LOCAL"). */
function parseTime(raw: string | undefined): Time | undefined {
  return timeOfDay(raw, [" UTC", " LOCAL"]);
}

/** Mirrors `Aircraft.clean_registration` as used by every other ported importer. */
function cleanRegistration(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

function upsertCrew(crew: ImportedEntryCrewMember[], member: ImportedEntryCrewMember): void {
  const idx = crew.findIndex((c) => c.refId === member.refId);
  if (idx >= 0) crew[idx] = member;
  else crew.push(member);
}

function isoDateOnlyIfValid(trimmed: string): DateOnly | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

/** Mirrors `DateOnly(iso8601String:)`, SafeLog's "Date" column is always `YYYY-MM-DD`. */
function parseSafeLogDate(raw: string | undefined): DateOnly | undefined {
  if (raw === undefined) return undefined;
  return isoDateOnlyIfValid(raw.trim());
}

// ---------------------------------------------------------------------------
// FSTD (simulator) row detection
// ---------------------------------------------------------------------------

/** Mirrors `isSimulatorEntry`: a simulator-type cell present AND no departure/arrival time. */
function isSimulatorEntry(columns: string[], headers: string[]): boolean {
  const simType = getValue("Simulator Sim.Type", columns, headers);
  const departureTime = getValue("Departure Time", columns, headers);
  const arrivalTime = getValue("Arrival Time", columns, headers);
  return simType !== undefined && departureTime === undefined && arrivalTime === undefined;
}

// ---------------------------------------------------------------------------
// Role determination
// ---------------------------------------------------------------------------

/** Mirrors `inferRoleFromTimeColumns`, consulted when "Holder's Operating
 * Capacity" is blank/unrecognized. Each bucket sums its day/night x
 * single/multi-engine quartet, same grouping as `authoritativeFlightTimeFields`. */
function inferRoleFromTimeColumns(columns: string[], headers: string[]): EntryPersonRole {
  const sumOf = (...names: string[]): number => names.reduce((acc, name) => acc + parseDuration(getValue(name, columns, headers)), 0);

  const inCommand = sumOf(
    "Day Single-Engine (SE) in Command",
    "Day Multi-Engine (ME) in Command",
    "Night Single-Engine (SE) in Command",
    "Night Multi-Engine (ME) in Command"
  );
  if (inCommand > 0) return "PIC";

  const picus = sumOf(
    "Day Single-Engine (SE) PICUS",
    "Day Multi-Engine (ME) PICUS",
    "Night Single-Engine (SE) PICUS",
    "Night Multi-Engine (ME) PICUS"
  );
  if (picus > 0) return "PICUS";

  const dual = sumOf("Day Multi-Engine (ME) Dual", "Night Multi-Engine (ME) Dual", "Day Single-Engine (SE) Dual", "Night Single-Engine (SE) Dual");
  if (dual > 0) return "STU";

  const coPilot = sumOf("Day Multi-Engine (ME) Co-Pilot", "Night Multi-Engine (ME) Co-Pilot", "Day Single-Engine (SE) P2", "Night Single-Engine (SE) P2");
  if (coPilot > 0) return "CP";

  const instructorTime = parseDuration(getValue("Instructor Flying", columns, headers));
  if (instructorTime > 0) return "FI";

  return "PIC";
}

/** Mirrors `determineHolderRole`. */
function determineHolderRole(columns: string[], headers: string[]): EntryPersonRole {
  const capacity = (getValue("Holder's Operating Capacity", columns, headers) ?? "").toUpperCase();
  switch (capacity) {
    case "PIC":
      return "PIC";
    case "COPILOT":
      return "CP";
    case "P/UT":
      return "STU";
    default:
      return inferRoleFromTimeColumns(columns, headers);
  }
}

/** Mirrors `determineFSTDRole`. */
function determineFSTDRole(columns: string[], headers: string[]): EntryPersonRole {
  const instructorTime = parseDuration(getValue("Instructor Flying", columns, headers));
  return instructorTime > 0 ? "FSTD_INS" : "FSTD_TRN";
}

// ---------------------------------------------------------------------------
// Authoritative-time field tables
// ---------------------------------------------------------------------------

/** Mirrors `authoritativeFlightTimeFields`. The four "in Command"/"P2 or
 * Co-Pilot"/"PICUS"/"Dual" groups are each split across day/night x
 * single/multi-engine columns in SafeLog's export, so they sum rather than
 * map 1:1. */
const AUTHORITATIVE_FLIGHT_TIME_FIELDS: AuthoritativeTimeField[] = [
  single("Total Flight Time", "totalTimeOfFlight"),
  sum(
    ["Day Single-Engine (SE) in Command", "Day Multi-Engine (ME) in Command", "Night Single-Engine (SE) in Command", "Night Multi-Engine (ME) in Command"],
    "pilotInCommand"
  ),
  sum(
    ["Day Single-Engine (SE) P2", "Day Multi-Engine (ME) Co-Pilot", "Night Single-Engine (SE) P2", "Night Multi-Engine (ME) Co-Pilot"],
    "coPilot"
  ),
  sum(["Day Single-Engine (SE) PICUS", "Day Multi-Engine (ME) PICUS", "Night Single-Engine (SE) PICUS", "Night Multi-Engine (ME) PICUS"], "picus"),
  sum(["Day Single-Engine (SE) Dual", "Day Multi-Engine (ME) Dual", "Night Single-Engine (SE) Dual", "Night Multi-Engine (ME) Dual"], "dual"),
  single("Instructor Flying", "instructor"),
  single("Instrument Flying", "ifr")
];

const AUTHORITATIVE_FSTD_TIME_FIELDS: AuthoritativeTimeField[] = [single("Simulator Sim.Time", "fstdSession")];

function applyAuthoritativeFlightTimes(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FLIGHT_TIME_FIELDS, (column) => durationIfPresent(column, columns, headers), entry);
}

function applyAuthoritativeFSTDTime(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FSTD_TIME_FIELDS, (column) => durationIfPresent(column, columns, headers), entry, false);
}

// ---------------------------------------------------------------------------
// People / aircraft collection
// ---------------------------------------------------------------------------

function ensureSelfPerson(people: Map<string, ImportedPerson>): void {
  if (people.has("SELF")) return;
  people.set("SELF", {
    refId: "SELF",
    defaultRole: "PIC",
    isExisting: { existing: false },
    isImportedFromOtherLogbook: true
  });
}

/** Mirrors `addPersonIfNeeded`. */
function addPersonIfNeeded(columns: string[], headers: string[], people: Map<string, ImportedPerson>): void {
  ensureSelfPerson(people);

  const picName = getValue("Name of PIC", columns, headers);
  if (picName === undefined || picName.toUpperCase() === "SELF") return;
  if (people.has(picName)) return;

  const names = picName.trim().split(/\s+/);
  const firstName = names[0];
  const lastName = names.slice(1).join(" ") || undefined;

  people.set(picName, {
    refId: picName,
    firstName,
    lastName,
    defaultRole: "PIC",
    isExisting: { existing: false },
    isImportedFromOtherLogbook: true
  });
}

/** Mirrors `addAircraftIfNeeded`, skipped for FSTD rows. */
function addAircraftIfNeeded(columns: string[], headers: string[], aircraft: Map<string, ImportedAircraft>): void {
  if (isSimulatorEntry(columns, headers)) return;
  const cleaned = cleanRegistration(getValue("Aircraft Registration", columns, headers));
  if (!cleaned || aircraft.has(cleaned)) return;
  aircraft.set(cleaned, { registration: cleaned, isImportedFromOtherLogbook: true });
}

// ---------------------------------------------------------------------------
// Crew handling
// ---------------------------------------------------------------------------

/** Mirrors `addFlightCrew`. */
function addFlightCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  const holderRole = determineHolderRole(columns, headers);
  upsertCrew(entry.crew, { refId: "SELF", role: holderRole });

  const picName = getValue("Name of PIC", columns, headers);
  if (picName === undefined || picName.toUpperCase() === "SELF") return;
  const picPerson = people.get(picName);
  if (!picPerson) return;

  // If the holder already logged PIC/PICUS, the named PIC on the row must be
  // the instructor/examiner supervising them, not a second PIC.
  const namedRole: EntryPersonRole = holderRole === "PIC" || holderRole === "PICUS" ? "FI" : "PIC";
  upsertCrew(entry.crew, { refId: picPerson.refId, role: namedRole });
}

/** Mirrors `addSimulatorCrew`, FSTD rows only ever get SELF as crew. */
function addSimulatorCrew(columns: string[], headers: string[], entry: ImportedEntry): void {
  upsertCrew(entry.crew, { refId: "SELF", role: determineFSTDRole(columns, headers) });
}

// ---------------------------------------------------------------------------
// Row -> entry
// ---------------------------------------------------------------------------

interface RowContext {
  columns: string[];
  headers: string[];
  row: number;
  people: Map<string, ImportedPerson>;
  importErrors: ImportError[];
}

function createFlightEntry(ctx: RowContext): ImportedEntry | undefined {
  const { columns, headers, row, people, importErrors } = ctx;

  const dateString = getValue("Date", columns, headers);
  const date = parseSafeLogDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: "Could not parse date", dateString, rowNumber: row });
    return undefined;
  }

  const registration = getValue("Aircraft Registration", columns, headers) ?? "";
  const from = canonicalCode(getValue("Departure", columns, headers)) ?? "";
  const to = canonicalCode(getValue("Arrival", columns, headers)) ?? "";
  const offBlocks = parseTime(getValue("Departure Time", columns, headers));
  const onBlocks = parseTime(getValue("Arrival Time", columns, headers));
  const blockMinutes = parseDuration(getValue("Total Flight Time", columns, headers));

  const takeoffsDay = Number.parseInt(getValue("Day T-O", columns, headers) ?? "", 10) || 0;
  const takeoffsNight = Number.parseInt(getValue("Night T-O", columns, headers) ?? "", 10) || 0;
  const landingsDay = Number.parseInt(getValue("Day Ldg", columns, headers) ?? "", 10) || 0;
  const landingsNight = Number.parseInt(getValue("Night Ldg", columns, headers) ?? "", 10) || 0;
  const takeoffsAndLandings: TakeoffsAndLandings = { type: "manual", takeoffsDay, takeoffsNight, landingsDay, landingsNight };

  const updateFlightData = offBlocks === undefined && onBlocks === undefined;

  const entry = newImportedEntry({
    date,
    type: "flight",
    registration: cleanRegistration(registration),
    from: from || undefined,
    to: to || undefined,
    offBlocks,
    onBlocks,
    updateFlightData,
    takeoffsAndLandings,
    isImportedFromOtherLogbook: true
  });

  addFlightCrew(columns, headers, people, entry);

  if (!entry.registration) {
    importErrors.push({
      code: "registrationMissing",
      reason: "Registration missing",
      dateString,
      flightNumber: entry.flightNumber,
      registration,
      entryId: entry.id
    });
  }
  if (from.length === 0) {
    importErrors.push({
      code: "originAirportMissing",
      reason: "Origin airport missing",
      dateString,
      flightNumber: entry.flightNumber,
      registration,
      entryId: entry.id
    });
  }
  if (to.length === 0) {
    importErrors.push({
      code: "destinationAirportMissing",
      reason: "Destination airport missing",
      dateString,
      flightNumber: entry.flightNumber,
      registration,
      entryId: entry.id
    });
  }

  applyAuthoritativeFlightBlockDuration(entry, blockMinutes > 0 ? blockMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFlightTimes(columns, headers, entry);

  const selfRole = entry.crew.find((c) => c.refId === "SELF")?.role;
  // Lossless PICUS retag: a co-pilot-seat row whose picus column equals the
  // full block was flown as PICUS, retag before normalize (whose PICUS case
  // clears the column) so the crew row and role attribution agree.
  const resolvedSelfRole = retaggedLosslessPICUSRole(entry, selfRole);
  if (resolvedSelfRole !== undefined && resolvedSelfRole !== selfRole) {
    upsertCrew(entry.crew, { refId: "SELF", role: resolvedSelfRole });
  }
  normalizeImportedFlightManualTimes(entry, resolvedSelfRole);

  return entry;
}

function createSimulatorEntry(ctx: RowContext): ImportedEntry | undefined {
  const { columns, headers, row, importErrors } = ctx;

  const dateString = getValue("Date", columns, headers);
  const date = parseSafeLogDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: "Could not parse date", dateString, rowNumber: row });
    return undefined;
  }

  const simType = getValue("Simulator Sim.Type", columns, headers);
  const fstdId = simType;
  const deviceCategoryHint = simType !== undefined ? fstdDeviceCategoryFromFreeText(simType) : undefined;

  const durationMinutes = parseDuration(getValue("Simulator Sim.Time", columns, headers));
  const startTime = time(0);
  const endTime = durationMinutes > 0 ? time(durationMinutes) : undefined;

  const remarks = truncatedRemarks(getRemarksValue(columns, headers), importErrors, { dateString });

  const entry = newImportedEntry({
    date,
    type: "fstd",
    fstdId,
    startTime,
    endTime,
    updateFlightData: false,
    isImportedFromOtherLogbook: true,
    remarks
  });
  entry.fstdDeviceCategory = deviceCategoryHint;

  addSimulatorCrew(columns, headers, entry);

  if (fstdId === undefined) {
    importErrors.push({
      code: "fstdIdentifierMissing",
      reason: "FSTD identifier missing",
      dateString,
      rowNumber: row,
      entryId: entry.id
    });
  }

  applyAuthoritativeFSTDSessionDuration(entry, durationMinutes > 0 ? durationMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFSTDTime(columns, headers, entry);

  return entry;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/** Parses SafeLog tab-delimited CSV content into an `ImportResult`. */
export function parseSafeLogCsv(csvText: string): ImportResult {
  const importErrors: ImportError[] = [];
  const rows = splitCSVIntoProperLines(csvText);

  if (rows.length === 0) {
    importErrors.push({ reason: "CSV data is empty." });
    return { entries: [], people: [], aircraft: [], importErrors, skippedUnchangedCount: 0 };
  }

  const headers = parseHeaderRow(rows[0]!);

  const people = new Map<string, ImportedPerson>();
  const aircraft = new Map<string, ImportedAircraft>();
  const entries: ImportedEntry[] = [];

  const dataRows = rows.slice(1);
  for (let index = 0; index < dataRows.length; index++) {
    const columns = parseCSVRow(dataRows[index]!);
    // Mirrors `guard columns.count == headers.count else { continue }`.
    if (columns.length !== headers.length) continue;

    addPersonIfNeeded(columns, headers, people);
    addAircraftIfNeeded(columns, headers, aircraft);

    const ctx: RowContext = { columns, headers, row: index, people, importErrors };
    const entry = isSimulatorEntry(columns, headers) ? createSimulatorEntry(ctx) : createFlightEntry(ctx);
    if (entry) {
      entry.sourceRow = index + 2;
      entries.push(entry);
    }
  }

  flagDuplicates(entries, importErrors);

  return {
    entries,
    people: [...people.values()],
    aircraft: [...aircraft.values()],
    importErrors,
    skippedUnchangedCount: 0
  };
}

export const safeLogImporter: Importer = {
  id: "safelog",
  displayName: "SafeLog export (tab-delimited CSV)",
  extensions: ["csv", "txt"],
  detect(buffer: Buffer, _filename: string | undefined): number {
    const text = buffer.toString("utf8");
    const firstLine = splitCSVIntoProperLines(text)[0] ?? "";
    if (firstLine.length === 0 || !firstLine.includes("\t")) return 0;
    const headers = parseHeaderRow(firstLine);
    // "Holder's Operating Capacity" and the day/night SE/ME split columns are
    // distinctive to SafeLog's EASA-style export; no other ported importer
    // uses this column shape.
    const hasSafeLogShape =
      headers.includes("Holder's Operating Capacity") &&
      headers.includes("Day Single-Engine (SE) in Command") &&
      headers.includes("Date");
    return hasSafeLogShape ? 0.8 : 0;
  },
  async parse(input: Buffer | string, _options?: ImporterOptions): Promise<ImportResult> {
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseSafeLogCsv(text);
  }
};
