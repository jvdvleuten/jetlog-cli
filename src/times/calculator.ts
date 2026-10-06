/**
 * Ports the Jetlog iOS app's `EntryTimesCalculator.calculateTimes`
 * as a pure function operating on `CalcEntry` + `CalcContext`. See
 * docs/TIMES.md.
 */
import { attribute } from "./detailedTimes.js";
import { easaTimes, cruiseReliefCoPilotCredit } from "./easa.js";
import { nightMinutes } from "./night.js";
import { parseTimeOfDay, subtractTimes, remainderOf } from "./time.js";
import { COPILOT_SEAT_FAMILY } from "./types.js";
import type { AircraftTypeInfo, CalcContext, CalcEntry, CalcTimes, DetailedTimes, EASATimes, EntryPersonRoleName } from "./types.js";

export interface CalculatedTimes {
  detailedTimes: DetailedTimes;
  /** Convenience top-level mirror of `detailedTimes.night` (matches the golden-corpus shape). */
  night?: number;
  easaTimesSigned: EASATimes;
  easaTimesUnsigned: EASATimes;
}

// ---------------------------------------------------------------------------
// Derived field resolution (the iOS `Entry`'s `derived*` getters)
// ---------------------------------------------------------------------------

interface DerivedFields {
  /** `Entry.derivedDate`: the UTC date the derived off-blocks belong to. */
  date: string;
  registration?: string;
  offBlocks?: number;
  onBlocks?: number;
  airborne?: number;
  touchdown?: number;
  from?: string;
  to?: string;
}

/** `Entry.derivedDate`: the system date when flight-data tracking is on, else the planned date. */
export function derivedDate(entry: Pick<CalcEntry, "updateFlightData" | "systemDate" | "date">): string {
  return entry.updateFlightData ? entry.systemDate ?? entry.date : entry.date;
}

/** The derived from/to codes the calculator resolves airports for (`Entry.derivedFrom`/`derivedTo`). Raw, unresolved. */
export function derivedRoute(entry: CalcEntry): { from?: string; to?: string } {
  const { from, to } = resolveDerivedFields(entry);
  return { from, to };
}

function maybeParseTimeOfDay(s: string | undefined): number | undefined {
  return s === undefined ? undefined : parseTimeOfDay(s);
}

function resolveDerivedFields(entry: CalcEntry): DerivedFields {
  const updateFlightData = entry.updateFlightData;
  return {
    date: derivedDate(entry),
    registration: updateFlightData ? entry.registrationSystem : entry.registration,
    offBlocks: maybeParseTimeOfDay(updateFlightData ? entry.offBlocksSystem : entry.offBlocks),
    onBlocks: maybeParseTimeOfDay(updateFlightData ? entry.onBlocksSystem : entry.onBlocks),
    airborne: maybeParseTimeOfDay(updateFlightData ? entry.airborneSystem : entry.airborne),
    touchdown: maybeParseTimeOfDay(updateFlightData ? entry.touchdownSystem : entry.touchdown),
    from: updateFlightData ? entry.systemFrom ?? entry.from : entry.actualFrom ?? entry.from,
    to: updateFlightData ? entry.systemTo ?? entry.to : entry.actualTo ?? entry.to
  };
}

// ---------------------------------------------------------------------------
// loggedBlockOrSessionTime
// ---------------------------------------------------------------------------

function loggedBlockOrSessionTime(
  entry: CalcEntry,
  derived: DerivedFields,
  startTime: number | undefined,
  endTime: number | undefined
): number | undefined {
  if (entry.type === "fstd") {
    if (entry.isBulk && entry.manualTimes) {
      return entry.manualTimes.fstdSession;
    }
    if (startTime === undefined || endTime === undefined) return undefined;
    return subtractTimes(endTime, startTime);
  }
  if (entry.isBulk) {
    return entry.manualTimes?.totalTimeOfFlight;
  }
  const derivedBlockTime =
    derived.offBlocks !== undefined && derived.onBlocks !== undefined ? subtractTimes(derived.onBlocks, derived.offBlocks) : undefined;
  if (entry.isImportedFromOtherLogbook && entry.manualTimes?.totalTimeOfFlight !== undefined) {
    return entry.manualTimes.totalTimeOfFlight;
  }
  return derivedBlockTime;
}

// ---------------------------------------------------------------------------
// effectiveManualOverrides
// ---------------------------------------------------------------------------

const PILOT_FUNCTION_BUCKET_KEYS: (keyof CalcTimes)[] = [
  "pilotInCommand",
  "coPilot",
  "cruiseReliefCoPilot",
  "picus",
  "spic",
  "dual",
  "instructor",
  "examiner"
];

function honoursZeroPilotFunctionOverride(entry: CalcEntry): boolean {
  return !entry.isImportedFromOtherLogbook || entry.isBulk;
}

function sanitizedImportedOverrides(times: CalcTimes): CalcTimes {
  const sanitized: CalcTimes = { ...times };
  for (const key of PILOT_FUNCTION_BUCKET_KEYS) {
    if (sanitized[key] === 0) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function effectiveManualOverrides(entry: CalcEntry): CalcTimes | undefined {
  if (!entry.manualTimes) return undefined;
  return honoursZeroPilotFunctionOverride(entry) ? entry.manualTimes : sanitizedImportedOverrides(entry.manualTimes);
}

// ---------------------------------------------------------------------------
// Aircraft classification helper (shared by bulk + main paths)
// ---------------------------------------------------------------------------

function classifyAircraft(detailed: DetailedTimes, blockTime: number | undefined, type: AircraftTypeInfo | undefined): void {
  if (!type) return;
  if (type.easaCertification === "SP" || type.easaCertification === "HPA") {
    if (type.engineCount === 1) {
      detailed.singlePilotSingleEngine = blockTime;
    } else if ((type.engineCount ?? 0) > 1) {
      detailed.singlePilotMultiEngine = blockTime;
    }
  } else {
    // MP or unknown, unknown cert defaults to multi-pilot.
    detailed.multiPilot = blockTime;
  }
}

// ---------------------------------------------------------------------------
// Night calculation wiring
// ---------------------------------------------------------------------------

function computeNight(derived: DerivedFields, ctx: CalcContext): number | undefined {
  if (derived.from === undefined || derived.to === undefined) return undefined;
  const origin = ctx.lookupAirport(derived.from);
  const destination = ctx.lookupAirport(derived.to);
  if (!origin || !destination || !origin.hasPosition || !destination.hasPosition) return undefined;
  if (derived.offBlocks === undefined || derived.onBlocks === undefined) return undefined;

  const totalFlightMinutes = subtractTimes(derived.onBlocks, derived.offBlocks);
  return nightMinutes(derived.date, derived.offBlocks, totalFlightMinutes, origin.lat, origin.lon, destination.lat, destination.lon);
}

/** Night and IFR never exceed the logged block time. With no block they are
 * left as they are (mirrors `DetailedTimes.clampNightAndIFRToTotal`). */
function clampNightAndIfr(detailed: DetailedTimes): void {
  const total = detailed.totalTimeOfFlight;
  if (total === undefined) return;
  if (detailed.night !== undefined && detailed.night > total) detailed.night = total;
  if (detailed.ifr !== undefined && detailed.ifr > total) detailed.ifr = total;
}

// ---------------------------------------------------------------------------
// FSTD branch
// ---------------------------------------------------------------------------

function calculateFSTDTimes(entry: CalcEntry, ctx: CalcContext): CalculatedTimes {
  const detailed: DetailedTimes = {};
  const sessionTime = loggedBlockOrSessionTime(entry, resolveDerivedFields(entry), maybeParseTimeOfDay(entry.startTime), maybeParseTimeOfDay(entry.endTime));

  switch (ctx.selfRole) {
    case "fstdTrainee":
      detailed.fstdSession = sessionTime;
      break;
    case "fstdInstructor":
      detailed.fstdInstructorTime = sessionTime;
      break;
    case "fstdExaminer":
      detailed.fstdExaminerTime = sessionTime;
      break;
    case "fstdSeniorInstructor":
      detailed.fstdSeniorInstructorTime = sessionTime;
      break;
    case "fstdObserver":
      break;
    default:
      detailed.fstdSession = sessionTime;
      break;
  }

  return {
    detailedTimes: detailed,
    night: detailed.night,
    easaTimesSigned: easaTimes(detailed, true, ctx.activeCrewCount),
    easaTimesUnsigned: easaTimes(detailed, false, ctx.activeCrewCount)
  };
}

// ---------------------------------------------------------------------------
// Bulk branch (bulk-only exceptions)
// ---------------------------------------------------------------------------

function fromBulkTimes(times: CalcTimes, role: EntryPersonRoleName): DetailedTimes {
  const detailed: DetailedTimes = {
    totalTimeOfFlight: times.totalTimeOfFlight,
    totalAirTime: times.totalAirTime,
    night: times.night,
    ifr: times.ifr,
    crossCountry: times.crossCountry,
    singlePilotSingleEngine: times.singlePilotSingleEngine,
    singlePilotMultiEngine: times.singlePilotMultiEngine,
    multiPilot: times.multiPilot,
    fstdSession: times.fstdSession
  };

  attribute(detailed, times.totalTimeOfFlight, role);

  switch (role) {
    case "coPilot":
      if (times.pilotInCommand !== undefined) {
        detailed.pilotInCommandRole = times.pilotInCommand;
        detailed.coPilotRole = remainderOf(times.totalTimeOfFlight, times.pilotInCommand);
      }
      break;
    case "cruiseReliefCoPilot":
      detailed.cruiseReliefCoPilotCredited = times.totalTimeOfFlight;
      break;
    case "fstdTrainee":
      detailed.fstdSession = times.fstdSession;
      break;
    case "fstdInstructor":
      detailed.fstdInstructorTime = times.fstdSession;
      break;
    case "fstdExaminer":
      detailed.fstdExaminerTime = times.fstdSession;
      break;
    case "fstdSeniorInstructor":
      detailed.fstdSeniorInstructorTime = times.fstdSession;
      break;
    default:
      break;
  }

  return detailed;
}

function calculateBulkTimes(entry: CalcEntry, ctx: CalcContext, selfRole: EntryPersonRoleName): CalculatedTimes {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const detailed = fromBulkTimes(entry.manualTimes!, selfRole);

  if (entry.aircraftIcaoCode !== undefined) {
    const aircraftType = (ctx.lookupAircraftTypeByIcao ?? ctx.lookupAircraftType)(entry.aircraftIcaoCode);
    classifyAircraft(detailed, entry.manualTimes?.totalTimeOfFlight, aircraftType);
  }

  // A bulk night/IFR larger than the bulk total is clamped to it.
  clampNightAndIfr(detailed);

  return {
    detailedTimes: detailed,
    night: detailed.night,
    easaTimesSigned: easaTimes(detailed, true, ctx.activeCrewCount),
    easaTimesUnsigned: easaTimes(detailed, false, ctx.activeCrewCount)
  };
}

// ---------------------------------------------------------------------------
// Main (non-bulk, non-FSTD) path
// ---------------------------------------------------------------------------

function calculateMainTimes(entry: CalcEntry, ctx: CalcContext, selfRole: EntryPersonRoleName): CalculatedTimes {
  const derived = resolveDerivedFields(entry);
  const detailed: DetailedTimes = {};

  const blockTime = loggedBlockOrSessionTime(entry, derived, undefined, undefined);
  detailed.totalTimeOfFlight = blockTime;
  detailed.totalAirTime =
    derived.airborne !== undefined && derived.touchdown !== undefined ? subtractTimes(derived.touchdown, derived.airborne) : undefined;

  attribute(detailed, detailed.totalTimeOfFlight, selfRole);

  // Manual pilot-function overrides (the entry-detail "logged hours" tiles): ONE rule for native and
  // imported rows. The ROLE leads; the only honoured columns are the tile overrides below (PIC carve
  // on the co-pilot-seat family, SPIC dual, CRCP credit further down). Every other pilot-function
  // column of an imported row (SIC on a PIC row, partial PIC/SIC, dual on STU, instructor, examiner,
  // the cross-role relief column) is ignored and the role gets the full block.
  if (!entry.isBulk) {
    const manualTimes = effectiveManualOverrides(entry);
    if (manualTimes) {
      // PIC flown from a co-pilot seat.
      if (COPILOT_SEAT_FAMILY.has(selfRole) && manualTimes.pilotInCommand !== undefined) {
        const picOverride = manualTimes.pilotInCommand;
        const carveBase: number | undefined =
          selfRole === "seniorInstructorCoPilot"
            ? detailed.seniorInstructorCoPilotRole ?? blockTime
            : selfRole === "routeInstructorCoPilot"
              ? detailed.routeInstructorCoPilotRole ?? blockTime
              : detailed.coPilotRole ?? blockTime; // coPilot, lineCheckAirmanInitialFO
        detailed.pilotInCommandRole = picOverride;
        const remainder = remainderOf(carveBase, picOverride);
        if (selfRole === "seniorInstructorCoPilot") {
          detailed.seniorInstructorCoPilotRole = remainder;
        } else if (selfRole === "routeInstructorCoPilot") {
          detailed.routeInstructorCoPilotRole = remainder;
        } else {
          detailed.coPilotRole = remainder;
        }
      }

      // SPIC dual portion.
      if (selfRole === "studentPilotInCommand" && manualTimes.dual !== undefined) {
        detailed.dualRole = manualTimes.dual;
        detailed.spicRole = remainderOf(blockTime, manualTimes.dual);
      }
    }
  }

  // Cruise-relief co-pilot credit.
  if (detailed.cruiseReliefRawBlock !== undefined) {
    const override = selfRole === "cruiseReliefCoPilot" ? effectiveManualOverrides(entry)?.coPilot : undefined;
    detailed.cruiseReliefCoPilotCredited = override ?? cruiseReliefCoPilotCredit(detailed.cruiseReliefRawBlock, ctx.activeCrewCount);
  }

  // Aircraft classification (SE/ME/MP).
  if (derived.registration !== undefined) {
    const aircraftType = ctx.lookupAircraftType(derived.registration);
    classifyAircraft(detailed, blockTime, aircraftType);
  }

  // Manual multi-pilot override.
  const manualMultiPilotOverride: boolean | undefined = (() => {
    if (entry.manualTimes?.isMultiPilot !== undefined) return entry.manualTimes.isMultiPilot;
    if (entry.manualTimes?.multiPilot !== undefined) return entry.manualTimes.multiPilot > 0;
    return undefined;
  })();

  if (!entry.isBulk && manualMultiPilotOverride !== undefined) {
    if (manualMultiPilotOverride) {
      detailed.multiPilot = blockTime;
      detailed.singlePilotSingleEngine = undefined;
      detailed.singlePilotMultiEngine = undefined;
    } else {
      detailed.multiPilot = undefined;
    }
  }

  // IFR determination.
  if (entry.manualTimes?.ifr !== undefined) {
    detailed.ifr = entry.manualTimes.ifr;
  } else if (entry.updateFlightData || entry.ifr) {
    detailed.ifr = blockTime;
  } else {
    detailed.ifr = undefined;
  }

  // Night determination.
  if (entry.manualTimes?.night !== undefined) {
    detailed.night = entry.manualTimes.night;
  } else {
    detailed.night = computeNight(derived, ctx);
  }

  // Invariant: night and IFR never exceed the logged total (a manual night
  // larger than the block, an imported manual total smaller than the
  // off/on-blocks span).
  clampNightAndIfr(detailed);

  return {
    detailedTimes: detailed,
    night: detailed.night,
    easaTimesSigned: easaTimes(detailed, true, ctx.activeCrewCount),
    easaTimesUnsigned: easaTimes(detailed, false, ctx.activeCrewCount)
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function calculateEntryTimes(entry: CalcEntry, ctx: CalcContext): CalculatedTimes {
  if (entry.type === "fstd") {
    return calculateFSTDTimes(entry, ctx);
  }
  // Mirrors the iOS calculator's early return when there is no self person:
  // when no person on the entry matches "self", EVERY non-FSTD entry
  // (bulk or not) returns a completely empty result, without even computing
  // block/session time. See the `selfRole` doc comment on `CalcContext`.
  if (ctx.selfRole === undefined) {
    return { detailedTimes: {}, night: undefined, easaTimesSigned: {}, easaTimesUnsigned: {} };
  }
  if (entry.isBulk && entry.manualTimes) {
    return calculateBulkTimes(entry, ctx, ctx.selfRole);
  }
  return calculateMainTimes(entry, ctx, ctx.selfRole);
}
