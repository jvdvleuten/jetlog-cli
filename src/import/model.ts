/**
 * The intermediate import model.
 *
 * Ported from the Jetlog iOS app's import model. This is the shape every
 * format importer produces: a row-oriented
 * `ImportedEntry`/`ImportedPerson`/`ImportedAircraft` model that mirrors the
 * iOS app's own intermediate import representation, with field names kept as
 * close to the app's as possible (camelCase, same names) so the two
 * codebases stay easy to compare.
 *
 * ## What is not ported here
 *
 * The iOS `ImportedEntry` carries a large amount of state that only makes
 * sense when importing into a local on-device store that already holds the
 * user's existing entries/people/aircraft (`isExisting`, `matchedResolution`,
 * `isDuplicateOfEarlierRow`, `clearedFields`, `manualTimesAreAuthoritative`,
 * `preferredNewId`, `replaceCrew`, and the whole merge-against-existing-store
 * pass). This CLI has no local store to match against: every importer run is
 * offline, one file in, one `ImportResult` out, so none of that merge/match
 * machinery lives in the importers. Every row they produce is effectively the
 * iOS app's `.no` (brand-new, unmatched) case. Fields kept for parity but
 * always `undefined`/unused here are called out below. (`match.ts` and
 * `merge.ts` do the matching and merging afterwards, against the remote
 * mirror.)
 *
 * Also skipped (UI/preview-only, no bearing on what an importer parses):
 * `ImportPreviewTotals`, `ImportOverrideComparison`, `ImportTypoScanner`,
 * `LogTenPartialSICReview`'s UI pieces, and the import time policy's
 * `ImportRowTimeFacts`/`ImportRowConversionPreview`/`effectiveImportNightPolicy`
 * (the import-review night/IFR chip result panel, which depends on the merge
 * and a cached solar calculation, neither of which exist offline). The plain
 * `ImportNightPolicy`/`ImportIFRPolicy`/`ImportTimePolicies` enums and
 * `applyImportTimePolicies` are kept (see below) since `LogTenPartialSICReview`
 * reuses the same night/IFR resolution during parsing itself, not just in the UI.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A calendar date with no time component, "YYYY-MM-DD". Mirrors `DateOnly`'s
 * wire representation (`iso8601String`); we don't port its julian-day-number
 * storage since nothing here needs calendar arithmetic beyond comparisons,
 * which plain ISO date strings already support lexicographically. */
export type DateOnly = string;

/**
 * A time-of-day or a duration, in total minutes. Mirrors `Time`:
 * time-of-day is `0..1439`, a duration can exceed
 * 1440 (bulk/bulk-adjacent entries). Negative values are invalid (the app's
 * initializer throws); callers here should clamp/validate at parse time
 * instead of constructing an invalid `Time`.
 */
export interface Time {
  totalMinutes: number;
}

export function time(totalMinutes: number): Time {
  return { totalMinutes: Math.max(0, Math.round(totalMinutes)) };
}

/** HH:MM for a time-of-day `Time`. */
export function formatTimeOfDay(t: Time): string {
  const minutes = ((t.totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** H:MM (no leading zero on hours) for a duration `Time`, e.g. LogTen/PilotLog style. */
export function formatDuration(t: Time): string {
  const h = Math.floor(t.totalMinutes / 60);
  const m = t.totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// EntryType / ApproachType / EntryPersonRole
// ---------------------------------------------------------------------------

/** Mirrors `EntryType`. `unknown` carries the
 * server's/source's original raw string, forward-compat, same as the app. */
export type EntryType = "flight" | "fstd" | { unknown: string };

export function entryTypeRawValue(t: EntryType): string {
  if (typeof t === "string") return t;
  return t.unknown;
}

/** Mirrors `ApproachType`. Wire values
 * are the snake_case rawValue strings. */
export type ApproachType =
  | "ils_cat1"
  | "ils_cat2"
  | "ils_cat3"
  | "gls"
  | "rnp"
  | "rnp_ar"
  | "loc"
  | "vor"
  | "ndb"
  | "visual"
  | "circling"
  | "par"
  | { unknown: string };

export function approachTypeRawValue(t: ApproachType): string {
  return typeof t === "string" ? t : t.unknown;
}

export interface ApproachCount {
  type: ApproachType;
  count: number;
  /** How many of `count` ended in an autoland. `undefined` means "not recorded", never `0`. */
  autolands?: number;
}

/**
 * Mirrors `EntryPersonRole`. The
 * string values are the canonical wire codes from that file's `encode(to:)`
 * (e.g. `"PIC"`, `"CP"`, `"FSTD_TRN"`), not the decode-side aliases (`"FO"`,
 * `"CAPTAIN"`, `"captain"`, ...), which importers should normalize to the
 * canonical code before producing an `ImportedEntryCrewMember`.
 */
export type EntryPersonRole =
  | "PIC" // pilotInCommand
  | "CP" // coPilot
  | "CRCP" // cruiseReliefCoPilot
  | "PICUS" // pilotInCommandUnderSuperVision
  | "SPIC" // studentPilotInCommand
  | "RI" // routeInstructor
  | "RI_CP" // routeInstructorCoPilot
  | "LCA" // lineCheckAirman
  | "LCAI" // lineCheckAirmanInitial
  | "LCAIFO" // lineCheckAirmanInitialFO
  | "FI" // flightInstructor
  | "FE" // flightExaminer
  | "SI_PIC" // seniorInstructorPIC
  | "SI_CP" // seniorInstructorCoPilot
  | "SI_OBS" // seniorInstructorObserver
  | "STU" // student
  | "DH" // deadHead
  | "CA" // cabinAttendant
  | "CS" // seniorCabinAttendant
  | "Purser" // purser
  | "SP" // seniorPurser
  | "FSTD_TRN" // fstdTrainee
  | "FSTD_INS" // fstdInstructor
  | "FSTD_EXA" // fstdExaminer
  | "FSTD_OBS" // fstdObserver
  | "FSTD_SI" // fstdSeniorInstructor
  | { unknown: string };

export function entryPersonRoleRawValue(r: EntryPersonRole): string {
  return typeof r === "string" ? r : r.unknown;
}

// ---------------------------------------------------------------------------
// TakeoffsAndLandings
// ---------------------------------------------------------------------------

/** Mirrors `TakeoffsAndLandings`. */
export type TakeoffsAndLandings =
  | { type: "auto"; takeoffs: number; landings: number }
  | { type: "manual"; takeoffsDay: number; takeoffsNight: number; landingsDay: number; landingsNight: number };

export function totalTakeoffs(t: TakeoffsAndLandings): number {
  return t.type === "auto" ? t.takeoffs : t.takeoffsDay + t.takeoffsNight;
}

export function totalLandings(t: TakeoffsAndLandings): number {
  return t.type === "auto" ? t.landings : t.landingsDay + t.landingsNight;
}

// ---------------------------------------------------------------------------
// FSTDDeviceCategory
// ---------------------------------------------------------------------------

/** Mirrors `FSTDDeviceCategory`. */
export type FSTDDeviceCategory = "ffs" | "fnpt" | "ftd" | "bitd";

/** Best-effort category guess
 * from free-text device/type strings an importer's source format supplies.
 * Deliberately conservative: returns `undefined` when the text is ambiguous. */
export function fstdDeviceCategoryFromFreeText(...texts: Array<string | undefined>): FSTDDeviceCategory | undefined {
  const candidates = texts.filter((t): t is string => !!t && t.length > 0);
  if (candidates.length === 0) return undefined;

  const containsSubstring = (needle: string): boolean =>
    candidates.some((t) => t.toUpperCase().includes(needle.toUpperCase()));
  const containsToken = (token: string): boolean =>
    candidates.some((t) => new RegExp(`\\b${token}\\b`, "i").test(t));

  if (containsSubstring("FNPT")) return "fnpt";
  if (containsSubstring("BITD")) return "bitd";
  if (containsToken("FTD")) return "ftd";
  if (containsToken("FFS") || containsToken("FSIM") || containsToken("FFSSIM")) return "ffs";
  return undefined;
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/** Mirrors `Times`, manual function-time
 * overrides. All fields optional/undefined by default. */
export interface Times {
  singlePilotSingleEngine?: Time;
  singlePilotMultiEngine?: Time;
  multiPilot?: Time;
  night?: Time;
  ifr?: Time;
  totalTimeOfFlight?: Time;
  pilotInCommand?: Time;
  coPilot?: Time;
  dual?: Time;
  spic?: Time;
  picus?: Time;
  instructor?: Time;
  examiner?: Time;
  crossCountry?: Time;
  totalAirTime?: Time;
  cruiseReliefCoPilot?: Time;
  fstdSession?: Time;
  isMultiPilot?: boolean;
}

/** Field keys of `Times` that hold a `Time` (i.e. exclude `isMultiPilot`). */
export type TimesFieldKey = Exclude<keyof Times, "isMultiPilot">;

const TIMES_FIELD_KEYS: TimesFieldKey[] = [
  "singlePilotSingleEngine",
  "singlePilotMultiEngine",
  "multiPilot",
  "night",
  "ifr",
  "totalTimeOfFlight",
  "pilotInCommand",
  "coPilot",
  "dual",
  "spic",
  "picus",
  "instructor",
  "examiner",
  "crossCountry",
  "totalAirTime",
  "cruiseReliefCoPilot",
  "fstdSession"
];

/** True when every field is unset; mirrors `Times() == Times()` comparisons
 * scattered through the iOS importers ("collapse an all-empty override back to nil"). */
export function isEmptyTimes(t: Times): boolean {
  return TIMES_FIELD_KEYS.every((k) => t[k] === undefined) && t.isMultiPilot === undefined;
}

/** True when any logged
 * duration is >= 24h (1440 min), which forces the bulk conversion. */
export function timesContainsDayOrLongerDuration(t: Times): boolean {
  return TIMES_FIELD_KEYS.some((k) => (t[k]?.totalMinutes ?? 0) >= 1440);
}

// ---------------------------------------------------------------------------
// ImportedEntryCrewMember / ImportedPerson / ImportedAircraft
// ---------------------------------------------------------------------------

/** Mirrors `ImportedEntryCrewMember`. `refId` identifies the `ImportedPerson`
 * within the same `ImportResult` (see `ImportedPerson.refId`), not a
 * database id, since there is no database offline. */
export interface ImportedEntryCrewMember {
  refId: string;
  role: EntryPersonRole;
}

/**
 * Mirrors `ImportedPerson`. `isExisting`/`preferredNewId` are kept on the
 * type for parity but always `{ existing: false }`/`undefined` here, see
 * the file doc comment (no local store to match against offline).
 */
export interface ImportedPerson {
  refId: string;
  firstName?: string;
  lastName?: string;
  defaultRole?: EntryPersonRole;
  employeeNumber?: string;
  isExisting: { existing: false } | { existing: true; id: string };
  isImportedFromOtherLogbook?: boolean;
  preferredNewId?: string;
}

/** Mirrors `ImportedPerson.displayName`. */
export function personDisplayName(p: ImportedPerson): string {
  return [p.firstName, p.lastName]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0)
    .join(" ");
}

/** Mirrors `ImportedAircraft`. */
export interface ImportedAircraft {
  registration: string;
  icaoCode?: string;
  iataCode?: string;
  systemIcaoCode?: string;
  systemIataCode?: string;
  /** Defaults to `true` (system-resolved type); `false` lets an explicit, importer-supplied code win. */
  useSystem?: boolean;
  isImportedFromOtherLogbook?: boolean;
}

// ---------------------------------------------------------------------------
// ImportError
// ---------------------------------------------------------------------------

/** Mirrors `ImportErrorCode`. */
export type ImportErrorCode =
  | "roleMissingFlight"
  | "roleMissingSimulator"
  | "registrationMissing"
  | "originAirportMissing"
  | "destinationAirportMissing"
  | "fstdIdentifierMissing"
  | "roleInferenceWarningMissingSeat"
  | "roleInferenceWarningAmbiguousSeat"
  | "futureEntriesSkipped"
  | "duplicateRowsInFile"
  | "logTenCustomSwitchConflict";

/** Mirrors `ImportError`. */
export interface ImportError {
  code?: ImportErrorCode;
  reason: string;
  dateString?: string;
  flightNumber?: string;
  registration?: string;
  from?: string;
  to?: string;
  remarks?: string;
  sourceFileName?: string;
  rowNumber?: number;
  entryId?: string;
}

/** Mirrors `ImportError.severity`. */
export function importErrorSeverity(e: ImportError): "error" | "warning" {
  return e.code === "roleInferenceWarningMissingSeat" ||
    e.code === "roleInferenceWarningAmbiguousSeat" ||
    e.code === "duplicateRowsInFile"
    ? "warning"
    : "error";
}

export const MAX_REMARKS_LENGTH = 1000;

/** Mirrors `ImportedEntry.truncatedRemarks`, truncate remarks to
 * `MAX_REMARKS_LENGTH`, appending an `ImportError` (mutating `importErrors`)
 * when truncation actually happens. */
export function truncatedRemarks(
  remarks: string | undefined,
  importErrors: ImportError[],
  context: { dateString?: string; flightNumber?: string; registration?: string } = {}
): string | undefined {
  if (remarks === undefined || remarks.length <= MAX_REMARKS_LENGTH) return remarks;
  importErrors.push({
    reason: `Remarks truncated to ${MAX_REMARKS_LENGTH} characters`,
    dateString: context.dateString,
    flightNumber: context.flightNumber,
    registration: context.registration
  });
  return remarks.slice(0, MAX_REMARKS_LENGTH);
}

// ---------------------------------------------------------------------------
// ImportedEntry
// ---------------------------------------------------------------------------

/**
 * Mirrors `ImportedEntry`. Fields that only matter for merging onto an
 * EXISTING local entry (`isExisting`, `matchedResolution`,
 * `isDuplicateOfEarlierRow`, `clearedFields`, `manualTimesAreAuthoritative`,
 * `preferredNewId`, `replaceCrew`, `actualTimeFieldsCarriedByPayload`,
 * `logTenCustomSwitchIndices` resolution, `matchedViaFlightNumberNormalization`)
 * are kept on the type (for round-tripping/documentation parity with the app)
 * but every importer here always produces the "brand-new row" shape:
 * `isExisting: { existing: false }`, no cleared fields, no duplicate-of-earlier
 * flag. `uniqueId`/`id` are generated per row the same way (random UUID per
 * parse), just so each row in a `Set`-like dedupe has a stable identity
 * within one run.
 */
export interface ImportedEntry {
  uniqueId: string;
  id: string;

  date: DateOnly;
  type: EntryType;
  flightNumber?: string;
  registration?: string;
  /** Planned route. */
  from?: string;
  to?: string;
  /** Flown route, distinct from the plan, only the Excel/CSV path sets these. */
  actualFrom?: string;
  actualTo?: string;
  scheduledOffBlocks?: Time;
  scheduledOnBlocks?: Time;
  offBlocks?: Time;
  airborne?: Time;
  touchdown?: Time;
  onBlocks?: Time;
  startTime?: Time;
  endTime?: Time;
  fstdId?: string;
  sessionType?: string;
  takeoffsAndLandings?: TakeoffsAndLandings;
  approaches?: ApproachCount[];
  goArounds?: number;
  passengersOnBoard?: number;
  fuelPlanned?: number;
  fuelUsed?: number;
  cargoOnBoard?: number;
  /** `false`/`undefined` here always means "manual, local data" (no live
   * flight-data tracking exists offline) unless an importer has a real
   * roster/auto-track signal, see `updateFlightDataIsNonIntentDefault`. */
  updateFlightData?: boolean;
  updateFlightDataIsInferredGapFill: boolean;
  updateFlightDataIsNonIntentDefault: boolean;
  crew: ImportedEntryCrewMember[];
  isExisting: { existing: false } | { existing: true; id: string };
  matchedResolution: "merge" | "createNew";
  isImportedFromOtherLogbook?: boolean;
  isBulk: boolean;
  manualTimes?: Times;

  /** LogTen custom Duty switch columns set on this row, see `LogTenCustomSwitchMapping`. */
  logTenCustomSwitchIndices: Set<number>;

  manualTimesAreAuthoritative: boolean;
  isDuplicateOfEarlierRow: boolean;
  aircraftIcaoCode?: string;
  ifr?: boolean;
  fstdTakeoffs?: number;
  fstdLandings?: number;
  fstdDeviceCategory?: FSTDDeviceCategory;
  /** 1-based line of the source file this entry came from, the header counting as line 1 (set by
   * the line-oriented importers; absent for PDF and JSON sources). Used only to label warnings. */
  sourceRow?: number;
  matchedViaFlightNumberNormalization: boolean;
  preferredNewId?: string;
  replaceCrew: boolean;
  isDuplicateInFile: boolean;

  remarks?: string;
  remarksMergeMode: "replace" | "append";
  isDeleted?: boolean;
}

let importedEntrySeq = 0;
function freshId(): string {
  // Not a real UUID: this CLI never needs cryptographic uniqueness, only a
  // stable per-run identity for Set-like dedupe/duplicate detection. Avoids
  // pulling in `crypto.randomUUID` formatting concerns for something this
  // throwaway.
  importedEntrySeq += 1;
  return `row-${Date.now().toString(36)}-${importedEntrySeq}`;
}

/** Mirrors `ImportedEntry.init(...)`'s defaults (the "brand-new row" shape,
 * see the type's doc comment for which iOS-only fields are omitted here). */
export function newImportedEntry(partial: Partial<ImportedEntry> & { date: DateOnly; type: EntryType }): ImportedEntry {
  const id = freshId();
  return {
    uniqueId: id,
    id,
    updateFlightDataIsInferredGapFill: false,
    updateFlightDataIsNonIntentDefault: false,
    crew: [],
    isExisting: { existing: false },
    matchedResolution: "merge",
    isBulk: false,
    logTenCustomSwitchIndices: new Set(),
    manualTimesAreAuthoritative: false,
    isDuplicateOfEarlierRow: false,
    matchedViaFlightNumberNormalization: false,
    replaceCrew: false,
    isDuplicateInFile: false,
    remarksMergeMode: "replace",
    ...partial
  };
}

// ---------------------------------------------------------------------------
// ImportResult
// ---------------------------------------------------------------------------

/** Mirrors `ImportResult`. Uses arrays instead of `Set` (TS has no
 * `Hashable`-keyed Set semantics); de-duplication is the importer's own
 * responsibility, same as the iOS importers populate their `Set`s. */
export interface ImportResult {
  entries: ImportedEntry[];
  people: ImportedPerson[];
  aircraft: ImportedAircraft[];
  importErrors: ImportError[];
  skippedUnchangedCount: number;
  /** CLI-only: plain-language notes about decisions the importer made for the user (for example which
   * crew member it treated as the pilot). Shown as warnings by every command. */
  notes?: string[];
}

export function emptyImportResult(): ImportResult {
  return { entries: [], people: [], aircraft: [], importErrors: [], skippedUnchangedCount: 0 };
}

/**
 * Mirrors `ImportResult.excludingFutureEntries`. Other-logbook exports can
 * contain rostered flights not yet flown; this drops entries dated after
 * `today` and surfaces one informational `futureEntriesSkipped` error. Only
 * other-logbook importers (PilotLog, LogTen, SafeLog, FlightLogger, Flylog,
 * RBLogbook) should call this; Jetlog's own re-import formats and roster-
 * style imports must not (future entries are first-class there).
 */
export function excludingFutureEntries(result: ImportResult, today: DateOnly): ImportResult {
  const futureEntries = result.entries.filter((e) => e.date > today);
  if (futureEntries.length === 0) return result;

  const skippedIds = new Set(futureEntries.map((e) => e.id));
  const entries = result.entries.filter((e) => e.date <= today);
  const importErrors = result.importErrors.filter((e) => e.entryId === undefined || !skippedIds.has(e.entryId));
  importErrors.push({
    code: "futureEntriesSkipped",
    reason:
      futureEntries.length === 1
        ? `Skipped 1 planned flight dated after ${today} (not yet flown)`
        : `Skipped ${futureEntries.length} planned flights dated after ${today} (not yet flown)`
  });
  return { ...result, entries, importErrors };
}

// ---------------------------------------------------------------------------
// ImportNightPolicy / ImportIFRPolicy / ImportTimePolicies
// ---------------------------------------------------------------------------
// Only the non-UI pieces of the iOS import time policy are ported; see the file doc
// comment for what's skipped (the chip/result-panel UI types, which need a
// live store + cached solar calculation). `LogTenPartialSICReview`'s own
// parse-time resolution reuses exactly this night/IFR vocabulary, so it's
// kept here rather than dropped entirely.

export type ImportNightPolicy = "keepLogged" | "recalculate";
export type ImportIFRPolicy = "fullFlightIFR" | "keepLogged" | "noIFR";

export interface ImportTimePolicies {
  night: ImportNightPolicy;
  ifr: ImportIFRPolicy;
}

export function defaultImportTimePolicies(): ImportTimePolicies {
  return { night: "keepLogged", ifr: "keepLogged" };
}

/** Mirrors `ImportedEntry.applyImportTimePolicies`. */
export function applyImportTimePolicies(entry: ImportedEntry, policies: ImportTimePolicies): void {
  const times: Times = { ...(entry.manualTimes ?? {}) };

  if (policies.night === "recalculate") times.night = undefined;

  if (policies.ifr === "fullFlightIFR") {
    times.ifr = undefined;
    entry.ifr = true;
  } else if (policies.ifr === "noIFR") {
    times.ifr = undefined;
    entry.ifr = false;
  }

  entry.manualTimes = isEmptyTimes(times) ? undefined : times;
  entry.manualTimesAreAuthoritative = true;
}
