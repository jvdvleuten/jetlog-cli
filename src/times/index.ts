/** Barrel export of the public `src/times` API. */
export type {
  EntryPersonRoleName,
  CalcTimes,
  CalcPerson,
  CalcEntry,
  DetailedTimes,
  EASATimes,
  AircraftTypeInfo,
  Airport,
  CalcContext
} from "./types.js";
export { COPILOT_SEAT_FAMILY } from "./types.js";

export { parseTimeOfDay, subtractTimes, remainderOf } from "./time.js";
export { attribute, commandPICMinutes } from "./detailedTimes.js";
export { easaTimes, cruiseReliefCoPilotCredit } from "./easa.js";
export { calculateEntryTimes, derivedDate, derivedRoute, type CalculatedTimes } from "./calculator.js";
export { inPeriod, type Period } from "./period.js";

/**
 * Bumped whenever a calculator change alters results for existing entries, and
 * kept equal to `calculatorVersion` in the golden corpus fixture (checked in
 * `test/times/golden.test.ts`). Same number on iOS
 * (`EntryTimesCalculator.calculatorVersion`) and the backend
 * (`Jetlog.Times.Persistence`). 3 = one airport resolver (IATA, lowercase,
 * padded, local-code and user-place codes now resolve for night time) plus
 * derived-date bucketing.
 */
export const CALCULATOR_VERSION = 3;
export { aggregateTotals, applyAtplCaps, type Totals, type EntryTimesForTotals, type AtplCaps, type FstdDeviceCategory } from "./aggregator.js";
export { payloadEntryToCalcEntry, PAYLOAD_ROLE_TO_CALC_ROLE } from "./adapter.js";
export { mapRoleCode, mapApiRoleCode, mapImportedRoleCode, WIRE_ROLE_TO_CALC_ROLE, ACTIVE_CREW_ROLES } from "./roleCodes.js";
export { importedEntryToCalcEntry } from "./importedEntryAdapter.js";
export { apiEntryToCalcEntry, parseDurationMinutes } from "./apiAdapter.js";
export { buildApiAircraftLookup } from "./apiAircraft.js";
export { haversineDistanceNM, CROSS_COUNTRY_DISTANCE_THRESHOLD_NM } from "./distance.js";
export {
  computeFileTotals,
  computeFileEntryTimes,
  computeProfileTotals,
  type FileEntryTimesResult,
  type ProfileTotalsResult
} from "./fromFile.js";

export { nightMinutes, nightMinutesBrute } from "./night.js";
