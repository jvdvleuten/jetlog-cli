/**
 * Ported from the Jetlog iOS app's FlightLogger importer, FlightLogger's CSV export
 * (quoted-header comma-delimited, one file, no flight-number column).
 *
 * Scope cut vs. the iOS app (see `model.ts`'s file doc comment): every
 * existing-entry/person/aircraft lookup is skipped (no local store offline),
 * every row is produced brand-new. The iOS app's post-parse "most frequently imported
 * person -> remap onto the real signed-in user" step exists only to
 * reconcile the placeholder SELF person against the DB user; offline there
 * is no DB user to remap onto, so the placeholder SELF (`refId: "SELF"`)
 * is simply kept as every entry's SELF crew member throughout, the net
 * row-level behavior (one SELF per entry, correct role) is identical, this
 * port just skips the redundant remap step.
 *
 * `from`/`to` go through `canonicalCode` (src/airports) like the iOS
 * importer. In-file duplicate flagging runs
 * once at the end, same as the iOS app.
 */
import type { Importer, ImporterOptions } from "../importer.js";
import { canonicalCode } from "../../airports/index.js";
import { flagDuplicates } from "../duplicate-detector.js";
import {
  fstdDeviceCategoryFromFreeText,
  newImportedEntry,
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
import { colonDuration, timeOfDay } from "../time-parsing.js";
import { single, applyAuthoritativeTimes, type AuthoritativeTimeField } from "../authoritative-times.js";
import {
  applyAuthoritativeFlightBlockDuration,
  applyAuthoritativeFSTDSessionDuration,
  convertToBulkIfNeeded,
  normalizeImportedFlightManualTimes,
  retaggedLosslessPICUSRole
} from "../normalization.js";

const FLIGHTLOGGER_HEADERS = [
  "date",
  "departure_airport_name",
  "off_block",
  "arrival_airport_name",
  "on_block",
  "type_of_aircraft",
  "registration",
  "name_of_pilot_in_command",
  "total",
  "day",
  "night",
  "single_engine_vfr",
  "single_engine_ifr",
  "multi_engine_vfr",
  "multi_engine_ifr",
  "pilot_in_command_time",
  "co_pilot",
  "multi_pilot",
  "flight_instructor",
  "dual",
  "if_time",
  "synthetic_training",
  "instructor_synthetic_training",
  "landings_day",
  "landings_night",
  "remarks_and_endorsements",
  "include_in_ftl"
] as const;

// ---------------------------------------------------------------------------
// CSV tokenizing, own hand-rolled quote-aware parser, trims each column
// (unlike RBLogbook's).
// ---------------------------------------------------------------------------

function splitCSVIntoProperLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  const chars = Array.from(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '"') {
      if (inQuotes && chars[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function parseCSVRow(row: string): string[] {
  const columns: string[] = [];
  let current = "";
  let inQuotes = false;
  const chars = Array.from(row);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '"') {
      if (inQuotes && chars[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      columns.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  columns.push(current.trim());
  return columns;
}

function parseRows(text: string): { headers: string[]; rows: string[][] } {
  const lines = splitCSVIntoProperLines(text);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVRow(lines[0]!).map((h) => h.toLowerCase());
  return { headers, rows: lines.slice(1).map((l) => parseCSVRow(l)) };
}

function colIndex(headers: string[], name: string): number {
  return headers.indexOf(name);
}

function getValue(headers: string[], row: string[], name: string): string | undefined {
  const idx = colIndex(headers, name);
  if (idx < 0 || idx >= row.length) return undefined;
  const v = row[idx] ?? "";
  return v.length === 0 ? undefined : v;
}

function hasExplicitValue(headers: string[], row: string[], name: string): boolean {
  return getValue(headers, row, name) !== undefined;
}

/** Mirrors `parseDate`: tries `DD.MM.YYYY` first, falls back to `DD-MM-YYYY`. */
function parseFlightLoggerDate(raw: string): DateOnly | undefined {
  const trimmed = raw.trim();
  const sep = trimmed.includes(".") ? "." : trimmed.includes("-") ? "-" : undefined;
  if (!sep) return undefined;
  const parts = trimmed.split(sep).map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [day, month, year] = parts as [number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanRegistration(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Mirrors the PIC-name cleanup in `addPersonIfNeeded`: strips a leading
 * "N. " numeric-dot prefix, e.g. "1. NCL" -> "NCL". */
function cleanPicName(raw: string): string {
  return raw.replace(/^\d+\.\s*/, "").trim();
}

function upsertCrew(crew: ImportedEntryCrewMember[], member: ImportedEntryCrewMember): void {
  const idx = crew.findIndex((c) => c.refId === member.refId);
  if (idx >= 0) crew[idx] = member;
  else crew.push(member);
}

/** Mirrors `isSimulatorEntry`. */
function isSimulatorEntry(headers: string[], row: string[]): boolean {
  if (hasExplicitValue(headers, row, "synthetic_training")) return true;
  const type = (getValue(headers, row, "type_of_aircraft") ?? "").toUpperCase();
  const isFstdType = type.includes("FNPT") || type.includes("FTD") || type.includes("SIM");
  const hasNoRoute = !hasExplicitValue(headers, row, "departure_airport_name") && !hasExplicitValue(headers, row, "arrival_airport_name");
  return isFstdType && hasNoRoute;
}

/** Mirrors `determineHolderRole`, note the default fallback is PIC, unlike RBLogbook's CP. */
function determineHolderRole(headers: string[], row: string[]): EntryPersonRole {
  if (colonDuration(getValue(headers, row, "flight_instructor")) > 0) return "FI";
  if (colonDuration(getValue(headers, row, "pilot_in_command_time")) > 0) return "PIC";
  if (colonDuration(getValue(headers, row, "co_pilot")) > 0) return "CP";
  if (colonDuration(getValue(headers, row, "dual")) > 0) return "STU";
  return "PIC";
}

function determineFSTDRole(headers: string[], row: string[]): EntryPersonRole {
  return colonDuration(getValue(headers, row, "instructor_synthetic_training")) > 0 ? "FSTD_INS" : "FSTD_TRN";
}

const AUTHORITATIVE_FLIGHT_TIME_FIELDS: AuthoritativeTimeField[] = [
  single("pilot_in_command_time", "pilotInCommand"),
  single("co_pilot", "coPilot"),
  single("dual", "dual"),
  single("flight_instructor", "instructor"),
  single("night", "night"),
  single("if_time", "ifr")
];

const AUTHORITATIVE_FSTD_TIME_FIELDS: AuthoritativeTimeField[] = [single("synthetic_training", "fstdSession")];

function colonLookup(headers: string[], row: string[]): (column: string) => Time | undefined {
  return (column) => {
    if (!hasExplicitValue(headers, row, column)) return undefined;
    return { totalMinutes: colonDuration(getValue(headers, row, column)) };
  };
}

// ---------------------------------------------------------------------------
// People / aircraft
// ---------------------------------------------------------------------------

function ensureSelfPerson(people: Map<string, ImportedPerson>): void {
  if (people.has("SELF")) return;
  people.set("SELF", { refId: "SELF", defaultRole: "PIC", isExisting: { existing: false }, isImportedFromOtherLogbook: true });
}

function addPersonIfNeeded(headers: string[], row: string[], people: Map<string, ImportedPerson>): void {
  ensureSelfPerson(people);
  const picRaw = getValue(headers, row, "name_of_pilot_in_command");
  if (!picRaw) return;
  const cleaned = cleanPicName(picRaw);
  if (cleaned.length === 0 || people.has(cleaned)) return;
  const [firstName, ...rest] = cleaned.split(/\s+/);
  people.set(cleaned, {
    refId: cleaned,
    firstName,
    lastName: rest.join(" ") || undefined,
    isExisting: { existing: false },
    isImportedFromOtherLogbook: true
  });
}

function addAircraftIfNeeded(headers: string[], row: string[], aircraft: Map<string, ImportedAircraft>): void {
  const cleaned = cleanRegistration(getValue(headers, row, "registration"));
  if (!cleaned || aircraft.has(cleaned)) return;
  aircraft.set(cleaned, { registration: cleaned, isImportedFromOtherLogbook: true });
}

// ---------------------------------------------------------------------------
// Row -> entry
// ---------------------------------------------------------------------------

function createFlightEntry(headers: string[], row: string[], people: Map<string, ImportedPerson>, importErrors: ImportError[]): ImportedEntry | undefined {
  const dateRaw = getValue(headers, row, "date");
  if (dateRaw === undefined) {
    importErrors.push({ reason: "Unexpected header: missing date column" });
    return undefined;
  }
  const date = parseFlightLoggerDate(dateRaw);
  if (date === undefined) {
    importErrors.push({ reason: `Incorrect date format: ${dateRaw}`, dateString: dateRaw });
    return undefined;
  }

  const registration = getValue(headers, row, "registration");
  const rawFrom = getValue(headers, row, "departure_airport_name");
  const rawTo = getValue(headers, row, "arrival_airport_name");
  const from = rawFrom ? canonicalCode(rawFrom) ?? rawFrom : rawFrom;
  const to = rawTo ? canonicalCode(rawTo) ?? rawTo : rawTo;
  const offBlocks = timeOfDay(getValue(headers, row, "off_block"));
  const onBlocks = timeOfDay(getValue(headers, row, "on_block"));
  const blockMinutes = colonDuration(getValue(headers, row, "total"));
  const landingsDay = Number.parseInt(getValue(headers, row, "landings_day") ?? "0", 10) || 0;
  const landingsNight = Number.parseInt(getValue(headers, row, "landings_night") ?? "0", 10) || 0;
  const takeoffsAndLandings: TakeoffsAndLandings = {
    type: "manual",
    takeoffsDay: landingsDay > 0 ? 1 : 0,
    takeoffsNight: landingsNight > 0 ? 1 : 0,
    landingsDay,
    landingsNight
  };

  const remarks = truncatedRemarks(getValue(headers, row, "remarks_and_endorsements"), importErrors, { dateString: dateRaw, registration });
  const updateFlightData = offBlocks === undefined && onBlocks === undefined;

  const entry = newImportedEntry({
    date,
    type: "flight",
    registration: cleanRegistration(registration),
    from,
    to,
    offBlocks,
    onBlocks,
    updateFlightData,
    takeoffsAndLandings,
    isImportedFromOtherLogbook: true,
    remarks
  });

  const holderRole = determineHolderRole(headers, row);
  upsertCrew(entry.crew, { refId: "SELF", role: holderRole });
  const picName = getValue(headers, row, "name_of_pilot_in_command");
  if (picName && (holderRole === "STU" || holderRole === "CP")) {
    const cleaned = cleanPicName(picName);
    if (people.has(cleaned)) upsertCrew(entry.crew, { refId: cleaned, role: "PIC" });
  }

  if (!entry.registration) {
    importErrors.push({ code: "registrationMissing", reason: "Registration missing", dateString: dateRaw, registration, entryId: entry.id });
  }
  if (!from) {
    importErrors.push({ code: "originAirportMissing", reason: "Origin airport missing", dateString: dateRaw, registration, entryId: entry.id });
  }
  if (!to) {
    importErrors.push({ code: "destinationAirportMissing", reason: "Destination airport missing", dateString: dateRaw, registration, entryId: entry.id });
  }

  applyAuthoritativeFlightBlockDuration(entry, blockMinutes > 0 ? blockMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeTimes(AUTHORITATIVE_FLIGHT_TIME_FIELDS, colonLookup(headers, row), entry);

  const resolvedSelfRole = retaggedLosslessPICUSRole(entry, holderRole);
  if (resolvedSelfRole !== undefined && resolvedSelfRole !== holderRole) {
    upsertCrew(entry.crew, { refId: "SELF", role: resolvedSelfRole });
  }
  normalizeImportedFlightManualTimes(entry, resolvedSelfRole);

  return entry;
}

function createSimulatorEntry(headers: string[], row: string[], importErrors: ImportError[]): ImportedEntry | undefined {
  const dateRaw = getValue(headers, row, "date");
  if (dateRaw === undefined) {
    importErrors.push({ reason: "Unexpected header: missing date column" });
    return undefined;
  }
  const date = parseFlightLoggerDate(dateRaw);
  if (date === undefined) {
    importErrors.push({ reason: `Incorrect date format: ${dateRaw}`, dateString: dateRaw });
    return undefined;
  }

  const aircraftType = getValue(headers, row, "type_of_aircraft") ?? "";
  const registration = getValue(headers, row, "registration") ?? "";
  const fstdId = aircraftType.length > 0 ? aircraftType : registration || undefined;
  const deviceCategoryHint = aircraftType.length > 0 ? fstdDeviceCategoryFromFreeText(aircraftType) : undefined;

  const startTime = timeOfDay(getValue(headers, row, "off_block"));
  const endTime = timeOfDay(getValue(headers, row, "on_block"));
  const sessionMinutes = colonDuration(getValue(headers, row, "synthetic_training"));

  const remarks = truncatedRemarks(getValue(headers, row, "remarks_and_endorsements"), importErrors, { dateString: dateRaw });

  const entry = newImportedEntry({ date, type: "fstd", fstdId, startTime, endTime, isImportedFromOtherLogbook: true, remarks });
  entry.fstdDeviceCategory = deviceCategoryHint;

  if (!fstdId) {
    importErrors.push({ code: "fstdIdentifierMissing", reason: "FSTD identifier missing", dateString: dateRaw, entryId: entry.id });
  }

  upsertCrew(entry.crew, { refId: "SELF", role: determineFSTDRole(headers, row) });

  applyAuthoritativeFSTDSessionDuration(entry, sessionMinutes > 0 ? sessionMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeTimes(AUTHORITATIVE_FSTD_TIME_FIELDS, colonLookup(headers, row), entry, false);

  return entry;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

export function parseFlightLoggerCsv(csvText: string): ImportResult {
  const importErrors: ImportError[] = [];
  const { headers, rows } = parseRows(csvText);
  if (headers.length === 0) {
    importErrors.push({ reason: "CSV data is empty." });
    return { entries: [], people: [], aircraft: [], importErrors, skippedUnchangedCount: 0 };
  }

  const people = new Map<string, ImportedPerson>();
  const aircraft = new Map<string, ImportedAircraft>();
  const entries: ImportedEntry[] = [];

  for (const [rowIndex, row] of rows.entries()) {
    if (row.every((c) => c.length === 0)) continue;
    addPersonIfNeeded(headers, row, people);
    const simulator = isSimulatorEntry(headers, row);
    if (!simulator) addAircraftIfNeeded(headers, row, aircraft);

    const entry = simulator ? createSimulatorEntry(headers, row, importErrors) : createFlightEntry(headers, row, people, importErrors);
    if (entry) {
      entry.sourceRow = rowIndex + 2;
      entries.push(entry);
    }
  }

  flagDuplicates(entries, importErrors);

  return { entries, people: [...people.values()], aircraft: [...aircraft.values()], importErrors, skippedUnchangedCount: 0 };
}

export const flightLoggerImporter: Importer = {
  id: "flightlogger",
  displayName: "FlightLogger export (CSV)",
  extensions: ["csv"],
  /** Content sniffing, not a port of existing iOS logic (see `importer.ts`'s
   * file doc comment); FlightLogger has no flight-number column and uses
   * `off_block`/`on_block`/`total`/`synthetic_training`, a fairly distinctive
   * shape vs. the other CSV-ish importers. */
  detect(buffer: Buffer): number {
    const { headers } = parseRows(buffer.toString("utf8"));
    const required: Array<(typeof FLIGHTLOGGER_HEADERS)[number]> = [
      "date",
      "departure_airport_name",
      "off_block",
      "arrival_airport_name",
      "on_block",
      "registration"
    ];
    return required.every((h) => headers.includes(h)) ? 0.8 : 0;
  },
  async parse(input: Buffer | string, _options?: ImporterOptions): Promise<ImportResult> {
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseFlightLoggerCsv(text);
  }
};
