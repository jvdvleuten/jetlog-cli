/**
 * Ported from the Jetlog iOS app's PilotLog importer (mccPILOTLOG / PilotLog / CrewLounge
 * app exports).
 *
 * PilotLog ships several export variants that all land in the same column
 * schema, detected per-row rather than per-file:
 *  - the classic standalone mccPILOTLOG desktop export: comma-delimited,
 *    lowercase headers, `mcc_date` date column, no `time_depsch` column;
 *  - the current CrewLounge/PilotLog *web* export ("raw" format): semicolon-
 *    delimited, UPPERCASE headers (lowercased here before matching), an
 *    `is_prevexp` column (the signal used for `isRawFormat` below),
 *    `pilotlog_date` date column, `DD-MM-YYYY`/`DD/MM/YYYY`/`DD.MM.YYYY`
 *    dates, and integer-minute durations instead of `H:MM`.
 *
 * `isRawFormat` (presence of the `is_prevexp` header) drives three things
 * that mirror the iOS app: (1) `IS_PREVEXP=TRUE` rows import as
 * accumulated bulk-hours entries rather than per-flight rows, (2) the
 * blank-pilot-slot SELF fallback always applies (the raw export logs the
 * owner's own time in the role columns instead of naming "SELF" in a pilot
 * slot), and (3) a dominant `PILOT1_NAME` across the file is treated as an
 * alias for the owner (see `dominantPilotName`).
 *
 * ## ZIP export variant
 *
 * The iOS importer also accepts a
 * zipped mccPILOTLOG backup (anything that isn't `.csv`/`.txt`), unzips it
 * and feeds the first `.csv` file found
 * inside to the exact same CSV parser ported here. Ported via `../zip.ts`
 * (`fflate`) below: mirrors the iOS app exactly,
 * non-recursive (top-level zip entries only, no subfolder search),
 * case-sensitive `.csv` suffix match, first match wins in zip-entry order
 * (the iOS directory-listing order isn't guaranteed either; this is the
 * same "whatever's first" contract, not a stronger one). No manifest/naming
 * convention is expected, same as the iOS app.
 *
 * ## Not ported (no local store offline, see `model.ts`)
 *
 * Every existing-entry/person/aircraft and stored-user lookup in the iOS
 * importer is skipped: there is no local database to match an existing entry,
 * person, or aircraft against, and no stored user person to resolve owner
 * aliases from. Concretely:
 *  - Every row is produced as brand-new (`isExisting: { existing: false }`);
 *    the "matched existing entry" parameter threaded through
 *    `normalizeImportedFlightManualTimes`/`retaggedLosslessPICUSRole` in
 *    the iOS app is always the `existingEntry: undefined` branch here (ported
 *    behavior already captures this, see `normalization.ts`'s file doc
 *    comment).
 *  - `ownerNameAliases` only ever contributes the raw-format
 *    `dominantPilotName` signal; the stored-user-person alias is skipped
 *    (nothing to fetch offline).
 *  - IATA->ICAO airport code conversion
 *    is backed by the airport resolver (logged-in catalog only, none offline) (`canonicalCode` in
 *    `../../airports/index.js`), low-impact in practice since PilotLog exports
 *    ICAO codes in `af_dep`/`af_arr` in every fixture seen, but applied for
 *    consistency with the other importers and in case a raw/web export
 *    ever emits IATA.
 *  - Person/aircraft "match existing" lookups are skipped; every person and
 *    aircraft not already resolved to "SELF" is produced as new.
 */
import { canonicalCode } from "../../airports/index.js";
import type { Importer, ImporterOptions } from "../importer.js";
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
  type Time,
  type Times
} from "../model.js";
import { colonMinutes, colonOrBareMinutesDuration } from "../time-parsing.js";
import { looksLikeZip, unzipEntries, decodeZipText } from "../zip.js";
import { single, applyAuthoritativeTimes, type AuthoritativeTimeField } from "../authoritative-times.js";
import {
  applyAuthoritativeFlightBlockDuration,
  applyAuthoritativeFSTDSessionDuration,
  convertToBulkIfNeeded,
  normalizedFlightBlockMinutesForImport,
  normalizeImportedFlightManualTimes,
  retaggedLosslessPICUSRole
} from "../normalization.js";

// ---------------------------------------------------------------------------
// File-kind routing
// ---------------------------------------------------------------------------

export type PilotLogFileKind = "csv" | "zip";

/** Mirrors `PilotLogImporter.fileKind(for:)`: `.csv`/`.txt` parse directly,
 * everything else (including no/unknown extension) is treated as a zipped
 * backup, not supported here, see the file doc comment. */
export function pilotLogFileKind(filename: string | undefined): PilotLogFileKind {
  const ext = filename?.split(".").pop()?.toLowerCase();
  return ext === "csv" || ext === "txt" ? "csv" : "zip";
}

// ---------------------------------------------------------------------------
// CSV tokenizing, ported from the iOS app's hand-rolled parser
// ---------------------------------------------------------------------------

/** Mirrors `cleanCSVString`. */
function cleanCSVString(csvData: string): string {
  return csvData
    .replace(/﻿/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^"+/, "")
    .replace(/"+$/, "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n");
}

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
        currentLine += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === "\n" && !inQuotes) {
      lines.push(currentLine);
      currentLine = "";
    } else {
      currentLine += char;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);
  return lines;
}

/** Mirrors `parseCSVRow`. */
function parseCSVRow(row: string, delimiter: string): string[] {
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
    if (char === delimiter && !inQuotes) {
      columns.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  columns.push(current);
  return columns;
}

/** Mirrors `detectDelimiter`. */
function detectDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

// ---------------------------------------------------------------------------
// Name normalization / owner (SELF) resolution
// ---------------------------------------------------------------------------

/** Mirrors `normalizedName`. */
function normalizedName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[ \t]+/)
    .filter((s) => s.length > 0)
    .join(" ");
}

/** Mirrors `dominantPilotName`: the normalized `pilot1_name` that appears
 * across a clear majority of rows naming a non-SELF pilot in slot 1. */
function dominantPilotName(rows: string[], headers: string[], delimiter: string): string | undefined {
  const nameIndex = headers.indexOf("pilot1_name");
  if (nameIndex < 0) return undefined;

  const counts = new Map<string, number>();
  let populated = 0;
  for (const row of rows.slice(1)) {
    const columns = parseCSVRow(row, delimiter);
    if (nameIndex >= columns.length) continue;
    const raw = columns[nameIndex]!.trim();
    if (raw.length === 0 || raw.toUpperCase() === "SELF") continue;
    populated += 1;
    const key = normalizedName(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (populated === 0) return undefined;

  let best: { name: string; count: number } | undefined;
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { name, count };
  }
  if (!best) return undefined;
  return best.count * 2 > populated ? best.name : undefined;
}

/** Mirrors `isSelfReference`. */
function isSelfReference(name: string, ownerNames: Set<string>): boolean {
  const trimmed = name.trim();
  if (trimmed.toUpperCase() === "SELF") return true;
  return ownerNames.size > 0 && ownerNames.has(normalizedName(trimmed));
}

function ensureSelfPerson(people: Map<string, ImportedPerson>): void {
  if (people.has("SELF")) return;
  people.set("SELF", {
    refId: "SELF",
    defaultRole: "PIC",
    isExisting: { existing: false },
    isImportedFromOtherLogbook: true
  });
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

function colIndex(headers: string[], name: string): number {
  return headers.indexOf(name);
}

/** Mirrors `hasValue`, true for an explicit value, including `"00:00"`. */
function hasValue(name: string, columns: string[], headers: string[]): boolean {
  const idx = colIndex(headers, name);
  return idx >= 0 && (columns[idx]?.length ?? 0) > 0;
}

/** Mirrors `getMinutes`, HH:MM or bare-integer-minutes duration columns. */
function getMinutes(name: string, columns: string[], headers: string[]): number {
  const idx = colIndex(headers, name);
  if (idx < 0) return 0;
  return colonOrBareMinutesDuration(columns[idx] ?? "");
}

/** Mirrors `boolValue`, raw exports use `TRUE`/`FALSE`. */
function boolValue(name: string, columns: string[], headers: string[]): boolean {
  const idx = colIndex(headers, name);
  if (idx < 0) return false;
  return (columns[idx] ?? "").trim().toLowerCase() === "true";
}

function manualTimeIfPresent(name: string, columns: string[], headers: string[]): Time | undefined {
  if (!hasValue(name, columns, headers)) return undefined;
  return time(getMinutes(name, columns, headers));
}

/** Mirrors `convertToMinutes`, clock-time columns are always `H:MM`, even in the raw export. */
function convertToMinutes(raw: string): number {
  return colonMinutes(raw);
}

/** Mirrors `dateColumnIndex`: `pilotlog_date` (raw/web export) or `mcc_date` (standalone desktop export). */
function dateColumnIndex(headers: string[]): number {
  const raw = colIndex(headers, "pilotlog_date");
  return raw >= 0 ? raw : colIndex(headers, "mcc_date");
}

function isoDateOnlyIfValid(trimmed: string): DateOnly | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

/** Mirrors `parsePilotLogDate`: `YYYY-MM-DD` (classic) or `DD-MM-YYYY`/`DD/MM/YYYY`/`DD.MM.YYYY` (raw/European). */
function parsePilotLogDate(raw: string): DateOnly | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const separator = trimmed.includes("/") ? "/" : trimmed.includes(".") ? "." : "-";
  const rawParts = trimmed.split(separator);
  const parts = rawParts.map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : -1;
  });
  if (parts.length !== 3 || parts.some((p) => p === -1)) return isoDateOnlyIfValid(trimmed);

  let year: number;
  let month: number;
  let day: number;
  if (parts[0]! > 31) {
    [year, month, day] = parts as [number, number, number];
  } else if (parts[2]! > 31) {
    [day, month, year] = parts as [number, number, number];
  } else {
    return isoDateOnlyIfValid(trimmed);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
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
// Simulator-row detection (Priority 1/2/3, `isSimulatorEntry`/`simFreeTextFallback`)
// ---------------------------------------------------------------------------

const SIM_FREE_TEXT_REGEX = /\b(?:sims?|simulator\w*|(?:ffs|ftd|fstd)\d*)\b/i;
const SIM_SLOT_DESIGNATOR_REGEX = /^[A-Z]\d$/i;
const FSTD_REGISTRATION_SHAPE_PATTERNS: RegExp[] = [/^NL-?\d/i, /^[A-Z]{2}-\dA-\d+$/i, /^EU-/i, /^SIM/i, /^FNPT/i, /^CT-?\d/i];

function isSimSlotDesignator(value: string): boolean {
  return SIM_SLOT_DESIGNATOR_REGEX.test(value);
}

/** Mirrors `isNonAircraftIdentity`, the Priority-3 aircraft-identity gate. */
function isNonAircraftIdentity(registration: string): boolean {
  if (registration.length === 0) return true;
  if (registration.toUpperCase().startsWith("XX-")) return true;
  return FSTD_REGISTRATION_SHAPE_PATTERNS.some((p) => p.test(registration));
}

/** Mirrors `simFreeTextFallback`, see the iOS source's extensive doc
 * comment for the full gate-by-gate rationale; ported verbatim here. */
function simFreeTextFallback(columns: string[], headers: string[]): boolean {
  // (1) Explicit-value veto
  const acIsSimIdx = colIndex(headers, "ac_issim");
  if (acIsSimIdx >= 0 && (columns[acIsSimIdx] ?? "").trim().length > 0) return false;

  // (2) Widened fail-closed structural zero guard
  const zeroGuardColumns = [
    "to_day",
    "to_night",
    "ldg_day",
    "ldg_night",
    "time_air",
    "time_night",
    "time_xc",
    "time_pic",
    "time_dual",
    "time_to",
    "time_ldg"
  ];
  for (const name of zeroGuardColumns) {
    const idx = colIndex(headers, name);
    if (idx < 0) return false;
    const value = (columns[idx] ?? "").trim();
    if (!(value === "" || value === "0" || value === "00:00")) return false;
  }

  // (3) Airport gate
  const afDepIdx = colIndex(headers, "af_dep");
  const afArrIdx = colIndex(headers, "af_arr");
  if (afDepIdx < 0 || afArrIdx < 0) return false;
  const dep = (columns[afDepIdx] ?? "").trim().toUpperCase();
  const arr = (columns[afArrIdx] ?? "").trim().toUpperCase();
  if (dep !== arr) return false;

  // (4) Aircraft-identity gate
  const acRegIdx = colIndex(headers, "ac_reg");
  if (acRegIdx < 0) return false;
  const registration = (columns[acRegIdx] ?? "").trim();
  if (!isNonAircraftIdentity(registration)) return false;

  // (5) Shared time_total gate
  if (colIndex(headers, "time_total") < 0) return false;
  const totalMinutes = getMinutes("time_total", columns, headers);
  if (totalMinutes <= 0) return false;

  // (5a) Free-text self-description path
  const text = ["flightlog", "remarks", "training"]
    .map((name) => colIndex(headers, name))
    .filter((idx) => idx >= 0)
    .map((idx) => columns[idx] ?? "")
    .join(" ");
  if (text.length > 0 && SIM_FREE_TEXT_REGEX.test(text)) return true;

  // (5b) Structural no-text path
  if ((columns[afDepIdx] ?? "").trim().length === 0) return false;
  const flightNumberIdx = colIndex(headers, "flightnumber");
  if (flightNumberIdx < 0) return false;
  const flightNumberValue = (columns[flightNumberIdx] ?? "").trim();
  if (!(flightNumberValue.length === 0 || isSimSlotDesignator(flightNumberValue))) return false;

  return true;
}

/** Mirrors `isSimulatorEntry`. */
function isSimulatorEntry(columns: string[], headers: string[]): boolean {
  const acIsSimIdx = colIndex(headers, "ac_issim");
  if (acIsSimIdx >= 0) {
    const value = (columns[acIsSimIdx] ?? "").trim().toLowerCase();
    if (value === "sim" || value === "true") return true;
  }
  const fnIdx = colIndex(headers, "flightnumber");
  if (fnIdx >= 0 && (columns[fnIdx] ?? "").toUpperCase() === "SIM") return true;
  return simFreeTextFallback(columns, headers);
}

// ---------------------------------------------------------------------------
// KLM training-session codes
// ---------------------------------------------------------------------------

interface FSTDTrainingCode {
  sessionType: string;
  role?: EntryPersonRole;
}

/** Mirrors `trainingCodes`. */
const TRAINING_CODES: Record<string, FSTDTrainingCode> = {
  TSLPC: { sessionType: "LPC" },
  TSLPCI: { sessionType: "LPC", role: "FSTD_INS" },
  TSLPCH: { sessionType: "LPC", role: "FSTD_TRN" },
  TSTR1: { sessionType: "Type Recurrent 1" },
  TSTR1I: { sessionType: "Type Recurrent 1", role: "FSTD_INS" },
  TSTR2I: { sessionType: "Type Recurrent 2", role: "FSTD_INS" },
  TSLOE: { sessionType: "LOE" },
  TSLOEI: { sessionType: "LOE", role: "FSTD_INS" },
  TSLOE2I: { sessionType: "LOE 2", role: "FSTD_INS" },
  TSLOEH: { sessionType: "LOE", role: "FSTD_TRN" },
  TSOD: { sessionType: "Other Duty" },
  TSODI: { sessionType: "Other Duty", role: "FSTD_INS" },
  TSTQ: { sessionType: "Type Rating Course" },
  TSTQI: { sessionType: "Type Rating Course", role: "FSTD_INS" },
  TSPQS: { sessionType: "Opposite Seat Qualification" },
  TSPQSI: { sessionType: "Opposite Seat Qualification", role: "FSTD_INS" },
  TSDTI: { sessionType: "Difference Training", role: "FSTD_INS" },
  TSIEV1: { sessionType: "Instructor Evaluation", role: "FSTD_INS" },
  TSIEV2: { sessionType: "Instructor Evaluation", role: "FSTD_INS" },
  TSIEVI: { sessionType: "Instructor Evaluation", role: "FSTD_SI" },
  TSIAOC: { sessionType: "Assessment of Competence", role: "FSTD_INS" },
  TSEAOC: { sessionType: "Assessment of Competence", role: "FSTD_EXA" }
};

const TRAINING_CODE_REGEX = new RegExp(`\\b(?:${Object.keys(TRAINING_CODES).join("|")})\\b`, "gi");

/** Mirrors `fstdTrainingCode`: returns the decoded code only when exactly one
 * distinct recognised code is present across `flightlog`/`training`. */
function fstdTrainingCode(columns: string[], headers: string[]): FSTDTrainingCode | undefined {
  const text = ["flightlog", "training"]
    .map((name) => colIndex(headers, name))
    .filter((idx) => idx >= 0)
    .map((idx) => columns[idx] ?? "")
    .join(" ");
  if (text.length === 0) return undefined;

  const distinct = new Set<string>();
  for (const match of text.matchAll(TRAINING_CODE_REGEX)) distinct.add(match[0]!.toUpperCase());
  if (distinct.size !== 1) return undefined;
  const code = [...distinct][0]!;
  return TRAINING_CODES[code];
}

// ---------------------------------------------------------------------------
// Role determination
// ---------------------------------------------------------------------------

/** Mirrors `determineSelfRole`. */
function determineSelfRole(columns: string[], headers: string[], seatIndex: number): EntryPersonRole {
  const examinerTime = getMinutes("time_examiner", columns, headers);
  const instructorTime = getMinutes("time_instructor", columns, headers);
  const totalTime = getMinutes("time_total", columns, headers);
  const picusTime = getMinutes("time_picus", columns, headers);
  const dualTime = getMinutes("time_dual", columns, headers);
  const reliefTime = getMinutes("time_relief", columns, headers);
  const picTime = getMinutes("time_pic", columns, headers);
  const sicTime = getMinutes("time_sic", columns, headers);

  if (examinerTime > 0) return "FE";
  if (instructorTime > 0) return "FI";
  if (picusTime > 0) return "PICUS";
  if (dualTime > 0) return "STU";
  if (reliefTime > 0) return "CRCP";
  if (totalTime > 0 && picTime > 0 && sicTime > 0 && picTime === totalTime && sicTime === totalTime) return "PICUS";
  if (picTime > 0) return "PIC";
  if (sicTime > 0) return "CP";

  switch (seatIndex) {
    case 1:
      return "PIC";
    case 2:
      return "CP";
    case 3:
    case 4:
      return "CRCP";
    default:
      return "PIC";
  }
}

/** Mirrors `determineFSTDRole`. */
function determineFSTDRole(columns: string[], headers: string[], trainingCodeRole: EntryPersonRole | undefined): EntryPersonRole {
  if (trainingCodeRole !== undefined) return trainingCodeRole;
  const instructorTime = getMinutes("time_instructor", columns, headers);
  return instructorTime > 0 ? "FSTD_INS" : "FSTD_TRN";
}

/** Mirrors `hasOwnPilotFunctionTimeSignal`. */
function hasOwnPilotFunctionTimeSignal(columns: string[], headers: string[]): boolean {
  return ["time_relief", "time_sic", "time_pic", "time_picus", "time_dual", "time_instructor", "time_examiner"].some(
    (c) => getMinutes(c, columns, headers) > 0
  );
}

/**
 * Mirrors `applyCRCPCreditFromLoggedRelief`, PilotLog's `time_relief` is the
 * pilot's REST time off the controls during a cruise-relief sector, not the
 * co-pilot seat time to credit. When `time_sic` is blank/zero (no pilot
 * names in the export, so every relief row lands here with nothing else to
 * go on), derive the credited co-pilot time as `block - 60min - relief`
 * instead of leaving `Times.coPilot` unset.
 */
function applyCRCPCreditFromLoggedRelief(entry: ImportedEntry, resolvedSelfRole: EntryPersonRole | undefined): void {
  if (resolvedSelfRole !== "CRCP") return;
  const reliefMinutes = entry.manualTimes?.cruiseReliefCoPilot?.totalMinutes;
  if (reliefMinutes === undefined || reliefMinutes <= 0) return;
  if ((entry.manualTimes?.coPilot?.totalMinutes ?? 0) !== 0) return;
  const blockMinutes = normalizedFlightBlockMinutesForImport(entry);
  if (blockMinutes === undefined) return;

  const creditedMinutes = blockMinutes - 60 - reliefMinutes;
  if (creditedMinutes <= 0) return;
  entry.manualTimes = { ...(entry.manualTimes ?? {}), coPilot: time(creditedMinutes) };
}

// ---------------------------------------------------------------------------
// Authoritative-time field tables
// ---------------------------------------------------------------------------

/** Mirrors `authoritativeFlightTimeFields`. `time_night`/`time_ifr` are
 * applied whenever present, including an explicit `"0:00"`, see
 * `applyAuthoritativeTimes`'s doc comment and the "zero is a real logged
 * value" tests in `pilotlog.test.ts`. */
const AUTHORITATIVE_FLIGHT_TIME_FIELDS: AuthoritativeTimeField[] = [
  single("time_total", "totalTimeOfFlight"),
  single("time_air", "totalAirTime"),
  single("time_pic", "pilotInCommand"),
  single("time_sic", "coPilot"),
  single("time_picus", "picus"),
  single("time_relief", "cruiseReliefCoPilot"),
  single("time_dual", "dual"),
  single("time_instructor", "instructor"),
  single("time_examiner", "examiner"),
  single("time_night", "night"),
  single("time_ifr", "ifr"),
  single("time_xc", "crossCountry")
];

const AUTHORITATIVE_FSTD_TIME_FIELDS: AuthoritativeTimeField[] = [single("time_total", "fstdSession")];

function applyAuthoritativeFlightTimes(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FLIGHT_TIME_FIELDS, (column) => manualTimeIfPresent(column, columns, headers), entry);
}

function applyAuthoritativeFSTDTime(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FSTD_TIME_FIELDS, (column) => manualTimeIfPresent(column, columns, headers), entry, false);
}

// ---------------------------------------------------------------------------
// People / aircraft collection
// ---------------------------------------------------------------------------

function getPerson(
  columns: string[],
  headers: string[],
  index: number,
  people: Map<string, ImportedPerson>,
  ownerNames: Set<string>
): ImportedPerson | undefined {
  const idIdx = colIndex(headers, `pilot${index}_id`);
  const nameIdx = colIndex(headers, `pilot${index}_name`);
  if (idIdx < 0 || nameIdx < 0) return undefined;

  const id = columns[idIdx] ?? "";
  const name = columns[nameIdx] ?? "";
  if (isSelfReference(name, ownerNames)) return people.get("SELF");

  const key = id.length > 0 ? id : name.length > 0 ? name : undefined;
  return key !== undefined ? people.get(key) : undefined;
}

const SEAT_DEFAULT_ROLE: Record<number, EntryPersonRole> = { 1: "PIC", 2: "CP", 3: "CRCP", 4: "CRCP" };

function addPersonIfNeeded(columns: string[], headers: string[], people: Map<string, ImportedPerson>, ownerNames: Set<string>): void {
  for (let i = 1; i <= 4; i++) {
    const idIdx = colIndex(headers, `pilot${i}_id`);
    const nameIdx = colIndex(headers, `pilot${i}_name`);
    if (idIdx < 0 || nameIdx < 0) continue;

    const id = columns[idIdx] ?? "";
    const name = columns[nameIdx] ?? "";

    if (isSelfReference(name, ownerNames)) {
      ensureSelfPerson(people);
      continue;
    }

    const key = id.length > 0 ? id : name.length > 0 ? name : undefined;
    if (key === undefined || people.has(key) || name.length === 0) continue;

    const names = name.trim().split(/\s+/);
    const firstName = names[0];
    const lastName = names.slice(1).join(" ") || undefined;

    people.set(key, {
      refId: key,
      firstName,
      lastName,
      defaultRole: SEAT_DEFAULT_ROLE[i],
      employeeNumber: id || undefined,
      isExisting: { existing: false },
      isImportedFromOtherLogbook: true
    });
  }
}

function addAircraftIfNeeded(columns: string[], headers: string[], aircraft: Map<string, ImportedAircraft>): void {
  const regIdx = colIndex(headers, "ac_reg");
  if (regIdx < 0) return;
  const cleaned = cleanRegistration(columns[regIdx]);
  if (!cleaned || aircraft.has(cleaned)) return;
  aircraft.set(cleaned, { registration: cleaned, isImportedFromOtherLogbook: true });
}

// ---------------------------------------------------------------------------
// Row -> entry
// ---------------------------------------------------------------------------

interface RowContext {
  columns: string[];
  headers: string[];
  row: number;
  isRawFormat: boolean;
  ownerNames: Set<string>;
  people: Map<string, ImportedPerson>;
  importErrors: ImportError[];
}

function createSimulatorEntry(ctx: RowContext): ImportedEntry | undefined {
  const { columns, headers, row, isRawFormat, ownerNames, people, importErrors } = ctx;

  const dateIdx = dateColumnIndex(headers);
  const acRegIdx = colIndex(headers, "ac_reg");
  const timeDepIdx = colIndex(headers, "time_dep");
  const timeArrIdx = colIndex(headers, "time_arr");
  if (dateIdx < 0 || acRegIdx < 0 || timeDepIdx < 0 || timeArrIdx < 0) {
    importErrors.push({ reason: "Unexpected headers for simulator entry", rowNumber: row });
    return undefined;
  }

  const dateString = columns[dateIdx] ?? "";
  const date = parsePilotLogDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: "Could not parse date", dateString, rowNumber: row });
    return undefined;
  }

  const fstdId = columns[acRegIdx] ?? "";
  const deviceCategoryHint = fstdId.length > 0 ? fstdDeviceCategoryFromFreeText(fstdId) : undefined;

  const startTime = time(convertToMinutes(columns[timeDepIdx] ?? ""));
  let endTime = time(convertToMinutes(columns[timeArrIdx] ?? ""));

  const hasImportedSessionDuration = hasValue("time_total", columns, headers);
  const importedSessionMinutes = getMinutes("time_total", columns, headers);
  if (hasImportedSessionDuration) {
    endTime = time((startTime.totalMinutes + importedSessionMinutes) % 1440);
  }

  const remarksIdx = colIndex(headers, "remarks");
  const remarks = truncatedRemarks(
    remarksIdx >= 0 && (columns[remarksIdx] ?? "").length > 0 ? columns[remarksIdx] : undefined,
    importErrors,
    { dateString }
  );

  const trainingCode = fstdTrainingCode(columns, headers);

  const entry = newImportedEntry({
    date,
    type: "fstd",
    fstdId: fstdId || undefined,
    sessionType: trainingCode?.sessionType,
    startTime,
    endTime,
    updateFlightData: false,
    isImportedFromOtherLogbook: true,
    remarks
  });
  entry.fstdDeviceCategory = deviceCategoryHint;

  const pilot1 = getPerson(columns, headers, 1, people, ownerNames);
  if (pilot1) {
    if (pilot1.refId === "SELF") {
      upsertCrew(entry.crew, { refId: "SELF", role: determineFSTDRole(columns, headers, trainingCode?.role) });
    } else {
      upsertCrew(entry.crew, { refId: pilot1.refId, role: "FSTD_TRN" });
    }
  }
  for (const idx of [2, 3, 4]) {
    const pilot = getPerson(columns, headers, idx, people, ownerNames);
    if (pilot) upsertCrew(entry.crew, { refId: pilot.refId, role: "FSTD_TRN" });
  }

  if (isRawFormat && !entry.crew.some((c) => c.refId === "SELF")) {
    ensureSelfPerson(people);
    upsertCrew(entry.crew, { refId: "SELF", role: determineFSTDRole(columns, headers, trainingCode?.role) });
  }

  if (!entry.crew.some((c) => c.refId === "SELF")) {
    importErrors.push({
      code: "roleMissingSimulator",
      reason: "You have no role set on this simulator session",
      dateString,
      registration: fstdId,
      entryId: entry.id
    });
  }

  applyAuthoritativeFSTDSessionDuration(entry, importedSessionMinutes > 0 ? importedSessionMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFSTDTime(columns, headers, entry);
  return entry;
}

function createFlightEntry(ctx: RowContext): ImportedEntry | undefined {
  const { columns, headers, row, isRawFormat, ownerNames, people, importErrors } = ctx;

  const isPreviousExperience = isRawFormat && boolValue("is_prevexp", columns, headers);

  const dateIdx = dateColumnIndex(headers);
  const flightNumberIdx = colIndex(headers, "flightnumber");
  const acRegIdx = colIndex(headers, "ac_reg");
  const afDepIdx = colIndex(headers, "af_dep");
  const afArrIdx = colIndex(headers, "af_arr");
  const timeDepIdx = colIndex(headers, "time_dep");
  const timeToIdx = colIndex(headers, "time_to");
  const timeLdgIdx = colIndex(headers, "time_ldg");
  const timeArrIdx = colIndex(headers, "time_arr");
  const toDayIdx = colIndex(headers, "to_day");
  const toNightIdx = colIndex(headers, "to_night");
  const ldgDayIdx = colIndex(headers, "ldg_day");
  const ldgNightIdx = colIndex(headers, "ldg_night");

  if (
    dateIdx < 0 ||
    flightNumberIdx < 0 ||
    acRegIdx < 0 ||
    afDepIdx < 0 ||
    afArrIdx < 0 ||
    timeDepIdx < 0 ||
    timeToIdx < 0 ||
    timeLdgIdx < 0 ||
    timeArrIdx < 0 ||
    toDayIdx < 0 ||
    toNightIdx < 0 ||
    ldgDayIdx < 0 ||
    ldgNightIdx < 0
  ) {
    importErrors.push({ reason: "Unexpected headers", rowNumber: row });
    return undefined;
  }

  const dateString = columns[dateIdx] ?? "";
  const date = parsePilotLogDate(dateString);
  if (date === undefined) {
    importErrors.push({ reason: "Could not parse date", dateString, rowNumber: row });
    return undefined;
  }

  const flightNumber = columns[flightNumberIdx] ?? "";
  const scheduledOffBlocksIdx = colIndex(headers, "time_depsch");
  const scheduledOffBlocks = scheduledOffBlocksIdx >= 0 ? time(convertToMinutes(columns[scheduledOffBlocksIdx] ?? "")) : undefined;
  const registration = columns[acRegIdx] ?? "";
  const from = canonicalCode(columns[afDepIdx]) ?? "";
  const to = canonicalCode(columns[afArrIdx]) ?? "";

  let offBlocks: Time | undefined = time(convertToMinutes(columns[timeDepIdx] ?? ""));
  let airborne: Time | undefined = time(convertToMinutes(columns[timeToIdx] ?? ""));
  let touchdown: Time | undefined = time(convertToMinutes(columns[timeLdgIdx] ?? ""));
  let onBlocks: Time | undefined = time(convertToMinutes(columns[timeArrIdx] ?? ""));

  const hasImportedBlockDuration = hasValue("time_total", columns, headers);
  const importedBlockMinutes = getMinutes("time_total", columns, headers);
  const hasImportedAirDuration = hasValue("time_air", columns, headers);
  const importedAirMinutes = getMinutes("time_air", columns, headers);

  if (hasImportedBlockDuration) {
    if (offBlocks === undefined) offBlocks = time(0);
    onBlocks = time(offBlocks.totalMinutes + importedBlockMinutes);
  }

  if (hasImportedAirDuration && airborne !== undefined) {
    touchdown = time((airborne.totalMinutes + importedAirMinutes) % 1440);
  }

  if (airborne !== undefined && touchdown !== undefined && airborne.totalMinutes === 0 && touchdown.totalMinutes === 0) {
    airborne = undefined;
    touchdown = undefined;
  }

  const takeoffsDay = Number.parseInt(columns[toDayIdx] ?? "", 10) || 0;
  const takeoffsNight = Number.parseInt(columns[toNightIdx] ?? "", 10) || 0;
  const landingsDay = Number.parseInt(columns[ldgDayIdx] ?? "", 10) || 0;
  const landingsNight = Number.parseInt(columns[ldgNightIdx] ?? "", 10) || 0;
  const takeoffsAndLandings: TakeoffsAndLandings = { type: "manual", takeoffsDay, takeoffsNight, landingsDay, landingsNight };

  const remarksIdx = colIndex(headers, "remarks");
  const remarks = truncatedRemarks(
    remarksIdx >= 0 && (columns[remarksIdx] ?? "").length > 0 ? columns[remarksIdx] : undefined,
    importErrors,
    { dateString, flightNumber, registration }
  );

  const updateFlightData = !(offBlocks !== undefined || airborne !== undefined || touchdown !== undefined || onBlocks !== undefined);

  const entry = newImportedEntry({
    date,
    type: "flight",
    flightNumber: flightNumber || undefined,
    registration: cleanRegistration(registration),
    from: from || undefined,
    to: to || undefined,
    scheduledOffBlocks,
    offBlocks,
    airborne,
    touchdown,
    onBlocks,
    updateFlightData,
    takeoffsAndLandings,
    isImportedFromOtherLogbook: true,
    remarks
  });

  for (const idx of [1, 2, 3, 4]) {
    const pilot = getPerson(columns, headers, idx, people, ownerNames);
    if (!pilot) continue;
    if (pilot.refId === "SELF") {
      upsertCrew(entry.crew, { refId: "SELF", role: determineSelfRole(columns, headers, idx) });
    } else {
      upsertCrew(entry.crew, { refId: pilot.refId, role: idx === 1 ? "PIC" : idx === 2 ? "CP" : "CRCP" });
    }
  }

  // Blank-pilot-slot SELF fallback: raw exports never name SELF directly in a
  // pilot slot (owner time lives in the role columns); a non-raw export with
  // every pilot slot blank gets the same fallback, but only when the row
  // carries an own pilot-function time signal, see `hasOwnPilotFunctionTimeSignal`.
  if (
    !entry.crew.some((c) => c.refId === "SELF") &&
    (isRawFormat || (entry.crew.length === 0 && hasOwnPilotFunctionTimeSignal(columns, headers)))
  ) {
    ensureSelfPerson(people);
    upsertCrew(entry.crew, { refId: "SELF", role: determineSelfRole(columns, headers, 1) });
  }

  if (!entry.crew.some((c) => c.refId === "SELF")) {
    importErrors.push({
      code: "roleMissingFlight",
      reason: "You have no role set on this flight",
      dateString,
      flightNumber,
      registration,
      entryId: entry.id
    });
  }

  if (!isPreviousExperience) {
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
  }

  if (isPreviousExperience) {
    // Accumulated previous-experience hours are always bulk, even below the
    // 24h threshold: there is no per-flight timeline or route to anchor them.
    const times: Times = { ...(entry.manualTimes ?? {}), totalTimeOfFlight: time(Math.max(0, importedBlockMinutes)) };
    entry.manualTimes = times;
    entry.isBulk = true;
    entry.offBlocks = undefined;
    entry.onBlocks = undefined;
    entry.airborne = undefined;
    entry.touchdown = undefined;
    entry.from = undefined;
    entry.to = undefined;
  } else {
    applyAuthoritativeFlightBlockDuration(entry, importedBlockMinutes > 0 ? importedBlockMinutes : undefined);
  }
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFlightTimes(columns, headers, entry);

  const selfRole = entry.crew.find((c) => c.refId === "SELF")?.role;
  const resolvedSelfRole = retaggedLosslessPICUSRole(entry, selfRole);
  if (resolvedSelfRole !== undefined && resolvedSelfRole !== selfRole) {
    upsertCrew(entry.crew, { refId: "SELF", role: resolvedSelfRole });
  }
  // Must run BEFORE normalize: normalize's CRCP case clears
  // `manualTimes.cruiseReliefCoPilot` once the role is known, and this
  // function still needs to read it.
  applyCRCPCreditFromLoggedRelief(entry, resolvedSelfRole);
  normalizeImportedFlightManualTimes(entry, resolvedSelfRole);

  return entry;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/** Parses PilotLog CSV/text content (either export variant) into an `ImportResult`. */
export function parsePilotLogCsv(csvText: string): ImportResult {
  const importErrors: ImportError[] = [];
  const cleaned = cleanCSVString(csvText);
  const rows = splitCSVIntoProperLines(cleaned);

  if (rows.length === 0) {
    importErrors.push({ reason: "CSV data is empty." });
    return { entries: [], people: [], aircraft: [], importErrors, skippedUnchangedCount: 0 };
  }

  const delimiter = detectDelimiter(rows[0]!);
  const headers = parseCSVRow(rows[0]!, delimiter).map((h) => h.trim().toLowerCase());
  const isRawFormat = headers.includes("is_prevexp");

  const ownerNames = new Set<string>();
  if (isRawFormat) {
    const dominant = dominantPilotName(rows, headers, delimiter);
    if (dominant) ownerNames.add(dominant);
  }

  const people = new Map<string, ImportedPerson>();
  const aircraft = new Map<string, ImportedAircraft>();
  const entries: ImportedEntry[] = [];

  const dataRows = rows.slice(1);
  for (let index = 0; index < dataRows.length; index++) {
    const row = dataRows[index]!;
    const columns = parseCSVRow(row, delimiter);
    // Allow trailing delimiters (data may have more columns than headers).
    if (columns.length < headers.length) continue;

    addPersonIfNeeded(columns, headers, people, ownerNames);
    addAircraftIfNeeded(columns, headers, aircraft);

    const ctx: RowContext = { columns, headers, row: index, isRawFormat, ownerNames, people, importErrors };
    const isPreviousExperience = isRawFormat && boolValue("is_prevexp", columns, headers);
    const entry = !isPreviousExperience && isSimulatorEntry(columns, headers) ? createSimulatorEntry(ctx) : createFlightEntry(ctx);
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

/** Mirrors `PilotLogImporter.getCSVFilePath(fromDirectory:)`: the first
 * TOP-LEVEL (non-recursive) zip entry whose name has a case-SENSITIVE
 * `.csv` suffix, in zip-entry order. `undefined` when none is found. */
function firstTopLevelCsvEntry(entries: Record<string, Uint8Array>): { name: string; bytes: Uint8Array } | undefined {
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.includes("/")) continue; // top-level only, like the iOS app's non-recursive directory listing
    if (!path.endsWith(".csv")) continue; // case-sensitive, like the iOS app
    return { name: path, bytes };
  }
  return undefined;
}

function pilotLogZipCsvText(buffer: Buffer): string {
  const entries = unzipEntries(buffer);
  const found = firstTopLevelCsvEntry(entries);
  if (!found) {
    throw new Error("No CSV file found in the zip archive.");
  }
  return decodeZipText(found.bytes);
}

export const pilotLogImporter: Importer = {
  id: "pilotlog",
  displayName: "PilotLog / CrewLounge / mccPILOTLOG export (CSV or zipped backup)",
  extensions: ["csv", "txt", "zip"],
  detect(buffer: Buffer, filename: string | undefined): number {
    let text: string;
    if (looksLikeZip(buffer) || pilotLogFileKind(filename) === "zip") {
      try {
        text = pilotLogZipCsvText(buffer);
      } catch {
        return 0;
      }
    } else {
      text = buffer.toString("utf8");
    }
    const firstLine = cleanCSVString(text).split("\n")[0] ?? "";
    if (firstLine.length === 0) return 0;
    const delimiter = detectDelimiter(firstLine);
    const headers = parseCSVRow(firstLine, delimiter).map((h) => h.trim().toLowerCase());
    const hasDateColumn = headers.includes("pilotlog_date") || headers.includes("mcc_date");
    const hasPilotLogShape = headers.includes("ac_reg") && (headers.includes("af_dep") || headers.includes("flightnumber"));
    return hasDateColumn && hasPilotLogShape ? 0.75 : 0;
  },
  async parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult> {
    const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    if (looksLikeZip(buffer) || pilotLogFileKind(options?.filename) === "zip") {
      let text: string;
      try {
        text = pilotLogZipCsvText(buffer);
      } catch (err) {
        return {
          entries: [],
          people: [],
          aircraft: [],
          importErrors: [{ reason: err instanceof Error ? err.message : String(err), sourceFileName: options?.filename }],
          skippedUnchangedCount: 0
        };
      }
      return parsePilotLogCsv(text);
    }
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parsePilotLogCsv(text);
  }
};
