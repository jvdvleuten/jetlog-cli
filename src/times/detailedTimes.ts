/**
 * Ports `DetailedTimes.attribute(block:role:)`
 * and the computed aggregate getters, operating on the plain-number
 * `DetailedTimes` shape (see `types.ts`).
 */
import type { DetailedTimes, EntryPersonRoleName } from "./types.js";

/**
 * THE single role->bucket attribution: writes `block` into the one bucket
 * the given role owns, mutating `detailed` in place. Roles that log no
 * flight time on a flight entry (FSTD roles, cabin crew, unknown) leave
 * every bucket untouched, the FSTD *entry* routing is handled separately
 * by the calculator.
 */
export function attribute(detailed: DetailedTimes, block: number | undefined, role: EntryPersonRoleName): void {
  switch (role) {
    case "pilotInCommand":
      detailed.pilotInCommandRole = block;
      break;
    case "coPilot":
      detailed.coPilotRole = block;
      break;
    case "cruiseReliefCoPilot":
      // Raw relief block only, the credited co-pilot value is filled in by
      // the caller (Part-FCL formula on the regular path, verbatim on bulk).
      detailed.cruiseReliefRawBlock = block;
      break;
    case "pilotInCommandUnderSuperVision":
      detailed.picusRole = block;
      break;
    case "studentPilotInCommand":
      detailed.spicRole = block;
      break;
    case "flightInstructor":
      detailed.flightInstructorRole = block;
      break;
    case "flightExaminer":
      detailed.flightExaminerRole = block;
      break;
    case "student":
      detailed.dualRole = block;
      break;
    case "lineCheckAirmanInitial":
      detailed.lineCheckAirmanInitialRole = block;
      break;
    case "lineCheckAirman":
      detailed.lineCheckAirmanRole = block;
      break;
    case "lineCheckAirmanInitialFO":
      detailed.coPilotRole = block;
      break;
    case "seniorInstructorPIC":
      detailed.seniorInstructorPICRole = block;
      break;
    case "seniorInstructorCoPilot":
      detailed.seniorInstructorCoPilotRole = block;
      break;
    case "seniorInstructorObserver":
      detailed.seniorInstructorObserverRole = block;
      break;
    case "routeInstructor":
      detailed.routeInstructorRole = block;
      break;
    case "routeInstructorCoPilot":
      detailed.routeInstructorCoPilotRole = block;
      break;
    case "deadHead":
      detailed.deadHeadRole = block;
      break;
    case "fstdTrainee":
    case "fstdInstructor":
    case "fstdExaminer":
    case "fstdObserver":
    case "fstdSeniorInstructor":
      // FSTD roles log no flight time on a flight entry.
      break;
    case "cabinAttendant":
    case "seniorCabinAttendant":
    case "purser":
    case "seniorPurser":
      break;
    case "unknown":
      break;
  }
}

/**
 * STRICT command-PIC minutes: the PIC-capacity
 * buckets that count as PIC unconditionally (no signature involved).
 */
export function commandPICMinutes(d: DetailedTimes): number {
  return (
    (d.pilotInCommandRole ?? 0) +
    (d.routeInstructorRole ?? 0) +
    (d.flightInstructorRole ?? 0) +
    (d.flightExaminerRole ?? 0) +
    (d.lineCheckAirmanInitialRole ?? 0) +
    (d.seniorInstructorPICRole ?? 0)
  );
}
