/**
 * Types for the DetailedTimes/EASA flight-times calculator port.
 *
 * Minutes are plain `number` throughout (not wrapped `Time` objects), this
 * matches the golden corpus (`test/times/fixtures/times-golden.v2.json`)
 * directly and keeps comparisons simple. See
 * docs/TIMES.md.
 */

export type EntryPersonRoleName =
  | "pilotInCommand"
  | "coPilot"
  | "cruiseReliefCoPilot"
  | "pilotInCommandUnderSuperVision"
  | "studentPilotInCommand"
  | "routeInstructor"
  | "routeInstructorCoPilot"
  | "lineCheckAirman"
  | "lineCheckAirmanInitial"
  | "lineCheckAirmanInitialFO"
  | "flightInstructor"
  | "flightExaminer"
  | "seniorInstructorPIC"
  | "seniorInstructorCoPilot"
  | "seniorInstructorObserver"
  | "student"
  | "deadHead"
  | "cabinAttendant"
  | "seniorCabinAttendant"
  | "purser"
  | "seniorPurser"
  | "fstdTrainee"
  | "fstdInstructor"
  | "fstdExaminer"
  | "fstdObserver"
  | "fstdSeniorInstructor"
  | "unknown";

export const COPILOT_SEAT_FAMILY: ReadonlySet<EntryPersonRoleName> = new Set([
  "coPilot",
  "lineCheckAirmanInitialFO",
  "seniorInstructorCoPilot",
  "routeInstructorCoPilot"
]);

/** Times-shaped manual override bag, minutes as plain numbers (durations, can exceed 1440). */
export interface CalcTimes {
  singlePilotSingleEngine?: number;
  singlePilotMultiEngine?: number;
  multiPilot?: number;
  night?: number;
  ifr?: number;
  totalTimeOfFlight?: number;
  pilotInCommand?: number;
  coPilot?: number;
  dual?: number;
  spic?: number;
  picus?: number;
  instructor?: number;
  examiner?: number;
  crossCountry?: number;
  totalAirTime?: number;
  cruiseReliefCoPilot?: number;
  fstdSession?: number;
  isMultiPilot?: boolean;
}

export interface CalcPerson {
  personId: string;
  role: EntryPersonRoleName;
  isDeleted?: boolean;
}

/** The calculator's entry input, mirrors Entry's RAW fields (not pre-derived); the
 * calculator itself computes derivedFrom/derivedTo/derivedOffBlocks/etc. internally, matching
 * the iOS `Entry`'s `derived*` computed properties, so callers (CLI adapter, tests) never have to
 * duplicate that logic. */
export interface CalcEntry {
  date: string; // "YYYY-MM-DD"
  type: "flight" | "fstd" | string;
  from?: string;
  to?: string;
  offBlocks?: string; // "H:MM"/"HH:MM" time-of-day
  onBlocks?: string;
  airborne?: string;
  touchdown?: string;
  registration?: string;
  registrationSystem?: string;
  offBlocksSystem?: string;
  onBlocksSystem?: string;
  airborneSystem?: string;
  touchdownSystem?: string;
  systemDate?: string;
  systemFrom?: string;
  systemTo?: string;
  actualFrom?: string;
  actualTo?: string;
  updateFlightData: boolean;
  ifr: boolean;
  isImportedFromOtherLogbook: boolean;
  isBulk: boolean;
  aircraftIcaoCode?: string;
  startTime?: string; // FSTD session start/end, "H:MM"
  endTime?: string;
  people: CalcPerson[];
  manualTimes?: CalcTimes;
}

/** DetailedTimes-shaped output, minutes as plain numbers, ABSENT (undefined) means nil,
 * mirroring the iOS struct's `Time?` fields 1:1. Never set a field to 0 unless the
 * calculation genuinely produces an explicit zero that must persist as distinguishable from
 * absent (e.g. a native-zero cruiseReliefCoPilotCredited override). */
export interface DetailedTimes {
  pilotInCommandRole?: number;
  spicRole?: number;
  picusRole?: number;
  lineCheckAirmanRole?: number;
  lineCheckAirmanInitialRole?: number;
  seniorInstructorPICRole?: number;
  seniorInstructorCoPilotRole?: number;
  seniorInstructorObserverRole?: number;
  deadHeadRole?: number;
  routeInstructorRole?: number;
  routeInstructorCoPilotRole?: number;
  coPilotRole?: number;
  cruiseReliefRawBlock?: number;
  cruiseReliefCoPilotCredited?: number;
  dualRole?: number;
  flightInstructorRole?: number;
  flightExaminerRole?: number;
  singlePilotSingleEngine?: number;
  singlePilotMultiEngine?: number;
  multiPilot?: number;
  night?: number;
  ifr?: number;
  crossCountry?: number;
  totalTimeOfFlight?: number;
  totalAirTime?: number;
  fstdSession?: number;
  fstdInstructorTime?: number;
  fstdExaminerTime?: number;
  fstdSeniorInstructorTime?: number;
}

export interface EASATimes {
  singlePilotSingleEngine?: number;
  singlePilotMultiEngine?: number;
  multiPilot?: number;
  totalTimeOfFlight?: number;
  night?: number;
  ifr?: number;
  pilotInCommand?: number;
  coPilot?: number;
  dual?: number;
  instructor?: number;
  fstdSession?: number;
}

export interface AircraftTypeInfo {
  easaCertification: "SP" | "HPA" | "MP" | "unknown";
  engineCount?: number;
}

/** A resolved airport as the calculator sees it. Position math must treat `hasPosition: false`
 * exactly like an unresolved code: never a (0, 0) placeholder. */
export type Airport = { hasPosition: true; lat: number; lon: number } | { hasPosition: false; lat: null; lon: null };

/** Injectable context, defaults to a no-op airport/aircraft lookup so the pure calculator
 * never requires any I/O; the CLI wires the real resolver (src/airports/; no aircraft-type DB offline
 *, documented gap, see docs/TIMES.md). */
export interface CalcContext {
  /** `undefined` means no person on the entry matches "self", mirrors the
   * iOS calculator's early exit (empty result) for non-FSTD entries;
   * see `calculator.ts`. The CLI adapter (`adapter.ts`) never produces this
   * case itself (it skips entries with no `ref_id: "SELF"` person before
   * calling the calculator at all), it exists so the golden-corpus test's
   * `missing_no_self_person` case can be reproduced faithfully. */
  selfRole: EntryPersonRoleName | undefined;
  activeCrewCount: number;
  /** For EASA projection; the golden-corpus test computes BOTH signed and unsigned regardless. */
  hasSignature?: boolean;
  /** Receives the RAW derived from/to code; the lookup normalizes and resolves it (`src/airports`). */
  lookupAirport: (code: string) => Airport | undefined;
  /** Look up aircraft type by registration (non-bulk) or ICAO type code (bulk, via
   * aircraftIcaoCode), whichever the calculator has on hand; callers decide which key makes
   * sense for their data source. */
  lookupAircraftType: (key: string) => AircraftTypeInfo | undefined;
  /** Bulk entries carry the ICAO type code directly (no aircraft row involved). When absent, bulk entries
   * fall back to `lookupAircraftType`. The logged-in path supplies both so a registration that happens to
   * look like a type code ("MD11", "NXT") is never mistaken for one. */
  lookupAircraftTypeByIcao?: (icao: string) => AircraftTypeInfo | undefined;
}
