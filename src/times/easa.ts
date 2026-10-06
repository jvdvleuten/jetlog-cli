/**
 * Ports the iOS app's `DetailedTimes` EASA extension, the pure projection from `DetailedTimes`
 * to `EASATimes`.
 */
import { commandPICMinutes } from "./detailedTimes.js";
import type { DetailedTimes, EASATimes } from "./types.js";

/**
 * The Part-FCL cruise-relief co-pilot formula:
 * `(block - 60) * (2 / max(activeCrew, 3))`, rounded UP (ceil) and clamped
 * at zero. Returns `undefined` for a zero/negative credit (bucket stays
 * absent).
 */
export function cruiseReliefCoPilotCredit(block: number | undefined, numberOfActiveCrew: number): number | undefined {
  if (block === undefined) return undefined;
  const raw = (block - 60) * (2 / Math.max(numberOfActiveCrew, 3));
  const minutes = Math.max(Math.ceil(raw), 0);
  return minutes > 0 ? minutes : undefined;
}

function calculateEASAPIC(d: DetailedTimes, hasSignature: boolean): number | undefined {
  let totalMinutes = commandPICMinutes(d);
  if (hasSignature) {
    totalMinutes += d.spicRole ?? 0;
    totalMinutes += d.picusRole ?? 0;
  }
  return totalMinutes > 0 ? totalMinutes : undefined;
}

function calculateEASACoPilot(d: DetailedTimes, hasSignature: boolean, numberOfActiveCrew: number): number | undefined {
  let totalMinutes = 0;
  totalMinutes += d.coPilotRole ?? 0;
  totalMinutes += d.routeInstructorCoPilotRole ?? 0;
  totalMinutes += d.seniorInstructorCoPilotRole ?? 0;

  if (!hasSignature) {
    totalMinutes += d.picusRole ?? 0;
  }

  if (d.cruiseReliefCoPilotCredited !== undefined) {
    totalMinutes += d.cruiseReliefCoPilotCredited;
  } else {
    const credited = cruiseReliefCoPilotCredit(d.cruiseReliefRawBlock, numberOfActiveCrew);
    if (credited !== undefined) totalMinutes += credited;
  }

  return totalMinutes > 0 ? totalMinutes : undefined;
}

function calculateEASADual(d: DetailedTimes, hasSignature: boolean): number | undefined {
  let totalMinutes = 0;
  totalMinutes += d.dualRole ?? 0;
  if (!hasSignature) {
    totalMinutes += d.spicRole ?? 0;
  }
  return totalMinutes > 0 ? totalMinutes : undefined;
}

/**
 * Derives EASA-compliant times from `DetailedTimes` + the signature flag +
 * crew count. PURE projection: a function of `d` only, never introducing a
 * value that isn't already persisted there.
 */
export function easaTimes(d: DetailedTimes, hasSignature: boolean, numberOfActiveCrew: number): EASATimes {
  // Observer-type roles don't log any EASA time: deadhead, LCA observer, SI observer.
  if (d.deadHeadRole !== undefined || d.lineCheckAirmanRole !== undefined || d.seniorInstructorObserverRole !== undefined) {
    return {};
  }

  return {
    singlePilotSingleEngine: d.singlePilotSingleEngine,
    singlePilotMultiEngine: d.singlePilotMultiEngine,
    multiPilot: d.multiPilot,
    totalTimeOfFlight: d.totalTimeOfFlight,
    night: d.night,
    ifr: d.ifr,
    pilotInCommand: calculateEASAPIC(d, hasSignature),
    coPilot: calculateEASACoPilot(d, hasSignature, numberOfActiveCrew),
    dual: calculateEASADual(d, hasSignature),
    instructor: d.flightInstructorRole,
    fstdSession: d.fstdSession
  };
}
