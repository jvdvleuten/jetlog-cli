/**
 * Ports a bounded subset of the iOS app's `FlightMetricsAggregator`
 * non-trivial rules plus the plain co-pilot/dual/
 * instructor/fstd sums. Not golden-corpus-gated: the per-entry corpus doesn't cover aggregate/career-level cases, so this
 * file's correctness rests on the hand-built unit tests in
 * `test/times/aggregator.test.ts`.
 *
 * Ported: FSTD device-category routing, FSTD trainee
 * vs. instructed session counts, cross-country-by-distance, and
 * the ATPL caps (CRCP 250h / FNPT 25h / synthetic 100h)
 * via the separate `applyAtplCaps` function.
 *
 * Still deliberately out of scope (see docs/TIMES.md "Known limitations"):
 * - The PIC-pillar "best of three routes" ATPL calculation
 *   (the iOS `ATPLLicenceProgress`), out of scope for the per-entry
 *   golden corpus; documented here in case a later corpus extends to it.
 */
import { commandPICMinutes } from "./detailedTimes.js";
import { CROSS_COUNTRY_DISTANCE_THRESHOLD_NM, haversineDistanceNM } from "./distance.js";
import { inPeriod, type Period } from "./period.js";
import type { Airport, DetailedTimes, EASATimes, EntryPersonRoleName } from "./types.js";

export type FstdDeviceCategory = "ffs" | "fnpt" | "ftd" | "bitd";

export interface EntryTimesForTotals {
  /** Entry type: `"fstd"` for simulator sessions, anything else (or absent)
   * is treated as a flight. Drives the inclusion rule and the FSTD-only
   * routing in `aggregateTotals`. */
  type?: string;
  detailedTimes: DetailedTimes;
  easaTimesSigned: EASATimes;
  easaTimesUnsigned?: EASATimes;
  night?: number;
  isBulk?: boolean;
  /** FSTD session's device category (fnpt/ftd/bitd/ffs), see 5a routing.
   * `undefined` means unknown; contributes to neither the FNPT nor the
   * non-creditable bucket, only to the plain `totalFstdSessionMinutes`
   * already tracked. */
  fstdDeviceCategory?: FstdDeviceCategory;
  /** The current user's own role on this entry, consulted only for the
   * FSTD trainee/instructed session-count routing (5b); passed through for
   * every entry per the iOS source's own (deliberate) default branch. */
  selfRole?: EntryPersonRoleName;
  /** The entry's derived date (`derivedDate`): the one date every
   * bucket and period filter uses. An entry without one never matches a period. */
  date?: string;
  /** Derived origin/destination code, raw (the lookup resolves it), for the
   * cross-country-by-distance heuristic (5c). The names predate the resolver and
   * may hold an IATA code or a user place code. */
  fromIcao?: string;
  toIcao?: string;
  /** Codes (normalized) of this entry's from/to airports that the lookup could not place (not found,
   * or no position). Present only when non-empty. Not used by `aggregateTotals`. */
  unresolvedAirports?: string[];
}

export interface Totals {
  totalBlockMinutes: number;
  totalAirMinutes: number;
  totalNightMinutes: number;
  totalIfrMinutes: number;
  /** Strict commandPICMinutes sum, excludes PICUS/SPIC even when signed. */
  totalPicMinutes: number;
  totalPicusMinutes: number;
  totalSpicMinutes: number;
  /** From `easaTimesSigned.coPilot` (credited, not raw). */
  totalCoPilotMinutes: number;
  totalDualMinutes: number;
  totalInstructorMinutes: number;
  totalFstdSessionMinutes: number;
  /** ATPL cruise-relief CAP input only, never mixed into credited. */
  cruiseReliefRawMinutes: number;
  /** Feeds co-pilot totals. */
  cruiseReliefCreditedMinutes: number;
  /** Gated on air time being logged. */
  taxiTimeMinutes: number;
  singlePilotSingleEngineMinutes: number;
  singlePilotMultiEngineMinutes: number;
  multiPilotMinutes: number;
  entryCount: number;
  /** FSTD device-category routing (5a), subsets of `totalFstdSessionMinutes`-like session time. */
  fnptSessionMinutes: number;
  nonCreditableSimSessionMinutes: number;
  /** FSTD trainee vs. instructed session counts (5b). */
  totalFSTDTraineeSessions: number;
  totalFSTDInstructedSessions: number;
  /** Cross-country-by-distance (5c): sum of block minutes for entries
   * classified cross-country (>= 300NM great-circle distance). */
  crossCountryMinutes: number;
  /** True only when a `lookupAirport` was supplied AND at least one entry
   * had resolvable coordinates, mirrors the iOS `ATPLLicenceProgress`'s
   * `crossCountryIsEstimated` flag. */
  crossCountryIsEstimated: boolean;
}

export interface AggregateTotalsOptions {
  lookupAirport?: (code: string) => Airport | undefined;
  /** Inclusive derived-date period; entries outside it are left out of every total. */
  period?: Period;
}

const FSTD_INSTRUCTED_ROLES: ReadonlySet<EntryPersonRoleName> = new Set([
  "fstdInstructor",
  "fstdExaminer",
  "fstdSeniorInstructor"
]);

/** The single session-duration bucket an FSTD entry actually populated
 * (`calculateFSTDTimes`/`fromBulkTimes` only ever set one of these for a
 * given entry, based on the self role on that entry). */
function fstdEntrySessionMinutes(d: DetailedTimes): number {
  return d.fstdSession ?? d.fstdInstructorTime ?? d.fstdExaminerTime ?? d.fstdSeniorInstructorTime ?? 0;
}

export function aggregateTotals(entries: EntryTimesForTotals[], opts: AggregateTotalsOptions = {}): Totals {
  // Inclusion rule, mirroring `FlightMetricsAggregator.aggregateEntry` and the
  // backend's `MetricsAggregator`: a flight entry with no calculated block
  // (scheduled but not flown) is kept out of EVERY total, including the entry
  // count. FSTD entries are not gated on a block (they carry `fstd*` fields only).
  const period = opts.period;
  const included = entries.filter(
    (entry) =>
      (entry.type === "fstd" || entry.detailedTimes.totalTimeOfFlight !== undefined) &&
      (period === undefined || inPeriod(entry.date, period))
  );

  const totals: Totals = {
    totalBlockMinutes: 0,
    totalAirMinutes: 0,
    totalNightMinutes: 0,
    totalIfrMinutes: 0,
    totalPicMinutes: 0,
    totalPicusMinutes: 0,
    totalSpicMinutes: 0,
    totalCoPilotMinutes: 0,
    totalDualMinutes: 0,
    totalInstructorMinutes: 0,
    totalFstdSessionMinutes: 0,
    cruiseReliefRawMinutes: 0,
    cruiseReliefCreditedMinutes: 0,
    taxiTimeMinutes: 0,
    singlePilotSingleEngineMinutes: 0,
    singlePilotMultiEngineMinutes: 0,
    multiPilotMinutes: 0,
    entryCount: included.length,
    fnptSessionMinutes: 0,
    nonCreditableSimSessionMinutes: 0,
    totalFSTDTraineeSessions: 0,
    totalFSTDInstructedSessions: 0,
    crossCountryMinutes: 0,
    crossCountryIsEstimated: false
  };

  let anyResolvableCoordinates = false;

  for (const { type, detailedTimes: d, easaTimesSigned: e, fstdDeviceCategory, selfRole, fromIcao, toIcao } of included) {
    const isFstd = type === "fstd";
    // careerTotals.totalBlockHours/totalAirTimeHours include bulk hours.
    totals.totalBlockMinutes += d.totalTimeOfFlight ?? 0;
    totals.totalAirMinutes += d.totalAirTime ?? 0;
    totals.totalNightMinutes += d.night ?? 0;
    totals.totalIfrMinutes += d.ifr ?? 0;

    // Strict command-PIC, PICUS/SPIC never double-summed.
    totals.totalPicMinutes += commandPICMinutes(d);
    totals.totalPicusMinutes += d.picusRole ?? 0;
    totals.totalSpicMinutes += d.spicRole ?? 0;

    totals.totalCoPilotMinutes += e.coPilot ?? 0;
    totals.totalDualMinutes += e.dual ?? 0;
    totals.totalInstructorMinutes += e.instructor ?? 0;
    totals.totalFstdSessionMinutes += d.fstdSession ?? 0;

    // CRCP credited-vs-raw split. A legacy row with no
    // persisted `cruiseReliefCoPilotCredited` undercounts here, a known
    // simplification; see docs/TIMES.md.
    totals.cruiseReliefRawMinutes += d.cruiseReliefRawBlock ?? 0;
    totals.cruiseReliefCreditedMinutes += d.cruiseReliefCoPilotCredited ?? 0;

    totals.singlePilotSingleEngineMinutes += d.singlePilotSingleEngine ?? 0;
    totals.singlePilotMultiEngineMinutes += d.singlePilotMultiEngine ?? 0;
    totals.multiPilotMinutes += d.multiPilot ?? 0;

    // 5a. FSTD device-category routing,
    // FSTD entries only.
    if (isFstd) {
      if (fstdDeviceCategory === "fnpt") {
        totals.fnptSessionMinutes += fstdEntrySessionMinutes(d);
      } else if (fstdDeviceCategory === "ftd" || fstdDeviceCategory === "bitd") {
        totals.nonCreditableSimSessionMinutes += fstdEntrySessionMinutes(d);
      }
      // "ffs" counts in neither sub-bucket, only in totalFstdSessionMinutes.
    }

    // 5b. Trainee vs. instructed FSTD session counts
    //, keyed on the current user's
    // OWN role on the entry, with a deliberate default-to-trainee branch.
    // FSTD entries only: a flight never counts as an FSTD session.
    if (isFstd) {
      if (selfRole === "fstdTrainee") {
        totals.totalFSTDTraineeSessions += 1;
      } else if (selfRole !== undefined && FSTD_INSTRUCTED_ROLES.has(selfRole)) {
        totals.totalFSTDInstructedSessions += 1;
      } else if (selfRole === "fstdObserver") {
        // neither bucket
      } else {
        // Default branch, deliberate (nil/non-FSTD role), matches the iOS source exactly.
        totals.totalFSTDTraineeSessions += 1;
      }
    }

    // 5c. Cross-country-by-distance.
    if (opts.lookupAirport && fromIcao !== undefined && toIcao !== undefined) {
      const origin = opts.lookupAirport(fromIcao);
      const destination = opts.lookupAirport(toIcao);
      if (origin?.hasPosition && destination?.hasPosition) {
        anyResolvableCoordinates = true;
        const distanceNM = haversineDistanceNM(origin.lat, origin.lon, destination.lat, destination.lon);
        if (distanceNM >= CROSS_COUNTRY_DISTANCE_THRESHOLD_NM) {
          totals.crossCountryMinutes += d.totalTimeOfFlight ?? 0;
        }
      }
    }
  }

  // Taxi time gated on air time being logged.
  totals.taxiTimeMinutes = totals.totalAirMinutes > 0 ? Math.max(0, totals.totalBlockMinutes - totals.totalAirMinutes) : 0;

  totals.crossCountryIsEstimated = opts.lookupAirport !== undefined && anyResolvableCoordinates;

  return totals;
}

// ---------------------------------------------------------------------------
// 5d. ATPL caps
// ---------------------------------------------------------------------------

const SYNTHETIC_CREDIT_CAP_HOURS = 100.0;
const FNPT_CREDIT_CAP_HOURS = 25.0;
const CRCP_CREDIT_CAP_HOURS = 250.0;

export interface AtplCaps {
  crcpCreditedHours: number;
  crcpExcessHours: number;
  fnptCreditedHours: number;
  ffsCreditedHours: number;
  syntheticCreditedHours: number;
  realAeroplaneCreditedHours: number;
  totalFlightTimeCreditedHours: number;
  multiPilotCreditedHours: number;
}

/**
 * Applies the ATPL CRCP/FNPT/synthetic credit caps to a `Totals` snapshot.
 * Kept as a clearly separable post-processing step (not folded into
 * `aggregateTotals` itself) since it's explicitly a licence-progress
 * projection, not a plain sum. Works in HOURS internally (matching the
 * iOS constants), converting `Totals`'s minutes at the boundary.
 *
 * Deliberately not implemented here: the PIC-pillar "best of three routes"
 * calculation is out of scope even for a future
 * entry-level corpus; documented here in case a later corpus extends to it.
 */
export function applyAtplCaps(totals: Totals): AtplCaps {
  const crcpFlown = totals.cruiseReliefRawMinutes / 60;
  const crcpCreditedHours = Math.min(crcpFlown, CRCP_CREDIT_CAP_HOURS);
  const crcpExcessHours = Math.max(0, crcpFlown - CRCP_CREDIT_CAP_HOURS);

  const loggedFNPT = totals.fnptSessionMinutes / 60;
  const loggedNonCreditable = totals.nonCreditableSimSessionMinutes / 60;
  const loggedFFS = Math.max(0, totals.totalFstdSessionMinutes / 60 - loggedFNPT - loggedNonCreditable);

  const fnptCreditedHours = Math.min(loggedFNPT, FNPT_CREDIT_CAP_HOURS);
  const ffsCreditedHours = Math.min(loggedFFS, Math.max(0, SYNTHETIC_CREDIT_CAP_HOURS - fnptCreditedHours));
  const syntheticCreditedHours = fnptCreditedHours + ffsCreditedHours;

  const realAeroplaneCreditedHours = Math.max(0, totals.totalBlockMinutes / 60 - crcpExcessHours);
  const totalFlightTimeCreditedHours = realAeroplaneCreditedHours + syntheticCreditedHours;
  const multiPilotCreditedHours = Math.max(0, totals.multiPilotMinutes / 60 - crcpExcessHours);

  return {
    crcpCreditedHours,
    crcpExcessHours,
    fnptCreditedHours,
    ffsCreditedHours,
    syntheticCreditedHours,
    realAeroplaneCreditedHours,
    totalFlightTimeCreditedHours,
    multiPilotCreditedHours
  };
}
