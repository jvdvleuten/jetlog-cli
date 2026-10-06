/**
 * Ported from the Jetlog iOS app's Skylife importer (Skylife logbook CSV export).
 *
 * Semicolon-delimited, every field double-quoted, UTF-8, `dd/MM/yyyy` dates.
 * Header (case-sensitive, not lowercased unlike PilotLog's port):
 * `DATE;FLIGHT;FROM;TO;DEP;ARR;REG;TYPE;ENG;PIC;COP;DAY;NIGHT;IFR;TOTAL;P1;
 * P1/S;P2;DUAL;INSTR;EXAM;SIM;X-COUNTRY P1;X-COUNTRY P1/S;MULTI PILOT;
 * SINGLE PILOT S/E;SINGLE PILOT M/E;DAY LDG;NIGHT LDG;AUTO LDG;OWN LDG;NOTE`
 *
 * Modeled closely on the SafeLog/Flylog importers in the iOS app (shared CSV/
 * duration helpers, SIM-row -> FSTD-entry split, seat-based SELF detection).
 *
 * ## Seat/role model
 * Exactly one of `PIC`/`COP` is the literal string `"Self"` (the logbook
 * owner's seat); the other column carries the other pilot's name (or is
 * blank on a solo/simulator row). Whichever column is `"Self"` decides the
 * holder's role: `PIC == "Self"` -> the holder was PIC, `COP == "Self"` ->
 * the holder was co-pilot. The other column's name (when present) is added
 * as the complementary crew member.
 *
 * ## SIM/FSTD detection
 * A row is an FSTD (simulator) entry whenever the `SIM` column is a
 * non-zero duration, a clean, non-overlapping discriminator in the source
 * data (no row has both `SIM > 0` and `TOTAL > 0`). `FLIGHT` on SIM rows
 * carries a session-type label rather than a flight number, and `FROM`/`TO`
 * always carry the same simulator-bay code (e.g. `XBH`), used as `fstdId`.
 *
 * ## Ground-training rows
 * A handful of rows have no `FROM`/`TO`/`REG`, legacy ground-training
 * entries with only a `TOTAL` duration. These are not SIM rows (`SIM == 0`)
 * so they fall through to the normal flight-entry path: the row is imported
 * anyway with `registrationMissing`/`originAirportMissing`/
 * `destinationAirportMissing` import errors attached, rather than silently
 * dropped.
 *
 * ## Landings
 * `DAY LDG`/`NIGHT LDG` are a 1/0 flag present on every row (exactly one is
 * `1`) classifying whether the sector's landing was by day or night, not a
 * per-pilot landing count. `OWN LDG` is the actual count of landings
 * performed by the logbook holder (`AUTO LDG`, autolands, is not modeled).
 * Credited landings = `OWN LDG`, classified day/night by the flag. Skylife
 * never tracks takeoffs, so takeoffs are always imported as `0`/`0`.
 *
 * ## Crew name parsing
 * Names are `"SURNAME FIRSTNAME [NOISE]"`, sometimes truncated/decorated
 * (e.g. `"PENDRY Chris SR"`, `"DE HAAN STEPHAN***"`, `"BAARS RODERICK (PAS"`).
 * `cleanSkylifeName` strips the noise (rank tags SR/LR/JR, `***`, `50%`,
 * parenthesized/truncated `(...` tokens) so one pilot always yields one
 * person, and `parseSkylifeName` treats leading particles (DE, VAN, VAN DE,
 * LE, AL, ...) as part of the surname.
 *
 * ## Not ported (no local store offline, see `model.ts`)
 * The iOS app's stored-user fetch and existing entry/FSTD entry/person/aircraft
 * matching are all skipped, there's no local database to match against offline:
 *  - `addPersonIfNeeded` always creates a brand-new `"SELF"` placeholder
 *    person (the real-identity branch is skipped), and
 *    every row is produced as brand-new (`isExisting: { existing: false }`).
 *  - The top-level "most frequent crew member is SELF"
 *    reconciliation pass (which remaps a DB-resolved real user identity onto
 *    the crew member seen most often) is entirely DB-backed, it only
 *    matters when the stored-user fetch succeeds, which never happens offline,
 *    so it's skipped; Skylife's own per-row `"Self"` literal already
 *    deterministically marks the holder's seat, so no reconciliation is
 *    needed.
 *  - IATA->ICAO conversion is backed by the airport resolver (logged-in catalog only, none offline) in
 *    `../../airports/index.js` (`canonicalCode`): `from`/`to` resolve to ICAO
 *    for a known IATA code, otherwise pass through unchanged, same as
 *    `deeplink-json.ts`/`logten.ts`/`pilotlog.ts`.
 *  - Person/aircraft "match existing" lookups are skipped; every person and
 *    aircraft not resolved to `"SELF"` is produced as new.
 *
 * Skylife is an "other-logbook" format: like PilotLog/LogTen, a caller
 * should apply `excludingFutureEntries` (`model.ts`) to the result before
 * presenting it, none of the importers here call it themselves
 * (it isn't wired into any `parse()`), so this one doesn't either;
 * wiring happens at the call site, consistent with the others.
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
import { single, sum, applyAuthoritativeTimes, type AuthoritativeTimeField } from "../authoritative-times.js";
import {
  applyAuthoritativeFSTDSessionDuration,
  applyAuthoritativeFlightBlockDuration,
  convertToBulkIfNeeded,
  normalizeImportedFlightManualTimes,
  retaggedLosslessPICUSRole
} from "../normalization.js";

// ---------------------------------------------------------------------------
// CSV tokenizing, ported from the iOS app's hand-rolled ';'-delimited parser
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

/** Mirrors `parseCSVRow`, ';'-delimited, each column trimmed of surrounding whitespace. */
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
    if (char === ";" && !inQuotes) {
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

const REQUIRED_HEADERS = ["DATE", "FLIGHT", "FROM", "TO", "DEP", "ARR", "P1/S", "OWN LDG"];

function colIndex(headers: string[], name: string): number {
  return headers.indexOf(name);
}

/** Mirrors `getValue`, `undefined` for a missing header or an empty cell. */
function getValue(name: string, columns: string[], headers: string[]): string | undefined {
  const idx = colIndex(headers, name);
  if (idx < 0 || idx >= columns.length) return undefined;
  const value = columns[idx] ?? "";
  return value.length > 0 ? value : undefined;
}

/** Mirrors `hasExplicitValue`. */
function hasExplicitValue(name: string, columns: string[], headers: string[]): boolean {
  const idx = colIndex(headers, name);
  return idx >= 0 && idx < columns.length && (columns[idx]?.length ?? 0) > 0;
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
// Date parsing, dd/MM/yyyy
// ---------------------------------------------------------------------------

/** Mirrors `parseDate`. */
function parseSkylifeDate(raw: string | undefined): DateOnly | undefined {
  if (!raw || raw.length === 0) return undefined;
  const parts = raw.split("/");
  if (parts.length !== 3) return undefined;
  const day = Number.parseInt(parts[0]!, 10);
  const month = Number.parseInt(parts[1]!, 10);
  const year = Number.parseInt(parts[2]!, 10);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// FSTD detection
// ---------------------------------------------------------------------------

/** Mirrors `isSimulatorEntry`, SIM > 0 is a clean, non-overlapping discriminator. */
function isSimulatorEntry(columns: string[], headers: string[]): boolean {
  return getDuration("SIM", columns, headers) > 0;
}

// ---------------------------------------------------------------------------
// Role determination
// ---------------------------------------------------------------------------

function isSelfLiteral(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "self";
}

/** Mirrors `determineHolderRole`. */
function determineHolderRole(columns: string[], headers: string[]): EntryPersonRole {
  return isSelfLiteral(getValue("PIC", columns, headers)) ? "PIC" : "CP";
}

/** Mirrors `determineFSTDRole`. */
function determineFSTDRole(columns: string[], headers: string[]): EntryPersonRole {
  return getDuration("INSTR", columns, headers) > 0 ? "FSTD_INS" : "FSTD_TRN";
}

// ---------------------------------------------------------------------------
// Authoritative-time field tables
// ---------------------------------------------------------------------------

/** Mirrors `authoritativeFlightTimeFields`. */
const AUTHORITATIVE_FLIGHT_TIME_FIELDS: AuthoritativeTimeField[] = [
  single("TOTAL", "totalTimeOfFlight"),
  single("P1", "pilotInCommand"),
  single("P1/S", "picus"),
  single("P2", "coPilot"),
  single("DUAL", "dual"),
  single("INSTR", "instructor"),
  single("EXAM", "examiner"),
  single("NIGHT", "night"),
  single("IFR", "ifr"),
  sum(["X-COUNTRY P1", "X-COUNTRY P1/S"], "crossCountry"),
  single("MULTI PILOT", "multiPilot"),
  single("SINGLE PILOT S/E", "singlePilotSingleEngine"),
  single("SINGLE PILOT M/E", "singlePilotMultiEngine")
];

const AUTHORITATIVE_FSTD_TIME_FIELDS: AuthoritativeTimeField[] = [single("SIM", "fstdSession")];

function applyAuthoritativeFlightTimes(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FLIGHT_TIME_FIELDS, (column) => manualDurationIfPresent(column, columns, headers), entry);
}

function applyAuthoritativeFSTDTime(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(
    AUTHORITATIVE_FSTD_TIME_FIELDS,
    (column) => manualDurationIfPresent(column, columns, headers),
    entry,
    false
  );
}

// ---------------------------------------------------------------------------
// Landings, DAY/NIGHT LDG is a day/night flag, OWN LDG is the count
// ---------------------------------------------------------------------------

/** Mirrors `parseTakeoffsAndLandings`. Skylife never tracks takeoffs. */
function parseTakeoffsAndLandings(columns: string[], headers: string[]): TakeoffsAndLandings {
  const ownLandings = Number.parseInt(getValue("OWN LDG", columns, headers) ?? "", 10) || 0;
  const isNightLanding = (Number.parseInt(getValue("NIGHT LDG", columns, headers) ?? "", 10) || 0) === 1;
  return {
    type: "manual",
    takeoffsDay: 0,
    takeoffsNight: 0,
    landingsDay: isNightLanding ? 0 : ownLandings,
    landingsNight: isNightLanding ? ownLandings : 0
  };
}

// ---------------------------------------------------------------------------
// Crew name cleaning / parsing
// ---------------------------------------------------------------------------

const RANK_TAGS = new Set(["SR", "LR", "JR"]);
const SURNAME_PARTICLES = new Set([
  "AL",
  "DA",
  "DE",
  "DEL",
  "DELLA",
  "DEN",
  "DER",
  "DI",
  "DOS",
  "DU",
  "EL",
  "LA",
  "LE",
  "TEN",
  "TER",
  "VAN",
  "VON"
]);

/** Mirrors `cleanSkylifeName`: strips rank tags, `***`, `50%`, and `(...`-style
 * noise tokens, so e.g. `"DE HAAN STEPHAN***"` -> `"DE HAAN STEPHAN"`. */
export function cleanSkylifeName(name: string): string | undefined {
  const tokens = name
    .replace(/\*/g, " ")
    .split(" ")
    .filter((t) => t.length > 0)
    .filter((token) => !token.startsWith("(") && !RANK_TAGS.has(token.toUpperCase()) && !/[0-9%]/.test(token));
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

/** Mirrors `parseSkylifeName`: splits a cleaned "SURNAME FIRSTNAME" into
 * (firstName, lastName), keeping leading particles with the surname. */
export function parseSkylifeName(name: string): { firstName: string | undefined; lastName: string | undefined } {
  const tokens = name.split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return { firstName: undefined, lastName: undefined };

  let surnameCount = 1;
  while (surnameCount < tokens.length - 1 && SURNAME_PARTICLES.has(tokens[surnameCount - 1]!.toUpperCase())) {
    surnameCount += 1;
  }
  if (surnameCount >= tokens.length) return { firstName: undefined, lastName: tokens.join(" ") };

  const lastName = tokens.slice(0, surnameCount).join(" ");
  const firstName = tokens.slice(surnameCount).join(" ");
  return { firstName, lastName };
}

/** Mirrors `crewName`, reads a PIC/COP column and strips non-name noise. */
function crewName(column: string, columns: string[], headers: string[]): string | undefined {
  const raw = getValue(column, columns, headers);
  return raw !== undefined ? cleanSkylifeName(raw) : undefined;
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

/** Mirrors `addPersonIfNeeded` (offline: no `fetchUserPerson`/`matchExistingPerson`
 * lookups, see the file doc comment). */
function addPersonIfNeeded(columns: string[], headers: string[], people: Map<string, ImportedPerson>): void {
  ensureSelfPerson(people);

  const pic = crewName("PIC", columns, headers);
  const cop = crewName("COP", columns, headers);
  const otherName = pic !== undefined && !isSelfLiteral(pic) ? pic : cop !== undefined && !isSelfLiteral(cop) ? cop : undefined;
  if (otherName === undefined || people.has(otherName)) return;

  const { firstName, lastName } = parseSkylifeName(otherName);
  people.set(otherName, {
    refId: otherName,
    firstName,
    lastName,
    defaultRole: "PIC",
    isExisting: { existing: false },
    isImportedFromOtherLogbook: true
  });
}

function addAircraftIfNeeded(columns: string[], headers: string[], aircraft: Map<string, ImportedAircraft>): void {
  const cleaned = cleanRegistration(getValue("REG", columns, headers));
  if (!cleaned || aircraft.has(cleaned)) return;
  aircraft.set(cleaned, { registration: cleaned, icaoCode: getValue("TYPE", columns, headers), isImportedFromOtherLogbook: true });
}

// ---------------------------------------------------------------------------
// Crew assignment
// ---------------------------------------------------------------------------

/** Mirrors `addFlightCrew`. */
function addFlightCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  const holderRole = determineHolderRole(columns, headers);
  if (people.has("SELF")) upsertCrew(entry.crew, { refId: "SELF", role: holderRole });

  const otherName = holderRole === "PIC" ? crewName("COP", columns, headers) : crewName("PIC", columns, headers);
  const otherRole: EntryPersonRole = holderRole === "PIC" ? "CP" : "PIC";
  if (otherName !== undefined && !isSelfLiteral(otherName) && people.has(otherName)) {
    upsertCrew(entry.crew, { refId: otherName, role: otherRole });
  }
}

/** Mirrors `addSimulatorCrew`. */
function addSimulatorCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  const fstdRole = determineFSTDRole(columns, headers);
  if (people.has("SELF")) upsertCrew(entry.crew, { refId: "SELF", role: fstdRole });

  if (fstdRole === "FSTD_TRN") {
    const picName = crewName("PIC", columns, headers);
    if (picName !== undefined && !isSelfLiteral(picName) && people.has(picName)) {
      upsertCrew(entry.crew, { refId: picName, role: "FSTD_INS" });
    }
  }
}

// ---------------------------------------------------------------------------
// Row -> entry
// ---------------------------------------------------------------------------

function createFlightEntry(
  columns: string[],
  headers: string[],
  row: number,
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[]
): ImportedEntry | undefined {
  const dateString = getValue("DATE", columns, headers);
  if (dateString === undefined) {
    importErrors.push({ reason: "DATE not found", rowNumber: row });
    return undefined;
  }
  const date = parseSkylifeDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: `Incorrect date format: ${dateString}`, dateString, rowNumber: row });
    return undefined;
  }

  const registration = getValue("REG", columns, headers) ?? "";
  const from = canonicalCode(getValue("FROM", columns, headers)) ?? "";
  const to = canonicalCode(getValue("TO", columns, headers)) ?? "";
  const offBlocks = parseTime(getValue("DEP", columns, headers));
  const onBlocks = parseTime(getValue("ARR", columns, headers));
  const blockMinutes = getDuration("TOTAL", columns, headers);
  const flightNumber = getValue("FLIGHT", columns, headers);
  const takeoffsAndLandings = parseTakeoffsAndLandings(columns, headers);
  const remarks = truncatedRemarks(getValue("NOTE", columns, headers), importErrors, {
    dateString,
    flightNumber,
    registration
  });

  const updateFlightData = offBlocks === undefined && onBlocks === undefined;

  const entry = newImportedEntry({
    date,
    type: "flight",
    flightNumber,
    registration: cleanRegistration(registration),
    from: from.length > 0 ? from : undefined,
    to: to.length > 0 ? to : undefined,
    offBlocks,
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
      dateString,
      flightNumber,
      registration,
      rowNumber: row,
      entryId: entry.id
    });
  }
  if (from.length === 0) {
    importErrors.push({
      code: "originAirportMissing",
      reason: "Origin airport missing",
      dateString,
      flightNumber,
      registration,
      rowNumber: row,
      entryId: entry.id
    });
  }
  if (to.length === 0) {
    importErrors.push({
      code: "destinationAirportMissing",
      reason: "Destination airport missing",
      dateString,
      flightNumber,
      registration,
      rowNumber: row,
      entryId: entry.id
    });
  }

  applyAuthoritativeFlightBlockDuration(entry, blockMinutes > 0 ? blockMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFlightTimes(columns, headers, entry);

  const selfRole = entry.crew.find((c) => c.refId === "SELF")?.role;
  // Lossless PICUS retag: a co-pilot-seat row whose `P1/S` column equals the
  // full block was flown as PICUS, retag before normalize (whose PICUS case
  // clears the column) so the crew row and role attribution agree.
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
  row: number,
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[]
): ImportedEntry | undefined {
  const dateString = getValue("DATE", columns, headers);
  if (dateString === undefined) {
    importErrors.push({ reason: "DATE not found", rowNumber: row });
    return undefined;
  }
  const date = parseSkylifeDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: `Incorrect date format: ${dateString}`, dateString, rowNumber: row });
    return undefined;
  }

  // FROM/TO always carry the same simulator-bay code on a SIM row, the
  // closest thing to an FSTD identifier this format has.
  const fstdId = getValue("FROM", columns, headers) ?? getValue("TO", columns, headers);
  const startTime = parseTime(getValue("DEP", columns, headers));
  const endTime = parseTime(getValue("ARR", columns, headers));
  const sessionMinutes = getDuration("SIM", columns, headers);
  const remarks = truncatedRemarks(getValue("NOTE", columns, headers), importErrors, { dateString });

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

  addSimulatorCrew(columns, headers, people, entry);

  if (!fstdId) {
    importErrors.push({
      code: "fstdIdentifierMissing",
      reason: "FSTD identifier missing",
      dateString,
      rowNumber: row,
      entryId: entry.id
    });
  }

  applyAuthoritativeFSTDSessionDuration(entry, sessionMinutes > 0 ? sessionMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFSTDTime(columns, headers, entry);

  return entry;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/** Parses Skylife CSV content into an `ImportResult`. */
export function parseSkylifeCsv(csvText: string): ImportResult {
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
  for (let index = 0; index < dataRows.length; index++) {
    const row = dataRows[index]!;
    const columns = parseCSVRow(row);
    if (columns.length < 2) continue;

    addPersonIfNeeded(columns, headers, people);
    const simRow = isSimulatorEntry(columns, headers);
    if (!simRow) addAircraftIfNeeded(columns, headers, aircraft);

    const entry = simRow
      ? createSimulatorEntry(columns, headers, index, people, importErrors)
      : createFlightEntry(columns, headers, index, people, importErrors);
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

export const skylifeImporter: Importer = {
  id: "skylife",
  displayName: "Skylife logbook export (CSV)",
  extensions: ["csv", "txt"],
  /** This CLI's own content sniffing (not a port of existing iOS logic, see
   * `importer.ts`'s doc comment): Skylife's header is a fairly unique
   * combination of semicolon-delimited, quoted columns including `P1/S`,
   * `OWN LDG`, and `X-COUNTRY P1`. */
  detect(buffer: Buffer, _filename: string | undefined): number {
    const text = buffer.toString("utf8");
    const firstLine = splitCSVIntoProperLines(text)[0] ?? "";
    if (firstLine.length === 0) return 0;
    const headers = parseCSVRow(firstLine);
    const hasRequired = REQUIRED_HEADERS.every((h) => headers.includes(h));
    const hasDistinctiveShape = headers.includes("X-COUNTRY P1") && headers.includes("OWN LDG");
    return hasRequired && hasDistinctiveShape ? 0.8 : 0;
  },
  async parse(input: Buffer | string, _options?: ImporterOptions): Promise<ImportResult> {
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseSkylifeCsv(text);
  }
};
