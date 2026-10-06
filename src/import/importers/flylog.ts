/**
 * Ported from the Jetlog iOS app's Flylog importer (Flylog logbook app exports).
 *
 * Flylog is a single comma-delimited CSV schema with fixed, case-sensitive
 * UPPERCASE headers: `DATE`, `AIRCRAFT_TYPE`, `AIRCRAFT_REGISTRATION`,
 * `DEPARTURE_AIRPORT`, `ARRIVAL_AIRPORT`, `TIME_BLOCK_START`/`TIME_BLOCK_END`,
 * `TIME_TAKEOFF`/`TIME_LANDING`, `DURATION_BLOCK`, `FLIGHT_NUMBER`,
 * `TAKEOFFS_DAY`/`TAKEOFFS_NIGHT`/`LDGS_DAY`/`LDGS_NIGHT`, `REMARKS`,
 * `PERSONAL_NOTE`, a `DURATION_*` column per pilot function (`PIC`/`SIC`/
 * `PICUS`/`DUAL`/`INSTRUCTOR`/`EXAMINER`/`NIGHT`/`IFR`/`XC`/`MULTI_PILOT`),
 * a `NAME_*` column per named crew role (`PIC`/`COPILOT`/`INSTRUCTOR`/
 * `EXAMINER`/`STUDENT`), and `DURATION_SIMULATOR` for FSTD rows. A row is an
 * FSTD session when `AIRCRAFT_TYPE` (uppercased) is exactly `"SIM"`; unlike
 * PilotLog there's no free-text/structural simulator-detection fallback.
 * Dates are strict `YYYY-MM-DD` only (no European `DD-MM-YYYY` variant).
 *
 * ## Not ported (no local store offline, see `model.ts`)
 *
 * Every existing-entry/person/aircraft and stored-user lookup
 * in the iOS importer is skipped: there is no local database to match
 * an existing entry, person, or aircraft against. Concretely:
 *  - Every row is produced as brand-new (`isExisting: { existing: false }`).
 *  - `addPersonIfNeeded`'s stored-user branch (seeding "SELF" from
 *    the stored user person) always fails offline; "SELF" is produced
 *    with the iOS app's own fallback shape (`defaultRole: "PIC"`,
 *    `isImportedFromOtherLogbook: true`) every time.
 *  - Named crew (`NAME_PIC`/`NAME_COPILOT`/...) never match an existing
 *    person; every named crew member is produced
 *    as new, keyed by their raw cell text.
 *  - IATA->ICAO airport code conversion
 *    is backed by the airport resolver (logged-in catalog only, none offline) in `../../airports/index.js`
 *    (`canonicalCode`): `from`/`to` resolve to ICAO for a known IATA
 *    code, otherwise pass through unchanged, same as `deeplink-json.ts`/
 *    `logten.ts`/`pilotlog.ts`.
 *  - `addAircraftIfNeeded`'s existing-aircraft lookup is skipped;
 *    every aircraft not already seen in this file is produced as new.
 *
 * ## The top-level "most frequent person" remap, also skipped, and why it's a no-op offline
 *
 * The iOS importer has a second pass after parsing: it finds
 * the crew `refId` appearing in the most entries (presumed to be the
 * logbook holder), and if the stored user person can be fetched,
 * re-keys that `refId` to the real stored user `Person` and re-checks every
 * entry for a `roleMissingFlight`/`roleMissingSimulator` error. That whole
 * block is gated on that fetch succeeding, which, per the point
 * above, never happens offline, so it's skipped entirely here. This isn't
 * a behavior change in practice: `addFlightCrew`/`addSimulatorCrew` (ported
 * below) always add "SELF" to every row's crew unconditionally (Flylog, in
 * contrast to PilotLog, has no blank/missing-pilot-slot case, every row
 * carries real duration/name columns for the holder), so the
 * `roleMissingFlight`/`roleMissingSimulator` codes this importer could in
 * principle emit never actually fire.
 */
import type { Importer, ImporterOptions } from "../importer.js";
import { canonicalCode } from "../../airports/index.js";
import { flagDuplicates } from "../duplicate-detector.js";
import {
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
import { colonDuration, timeOfDay } from "../time-parsing.js";
import { single, applyAuthoritativeTimes, type AuthoritativeTimeField } from "../authoritative-times.js";
import {
  applyAuthoritativeFlightBlockDuration,
  applyAuthoritativeFSTDSessionDuration,
  convertToBulkIfNeeded,
  normalizeImportedFlightManualTimes,
  retaggedLosslessPICUSRole
} from "../normalization.js";

// ---------------------------------------------------------------------------
// CSV tokenizing, ported from the iOS app's hand-rolled parser
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

/** Mirrors `parseCSVRow`, comma-delimited only; unlike PilotLog's tokenizer,
 * each column is trimmed of surrounding whitespace. */
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
    if (char === "," && !inQuotes) {
      columns.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  columns.push(current.trim());
  return columns;
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

/** Mirrors `getValue`, `undefined` for a missing header or a blank cell. */
function getValue(name: string, columns: string[], headers: string[]): string | undefined {
  const idx = headers.indexOf(name);
  if (idx < 0 || idx >= columns.length) return undefined;
  const value = columns[idx]!;
  return value.length === 0 ? undefined : value;
}

/** Mirrors `hasExplicitValue`. */
function hasExplicitValue(name: string, columns: string[], headers: string[]): boolean {
  const idx = headers.indexOf(name);
  return idx >= 0 && idx < columns.length && columns[idx]!.length > 0;
}

function parseDuration(raw: string | undefined): number {
  return colonDuration(raw);
}

function parseTime(raw: string | undefined): Time | undefined {
  return timeOfDay(raw);
}

function getDuration(name: string, columns: string[], headers: string[]): number {
  return parseDuration(getValue(name, columns, headers));
}

/** Mirrors `manualDurationIfPresent`. */
function manualDurationIfPresent(name: string, columns: string[], headers: string[]): Time | undefined {
  if (!hasExplicitValue(name, columns, headers)) return undefined;
  return time(getDuration(name, columns, headers));
}

// ---------------------------------------------------------------------------
// FSTD detection
// ---------------------------------------------------------------------------

/** Mirrors `isSimulatorEntry`, `AIRCRAFT_TYPE` (uppercased) exactly `"SIM"`,
 * no free-text/structural fallback (unlike PilotLog). */
function isSimulatorEntry(columns: string[], headers: string[]): boolean {
  const aircraftType = getValue("AIRCRAFT_TYPE", columns, headers) ?? "";
  return aircraftType.toUpperCase() === "SIM";
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/** Mirrors `parseDate`, strict `YYYY-MM-DD` only. */
function parseFlylogDate(raw: string | undefined): DateOnly | undefined {
  if (!raw || raw.length === 0) return undefined;
  const components = raw.split("-");
  if (components.length !== 3) return undefined;
  const year = Number.parseInt(components[0]!, 10);
  const month = Number.parseInt(components[1]!, 10);
  const day = Number.parseInt(components[2]!, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

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

// ---------------------------------------------------------------------------
// Role determination
// ---------------------------------------------------------------------------

/** Mirrors `determineHolderRole`: duration columns first (priority order
 * examiner > instructor > PIC > PICUS > SIC > dual), then a name-column
 * fallback when every duration column is blank/zero. */
function determineHolderRole(columns: string[], headers: string[]): EntryPersonRole {
  const picTime = getDuration("DURATION_PIC", columns, headers);
  const sicTime = getDuration("DURATION_SIC", columns, headers);
  const picusTime = getDuration("DURATION_PICUS", columns, headers);
  const dualTime = getDuration("DURATION_DUAL", columns, headers);
  const instructorTime = getDuration("DURATION_INSTRUCTOR", columns, headers);
  const examinerTime = getDuration("DURATION_EXAMINER", columns, headers);

  if (examinerTime > 0) return "FE";
  if (instructorTime > 0) return "FI";
  if (picTime > 0) return "PIC";
  if (picusTime > 0) return "PICUS";
  if (sicTime > 0) return "CP";
  if (dualTime > 0) return "STU";

  const namePIC = getValue("NAME_PIC", columns, headers);
  const nameCopilot = getValue("NAME_COPILOT", columns, headers);
  const nameInstructor = getValue("NAME_INSTRUCTOR", columns, headers);
  const nameExaminer = getValue("NAME_EXAMINER", columns, headers);
  const nameStudent = getValue("NAME_STUDENT", columns, headers);

  if (namePIC !== undefined && nameCopilot === undefined && nameInstructor === undefined && nameExaminer === undefined) return "CP";
  if (nameCopilot !== undefined && namePIC === undefined) return "PIC";
  if (nameInstructor !== undefined) return "STU";
  if (nameStudent !== undefined) return "FI";
  if (nameExaminer !== undefined) return "STU";

  return "PIC";
}

/** Mirrors `determineFSTDRole`. */
function determineFSTDRole(columns: string[], headers: string[]): EntryPersonRole {
  const instructorTime = getDuration("DURATION_INSTRUCTOR", columns, headers);
  const examinerTime = getDuration("DURATION_EXAMINER", columns, headers);
  if (examinerTime > 0) return "FSTD_EXA";
  if (instructorTime > 0) return "FSTD_INS";
  return "FSTD_TRN";
}

// ---------------------------------------------------------------------------
// Authoritative flight time fields
// ---------------------------------------------------------------------------

const AUTHORITATIVE_FLIGHT_TIME_FIELDS: AuthoritativeTimeField[] = [
  single("DURATION_PIC", "pilotInCommand"),
  single("DURATION_SIC", "coPilot"),
  single("DURATION_PICUS", "picus"),
  single("DURATION_DUAL", "dual"),
  single("DURATION_INSTRUCTOR", "instructor"),
  single("DURATION_EXAMINER", "examiner"),
  single("DURATION_NIGHT", "night"),
  single("DURATION_IFR", "ifr"),
  single("DURATION_XC", "crossCountry"),
  single("DURATION_MULTI_PILOT", "multiPilot")
];

function applyAuthoritativeFlightTimes(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FLIGHT_TIME_FIELDS, (column) => manualDurationIfPresent(column, columns, headers), entry);
}

// ---------------------------------------------------------------------------
// Session-type matching (REMARKS -> a predefined FSTD session type)
// ---------------------------------------------------------------------------

const PREDEFINED_SESSION_TYPES = ["LPC", "OPC", "LPC/OPC", "Type Recurrent", "LOE", "ZFT", "LOFT"];

/** Mirrors `matchSessionType`: best-effort extraction of a recognized FSTD
 * session type from free-text remarks, matched against the picker's own
 * preset list (case-insensitive), with a few extra common abbreviations. */
function matchSessionType(remarks: string | undefined): string | undefined {
  if (!remarks || remarks.length === 0) return undefined;
  const upper = remarks.toUpperCase();

  if (upper.includes("LPC") && upper.includes("OPC")) return "LPC/OPC";
  if (upper.includes("FCL") && upper.includes("OPC")) return "LPC/OPC";

  for (const preset of PREDEFINED_SESSION_TYPES) {
    if (upper.includes(preset.toUpperCase())) return preset;
  }

  if (upper.includes("PC") && !upper.includes("OPC") && !upper.includes("LPC")) return "LPC";
  if (upper.includes("FCL")) return "LPC";
  if (upper.includes("TYPE RECURRENT") || upper.startsWith("TR1") || upper.startsWith("TR2")) return "Type Recurrent";
  if (upper.includes("LOE")) return "LOE";

  return undefined;
}

// ---------------------------------------------------------------------------
// Name parsing
// ---------------------------------------------------------------------------

/** Initials pattern, e.g. "T.M.Eriksson", "P. Tjittes". */
const INITIALS_REGEX = /^((?:[A-Za-z]\.)+)\s*(.+)$/;

/**
 * Mirrors `parseFlylogName`. Examples: "O.Ronning" -> ("O.", "Ronning");
 * "T.M.Eriksson" -> ("T.M.", "Eriksson"); "P. Tjittes" -> ("P.", "Tjittes");
 * "John Smith" -> ("John", "Smith"); a single word is treated as a last name.
 */
export function parseFlylogName(name: string): { firstName?: string; lastName?: string } {
  const trimmed = name.trim();
  if (trimmed.length === 0) return {};

  const initialsMatch = INITIALS_REGEX.exec(trimmed);
  if (initialsMatch) {
    return { firstName: initialsMatch[1], lastName: initialsMatch[2] };
  }

  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace >= 0) {
    const firstName = trimmed.slice(0, lastSpace);
    const lastName = trimmed.slice(lastSpace + 1);
    return { firstName: firstName.length > 0 ? firstName : undefined, lastName: lastName.length > 0 ? lastName : undefined };
  }

  return { lastName: trimmed };
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

const NAME_CREW_COLUMNS: Array<{ header: string; defaultRole: EntryPersonRole }> = [
  { header: "NAME_PIC", defaultRole: "PIC" },
  { header: "NAME_COPILOT", defaultRole: "CP" },
  { header: "NAME_INSTRUCTOR", defaultRole: "FI" },
  { header: "NAME_EXAMINER", defaultRole: "FE" },
  { header: "NAME_STUDENT", defaultRole: "STU" }
];

/** Mirrors `addPersonIfNeeded`: "SELF" is always present (the
 * `fetchUserPerson` branch never succeeds offline, see the file doc
 * comment), plus a new `ImportedPerson` per distinct, not-yet-seen name
 * cell across the `NAME_*` columns. */
function addPersonIfNeeded(columns: string[], headers: string[], people: Map<string, ImportedPerson>): void {
  ensureSelfPerson(people);

  for (const { header, defaultRole } of NAME_CREW_COLUMNS) {
    const name = getValue(header, columns, headers);
    if (name === undefined || people.has(name)) continue;

    const { firstName, lastName } = parseFlylogName(name);
    people.set(name, {
      refId: name,
      firstName,
      lastName,
      defaultRole,
      isExisting: { existing: false },
      isImportedFromOtherLogbook: true
    });
  }
}

function addAircraftIfNeeded(columns: string[], headers: string[], aircraft: Map<string, ImportedAircraft>): void {
  const registration = getValue("AIRCRAFT_REGISTRATION", columns, headers) ?? "";
  const cleaned = cleanRegistration(registration);
  if (!cleaned || aircraft.has(cleaned)) return;
  const icaoCode = getValue("AIRCRAFT_TYPE", columns, headers);
  aircraft.set(cleaned, { registration: cleaned, icaoCode, isImportedFromOtherLogbook: true });
}

// ---------------------------------------------------------------------------
// Crew assignment
// ---------------------------------------------------------------------------

/** Mirrors `addFlightCrew`: "SELF" always gets the determined holder role; a
 * named crew column only contributes a crew row when its fixed role isn't
 * the same as the holder's own role (avoids attributing the holder's own
 * seat twice under two different names). */
function addFlightCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  const holderRole = determineHolderRole(columns, headers);
  upsertCrew(entry.crew, { refId: "SELF", role: holderRole });

  for (const { header, defaultRole } of NAME_CREW_COLUMNS) {
    if (holderRole === defaultRole) continue;
    const name = getValue(header, columns, headers);
    if (name === undefined) continue;
    const person = people.get(name);
    if (person) upsertCrew(entry.crew, { refId: person.refId, role: defaultRole });
  }
}

/** Mirrors `addSimulatorCrew`: "SELF" always gets the determined FSTD role;
 * when SELF is a trainee, a `NAME_PIC` cell is additionally credited as the
 * session's FSTD instructor. */
function addSimulatorCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  const fstdRole = determineFSTDRole(columns, headers);
  upsertCrew(entry.crew, { refId: "SELF", role: fstdRole });

  if (fstdRole === "FSTD_TRN") {
    const picName = getValue("NAME_PIC", columns, headers);
    const person = picName !== undefined ? people.get(picName) : undefined;
    if (person) upsertCrew(entry.crew, { refId: person.refId, role: "FSTD_INS" });
  }
}

// ---------------------------------------------------------------------------
// Remarks
// ---------------------------------------------------------------------------

/** Mirrors the `REMARKS`/`PERSONAL_NOTE` combine-with-"; "-separator shared
 * by both row kinds. */
function combinedRemarks(columns: string[], headers: string[]): string | undefined {
  const parts = [getValue("REMARKS", columns, headers), getValue("PERSONAL_NOTE", columns, headers)].filter(
    (s): s is string => s !== undefined
  );
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// ---------------------------------------------------------------------------
// Row -> entry
// ---------------------------------------------------------------------------

function createFlightEntry(
  columns: string[],
  headers: string[],
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[]
): ImportedEntry | undefined {
  const dateString = getValue("DATE", columns, headers);
  const date = parseFlylogDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: `Incorrect date format: ${dateString ?? ""}`, dateString });
    return undefined;
  }

  const registration = getValue("AIRCRAFT_REGISTRATION", columns, headers) ?? "";
  const from = canonicalCode(getValue("DEPARTURE_AIRPORT", columns, headers)) ?? "";
  const to = canonicalCode(getValue("ARRIVAL_AIRPORT", columns, headers)) ?? "";
  const offBlocks = parseTime(getValue("TIME_BLOCK_START", columns, headers));
  const onBlocks = parseTime(getValue("TIME_BLOCK_END", columns, headers));
  const airborne = parseTime(getValue("TIME_TAKEOFF", columns, headers));
  const touchdown = parseTime(getValue("TIME_LANDING", columns, headers));
  const blockMinutes = getDuration("DURATION_BLOCK", columns, headers);
  const flightNumber = getValue("FLIGHT_NUMBER", columns, headers);

  const takeoffsDay = Number.parseInt(getValue("TAKEOFFS_DAY", columns, headers) ?? "", 10) || 0;
  const takeoffsNight = Number.parseInt(getValue("TAKEOFFS_NIGHT", columns, headers) ?? "", 10) || 0;
  const landingsDay = Number.parseInt(getValue("LDGS_DAY", columns, headers) ?? "", 10) || 0;
  const landingsNight = Number.parseInt(getValue("LDGS_NIGHT", columns, headers) ?? "", 10) || 0;
  const takeoffsAndLandings: TakeoffsAndLandings = { type: "manual", takeoffsDay, takeoffsNight, landingsDay, landingsNight };

  const remarks = truncatedRemarks(combinedRemarks(columns, headers), importErrors, {
    dateString: date,
    flightNumber,
    registration
  });

  const updateFlightData = offBlocks === undefined && onBlocks === undefined;

  const entry = newImportedEntry({
    date,
    type: "flight",
    flightNumber,
    registration: cleanRegistration(registration),
    from: from || undefined,
    to: to || undefined,
    offBlocks,
    airborne,
    touchdown,
    onBlocks,
    updateFlightData,
    takeoffsAndLandings,
    isImportedFromOtherLogbook: true,
    remarks
  });

  addFlightCrew(columns, headers, people, entry);

  if (!entry.registration) {
    importErrors.push({
      code: "registrationMissing",
      reason: "Registration missing",
      dateString: date,
      flightNumber,
      registration,
      entryId: entry.id
    });
  }
  if (from.length === 0) {
    importErrors.push({
      code: "originAirportMissing",
      reason: "Origin airport missing",
      dateString: date,
      flightNumber,
      registration,
      entryId: entry.id
    });
  }
  if (to.length === 0) {
    importErrors.push({
      code: "destinationAirportMissing",
      reason: "Destination airport missing",
      dateString: date,
      flightNumber,
      registration,
      entryId: entry.id
    });
  }

  applyAuthoritativeFlightBlockDuration(entry, blockMinutes > 0 ? blockMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFlightTimes(columns, headers, entry);

  const selfRole = entry.crew.find((c) => c.refId === "SELF")?.role;
  const resolvedSelfRole = retaggedLosslessPICUSRole(entry, selfRole);
  if (resolvedSelfRole !== undefined && resolvedSelfRole !== selfRole) {
    upsertCrew(entry.crew, { refId: "SELF", role: resolvedSelfRole });
  }
  normalizeImportedFlightManualTimes(entry, resolvedSelfRole);

  return entry;
}

function createSimulatorEntry(
  columns: string[],
  headers: string[],
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[]
): ImportedEntry | undefined {
  const dateString = getValue("DATE", columns, headers);
  const date = parseFlylogDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: `Incorrect date format: ${dateString ?? ""}`, dateString });
    return undefined;
  }

  const fstdId = getValue("AIRCRAFT_REGISTRATION", columns, headers);
  const startTime = parseTime(getValue("TIME_BLOCK_START", columns, headers));
  const endTime = parseTime(getValue("TIME_BLOCK_END", columns, headers));
  const sessionMinutes = getDuration("DURATION_SIMULATOR", columns, headers);
  const sessionType = matchSessionType(getValue("REMARKS", columns, headers));

  const remarks = truncatedRemarks(combinedRemarks(columns, headers), importErrors, { dateString: date });

  const entry = newImportedEntry({
    date,
    type: "fstd",
    fstdId,
    sessionType,
    startTime,
    endTime,
    updateFlightData: false,
    isImportedFromOtherLogbook: true,
    remarks
  });

  addSimulatorCrew(columns, headers, people, entry);

  if (!fstdId || fstdId.length === 0) {
    importErrors.push({
      code: "fstdIdentifierMissing",
      reason: "FSTD identifier missing",
      dateString: date,
      entryId: entry.id
    });
  }

  applyAuthoritativeFSTDSessionDuration(entry, sessionMinutes > 0 ? sessionMinutes : undefined);
  convertToBulkIfNeeded(entry);

  return entry;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

const REQUIRED_HEADERS = ["DATE", "AIRCRAFT_TYPE"];

/** Parses Flylog CSV content into an `ImportResult`. */
export function parseFlylogCsv(csvText: string): ImportResult {
  const importErrors: ImportError[] = [];
  const rows = splitCSVIntoProperLines(csvText);

  if (rows.length === 0) {
    importErrors.push({ reason: "CSV data is empty." });
    return { entries: [], people: [], aircraft: [], importErrors, skippedUnchangedCount: 0 };
  }

  const headers = parseCSVRow(rows[0]!);
  const missingHeader = REQUIRED_HEADERS.find((h) => !headers.includes(h));
  if (missingHeader !== undefined) {
    importErrors.push({
      reason: `Unexpected header: ${missingHeader} not found. Available headers: ${headers.slice(0, 10).join(", ")}`
    });
    return { entries: [], people: [], aircraft: [], importErrors, skippedUnchangedCount: 0 };
  }

  const people = new Map<string, ImportedPerson>();
  const aircraft = new Map<string, ImportedAircraft>();
  const entries: ImportedEntry[] = [];

  const dataRows = rows.slice(1);
  for (const [rowIndex, row] of dataRows.entries()) {
    const columns = parseCSVRow(row);
    if (columns.length < 2) continue;

    addPersonIfNeeded(columns, headers, people);

    const isSim = isSimulatorEntry(columns, headers);
    if (!isSim) addAircraftIfNeeded(columns, headers, aircraft);

    const entry = isSim
      ? createSimulatorEntry(columns, headers, people, importErrors)
      : createFlightEntry(columns, headers, people, importErrors);
    if (entry) {
      entry.sourceRow = rowIndex + 2;
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

export const flylogImporter: Importer = {
  id: "flylog",
  displayName: "Flylog export (CSV)",
  extensions: ["csv"],
  detect(buffer: Buffer, _filename: string | undefined): number {
    const text = buffer.toString("utf8");
    const firstLine = splitCSVIntoProperLines(text)[0] ?? "";
    if (firstLine.length === 0) return 0;
    const headers = parseCSVRow(firstLine);
    const hasRequired = REQUIRED_HEADERS.every((h) => headers.includes(h));
    const hasFlylogShape = headers.includes("AIRCRAFT_REGISTRATION") && headers.includes("DEPARTURE_AIRPORT");
    return hasRequired && hasFlylogShape ? 0.75 : 0;
  },
  async parse(input: Buffer | string, _options?: ImporterOptions): Promise<ImportResult> {
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseFlylogCsv(text);
  }
};
