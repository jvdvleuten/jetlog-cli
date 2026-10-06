/**
 * Shared wire role-code tables, mirroring the Jetlog iOS app's
 * `EntryPersonRole`: the canonical `encode(to:)` values (`"PIC"`, `"CP"`, `"FSTD_TRN"`, ...) PLUS
 * the two alias decoders that same file also exposes, because real-world
 * `entries_people.role` data contains aliases the app tolerates on decode
 * (`"FO"`, `"Co-Pilot"`, `"CA1/2"`, `"captain"`, ...) that a canonical-only
 * table would silently turn into `"unknown"` here while the app still
 * counts them.
 *
 * iOS has two separate alias decoders, used in two different contexts, and
 * they do not accept the same aliases:
 *
 * 1. `EntryPersonRole: Codable`'s `init(from decoder:)`
 *    used everywhere a role is decoded (DB reads, server sync, JSON
 *    imports). Exact
 *    (case-sensitive) match against the canonical codes plus a handful of
 *    literal aliases (`"FO"`, `"Co-Pilot"`, `"CA1/2"`, `"CA2/3"`,
 *    `"Cabin Crew"`), then a lowercase+space-to-underscore fallback that
 *    only recognizes `"captain"`/`"first_officer"`. This is the parser for
 *    the logged-in read API (`apiAdapter.ts`, `/api/cli/v1/entries`
 *    `people[].role`, literally a DB-read-then-JSON-serialize round trip)
 *    and for the public JSON import payload (`adapter.ts`'s
 *    `payloadEntryToCalcEntry`).
 *    Implemented here as `mapApiRoleCode`.
 *
 * 2. `EntryPersonRole.init(fromRawString:)`, the lenient free-text decoder
 *    used when importing from other logbook formats. Upper-cases and folds
 *    spaces to underscores first,
 *    then matches a wider (but DIFFERENT) alias set: adds `"CPT"`/
 *    `"CAPTAIN"`, `"FIRST_OFFICER"`, `"SO"`, `"INSTRUCTOR"`, `"EXAMINER"`,
 *    `"STUDENT"`, `"DHD"`/`"DEADHEAD"`, `"TRAINEE"`, but has no cabin-crew
 *    aliases at all (no `CA`/`CS`/`Purser`/`SP` entries), unlike parser 1.
 *    This is the parser for `ImportedEntry.role`
 *    (`importedEntryAdapter.ts`), the CLI's own importers' free-text role
 *    columns, and the round-trip importers (`csv-logbook.ts`,
 *    `deeplink-json.ts`) that wrap any code they don't recognize as
 *    `{ unknown: rawString }` and let this mapper have the final say.
 *    Implemented here as `mapImportedRoleCode`.
 *
 * Unrecognized values map to `"unknown"` in both, same as the iOS
 * decoders' `.unknown(rawValue)` fallback.
 */
import type { EntryPersonRoleName } from "./types.js";

/** Canonical wire codes only (no aliases), kept for callers that need the
 * exact round-trippable `encode(to:)` table, and for backward compat with
 * `adapter.ts`'s `PAYLOAD_ROLE_TO_CALC_ROLE` re-export. */
export const WIRE_ROLE_TO_CALC_ROLE: Record<string, EntryPersonRoleName> = {
  PIC: "pilotInCommand",
  CP: "coPilot",
  CRCP: "cruiseReliefCoPilot",
  PICUS: "pilotInCommandUnderSuperVision",
  SPIC: "studentPilotInCommand",
  RI: "routeInstructor",
  RI_CP: "routeInstructorCoPilot",
  LCA: "lineCheckAirman",
  LCAI: "lineCheckAirmanInitial",
  LCAIFO: "lineCheckAirmanInitialFO",
  FI: "flightInstructor",
  FE: "flightExaminer",
  SI_PIC: "seniorInstructorPIC",
  SI_CP: "seniorInstructorCoPilot",
  SI_OBS: "seniorInstructorObserver",
  STU: "student",
  DH: "deadHead",
  CA: "cabinAttendant",
  CS: "seniorCabinAttendant",
  Purser: "purser",
  SP: "seniorPurser",
  FSTD_TRN: "fstdTrainee",
  FSTD_INS: "fstdInstructor",
  FSTD_EXA: "fstdExaminer",
  FSTD_OBS: "fstdObserver",
  FSTD_SI: "fstdSeniorInstructor"
};

/**
 * Parser 1's exact (case-sensitive) match table, the canonical codes plus
 * `init(from decoder:)`'s literal aliases.
 */
const API_ROLE_EXACT: Record<string, EntryPersonRoleName> = {
  ...WIRE_ROLE_TO_CALC_ROLE,
  FO: "coPilot",
  "Co-Pilot": "coPilot",
  "CA1/2": "cabinAttendant",
  "CA2/3": "cabinAttendant",
  "Cabin Crew": "cabinAttendant"
};

/**
 * Parser 1's fallback table, consulted
 * only after `typeString.lowercased().replacingOccurrences(of: " ", with:
 * "_")` when the exact match above misses.
 */
const API_ROLE_FALLBACK: Record<string, EntryPersonRoleName> = {
  captain: "pilotInCommand",
  first_officer: "coPilot"
};

/**
 * Mirrors `EntryPersonRole: Codable`'s `init(from decoder:)`, the parser
 * for anywhere a role is decoded from JSON exactly as stored/synced: the
 * logged-in read API (`apiAdapter.ts`) and the public JSON import payload
 * (`adapter.ts`). See this file's header comment for the two-parser split.
 */
export function mapApiRoleCode(wireRole: string): EntryPersonRoleName {
  const exact = API_ROLE_EXACT[wireRole];
  if (exact !== undefined) return exact;
  const folded = wireRole.toLowerCase().replace(/ /g, "_");
  return API_ROLE_FALLBACK[folded] ?? "unknown";
}

/** @deprecated use `mapApiRoleCode` (or `mapImportedRoleCode` for
 * `ImportedEntry.role`), kept only so nothing importing the old name
 * breaks; behaves exactly like `mapApiRoleCode`. */
export const mapRoleCode = mapApiRoleCode;

/**
 * Parser 2's match table, matched after
 * `roleString.uppercased().replacingOccurrences(of: " ", with: "_")`, note
 * this table has no cabin-crew entries at all, unlike parser 1's.
 */
const IMPORTED_ROLE_MAP: Record<string, EntryPersonRoleName> = {
  PIC: "pilotInCommand",
  CPT: "pilotInCommand",
  CAPTAIN: "pilotInCommand",
  CP: "coPilot",
  FO: "coPilot",
  FIRST_OFFICER: "coPilot",
  CRCP: "cruiseReliefCoPilot",
  SO: "cruiseReliefCoPilot",
  PICUS: "pilotInCommandUnderSuperVision",
  SPIC: "studentPilotInCommand",
  RI: "routeInstructor",
  RI_CP: "routeInstructorCoPilot",
  LCA: "lineCheckAirman",
  LCAI: "lineCheckAirmanInitial",
  LCAIFO: "lineCheckAirmanInitialFO",
  FI: "flightInstructor",
  INSTRUCTOR: "flightInstructor",
  FE: "flightExaminer",
  EXAMINER: "flightExaminer",
  SI_PIC: "seniorInstructorPIC",
  SI_CP: "seniorInstructorCoPilot",
  SI_OBS: "seniorInstructorObserver",
  STU: "student",
  STUDENT: "student",
  DH: "deadHead",
  DHD: "deadHead",
  DEADHEAD: "deadHead",
  FSTD_TRN: "fstdTrainee",
  TRAINEE: "fstdTrainee",
  FSTD_INS: "fstdInstructor",
  FSTD_EXA: "fstdExaminer",
  FSTD_OBS: "fstdObserver",
  FSTD_SI: "fstdSeniorInstructor"
};

/**
 * Mirrors `EntryPersonRole.init(fromRawString:)`, the lenient free-text
 * parser for `ImportedEntry.role` (`importedEntryAdapter.ts`). See this
 * file's header comment for the two-parser split; note the alias set here
 * differs from `mapApiRoleCode`'s (adds CPT/CAPTAIN/FIRST_OFFICER/SO/
 * INSTRUCTOR/EXAMINER/STUDENT/DHD/DEADHEAD/TRAINEE, has no cabin-crew
 * aliases at all).
 */
export function mapImportedRoleCode(roleString: string): EntryPersonRoleName {
  const folded = roleString.toUpperCase().replace(/ /g, "_");
  return IMPORTED_ROLE_MAP[folded] ?? "unknown";
}

/** `Entry.activeCrewCount`: PIC+CP+CRCP headcount. */
export const ACTIVE_CREW_ROLES: ReadonlySet<EntryPersonRoleName> = new Set([
  "pilotInCommand",
  "coPilot",
  "cruiseReliefCoPilot"
]);

/**
 * `EntryPersonRole`'s `Comparable` rank,
 * the order `Entry.derivedPeople` sorts a user's rows in. Unknown roles rank
 * last (and order among themselves by raw string).
 */
const ROLE_SORT_ORDER: readonly EntryPersonRoleName[] = [
  "pilotInCommand",
  "pilotInCommandUnderSuperVision",
  "studentPilotInCommand",
  "routeInstructor",
  "routeInstructorCoPilot",
  "lineCheckAirman",
  "lineCheckAirmanInitial",
  "lineCheckAirmanInitialFO",
  "flightInstructor",
  "flightExaminer",
  "seniorInstructorPIC",
  "seniorInstructorCoPilot",
  "seniorInstructorObserver",
  "coPilot",
  "cruiseReliefCoPilot",
  "student",
  "deadHead",
  "cabinAttendant",
  "seniorCabinAttendant",
  "purser",
  "seniorPurser",
  "fstdTrainee",
  "fstdInstructor",
  "fstdExaminer",
  "fstdObserver",
  "fstdSeniorInstructor"
];

/** Sort key `[rank, rawString]` for a role, `rawString` only breaking ties between unknown roles. */
export function roleSortKey(role: EntryPersonRoleName, raw: string): [number, string] {
  const rank = ROLE_SORT_ORDER.indexOf(role);
  return rank === -1 ? [ROLE_SORT_ORDER.length, raw] : [rank, ""];
}
