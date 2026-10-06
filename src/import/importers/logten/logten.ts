/**
 * Ported from the Jetlog iOS app's LogTen importer, LogTen Pro's "Flights" TXT export
 * (tab-separated, `flight_*`/`aircraft_*`/`aircraftType_*` headers covering
 * normal flights, deadhead rows, and simulator/FSTD sessions in one file).
 *
 * Scope cut vs. the iOS app (see `model.ts`'s file doc comment for the
 * general "no local store offline" rule):
 *  - The existing-entry/FSTD/person/aircraft matching and entry fetches are all
 *    DB-backed lookups with no offline equivalent, every row here is
 *    produced as a brand-new, unmatched row (`isExisting: { existing: false
 *    }`), same as every other importer in this CLI.
 *  - Airport-code normalization is backed by the airport resolver (logged-in
 *    catalog only, none offline) (`canonicalCode` in `../../../airports/index.js`),
 *    `from`/`to` resolve to ICAO for a known IATA alias, and pass through
 *    verbatim/unconverted when unknown, same as the iOS app's own fallback when
 *    its lookup misses.
 *  - The signed-in Jetlog user's own person record doesn't exist offline. The iOS
 *    importer uses it in two places:
 *      1. Remapping the "most frequently imported person" onto the real
 *         user's database id. Skipped here, the self person simply keeps
 *         whatever `refId` (crew-column name) was most frequent in the
 *         file; there's no local user id to remap onto.
 *      2. As a last-resort crew member on an unassigned deadhead row with no
 *         real crew names. Skipped here too, but the net behaviour is the
 *         same: `resolveAuthoritativeUserRole`'s own default branch (no
 *         positive function-time candidates + no current role -> `"DH"`)
 *         still assigns the self person a deadhead role in the second pass
 *         below, for exactly the rows this fallback would have covered.
 *  - The iOS app's async/progress-callback plumbing doesn't apply to this
 *    CLI's synchronous `parse()`.
 *  - The pre-parse probes that drive the iOS review sheets (asking the user to
 *    pick a partial-SIC strategy or build a custom switch mapping before
 *    running the import) are UI-flow helpers with no bearing on parsing
 *    itself once the caller already has a strategy/mapping in hand, not
 *    ported. A CLI caller instead passes `partialSICStrategy`/
 *    `customSwitchMapping` directly via `LogTenImportOptions`.
 *  - The iOS "review partial-SIC rows one by one" screen and its
 *    undo/scope/aggregate machinery are pure UI state with no parsing
 *    behaviour of their own and are not ported. The actual partial-SIC
 *    strategy it lets the user pick between (`creditFullBlock` /
 *    `preserveLoggedSeatTime`) is real parsing behaviour and is ported, in
 *    `normalization.ts`'s `normalizeImportedFlightManualTimes`, this
 *    importer just calls it with whichever strategy the caller supplied.
 */
import { canonicalCode } from "../../../airports/index.js";
import type { Importer, ImporterOptions } from "../../importer.js";
import {
  emptyImportResult,
  entryPersonRoleRawValue,
  formatDuration,
  isEmptyTimes,
  newImportedEntry,
  time,
  truncatedRemarks,
  type ApproachCount,
  type ApproachType,
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
} from "../../model.js";
import { colonMinutes } from "../../time-parsing.js";
import { single, applyAuthoritativeTimes, type AuthoritativeTimeField } from "../../authoritative-times.js";
import {
  applyAuthoritativeFlightBlockDuration,
  applyAuthoritativeFSTDSessionDuration,
  convertToBulkIfNeeded,
  normalizedFlightBlockMinutesForImport,
  normalizeImportedFlightManualTimes,
  retaggedLosslessPICUSRole,
  type LogTenPartialSICStrategy
} from "../../normalization.js";
import { flagDuplicates } from "../../duplicate-detector.js";
import { fstdDeviceCategoryFromFreeText } from "../../model.js";
import { getValue, hasExplicitValue, parseRow, splitIntoProperLines } from "./tsv.js";
import { detectLogTenTextFileKind, mergeLogTenPeople, parseLogTenAddressBook } from "./address-book.js";
import {
  isCustomSwitchValueSet,
  newLogTenCustomSwitchMapping,
  winner as customSwitchWinner,
  type LogTenCustomSwitchMapping
} from "./custom-switch-mapping.js";

/** Placeholder names used in LogTen for deadhead flights, these aren't real people. */
const DEADHEAD_PLACEHOLDERS = new Set(["dead heading", "deadheading", "dead head"]);
const BULK_REMAINDER_MARKER = "[Unassigned remainder]";

const PROTECTED_NON_PILOT_ROLES: EntryPersonRole[] = [
  "DH",
  "CRCP",
  "RI",
  "RI_CP",
  "FI",
  "FSTD_TRN",
  "FSTD_INS",
  "FSTD_EXA",
  "FSTD_OBS",
  "FSTD_SI"
];

function isProtectedNonPilotRole(role: EntryPersonRole): boolean {
  return PROTECTED_NON_PILOT_ROLES.some((r) => entryPersonRoleRawValue(r) === entryPersonRoleRawValue(role));
}

const CABIN_ROLES: EntryPersonRole[] = ["CA", "CS", "Purser", "SP"];

function isCabinRole(role: EntryPersonRole): boolean {
  return CABIN_ROLES.some((r) => entryPersonRoleRawValue(r) === entryPersonRoleRawValue(role));
}

function isUnassignedBulkRemainder(entry: ImportedEntry): boolean {
  return entry.type === "flight" && entry.isBulk && (entry.remarks ?? "").includes(BULK_REMAINDER_MARKER);
}

/** Thrown by row-level parsing to report a structured `ImportError` for that
 * row, mirroring the file-level error cases the iOS app throws. */
class LogTenRowError extends Error {
  constructor(public readonly importError: ImportError) {
    super(importError.reason);
  }
}

function isPlausibleDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function cleanRegistration(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

// ---------------------------------------------------------------------------
// Authoritative user-role resolution (`resolveAuthoritativeUserRole`)
// ---------------------------------------------------------------------------

function roleRank(role: EntryPersonRole): number {
  switch (entryPersonRoleRawValue(role)) {
    case "PIC":
      return 0;
    case "CP":
      return 1;
    case "CRCP":
      return 2;
    case "PICUS":
      return 3;
    case "STU":
      return 4;
    case "RI":
      return 5;
    default:
      return 10;
  }
}

/**
 * Resolves which role the importing user (the "self" person, see
 * `resolveSelfRoles`) should have on a flight row, from its PIC/SIC/relief/
 * PICUS/dual/instructor function-time columns. Ported verbatim from
 * the iOS importer.
 */
function resolveAuthoritativeUserRole(entry: ImportedEntry, originalRole: EntryPersonRole | undefined): EntryPersonRole | undefined {
  if (entry.type !== "flight") return originalRole;
  let currentRole = originalRole;

  const picMinutes = entry.manualTimes?.pilotInCommand?.totalMinutes ?? 0;
  const sicMinutes = entry.manualTimes?.coPilot?.totalMinutes ?? 0;
  const reliefMinutes = entry.manualTimes?.cruiseReliefCoPilot?.totalMinutes ?? 0;
  const picusMinutes = entry.manualTimes?.picus?.totalMinutes ?? 0;
  const dualMinutes = entry.manualTimes?.dual?.totalMinutes ?? 0;
  const instructorMinutes = entry.manualTimes?.instructor?.totalMinutes ?? 0;
  const blockMinutes = entry.isBulk
    ? (entry.manualTimes?.totalTimeOfFlight?.totalMinutes ?? 0)
    : (normalizedFlightBlockMinutesForImport(entry) ?? 0);

  const candidates: Array<{ role: EntryPersonRole; minutes: number }> = [
    { role: "PIC", minutes: picMinutes },
    { role: "CP", minutes: sicMinutes },
    { role: "CRCP", minutes: reliefMinutes },
    { role: "PICUS", minutes: picusMinutes },
    { role: "STU", minutes: dualMinutes },
    { role: "RI", minutes: instructorMinutes }
  ];

  const positiveCandidates = candidates.filter((c) => c.minutes > 0);
  if (positiveCandidates.length === 0) {
    if (currentRole === undefined) return "DH";
    return currentRole;
  }

  // The user's own role can never be cabin crew. A cabin role here comes from the
  // Custom/FlightAttendant crew fields (e.g. the third pilot of an augmented crew sits in a
  // Custom field), so ignore it and let the function columns decide.
  if (currentRole !== undefined && isCabinRole(currentRole)) currentRole = undefined;

  // Hard rule: any positive relief time means CRCP, regardless of current role.
  if (reliefMinutes > 0) return "CRCP";

  if (
    sicMinutes > 0 &&
    picusMinutes > 0 &&
    sicMinutes === picusMinutes &&
    blockMinutes > 0 &&
    blockMinutes === picusMinutes &&
    picMinutes === 0 &&
    dualMinutes === 0
  ) {
    return "PICUS";
  }

  if (picMinutes > 0 && sicMinutes > 0 && reliefMinutes === 0 && picusMinutes === 0 && dualMinutes === 0) {
    if (blockMinutes > 0 && picMinutes === sicMinutes && picMinutes === blockMinutes) return "PICUS";
    // Partial PIC + SIC rows preserve both function totals, import as CoPilot
    // with a manual PIC override (`normalizeImportedFlightManualTimes` keeps it).
    return "CP";
  }

  if (picMinutes > 0 && sicMinutes === 0 && reliefMinutes === 0 && picusMinutes === 0 && dualMinutes > 0 && blockMinutes > 0) {
    return "SPIC";
  }

  if (
    picMinutes > 0 &&
    sicMinutes === 0 &&
    reliefMinutes === 0 &&
    picusMinutes === 0 &&
    dualMinutes === 0 &&
    currentRole !== undefined &&
    entryPersonRoleRawValue(currentRole) === "CP" &&
    blockMinutes > 0 &&
    picMinutes < blockMinutes
  ) {
    return "CP";
  }

  if (picusMinutes > 0 && dualMinutes > 0) return "SPIC";

  if (currentRole !== undefined && isProtectedNonPilotRole(currentRole)) return currentRole;

  if (currentRole !== undefined && positiveCandidates.some((c) => entryPersonRoleRawValue(c.role) === entryPersonRoleRawValue(currentRole!))) {
    return currentRole;
  }

  let best = positiveCandidates[0]!;
  for (const candidate of positiveCandidates.slice(1)) {
    if (candidate.minutes > best.minutes) best = candidate;
    else if (candidate.minutes === best.minutes && roleRank(candidate.role) < roleRank(best.role)) best = candidate;
  }
  return best.role;
}

/**
 * Resolves the winning role for a row's mapped custom Duty switches. `role:
 * undefined, conflict: false` means "no mapped switch on this row",
 * resolution falls through to `resolveAuthoritativeUserRole`. `conflict:
 * true` means two or more mapped switches disagree with no resolved winner.
 * Ported from `LogTenImporter.resolveCustomSwitchRole`.
 */
function resolveCustomSwitchRole(
  indices: Set<number>,
  mapping: LogTenCustomSwitchMapping
): { role?: EntryPersonRole; conflict: boolean } {
  const mapped = [...indices]
    .map((index) => ({ index, role: mapping.roles[index] }))
    .filter((m): m is { index: number; role: EntryPersonRole } => m.role !== undefined);
  if (mapped.length === 0) return { conflict: false };

  const uniqueRoles = [...new Set(mapped.map((m) => entryPersonRoleRawValue(m.role)))];
  if (uniqueRoles.length === 1) return { role: mapped[0]!.role, conflict: false };

  const winningEntry = mapped.find(({ role: candidateRole }) => {
    const candidateIndices = mapped.filter((m) => entryPersonRoleRawValue(m.role) === entryPersonRoleRawValue(candidateRole)).map((m) => m.index);
    const otherIndices = mapped.filter((m) => entryPersonRoleRawValue(m.role) !== entryPersonRoleRawValue(candidateRole)).map((m) => m.index);
    return candidateIndices.some((candidateIndex) => otherIndices.every((otherIndex) => customSwitchWinner(mapping, candidateIndex, otherIndex) === candidateIndex));
  });
  if (winningEntry !== undefined) return { role: winningEntry.role, conflict: false };
  return { conflict: true };
}

// ---------------------------------------------------------------------------
// Approaches & autoland (flight_selectedApproach1…10, flight_catII/III, flight_autolands)
// ---------------------------------------------------------------------------

const APPROACH_TYPE_CANONICAL_ORDER: ApproachType[] = [
  "ils_cat1",
  "ils_cat2",
  "ils_cat3",
  "gls",
  "rnp",
  "rnp_ar",
  "loc",
  "vor",
  "ndb",
  "visual",
  "circling",
  "par"
];

/** Maps a LogTen `selectedApproach` type token to `ApproachType`,
 * case-insensitively. Anything that can't be confidently mapped (including
 * LogTen's own IGS type, and malformed exports fusing type+runway like
 * "ILS25L") returns `undefined` so the approach is skipped. */
export function mapLogTenApproachType(raw: string): ApproachType | undefined {
  switch (raw.toUpperCase()) {
    case "ILS":
      return "ils_cat1";
    case "GLS":
      return "gls";
    case "GPS/GNSS":
    case "RNP":
      return "rnp";
    case "RNP AR":
      return "rnp_ar";
    case "LOC":
    case "LOC/DME":
      return "loc";
    case "VOR":
    case "VOR/DME":
      return "vor";
    case "NDB":
      return "ndb";
    case "VISUAL":
      return "visual";
    case "CIRCLING":
      return "circling";
    case "PAR":
      return "par";
    default:
      return undefined;
  }
}

/** Parses one `flight_selectedApproach<N>` cell, format
 * `count;TYPE;runway;airport` (only `count` and `TYPE` matter). */
export function parseSelectedApproach(raw: string): { type: ApproachType; count: number } | undefined {
  const parts = raw.split(";").map((p) => p.trim());
  if (parts.length < 2) return undefined;
  const count = Number.parseInt(parts[0]!, 10);
  if (!Number.isFinite(count) || count <= 0 || !/^-?\d+$/.test(parts[0]!)) return undefined;
  const typeToken = parts[1]!;
  if (typeToken.length === 0) return undefined;
  const type = mapLogTenApproachType(typeToken);
  if (type === undefined) return undefined;
  return { type, count };
}

/** Builds the flight's `ApproachCount[]`, merging
 * `flight_selectedApproach1…10`, refining the ILS tally with
 * `flight_catII`/`flight_catIII`, then attributing `flight_autolands` across
 * the autoland-capable rows. `undefined` (never `[]`) when the flight has no
 * usable approach data. Ported from `LogTenImporter.buildApproaches`. */
export function buildApproaches(columns: string[], headers: string[]): ApproachCount[] | undefined {
  const counts = new Map<ApproachType, number>();
  for (let index = 1; index <= 10; index++) {
    const raw = getValue(`flight_selectedApproach${index}`, columns, headers);
    if (!raw || raw.length === 0) continue;
    const parsed = parseSelectedApproach(raw);
    if (!parsed) continue;
    counts.set(parsed.type, (counts.get(parsed.type) ?? 0) + parsed.count);
  }

  const catII = Number.parseInt(getValue("flight_catII", columns, headers) ?? "", 10);
  const catIII = Number.parseInt(getValue("flight_catIII", columns, headers) ?? "", 10);
  const catIIValue = Number.isFinite(catII) ? catII : 0;
  const catIIIValue = Number.isFinite(catIII) ? catIII : 0;

  if (catIIValue > 0) counts.set("ils_cat2", (counts.get("ils_cat2") ?? 0) + catIIValue);
  if (catIIIValue > 0) counts.set("ils_cat3", (counts.get("ils_cat3") ?? 0) + catIIIValue);

  const ilsCat1Count = counts.get("ils_cat1");
  if (ilsCat1Count !== undefined) {
    const refined = Math.max(0, ilsCat1Count - catIIValue - catIIIValue);
    if (refined > 0) counts.set("ils_cat1", refined);
    else counts.delete("ils_cat1");
  }

  const rows: ApproachCount[] = [...counts.entries()].map(([type, count]) => ({ type, count }));

  let autolands = Number.parseInt(getValue("flight_autolands", columns, headers) ?? "", 10);
  autolands = Number.isFinite(autolands) ? autolands : 0;

  if (autolands > 0) {
    const precedence: ApproachType[] = ["ils_cat3", "ils_cat2", "gls", "ils_cat1"];
    for (const approachType of precedence) {
      if (autolands <= 0) break;
      const idx = rows.findIndex((r) => r.type === approachType);
      if (idx < 0) continue;
      const attributable = Math.min(autolands, rows[idx]!.count);
      if (attributable <= 0) continue;
      rows[idx]!.autolands = (rows[idx]!.autolands ?? 0) + attributable;
      autolands -= attributable;
    }

    if (autolands > 0) {
      const idx = rows.findIndex((r) => r.type === "ils_cat1");
      if (idx >= 0) {
        rows[idx]!.count += autolands;
        rows[idx]!.autolands = (rows[idx]!.autolands ?? 0) + autolands;
      } else {
        rows.push({ type: "ils_cat1", count: autolands, autolands });
      }
      autolands = 0;
    }
  }

  const filtered = rows.filter((r) => r.count > 0);
  if (filtered.length === 0) return undefined;

  filtered.sort((a, b) => {
    const aIdx = APPROACH_TYPE_CANONICAL_ORDER.indexOf(a.type as ApproachType);
    const bIdx = APPROACH_TYPE_CANONICAL_ORDER.indexOf(b.type as ApproachType);
    return (aIdx < 0 ? Number.MAX_SAFE_INTEGER : aIdx) - (bIdx < 0 ? Number.MAX_SAFE_INTEGER : bIdx);
  });
  return filtered;
}

// ---------------------------------------------------------------------------
// Authoritative column -> manualTimes tables
// ---------------------------------------------------------------------------

const AUTHORITATIVE_FLIGHT_TIME_FIELDS: AuthoritativeTimeField[] = [
  single("flight_night", "night"),
  single("flight_actualInstrument", "ifr"),
  single("flight_crossCountry", "crossCountry")
];

const AUTHORITATIVE_FSTD_TIME_FIELDS: AuthoritativeTimeField[] = [single("flight_simulator", "fstdSession")];

function durationIfPresent(header: string, columns: string[], headers: string[]): Time | undefined {
  if (!hasExplicitValue(header, columns, headers)) return undefined;
  const raw = getValue(header, columns, headers);
  if (raw === undefined) return undefined;
  return time(colonMinutes(raw));
}

/** Row-authoritative seat/function time: `undefined` when this export's
 * schema doesn't even have `header` (nothing to assert, `fallback`
 * preserved), otherwise THIS row's own value, including `undefined` when
 * the cell is blank (blank asserts "none", not "unknown", for these columns). */
function authoritativeSeatTime(header: string, columns: string[], headers: string[], fallback: Time | undefined): Time | undefined {
  if (!headers.includes(header)) return fallback;
  return durationIfPresent(header, columns, headers);
}

function applyAuthoritativeFlightTimes(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FLIGHT_TIME_FIELDS, (column) => durationIfPresent(column, columns, headers), entry);

  const times: Times = { ...(entry.manualTimes ?? {}) };
  times.pilotInCommand = authoritativeSeatTime("flight_pic", columns, headers, times.pilotInCommand);
  times.coPilot = authoritativeSeatTime("flight_sic", columns, headers, times.coPilot);
  times.picus = authoritativeSeatTime("flight_p1us", columns, headers, times.picus);
  times.dual = authoritativeSeatTime("flight_dualReceived", columns, headers, times.dual);
  times.instructor = authoritativeSeatTime("flight_dualGiven", columns, headers, times.instructor);
  times.cruiseReliefCoPilot = authoritativeSeatTime("flight_relief", columns, headers, times.cruiseReliefCoPilot);
  entry.manualTimes = isEmptyTimes(times) ? undefined : times;
}

function applyAuthoritativeFSTDTime(columns: string[], headers: string[], entry: ImportedEntry): void {
  applyAuthoritativeTimes(AUTHORITATIVE_FSTD_TIME_FIELDS, (column) => durationIfPresent(column, columns, headers), entry, false);
}

// ---------------------------------------------------------------------------
// Custom Duty switches (flight_customCapacity1…20)
// ---------------------------------------------------------------------------

function readCustomSwitchIndices(columns: string[], headers: string[]): Set<number> {
  const indices = new Set<number>();
  for (let index = 1; index <= 20; index++) {
    const value = getValue(`flight_customCapacity${index}`, columns, headers);
    if (isCustomSwitchValueSet(value)) indices.add(index);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Crew / people / aircraft
// ---------------------------------------------------------------------------

const CREW_NAME_COLUMNS = [
  "flight_selectedCrewPIC",
  "flight_selectedCrewSIC",
  "flight_selectedCrewRelief",
  "flight_selectedCrewRelief2",
  "flight_selectedCrewRelief3",
  "flight_selectedCrewRelief4",
  "flight_selectedCrewInstructor",
  "flight_selectedCrewObserver",
  "flight_selectedCrewObserver2",
  "flight_selectedCrewPurser",
  "flight_selectedCrewFlightAttendant",
  "flight_selectedCrewFlightAttendant2",
  "flight_selectedCrewFlightAttendant3",
  "flight_selectedCrewFlightAttendant4",
  "flight_selectedCrewCustom1",
  "flight_selectedCrewCustom2",
  "flight_selectedCrewCustom3",
  "flight_selectedCrewCustom4",
  "flight_selectedCrewCustom5"
];

function getPerson(columns: string[], headers: string[], header: string, people: Map<string, ImportedPerson>): ImportedPerson | undefined {
  const name = getValue(header, columns, headers);
  if (!name || name.length === 0) return undefined;
  return people.get(name);
}

function addPersonIfNeeded(columns: string[], headers: string[], people: Map<string, ImportedPerson>): void {
  for (const column of CREW_NAME_COLUMNS) {
    const nameIndex = headers.indexOf(column);
    if (nameIndex < 0) continue;

    const name = columns[nameIndex] ?? "";
    if (name.length === 0 || people.has(name)) continue;
    if (DEADHEAD_PLACEHOLDERS.has(name.toLowerCase())) continue;

    if (name === "SELF") {
      // No local user record offline, still emit a placeholder person so
      // crew links resolve, same shape `deeplink-json.ts` uses for `SELF`.
      people.set(name, { refId: name, isExisting: { existing: false }, isImportedFromOtherLogbook: true });
      continue;
    }

    const parts = name.split(" ").filter((s) => s.length > 0);
    const firstName = parts[0];
    const lastName = parts.slice(1).join(" ") || undefined;
    people.set(name, {
      refId: name,
      firstName,
      lastName,
      isExisting: { existing: false },
      isImportedFromOtherLogbook: true
    });
  }
}

function addAircraftIfNeeded(columns: string[], headers: string[], aircraft: Map<string, ImportedAircraft>): void {
  const registrationIndex = headers.indexOf("aircraft_aircraftID");
  if (registrationIndex < 0) return;
  const cleaned = cleanRegistration(columns[registrationIndex]);
  if (!cleaned || aircraft.has(cleaned)) return;
  aircraft.set(cleaned, { registration: cleaned, isImportedFromOtherLogbook: true });
}

function updateCrew(entry: ImportedEntry, member: ImportedEntryCrewMember): void {
  const idx = entry.crew.findIndex((c) => c.refId === member.refId);
  if (idx >= 0) entry.crew[idx] = member;
  else entry.crew.push(member);
}

/** Adds a cabin-crew member without overwriting a pilot role already set for the same person
 * in this row (updateCrew is last-wins). */
function addCabinCrew(entry: ImportedEntry, refId: string): void {
  const existing = entry.crew.find((c) => c.refId === refId);
  if (existing && !isCabinRole(existing.role)) return;
  updateCrew(entry, { refId, role: "CA" });
}

function addFlightCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  const p1usTime = getValue("flight_p1us", columns, headers) ?? "";
  const underSupervision = getValue("flight_underSupervisionCapacity", columns, headers) ?? "";
  const isPICUS = colonMinutes(p1usTime) > 0 || underSupervision === "1";

  const pic = getPerson(columns, headers, "flight_selectedCrewPIC", people);
  if (pic) updateCrew(entry, { refId: pic.refId, role: "PIC" });

  const sic = getPerson(columns, headers, "flight_selectedCrewSIC", people);
  if (sic) updateCrew(entry, { refId: sic.refId, role: isPICUS ? "PICUS" : "CP" });

  for (const column of ["flight_selectedCrewRelief", "flight_selectedCrewRelief2", "flight_selectedCrewRelief3", "flight_selectedCrewRelief4"]) {
    const relief = getPerson(columns, headers, column, people);
    if (relief) updateCrew(entry, { refId: relief.refId, role: "CRCP" });
  }

  const instructor = getPerson(columns, headers, "flight_selectedCrewInstructor", people);
  if (instructor) updateCrew(entry, { refId: instructor.refId, role: "RI" });

  for (const column of ["flight_selectedCrewObserver", "flight_selectedCrewObserver2"]) {
    const observer = getPerson(columns, headers, column, people);
    if (observer) updateCrew(entry, { refId: observer.refId, role: "LCA" });
  }

  const purser = getPerson(columns, headers, "flight_selectedCrewPurser", people);
  if (purser) updateCrew(entry, { refId: purser.refId, role: "Purser" });

  for (const column of [
    "flight_selectedCrewFlightAttendant",
    "flight_selectedCrewFlightAttendant2",
    "flight_selectedCrewFlightAttendant3",
    "flight_selectedCrewFlightAttendant4"
  ]) {
    const attendant = getPerson(columns, headers, column, people);
    if (attendant) addCabinCrew(entry, attendant.refId);
  }

  for (const column of [
    "flight_selectedCrewCustom1",
    "flight_selectedCrewCustom2",
    "flight_selectedCrewCustom3",
    "flight_selectedCrewCustom4",
    "flight_selectedCrewCustom5"
  ]) {
    const custom = getPerson(columns, headers, column, people);
    if (custom) addCabinCrew(entry, custom.refId);
  }
}

function addDeadheadCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  for (const column of ["flight_selectedCrewPIC", "flight_selectedCrewSIC"]) {
    const name = getValue(column, columns, headers) ?? "";
    if (DEADHEAD_PLACEHOLDERS.has(name.toLowerCase())) continue;
    const person = getPerson(columns, headers, column, people);
    if (person) updateCrew(entry, { refId: person.refId, role: "DH" });
  }
  // No local "self" record to fall back to when neither seat names a real
  // person (unlike the iOS app's stored-user fetch), the
  // self-role second pass (`resolveSelfRoles`) still assigns the self
  // person a `"DH"` role on this row via `resolveAuthoritativeUserRole`'s
  // own "no positive candidates, no current role" default, so the outcome
  // matches.
}

function addSimulatorCrew(columns: string[], headers: string[], people: Map<string, ImportedPerson>, entry: ImportedEntry): void {
  const trainee1 = getPerson(columns, headers, "flight_selectedCrewPIC", people);
  if (trainee1) updateCrew(entry, { refId: trainee1.refId, role: "FSTD_TRN" });
  const trainee2 = getPerson(columns, headers, "flight_selectedCrewSIC", people);
  if (trainee2) updateCrew(entry, { refId: trainee2.refId, role: "FSTD_TRN" });
  const instructor = getPerson(columns, headers, "flight_selectedCrewInstructor", people);
  if (instructor) updateCrew(entry, { refId: instructor.refId, role: "FSTD_INS" });
}

// ---------------------------------------------------------------------------
// Row -> ImportedEntry
// ---------------------------------------------------------------------------

/** Present-column time-of-day: a blank-but-present cell parses to minute `0`
 * (midnight), not `undefined`, as in the iOS app, where a
 * present-but-blank column is a present empty string. Only
 * an absent HEADER (export schema without the column at all) is `undefined`. */
function timeOfDayOrMidnightIfPresent(header: string, columns: string[], headers: string[]): Time | undefined {
  const raw = getValue(header, columns, headers);
  if (raw === undefined) return undefined;
  return time(colonMinutes(raw));
}

function cleanFSTDType(rawType: string): string {
  return rawType
    .replace(/\s*\((?:F?SIM)\)\s*$/i, "")
    .replace(/\s+SIMULATOR\s*$/i, "")
    .trim();
}

function createSimulatorEntry(
  columns: string[],
  headers: string[],
  date: string,
  dateString: string,
  index: number,
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[]
): ImportedEntry {
  const simulatorDurationRaw = getValue("flight_simulator", columns, headers) ?? "";
  const durationMinutes = colonMinutes(simulatorDurationRaw);

  const startTime = time(0);
  const endTime = durationMinutes > 0 ? time(durationMinutes) : undefined;

  const aircraftId = getValue("aircraft_aircraftID", columns, headers);
  const aircraftType = getValue("aircraftType_type", columns, headers);
  const fstdId = (aircraftId && aircraftId.length > 0 ? aircraftId : undefined) ?? (aircraftType && aircraftType.length > 0 ? cleanFSTDType(aircraftType) : "");

  const aircraftTypeSelectedCategory = getValue("aircraftType_selectedCategory", columns, headers);
  const deviceCategoryHint = fstdDeviceCategoryFromFreeText(
    aircraftType && aircraftType.length > 0 ? aircraftType : undefined,
    aircraftTypeSelectedCategory && aircraftTypeSelectedCategory.length > 0 ? aircraftTypeSelectedCategory : undefined
  );

  const sessionTypeRaw = getValue("flight_flightNumber", columns, headers);
  const sessionType = sessionTypeRaw && sessionTypeRaw.length > 0 ? sessionTypeRaw : undefined;

  const remarksRaw = getValue("flight_remarks", columns, headers);
  const remarks = truncatedRemarks(remarksRaw && remarksRaw.length > 0 ? remarksRaw : undefined, importErrors, { dateString });

  const entry = newImportedEntry({
    date,
    type: "fstd",
    startTime,
    endTime,
    fstdId: fstdId.length > 0 ? fstdId : undefined,
    sessionType,
    updateFlightData: false,
    isImportedFromOtherLogbook: true,
    remarks
  });
  entry.fstdDeviceCategory = deviceCategoryHint;

  addSimulatorCrew(columns, headers, people, entry);

  if (fstdId.length === 0) {
    importErrors.push({
      code: "fstdIdentifierMissing",
      reason: "FSTD identifier missing",
      dateString,
      remarks,
      rowNumber: index,
      entryId: entry.id
    });
  }

  applyAuthoritativeFSTDSessionDuration(entry, durationMinutes > 0 ? durationMinutes : undefined);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFSTDTime(columns, headers, entry);
  return entry;
}

function createFlightEntry(
  columns: string[],
  headers: string[],
  date: string,
  dateString: string,
  index: number,
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[],
  isDeadhead: boolean
): ImportedEntry {
  const from = canonicalCode(getValue("flight_from", columns, headers)) ?? "";
  const to = canonicalCode(getValue("flight_to", columns, headers)) ?? "";
  const flightNumberRaw = getValue("flight_flightNumber", columns, headers) ?? "";
  const flightNumber = flightNumberRaw.length > 0 ? flightNumberRaw : undefined;
  const scheduledOffBlocks = timeOfDayOrMidnightIfPresent("flight_scheduledDepartureTime", columns, headers);
  const registrationRaw = getValue("aircraft_aircraftID", columns, headers) ?? "";
  const registration = cleanRegistration(registrationRaw);
  const offBlocks = timeOfDayOrMidnightIfPresent("flight_actualDepartureTime", columns, headers);
  let airborne = timeOfDayOrMidnightIfPresent("flight_takeoffTime", columns, headers);
  let touchdown = timeOfDayOrMidnightIfPresent("flight_landingTime", columns, headers);
  const onBlocks = timeOfDayOrMidnightIfPresent("flight_actualArrivalTime", columns, headers);

  const totalRaw = getValue("flight_totalTime", columns, headers);
  const durationRaw = getValue("flight_duration", columns, headers);
  const blockValue = totalRaw ?? durationRaw;
  const blockMinutesRaw = blockValue !== undefined ? colonMinutes(blockValue) : 0;
  const blockMinutes = blockMinutesRaw > 0 ? blockMinutesRaw : undefined;

  const preserveExistingTimeline = durationIfPresent("flight_relief", columns, headers) !== undefined;

  if (airborne?.totalMinutes === 0 && touchdown?.totalMinutes === 0) {
    airborne = undefined;
    touchdown = undefined;
  }

  const takeoffsDay = Number.parseInt(getValue("flight_dayTakeoffs", columns, headers) ?? "", 10) || 0;
  const takeoffsNight = Number.parseInt(getValue("flight_nightTakeoffs", columns, headers) ?? "", 10) || 0;
  const landingsDay = Number.parseInt(getValue("flight_dayLandings", columns, headers) ?? "", 10) || 0;
  const landingsNight = Number.parseInt(getValue("flight_nightLandings", columns, headers) ?? "", 10) || 0;
  const takeoffsAndLandings: TakeoffsAndLandings = { type: "manual", takeoffsDay, takeoffsNight, landingsDay, landingsNight };

  const approaches = buildApproaches(columns, headers);

  const remarksRaw = getValue("flight_remarks", columns, headers);
  const remarks = truncatedRemarks(remarksRaw && remarksRaw.length > 0 ? remarksRaw : undefined, importErrors, {
    dateString,
    flightNumber,
    registration
  });

  const updateFlightData = !(offBlocks !== undefined || airborne !== undefined || touchdown !== undefined || onBlocks !== undefined);

  const entry = newImportedEntry({
    date,
    type: "flight",
    flightNumber,
    registration,
    from,
    to,
    scheduledOffBlocks,
    offBlocks,
    airborne,
    touchdown,
    onBlocks,
    updateFlightData,
    takeoffsAndLandings,
    approaches,
    isImportedFromOtherLogbook: true,
    remarks
  });

  if (isDeadhead) {
    addDeadheadCrew(columns, headers, people, entry);
  } else {
    addFlightCrew(columns, headers, people, entry);
    entry.logTenCustomSwitchIndices = readCustomSwitchIndices(columns, headers);
  }

  if (!entry.registration) {
    importErrors.push({
      code: "registrationMissing",
      reason: "Registration missing",
      dateString,
      flightNumber: entry.flightNumber,
      registration: registrationRaw,
      rowNumber: index,
      entryId: entry.id
    });
  }
  if (from.length === 0) {
    importErrors.push({
      code: "originAirportMissing",
      reason: "Origin airport missing",
      dateString,
      flightNumber: entry.flightNumber,
      registration: registrationRaw,
      rowNumber: index,
      entryId: entry.id
    });
  }
  if (to.length === 0) {
    importErrors.push({
      code: "destinationAirportMissing",
      reason: "Destination airport missing",
      dateString,
      flightNumber: entry.flightNumber,
      registration: registrationRaw,
      rowNumber: index,
      entryId: entry.id
    });
  }

  applyAuthoritativeFlightBlockDuration(entry, blockMinutes, preserveExistingTimeline);
  convertToBulkIfNeeded(entry);
  applyAuthoritativeFlightTimes(columns, headers, entry);
  return entry;
}

function createEntry(
  columns: string[],
  headers: string[],
  index: number,
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[]
): ImportedEntry {
  const dateString = getValue("flight_flightDate", columns, headers);
  if (dateString === undefined) {
    throw new LogTenRowError({
      reason: `Unexpected header: flight_flightDate not found. Available headers: ${headers.slice(0, 10).join(", ")}`
    });
  }
  if (!isPlausibleDateOnly(dateString)) {
    throw new LogTenRowError({ reason: `Incorrect date format: ${dateString}` });
  }

  const flightType = getValue("flight_type", columns, headers) ?? "0";

  if (flightType === "3") {
    return createSimulatorEntry(columns, headers, dateString, dateString, index, people, importErrors);
  }
  if (flightType === "2") {
    throw new LogTenRowError({ reason: "Row not implemented: Training flight type not implemented" });
  }

  const isDeadhead = flightType === "1";
  return createFlightEntry(columns, headers, dateString, dateString, index, people, importErrors, isDeadhead);
}

// ---------------------------------------------------------------------------
// Bulk (>=24h) role split
// ---------------------------------------------------------------------------

interface BulkRoleSplitComponent {
  label: string;
  time: Time;
  apply: (times: Times, t: Time) => void;
}

function bulkRoleSplitComponents(manualTimes: Times): BulkRoleSplitComponent[] {
  const components: BulkRoleSplitComponent[] = [];
  if (manualTimes.pilotInCommand && manualTimes.pilotInCommand.totalMinutes > 0) {
    components.push({ label: "PIC", time: manualTimes.pilotInCommand, apply: (t, v) => (t.pilotInCommand = v) });
  }
  if (manualTimes.coPilot && manualTimes.coPilot.totalMinutes > 0) {
    components.push({ label: "SIC", time: manualTimes.coPilot, apply: (t, v) => (t.coPilot = v) });
  }
  if (manualTimes.cruiseReliefCoPilot && manualTimes.cruiseReliefCoPilot.totalMinutes > 0) {
    components.push({ label: "CRCP", time: manualTimes.cruiseReliefCoPilot, apply: (t, v) => (t.cruiseReliefCoPilot = v) });
  }
  if (manualTimes.picus && manualTimes.picus.totalMinutes > 0) {
    components.push({ label: "PICUS", time: manualTimes.picus, apply: (t, v) => (t.picus = v) });
  }
  if (manualTimes.dual && manualTimes.dual.totalMinutes > 0) {
    components.push({ label: "DUAL", time: manualTimes.dual, apply: (t, v) => (t.dual = v) });
  }
  if (manualTimes.instructor && manualTimes.instructor.totalMinutes > 0) {
    components.push({ label: "INSTR", time: manualTimes.instructor, apply: (t, v) => (t.instructor = v) });
  }
  return components;
}

function scaledOperationalTime(original: Time | undefined, roleMinutes: number, totalRoleMinutes: number): Time | undefined {
  if (!original || original.totalMinutes <= 0 || roleMinutes <= 0 || totalRoleMinutes <= 0) return undefined;
  if (original.totalMinutes === totalRoleMinutes) return time(roleMinutes);
  if (original.totalMinutes < totalRoleMinutes) {
    const scaled = Math.round((original.totalMinutes * roleMinutes) / totalRoleMinutes);
    return scaled > 0 ? time(scaled) : undefined;
  }
  return undefined;
}

function bulkSplitRemarks(base: string | undefined, label: string): string {
  const prefix = base && base.length > 0 ? base : "Bulk transfer row";
  return `${prefix} [Split ${label}]`;
}

function formatDurationMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const absolute = Math.abs(minutes);
  return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
}

/** Splits a mixed-role bulk (>=24h) flight row into one `ImportedEntry` per
 * role that carries function time, plus an unassigned-remainder entry when
 * the components don't add up to the row's full total. Ported from
 * `LogTenImporter.splitBulkFlightEntryIfNeeded`. */
function splitBulkFlightEntryIfNeeded(entry: ImportedEntry, rowNumber: number, importErrors: ImportError[]): ImportedEntry[] {
  if (entry.type !== "flight" || !entry.isBulk || !entry.manualTimes) return [entry];

  const manualTimes = entry.manualTimes;
  const components = bulkRoleSplitComponents(manualTimes);
  if (components.length <= 1) return [entry];

  const totalMinutes = manualTimes.totalTimeOfFlight?.totalMinutes ?? 0;
  const assignedMinutes = components.reduce((sum, c) => sum + c.time.totalMinutes, 0);
  const remainderMinutes = totalMinutes - assignedMinutes;
  const remainderDescription = formatDurationMinutes(remainderMinutes);
  const componentDescription = components.map((c) => `${c.label}=${formatDuration(c.time)}`).join(", ");

  const splitEntries: ImportedEntry[] = components.map((component) => {
    const split = newImportedEntry({
      date: entry.date,
      type: entry.type,
      flightNumber: entry.flightNumber,
      registration: entry.registration,
      from: entry.from,
      to: entry.to,
      offBlocks: entry.offBlocks,
      airborne: entry.airborne,
      touchdown: entry.touchdown,
      onBlocks: entry.onBlocks,
      startTime: entry.startTime,
      endTime: entry.endTime,
      fstdId: entry.fstdId,
      sessionType: entry.sessionType,
      updateFlightData: entry.updateFlightData,
      takeoffsAndLandings: entry.takeoffsAndLandings,
      crew: [...entry.crew],
      isImportedFromOtherLogbook: entry.isImportedFromOtherLogbook,
      remarks: entry.remarks
    });
    split.aircraftIcaoCode = entry.aircraftIcaoCode;
    split.isBulk = entry.isBulk;

    const splitTimes: Times = { totalTimeOfFlight: component.time };
    component.apply(splitTimes, component.time);

    const operationalSeed = assignedMinutes > 0 ? assignedMinutes : totalMinutes;
    const ifr = scaledOperationalTime(manualTimes.ifr, component.time.totalMinutes, operationalSeed);
    if (ifr !== undefined) splitTimes.ifr = ifr;
    const night = scaledOperationalTime(manualTimes.night, component.time.totalMinutes, operationalSeed);
    if (night !== undefined) splitTimes.night = night;
    const crossCountry = scaledOperationalTime(manualTimes.crossCountry, component.time.totalMinutes, operationalSeed);
    if (crossCountry !== undefined) splitTimes.crossCountry = crossCountry;

    split.manualTimes = splitTimes;
    split.remarks = bulkSplitRemarks(entry.remarks, component.label);
    return split;
  });

  if (remainderMinutes > 0) {
    const remainderEntry = newImportedEntry({
      date: entry.date,
      type: entry.type,
      flightNumber: entry.flightNumber,
      registration: entry.registration,
      from: entry.from,
      to: entry.to,
      offBlocks: entry.offBlocks,
      airborne: entry.airborne,
      touchdown: entry.touchdown,
      onBlocks: entry.onBlocks,
      startTime: entry.startTime,
      endTime: entry.endTime,
      fstdId: entry.fstdId,
      sessionType: entry.sessionType,
      updateFlightData: entry.updateFlightData,
      takeoffsAndLandings: entry.takeoffsAndLandings,
      crew: [],
      isImportedFromOtherLogbook: entry.isImportedFromOtherLogbook,
      remarks: `${entry.remarks ?? "Bulk transfer row"} ${BULK_REMAINDER_MARKER}`
    });
    remainderEntry.aircraftIcaoCode = entry.aircraftIcaoCode;
    remainderEntry.isBulk = true;
    remainderEntry.manualTimes = { totalTimeOfFlight: time(remainderMinutes) };
    splitEntries.push(remainderEntry);
  }

  const remainderEntryId = [...splitEntries].reverse().find((e) => (e.remarks ?? "").includes(BULK_REMAINDER_MARKER))?.id ?? entry.id;
  importErrors.push({
    reason: `Mixed bulk flight row split into separate role entries (${componentDescription}). Unassigned remainder ${remainderDescription} has no role in the source export; an empty-role bulk entry was created for review.`,
    dateString: entry.date,
    flightNumber: entry.flightNumber,
    registration: entry.registration,
    remarks: entry.remarks,
    rowNumber,
    entryId: remainderEntryId
  });

  return splitEntries;
}

// ---------------------------------------------------------------------------
// Self-role resolution (second pass over all parsed entries)
// ---------------------------------------------------------------------------

/** The most frequent crew name, like the app. Unlike the app (which takes whichever name `max` returns) a tie
 * for first place yields `tied` instead of a guess, since crediting the wrong person's hours is worse than asking. */
function mostFrequentPersonRefId(entries: ImportedEntry[]): { refId?: string; count: number; tied: string[] } {
  const frequency = new Map<string, number>();
  for (const entry of entries) {
    for (const crewMember of entry.crew) {
      frequency.set(crewMember.refId, (frequency.get(crewMember.refId) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const [refId, count] of frequency) {
    if (count > bestCount) {
      best = refId;
      bestCount = count;
    }
  }
  const tied = [...frequency].filter(([, count]) => count === bestCount).map(([refId]) => refId);
  return tied.length > 1 ? { count: bestCount, tied } : { refId: best, count: Math.max(bestCount, 0), tied: [] };
}

interface SelfRoleOptions {
  selfRefId?: string;
  customSwitchMapping?: LogTenCustomSwitchMapping;
  partialSICStrategy?: LogTenPartialSICStrategy;
}

/**
 * Resolves and attaches the importing user's ("self") role on every parsed
 * row, mirroring the second pass in `LogTenImporter.importLogbook` (the part
 * after `parseTXTData` returns). The self person is identified as whichever
 * crew `refId` appears most often across the file, see this module's file
 * doc comment for why no DB-backed `fetchUserPerson()` remap happens here.
 */
function resolveSelfRoles(entries: ImportedEntry[], importErrors: ImportError[], options: SelfRoleOptions & { selfRefId: string }): void {
  const selfRefId = options.selfRefId;

  const mapping = options.customSwitchMapping ?? newLogTenCustomSwitchMapping();
  const partialSICStrategy = options.partialSICStrategy ?? "creditFullBlock";

  for (const entry of entries) {
    if (isUnassignedBulkRemainder(entry)) continue;

    const currentRole = entry.crew.find((c) => c.refId === selfRefId)?.role;
    let authoritativeRole = resolveAuthoritativeUserRole(entry, currentRole);

    if (entry.logTenCustomSwitchIndices.size > 0) {
      const { role: switchRole, conflict } = resolveCustomSwitchRole(entry.logTenCustomSwitchIndices, mapping);
      if (conflict) {
        importErrors.push({
          code: "logTenCustomSwitchConflict",
          reason: "This flight carries more than one mapped LogTen switch with no resolved winner",
          dateString: entry.date,
          flightNumber: entry.flightNumber,
          registration: entry.registration,
          entryId: entry.id
        });
      } else if (switchRole !== undefined) {
        if (authoritativeRole === undefined || entryPersonRoleRawValue(switchRole) !== entryPersonRoleRawValue(authoritativeRole)) {
          // The switch-mapped role disagrees with what this row's own
          // PIC/SIC/relief/PICUS/dual/instructor columns implied, clear the
          // manual pilot-function columns so the chosen role attributes the
          // block on its own, instead of double-crediting (see
          // `LogTenImporter.importLogbook`'s identical comment).
          const times: Times = { ...(entry.manualTimes ?? {}) };
          times.pilotInCommand = undefined;
          times.coPilot = undefined;
          times.cruiseReliefCoPilot = undefined;
          times.picus = undefined;
          times.dual = undefined;
          times.instructor = undefined;
          entry.manualTimes = isEmptyTimes(times) ? undefined : times;
        }
        authoritativeRole = switchRole;
      }
    }

    const resolvedRole = retaggedLosslessPICUSRole(entry, authoritativeRole);

    const existingIndex = entry.crew.findIndex((c) => c.refId === selfRefId);
    if (existingIndex < 0) {
      if (resolvedRole !== undefined) {
        entry.crew.push({ refId: selfRefId, role: resolvedRole });
      } else {
        importErrors.push({
          code: "roleMissingFlight",
          reason: "You have no role set on this flight",
          dateString: entry.date,
          flightNumber: entry.flightNumber,
          registration: entry.registration,
          entryId: entry.id
        });
      }
    } else if (resolvedRole !== undefined && entryPersonRoleRawValue(resolvedRole) !== (currentRole ? entryPersonRoleRawValue(currentRole) : undefined)) {
      entry.crew[existingIndex] = { refId: selfRefId, role: resolvedRole };
    }

    normalizeImportedFlightManualTimes(entry, resolvedRole, partialSICStrategy);
  }
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

export interface LogTenImportOptions extends ImporterOptions {
  /** Raw content of LogTen's separate Address Book export, when the caller
   * has one, see `address-book.ts`. */
  addressBookContent?: string;
  /** Strategy for LogTen's augmented-crew partial-SIC rows. Defaults to
   * `"creditFullBlock"` (legacy behaviour), same as the iOS importer's
   * default. */
  partialSICStrategy?: LogTenPartialSICStrategy;
  /** User-supplied mapping for `flight_customCapacity1...20` Duty switches.
   * Defaults to an empty mapping (every switch resolves as "Ignore"). */
  customSwitchMapping?: LogTenCustomSwitchMapping;
  /** Overrides automatic "most frequent crew name in the file" self-person
   * detection. */
  selfRefId?: string;
}

function parseFlightsContent(content: string): {
  entries: ImportedEntry[];
  people: ImportedPerson[];
  aircraft: ImportedAircraft[];
  importErrors: ImportError[];
} {
  const importErrors: ImportError[] = [];
  const rows = splitIntoProperLines(content);
  if (rows.length === 0) {
    importErrors.push({ reason: "TXT data is empty." });
    return { entries: [], people: [], aircraft: [], importErrors };
  }

  const headers = parseRow(rows[0]!);
  const peopleByRef = new Map<string, ImportedPerson>();
  const aircraftByReg = new Map<string, ImportedAircraft>();
  const entries: ImportedEntry[] = [];

  rows.slice(1).forEach((row, index) => {
    const columns = parseRow(row);
    if (columns.length !== headers.length) return;

    addPersonIfNeeded(columns, headers, peopleByRef);
    addAircraftIfNeeded(columns, headers, aircraftByReg);

    try {
      const entry = createEntry(columns, headers, index, peopleByRef, importErrors);
      const splitEntries = splitBulkFlightEntryIfNeeded(entry, index, importErrors);
      for (const split of splitEntries) split.sourceRow = index + 2;
      entries.push(...splitEntries);
    } catch (err) {
      if (err instanceof LogTenRowError) {
        importErrors.push({ ...err.importError, rowNumber: index });
      } else {
        importErrors.push({ reason: `Unknown error: ${(err as Error).message}`, rowNumber: index });
      }
    }
  });

  return { entries, people: [...peopleByRef.values()], aircraft: [...aircraftByReg.values()], importErrors };
}

function parse(input: Buffer | string, options?: LogTenImportOptions): ImportResult {
  const content = typeof input === "string" ? input : input.toString("utf8");

  if (detectLogTenTextFileKind(content) === "addressBook") {
    return {
      ...emptyImportResult(),
      importErrors: [
        {
          reason: "This looks like a LogTen Address Book export, not a Flights export. Pass it via `addressBookContent` alongside the Flights export instead."
        }
      ]
    };
  }

  const { entries, people, aircraft, importErrors } = parseFlightsContent(content);
  let mergedPeople = people;

  if (options?.addressBookContent) {
    const addressBookResult = parseLogTenAddressBook(options.addressBookContent);
    mergedPeople = mergeLogTenPeople(people, addressBookResult.people);
    importErrors.push(...addressBookResult.importErrors);
  }

  // Who is the user? LogTen does not mark the owner, so the app takes the most frequent crew name and
  // remaps that person onto the signed-in user (`LogTenImporter.importLogbook`). Offline there is no signed-in
  // person, so that person becomes the `SELF` placeholder every other importer uses, and `resolveSelfRoles`
  // derives the role on it. `--self <name>` picks a different crew name.
  const notes: string[] = [];
  const requested = options?.selfName ?? options?.selfRefId;
  let selfRefId: string | undefined;
  const known = new Set(entries.flatMap((e) => e.crew.map((c) => c.refId)));
  if (requested !== undefined) {
    const match = [...known].find((name) => name.toLowerCase() === requested.trim().toLowerCase());
    if (match === undefined) {
      importErrors.push({ reason: `--self "${requested}": no crew member with that name in this file, so no one is treated as you` });
    } else {
      selfRefId = match;
      notes.push(`Treating "${match}" as you (--self).`);
    }
  } else {
    const frequent = mostFrequentPersonRefId(entries);
    if (frequent.refId !== undefined) {
      selfRefId = frequent.refId;
      notes.push(
        `Treating "${frequent.refId}" as you, the crew name that appears most often in this file (${frequent.count} of ${entries.length} rows). ` +
          `If that is wrong, pass --self "<your name as it appears in the file>".`
      );
    } else if (frequent.tied.length > 1) {
      importErrors.push({
        reason:
          `Could not tell which crew member is you: ${frequent.tied.slice(0, 4).map((n) => `"${n}"`).join(", ")} appear equally often. ` +
          `Pass --self "<your name as it appears in the file>".`
      });
    }
  }

  if (selfRefId !== undefined) {
    resolveSelfRoles(entries, importErrors, {
      selfRefId,
      customSwitchMapping: options?.customSwitchMapping,
      partialSICStrategy: options?.partialSICStrategy
    });
    if (selfRefId !== "SELF") {
      for (const entry of entries) {
        entry.crew = entry.crew.map((c) => (c.refId === selfRefId ? { ...c, refId: "SELF" } : c));
      }
      mergedPeople = mergedPeople.filter((p) => p.refId !== selfRefId);
      if (!mergedPeople.some((p) => p.refId === "SELF")) {
        mergedPeople = [...mergedPeople, { refId: "SELF", isExisting: { existing: false }, isImportedFromOtherLogbook: true }];
      }
    }
  }

  const result: ImportResult = { entries, people: mergedPeople, aircraft, importErrors, skippedUnchangedCount: 0, ...(notes.length > 0 ? { notes } : {}) };
  flagDuplicates(result.entries, result.importErrors);
  return result;
}

export const logTenImporter: Importer = {
  id: "logten",
  displayName: "LogTen Pro (Flights export)",
  extensions: ["txt"],
  detect(buffer: Buffer): number {
    const content = buffer.toString("utf8");
    return detectLogTenTextFileKind(content) === "flights" ? 0.9 : 0;
  },
  async parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult> {
    return parse(input, options as LogTenImportOptions | undefined);
  }
};
