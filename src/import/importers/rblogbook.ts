/**
 * Ported from the Jetlog iOS app's RB Logbook importer, RosterBuster/"RB Logbook" exports.
 *
 * RB Logbook exports up to three separate CSV files: `rb_logbook_flights.csv`
 * (required), `rb_logbook_aircraft.csv` and `rb_logbook_people.csv` (both
 * optional enrichment). The iOS app identifies each by content sniffing
 * (first ~500 chars, substring containment, not header equality) rather than
 * filename, and this port mirrors that exactly (`identifyFile`). This CLI's
 * `parse()` takes a single `Buffer | string` per the `Importer` interface, so
 * multi-file RB imports go through `parseRBLogbookFiles` (several texts in
 * one call) instead, `--from rblogbook` on a single flights-only file still
 * works via the registered `Importer.parse`.
 *
 * Scope cut vs. the iOS app (see `model.ts`'s file doc comment for the
 * general "no local store offline" rule): every existing-entry/person/aircraft
 * DB match is skipped, every row is
 * produced brand-new. The stored-user fetch is skipped too (SELF seeded as a
 * bare placeholder person). `from`/`to` go through `canonicalCode`
 * (src/airports), like the iOS app.
 *
 * In-file duplicate flagging runs once at the very end, same
 * as the iOS app.
 */
import type { Importer, ImporterOptions } from "../importer.js";
import { canonicalCode } from "../../airports/index.js";
import { flagDuplicates } from "../duplicate-detector.js";
import {
  emptyImportResult,
  newImportedEntry,
  truncatedRemarks,
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
import { strictTimeOfDay } from "../time-parsing.js";
import { single, applyAuthoritativeTimes, type AuthoritativeTimeField } from "../authoritative-times.js";
import {
  applyAuthoritativeFlightBlockDuration,
  applyAuthoritativeFSTDSessionDuration,
  convertToBulkIfNeeded,
  normalizeImportedFlightManualTimes,
  retaggedLosslessPICUSRole
} from "../normalization.js";

// ---------------------------------------------------------------------------
// CSV tokenizing, RB's own hand-rolled quote-aware parser (no column trim,
// unlike FlightLogger's).
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
      columns.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  columns.push(current);
  return columns;
}

function parseRows(text: string): { headers: string[]; rows: string[][] } {
  const lines = splitCSVIntoProperLines(text);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVRow(lines[0]!);
  return { headers, rows: lines.slice(1).map((l) => parseCSVRow(l)) };
}

// ---------------------------------------------------------------------------
// File-type content sniffing, mirrors `identifyFile(atPath:)`.
// ---------------------------------------------------------------------------

export type RBFileType = "flights" | "aircraft" | "people";

export function identifyRBFile(text: string): RBFileType | undefined {
  const head = text.slice(0, 500);
  if (head.includes("Duty Type") && head.includes("Departure") && head.includes("Arrival")) return "flights";
  if (head.includes("Registration") && head.includes("Manufacturer") && head.includes("Model")) return "aircraft";
  if (head.includes("First name") && head.includes("Last name") && head.includes("Function")) return "people";
  return undefined;
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

function colIndex(headers: string[], name: string): number {
  return headers.indexOf(name);
}

function getValue(headers: string[], columns: string[], name: string): string | undefined {
  const idx = colIndex(headers, name);
  if (idx < 0 || idx >= columns.length) return undefined;
  const v = columns[idx] ?? "";
  return v.length === 0 ? undefined : v;
}

function hasExplicitValue(headers: string[], columns: string[], name: string): boolean {
  return getValue(headers, columns, name) !== undefined;
}

function minutesIfPresent(headers: string[], columns: string[], name: string): number | undefined {
  if (!hasExplicitValue(headers, columns, name)) return undefined;
  const n = Number.parseInt(getValue(headers, columns, name)!, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntOr0(headers: string[], columns: string[], name: string): number {
  const v = getValue(headers, columns, name);
  if (v === undefined) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function cleanRegistration(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

// ---------------------------------------------------------------------------
// Aircraft / people lookups (from the optional aircraft/people CSVs)
// ---------------------------------------------------------------------------

interface RBAircraftData {
  aircraftGroup?: string;
  isSimulator: boolean;
}

function parseAircraftCsv(text: string): Map<string, RBAircraftData> {
  const { headers, rows } = parseRows(text);
  const lookup = new Map<string, RBAircraftData>();
  for (const row of rows) {
    const registration = getValue(headers, row, "Registration")?.trim();
    if (!registration) continue;
    const model = (getValue(headers, row, "Model") ?? "").toUpperCase();
    lookup.set(registration, { aircraftGroup: getValue(headers, row, "Aircraft Group"), isSimulator: model.includes("SIM") });
  }
  return lookup;
}

interface RBPersonData {
  firstName?: string;
  lastName?: string;
  function?: string;
  crewId?: string;
}

function rbDefaultRoleFromFunction(fn: string | undefined): EntryPersonRole | undefined {
  switch (fn?.toLowerCase()) {
    case "captain":
      return "PIC";
    case "first officer":
      return "CP";
    case "second officer":
      return "CRCP";
    case "instructor":
      return "FI";
    default:
      return undefined;
  }
}

function parsePeopleCsv(text: string): Map<string, RBPersonData> {
  const { headers, rows } = parseRows(text);
  const lookup = new Map<string, RBPersonData>();
  for (const row of rows) {
    const firstName = getValue(headers, row, "First name");
    const lastName = getValue(headers, row, "Last name");
    if (!firstName && !lastName) continue;
    const key = `${firstName ?? ""}${lastName ?? ""}`;
    lookup.set(key, { firstName, lastName, function: getValue(headers, row, "Function"), crewId: getValue(headers, row, "Crew ID") });
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// Crew parsing, "FirstName+LastName+Email+Unknown+EmployeeNumber"
// ---------------------------------------------------------------------------

interface RBCrewValue {
  isSelf: boolean;
  firstName?: string;
  lastName?: string;
  employeeNumber?: string;
}

function parseCrewField(raw: string): RBCrewValue {
  const parts = raw.split("+");
  const firstName = parts[0] || undefined;
  const lastName = parts[1] || undefined;
  const employeeNumber = parts[4] || undefined;
  const isSelf = (firstName ?? "").toLowerCase() === "self";
  return isSelf ? { isSelf: true, employeeNumber } : { isSelf: false, firstName, lastName, employeeNumber };
}

const FLIGHT_CREW_COLUMNS: Array<{ column: string; role: EntryPersonRole }> = [
  { column: "Crew PIC", role: "PIC" },
  { column: "Crew SIC", role: "CP" },
  { column: "Crew First Officer", role: "CP" },
  { column: "Crew Second Officer", role: "CRCP" },
  { column: "Crew Instructor", role: "FI" },
  { column: "Crew Student", role: "STU" },
  { column: "Crew Relief1", role: "CRCP" },
  { column: "Crew Relief2", role: "CRCP" },
  { column: "Crew Relief3", role: "CRCP" },
  { column: "Crew Relief4", role: "CRCP" },
  { column: "Crew Relief5", role: "CRCP" }
];

const FSTD_CREW_COLUMNS: Array<{ column: string; role: EntryPersonRole }> = FLIGHT_CREW_COLUMNS.map(({ column }) => ({
  column,
  role: column === "Crew Instructor" ? "FSTD_INS" : "FSTD_TRN"
}));

function upsertCrew(crew: ImportedEntryCrewMember[], member: ImportedEntryCrewMember): void {
  const idx = crew.findIndex((c) => c.refId === member.refId);
  if (idx >= 0) crew[idx] = member;
  else crew.push(member);
}

/** Mirrors `determineSelfRole`, priority-ordered function-time columns, falling
 * back to the crew column's own default role. */
function determineSelfRole(headers: string[], row: string[], columnRole: EntryPersonRole): EntryPersonRole {
  const examiner = minutesIfPresent(headers, row, "Examiner") ?? 0;
  const instructor = minutesIfPresent(headers, row, "Instructor") ?? 0;
  const dualGiven = minutesIfPresent(headers, row, "Dual Given") ?? 0;
  const picus = minutesIfPresent(headers, row, "PICUS") ?? 0;
  const dualReceived = minutesIfPresent(headers, row, "Dual Received") ?? 0;
  const pic = minutesIfPresent(headers, row, "PIC") ?? 0;
  const sic = minutesIfPresent(headers, row, "SIC") ?? 0;

  if (examiner > 0) return "FE";
  if (instructor > 0 || dualGiven > 0) return "FI";
  if (picus > 0) return "PICUS";
  if (dualReceived > 0) return "STU";
  if (pic > 0) return "PIC";
  if (sic > 0) return "CP";
  return columnRole;
}

function determineFSTDRole(headers: string[], row: string[]): EntryPersonRole {
  const instructor = minutesIfPresent(headers, row, "Instructor") ?? 0;
  const dualGiven = minutesIfPresent(headers, row, "Dual Given") ?? 0;
  const examiner = minutesIfPresent(headers, row, "Examiner") ?? 0;
  return instructor > 0 || dualGiven > 0 || examiner > 0 ? "FSTD_INS" : "FSTD_TRN";
}

/** Mirrors `inferMissingSelfRole`'s bucket logic for a row with no function
 * times and no SELF found among the named crew columns. */
function inferMissingSelfRole(headers: string[], row: string[]): { role: EntryPersonRole; error?: ImportError["code"] } {
  const asCoPilot = determineSelfRole(headers, row, "CP");
  if (asCoPilot !== "CP") return { role: asCoPilot };

  const occupied = new Set(FLIGHT_CREW_COLUMNS.filter((c) => hasExplicitValue(headers, row, c.column)).map((c) => c.column));
  if (occupied.size === 0) return { role: "CP", error: "roleInferenceWarningMissingSeat" };
  if (occupied.size === 1 && occupied.has("Crew PIC")) return { role: "CP" };
  const foSo = occupied.size === 2 && occupied.has("Crew First Officer") && occupied.has("Crew Second Officer");
  const sicSo = occupied.size === 2 && occupied.has("Crew SIC") && occupied.has("Crew Second Officer");
  if (foSo || sicSo) return { role: "PIC" };
  return { role: "CP", error: "roleInferenceWarningAmbiguousSeat" };
}

// ---------------------------------------------------------------------------
// People / aircraft collection
// ---------------------------------------------------------------------------

function ensureSelfPerson(people: Map<string, ImportedPerson>): void {
  if (people.has("SELF")) return;
  people.set("SELF", { refId: "SELF", defaultRole: "PIC", isExisting: { existing: false }, isImportedFromOtherLogbook: true });
}

function addPeopleFromCrew(
  headers: string[],
  row: string[],
  people: Map<string, ImportedPerson>,
  peopleCsv: Map<string, RBPersonData>
): void {
  for (const { column } of FLIGHT_CREW_COLUMNS) {
    const raw = getValue(headers, row, column);
    if (!raw) continue;
    const crew = parseCrewField(raw);
    if (crew.isSelf) continue;
    const key = `${crew.firstName ?? ""}${crew.lastName ?? ""}`;
    if (key.length === 0 || people.has(key)) continue;
    const enrichment = peopleCsv.get(key);
    people.set(key, {
      refId: key,
      firstName: crew.firstName ?? enrichment?.firstName,
      lastName: crew.lastName ?? enrichment?.lastName,
      employeeNumber: crew.employeeNumber ?? enrichment?.crewId,
      defaultRole: rbDefaultRoleFromFunction(enrichment?.function),
      isExisting: { existing: false },
      isImportedFromOtherLogbook: true
    });
  }
}

function addAircraftIfNeeded(
  registration: string | undefined,
  aircraftCsv: Map<string, RBAircraftData>,
  aircraft: Map<string, ImportedAircraft>
): void {
  const cleaned = cleanRegistration(registration);
  if (!cleaned || aircraft.has(cleaned)) return;
  aircraft.set(cleaned, {
    registration: cleaned,
    icaoCode: aircraftCsv.get(registration ?? "")?.aircraftGroup,
    isImportedFromOtherLogbook: true
  });
}

// ---------------------------------------------------------------------------
// Authoritative-time field tables
// ---------------------------------------------------------------------------

const AUTHORITATIVE_FLIGHT_TIME_FIELDS: AuthoritativeTimeField[] = [
  single("Total Block", "totalTimeOfFlight"),
  single("PIC", "pilotInCommand"),
  single("SIC", "coPilot"),
  single("PICUS", "picus"),
  single("Relief Time", "cruiseReliefCoPilot"),
  single("Night", "night"),
  single("IFR", "ifr"),
  single("Instructor", "instructor"),
  single("Examiner", "examiner")
];

const AUTHORITATIVE_FSTD_TIME_FIELDS: AuthoritativeTimeField[] = [single("Simulator", "fstdSession")];

function minutesLookup(headers: string[], row: string[]): (column: string) => Time | undefined {
  return (column) => {
    const minutes = minutesIfPresent(headers, row, column);
    return minutes === undefined ? undefined : { totalMinutes: Math.max(0, minutes) };
  };
}

// ---------------------------------------------------------------------------
// Row -> entry
// ---------------------------------------------------------------------------

function createFlightEntry(
  headers: string[],
  row: string[],
  people: Map<string, ImportedPerson>,
  peopleCsv: Map<string, RBPersonData>,
  importErrors: ImportError[]
): ImportedEntry | undefined {
  const dateString = getValue(headers, row, "Date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    importErrors.push({ reason: "Could not parse date", dateString });
    return undefined;
  }

  const departure = getValue(headers, row, "Departure") ?? "";
  const arrival = getValue(headers, row, "Arrival") ?? "";
  const registration = getValue(headers, row, "Aircraft ID");
  const flightNumber = getValue(headers, row, "Flight #")?.replace(/\s+/g, "");
  const authoritativeBlockMinutes = minutesIfPresent(headers, row, "Total Block");

  let offBlocks = strictTimeOfDay(getValue(headers, row, "Out"));
  let onBlocks = strictTimeOfDay(getValue(headers, row, "In"));
  let airborne = strictTimeOfDay(getValue(headers, row, "Off"));
  let touchdown = strictTimeOfDay(getValue(headers, row, "On"));
  if (airborne?.totalMinutes === 0 && touchdown?.totalMinutes === 0) {
    airborne = undefined;
    touchdown = undefined;
  }

  const takeoffsAndLandings: TakeoffsAndLandings = {
    type: "manual",
    takeoffsDay: parseIntOr0(headers, row, "Day Takeoff"),
    takeoffsNight: parseIntOr0(headers, row, "Night Takeoff"),
    landingsDay: parseIntOr0(headers, row, "Day Landing"),
    landingsNight: parseIntOr0(headers, row, "Night Landing")
  };

  const remarks = truncatedRemarks(getValue(headers, row, "Remarks"), importErrors, { dateString, flightNumber, registration });
  const updateFlightData = offBlocks === undefined && airborne === undefined && touchdown === undefined && onBlocks === undefined;

  const entry = newImportedEntry({
    date: dateString,
    type: "flight",
    flightNumber,
    registration: cleanRegistration(registration),
    from: departure ? canonicalCode(departure) ?? departure : undefined,
    to: arrival ? canonicalCode(arrival) ?? arrival : undefined,
    scheduledOffBlocks: strictTimeOfDay(getValue(headers, row, "Sched Out")),
    offBlocks,
    airborne,
    touchdown,
    onBlocks,
    updateFlightData,
    takeoffsAndLandings,
    isImportedFromOtherLogbook: true,
    remarks
  });

  let missingSelfRoleAlreadyFlagged = false;
  for (const { column, role } of FLIGHT_CREW_COLUMNS) {
    const raw = getValue(headers, row, column);
    if (!raw) continue;
    const crew = parseCrewField(raw);
    if (crew.isSelf) {
      upsertCrew(entry.crew, { refId: "SELF", role: determineSelfRole(headers, row, role) });
    } else {
      const key = `${crew.firstName ?? ""}${crew.lastName ?? ""}`;
      if (key.length > 0 && people.has(key)) upsertCrew(entry.crew, { refId: key, role });
    }
  }

  if (!entry.crew.some((c) => c.refId === "SELF")) {
    const inferred = inferMissingSelfRole(headers, row);
    ensureSelfPerson(people);
    upsertCrew(entry.crew, { refId: "SELF", role: inferred.role });
    if (inferred.error) {
      importErrors.push({
        code: inferred.error,
        reason:
          inferred.error === "roleInferenceWarningMissingSeat"
            ? "Role inferred as Co-pilot for review: RB Logbook row has no function times and no crew columns identifying your seat."
            : "Role inferred as Co-pilot for review: RB Logbook row has no function times and ambiguous crew columns, so your seat could not be inferred safely.",
        dateString,
        flightNumber,
        registration,
        entryId: entry.id
      });
      missingSelfRoleAlreadyFlagged = true;
    }
  }

  if (!missingSelfRoleAlreadyFlagged && !entry.crew.some((c) => c.refId === "SELF")) {
    importErrors.push({ code: "roleMissingFlight", reason: "You have no role set on this flight", dateString, flightNumber, registration, entryId: entry.id });
  }
  if (!entry.registration) {
    importErrors.push({ code: "registrationMissing", reason: "Registration missing", dateString, flightNumber, registration, entryId: entry.id });
  }
  if (departure.length === 0) {
    importErrors.push({ code: "originAirportMissing", reason: "Origin airport missing", dateString, flightNumber, registration, entryId: entry.id });
  }
  if (arrival.length === 0) {
    importErrors.push({ code: "destinationAirportMissing", reason: "Destination airport missing", dateString, flightNumber, registration, entryId: entry.id });
  }

  applyAuthoritativeFlightBlockDuration(entry, authoritativeBlockMinutes);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeTimes(AUTHORITATIVE_FLIGHT_TIME_FIELDS, minutesLookup(headers, row), entry);

  const selfRole = entry.crew.find((c) => c.refId === "SELF")?.role;
  const resolvedSelfRole = retaggedLosslessPICUSRole(entry, selfRole);
  if (resolvedSelfRole !== undefined && resolvedSelfRole !== selfRole) {
    upsertCrew(entry.crew, { refId: "SELF", role: resolvedSelfRole });
  }
  normalizeImportedFlightManualTimes(entry, resolvedSelfRole);

  void peopleCsv;
  return entry;
}

/** Mirrors `sanitizedFSTDClocks`, reconciles Sched Out/In vs Out/In against
 * the authoritative simulator-minutes column, clearing clocks that
 * disagree/are incomplete rather than silently trusting mismatched data. */
function sanitizedFSTDClocks(
  headers: string[],
  row: string[],
  simulatorMinutes: number,
  importErrors: ImportError[],
  dateString: string
): { startTime: Time | undefined; endTime: Time | undefined; clearDisplayedClocks: boolean } {
  const start = strictTimeOfDay(getValue(headers, row, "Sched Out") ?? getValue(headers, row, "Out"));
  const end = strictTimeOfDay(getValue(headers, row, "Sched In") ?? getValue(headers, row, "In"));

  if (simulatorMinutes <= 0) return { startTime: start, endTime: end, clearDisplayedClocks: false };

  if ((start === undefined) !== (end === undefined)) {
    importErrors.push({
      reason: "RB simulator clocks are incomplete; imported authoritative simulator duration without session start/end times.",
      dateString
    });
    return { startTime: undefined, endTime: undefined, clearDisplayedClocks: true };
  }
  if (start === undefined || end === undefined) return { startTime: undefined, endTime: undefined, clearDisplayedClocks: false };

  const derived = end.totalMinutes - start.totalMinutes;
  if (Math.abs(derived - simulatorMinutes) >= 30) {
    importErrors.push({
      reason: "RB simulator clocks disagree with the authoritative simulator duration; imported the simulator duration and cleared the session start/end times for review.",
      dateString
    });
    return { startTime: undefined, endTime: undefined, clearDisplayedClocks: true };
  }
  return { startTime: start, endTime: end, clearDisplayedClocks: false };
}

function createFSTDEntry(headers: string[], row: string[], people: Map<string, ImportedPerson>, importErrors: ImportError[]): ImportedEntry | undefined {
  const dateString = getValue(headers, row, "Date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    importErrors.push({ reason: "Could not parse date", dateString });
    return undefined;
  }

  const fstdId = getValue(headers, row, "Aircraft ID");
  const simulatorMinutes = parseIntOr0(headers, row, "Simulator");
  const departure = getValue(headers, row, "Departure");
  const arrival = getValue(headers, row, "Arrival");
  if (departure || arrival) {
    importErrors.push({
      reason: "RB simulator row still contains route airports; imported as simulator because the source marks it as an FSTD row.",
      dateString
    });
  }

  const { startTime, endTime, clearDisplayedClocks } = sanitizedFSTDClocks(headers, row, simulatorMinutes, importErrors, dateString);
  const remarks = truncatedRemarks(getValue(headers, row, "Remarks"), importErrors, { dateString });

  const entry = newImportedEntry({ date: dateString, type: "fstd", fstdId, startTime, endTime, isImportedFromOtherLogbook: true, remarks });

  for (const { column, role } of FSTD_CREW_COLUMNS) {
    const raw = getValue(headers, row, column);
    if (!raw) continue;
    const crew = parseCrewField(raw);
    if (crew.isSelf) {
      upsertCrew(entry.crew, { refId: "SELF", role: column === "Crew Instructor" ? "FSTD_INS" : determineFSTDRole(headers, row) });
    } else {
      const key = `${crew.firstName ?? ""}${crew.lastName ?? ""}`;
      if (key.length > 0 && people.has(key)) upsertCrew(entry.crew, { refId: key, role });
    }
  }
  if (!entry.crew.some((c) => c.refId === "SELF")) {
    importErrors.push({ code: "roleMissingSimulator", reason: "You have no role set on this simulator session", dateString, entryId: entry.id });
  }

  applyAuthoritativeFSTDSessionDuration(entry, simulatorMinutes > 0 ? simulatorMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeTimes(AUTHORITATIVE_FSTD_TIME_FIELDS, minutesLookup(headers, row), entry, false);
  if (clearDisplayedClocks) {
    entry.startTime = undefined;
    entry.endTime = undefined;
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

export interface RBLogbookFiles {
  flights: string;
  aircraft?: string;
  people?: string;
}

/** Classifies a set of raw file texts by content (mirrors `identifyFile`),
 * keeping the LAST match per type (same as the iOS app's loop). */
export function classifyRBLogbookFiles(texts: string[]): RBLogbookFiles | undefined {
  let flights: string | undefined;
  let aircraft: string | undefined;
  let people: string | undefined;
  for (const text of texts) {
    switch (identifyRBFile(text)) {
      case "flights":
        flights = text;
        break;
      case "aircraft":
        aircraft = text;
        break;
      case "people":
        people = text;
        break;
      default:
        break;
    }
  }
  return flights !== undefined ? { flights, aircraft, people } : undefined;
}

export function parseRBLogbookFiles(files: RBLogbookFiles): ImportResult {
  const importErrors: ImportError[] = [];
  const aircraftCsv = files.aircraft ? parseAircraftCsv(files.aircraft) : new Map<string, RBAircraftData>();
  const peopleCsv = files.people ? parsePeopleCsv(files.people) : new Map<string, RBPersonData>();

  const people = new Map<string, ImportedPerson>();
  ensureSelfPerson(people);
  const aircraft = new Map<string, ImportedAircraft>();
  const entries: ImportedEntry[] = [];

  const { headers, rows } = parseRows(files.flights);
  if (headers.length === 0) {
    importErrors.push({ reason: "No flights CSV file found. Please select the rb_logbook_flights.csv file." });
    return { ...emptyImportResult(), importErrors };
  }

  for (const [rowIndex, row] of rows.entries()) {
    if (row.length < 18) continue; // "Minimum: up to Total Block column"

    const simulatorMinutes = minutesIfPresent(headers, row, "Simulator") ?? 0;
    const dutyType = parseIntOr0(headers, row, "Duty Type");
    const totalBlock = minutesIfPresent(headers, row, "Total Block") ?? 0;
    const flightNumber = getValue(headers, row, "Flight #");
    const departure = getValue(headers, row, "Departure") ?? "";
    const arrival = getValue(headers, row, "Arrival") ?? "";
    const hasRealRoute = departure.length > 0 && arrival.length > 0 && departure !== arrival;
    const aircraftId = getValue(headers, row, "Aircraft ID");
    const isSimulator = !hasRealRoute && (simulatorMinutes > 0 || (dutyType === 1 && aircraftCsv.get(aircraftId ?? "")?.isSimulator === true));

    if (dutyType === 1 && !isSimulator && totalBlock === 0 && !flightNumber) continue; // ground duty, skip

    addPeopleFromCrew(headers, row, people, peopleCsv);
    if (!isSimulator) addAircraftIfNeeded(aircraftId, aircraftCsv, aircraft);

    const entry = isSimulator ? createFSTDEntry(headers, row, people, importErrors) : createFlightEntry(headers, row, people, peopleCsv, importErrors);
    if (entry) {
      entry.sourceRow = rowIndex + 2;
      entries.push(entry);
    }
  }

  flagDuplicates(entries, importErrors);

  return { entries, people: [...people.values()], aircraft: [...aircraft.values()], importErrors, skippedUnchangedCount: 0 };
}

export const rbLogbookImporter: Importer = {
  id: "rblogbook",
  displayName: "RB Logbook (RosterBuster) export (CSV)",
  extensions: ["csv"],
  /** Content-sniffing, mirroring `identifyFile`, the real multi-file flow
   * (`--from rblogbook` with flights+aircraft+people) only runs through
   * `parseRBLogbookFiles` directly; `detect()`/single-file `parse()` only
   * ever see the flights file (the required one). */
  detect(buffer: Buffer): number {
    return identifyRBFile(buffer.toString("utf8")) === "flights" ? 0.7 : 0;
  },
  async parse(input: Buffer | string, _options?: ImporterOptions): Promise<ImportResult> {
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseRBLogbookFiles({ flights: text });
  },
  /** The real 3-file RB Logbook export (flights required, aircraft/people
   * optional enrichment), content-sniffed exactly like single-file
   * `detect()`/the iOS app's file identification, via `classifyRBLogbookFiles`.
   * `jetlog convert` routes here automatically when more than one input file
   * is given and the format resolves to `rblogbook`. */
  async parseMany(files: { buffer: Buffer; filename: string | undefined }[]): Promise<ImportResult> {
    const texts = files.map((f) => f.buffer.toString("utf8"));
    const classified = classifyRBLogbookFiles(texts);
    if (!classified) {
      return {
        ...emptyImportResult(),
        importErrors: [{ reason: "No flights CSV file found among the given files. Please include the rb_logbook_flights.csv file." }]
      };
    }
    return parseRBLogbookFiles(classified);
  }
};
