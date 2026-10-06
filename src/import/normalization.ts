/**
 * Import normalization, ported from the Jetlog iOS app.
 *
 * In the app every function here takes an `existingEntry` parameter so a
 * matched row (one merging onto a stored entry) can be normalized correctly
 * too. This CLI never has a matched existing entry (see `model.ts`'s file
 * doc comment), so `existingEntry` is omitted here and every call site behaves
 * like the app's `existingEntry: nil` branch. Comments below call out
 * anywhere that branch choice matters.
 */
import { mapImportedRoleCode } from "../times/roleCodes.js";
import { COPILOT_SEAT_FAMILY as CALC_COPILOT_SEAT_FAMILY } from "../times/types.js";
import {
  entryPersonRoleRawValue,
  isEmptyTimes,
  time,
  timesContainsDayOrLongerDuration,
  type EntryPersonRole,
  type ImportedEntry,
  type Times
} from "./model.js";

/** How a LogTen partial-SIC (seat-time-less-than-block co-pilot) row resolves. */
export type LogTenPartialSICStrategy = "creditFullBlock" | "preserveLoggedSeatTime";

const DAY_MINUTES = 24 * 60;
function normalizeDay(minutes: number): number {
  return ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

/** Wrap-safe (day-boundary) block duration derived from the imported timeline
 * (or `manualTimes.totalTimeOfFlight` for bulk entries). */
export function normalizedFlightBlockMinutesForImport(entry: ImportedEntry): number | undefined {
  if (entry.type !== "flight") return undefined;
  if (entry.isBulk) return entry.manualTimes?.totalTimeOfFlight?.totalMinutes;
  if (entry.offBlocks === undefined || entry.onBlocks === undefined) return undefined;
  return normalizeDay(entry.onBlocks.totalMinutes - entry.offBlocks.totalMinutes);
}

/**
 * A source logbook that records the ENTIRE block as PICUS on a co-pilot-seat
 * row means the sector was flown as PICUS; retag the role so role
 * attribution produces the identical hours. Lossless by construction: it
 * only fires when `picus` equals the row's own block.
 */
export function retaggedLosslessPICUSRole(entry: ImportedEntry, role: EntryPersonRole | undefined): EntryPersonRole | undefined {
  if (
    role === undefined ||
    // Same seat family as iOS `EntryPersonRole.coPilotSeatFamily` (CRCP is NOT in it).
    !CALC_COPILOT_SEAT_FAMILY.has(mapImportedRoleCode(entryPersonRoleRawValue(role))) ||
    entry.type !== "flight" ||
    entry.isBulk
  ) {
    return role;
  }
  const picusMinutes = entry.manualTimes?.picus?.totalMinutes;
  if (picusMinutes === undefined || picusMinutes <= 0) return role;
  if (picusMinutes !== normalizedFlightBlockMinutesForImport(entry)) return role;
  return "PICUS";
}

/**
 * Applies authoritative flight block duration from importer source data. For
 * regular flight entries this is represented by on/off block timeline
 * values so calculator and UX follow the same editable source of truth.
 */
export function applyAuthoritativeFlightBlockDuration(
  entry: ImportedEntry,
  blockMinutes: number | undefined,
  preserveExistingTimeline = false
): void {
  if (entry.type !== "flight" || blockMinutes === undefined || blockMinutes < 0) return;

  if (blockMinutes >= 1440) {
    const times: Times = { ...(entry.manualTimes ?? {}) };
    times.totalTimeOfFlight = time(blockMinutes);
    entry.manualTimes = times;
    entry.isBulk = true;
    entry.offBlocks = undefined;
    entry.onBlocks = undefined;
    entry.airborne = undefined;
    entry.touchdown = undefined;
    entry.from = undefined;
    entry.to = undefined;
    entry.actualFrom = undefined;
    entry.actualTo = undefined;
    return;
  }

  if (entry.manualTimes) {
    entry.manualTimes = { ...entry.manualTimes, totalTimeOfFlight: undefined };
  }

  const off = entry.offBlocks;
  const on = entry.onBlocks;
  if (off === undefined && on === undefined) {
    entry.offBlocks = time(0);
    entry.onBlocks = time(blockMinutes);
  } else if (off === undefined && on !== undefined) {
    const offMinutes = normalizeDay(on.totalMinutes - blockMinutes);
    entry.offBlocks = time(offMinutes);
    entry.onBlocks = time(normalizeDay(offMinutes + blockMinutes));
  } else if (off !== undefined && on === undefined) {
    entry.onBlocks = time(normalizeDay(off.totalMinutes + blockMinutes));
  } else if (off !== undefined && on !== undefined) {
    if (!preserveExistingTimeline) {
      entry.onBlocks = time(normalizeDay(off.totalMinutes + blockMinutes));
    }
    // else: keep the exported off/on blocks as the authoritative timeline
    // (some CRCP LogTen exports use flight_totalTime for seat/function time
    // rather than block time).
  }

  entry.updateFlightData = false;
  entry.updateFlightDataIsNonIntentDefault = true;
}

const PILOT_FUNCTION_BUCKETS: Array<keyof Times> = [
  "pilotInCommand",
  "coPilot",
  "cruiseReliefCoPilot",
  "picus",
  "spic",
  "dual",
  "instructor",
  "examiner"
];

function clearingRedundantCRCPRawTimeOverride(times: Times): Times {
  return { ...times, cruiseReliefCoPilot: undefined };
}

/**
 * Nils `cruiseReliefCoPilot`: redundant once a row's role resolves to CRCP,
 * since role-based attribution already credits the full block. Call after
 * (re-)assigning a row's role to CRCP outside of import, where
 * `normalizeImportedFlightManualTimes` already ran once against the row's
 * original role and never saw this one.
 */
export function clearRedundantCRCPRawTimeOverride(entry: ImportedEntry): void {
  if (!entry.manualTimes || entry.manualTimes.cruiseReliefCoPilot === undefined) return;
  const cleared = clearingRedundantCRCPRawTimeOverride(entry.manualTimes);
  entry.manualTimes = isEmptyTimes(cleared) ? undefined : cleared;
}

/**
 * Resolves a flight row's `manualTimes` for the role it was assigned:
 * keeps only the pilot-function column the role's override tile consumes (the role leads) and
 * sweeps stray 0:00 overrides that just mean "absent source column" (not
 * a deliberate zero, that distinction only exists for a matched row whose
 * existing entry "honours zero pilot-function overrides", which never
 * applies offline, so the sweep always fires here; see the file doc comment).
 */
export function normalizeImportedFlightManualTimes(
  entry: ImportedEntry,
  role: EntryPersonRole | undefined,
  partialSICStrategy: LogTenPartialSICStrategy = "creditFullBlock"
): void {
  if (entry.type !== "flight" || entry.isBulk) return;

  const times: Times = { ...(entry.manualTimes ?? {}) };
  const roleRaw = role !== undefined ? entryPersonRoleRawValue(role) : undefined;

  // The partial co-pilot seat-time predicate only matters for the LogTen
  // partial-SIC review: it decides whether a `CP` row keeps its logged `coPilot`
  // figure for the review to credit as the CRCP override. `spic` /
  // `cruiseReliefCoPilot` are deliberately not part of the shape check.
  // `CRCP` must stay excluded: a CRCP row keeps `coPilot` as its credited
  // override, which is not partial seat time. A zero is never partial.
  const isPartialSICSeatTimeRow = (() => {
    if (
      roleRaw === "CRCP" ||
      times.pilotInCommand !== undefined ||
      times.picus !== undefined ||
      times.dual !== undefined
    ) {
      return false;
    }
    const loggedCoPilot = times.coPilot?.totalMinutes;
    if (loggedCoPilot === undefined || loggedCoPilot <= 0) return false;
    const blockMinutes = normalizedFlightBlockMinutesForImport(entry);
    return blockMinutes !== undefined && blockMinutes > loggedCoPilot;
  })();
  const shouldPreservePartialSeatTime = isPartialSICSeatTimeRow && partialSICStrategy === "preserveLoggedSeatTime";

  // Policy for imported pilot-function columns: the role leads. The only
  // source columns an imported row may keep are exactly the ones the app's own
  // override tiles write (the calculator's manual-override fold is their only
  // consumer, see `manualOverrideColumns` in `calculator.ts`):
  //   - co-pilot seat family  -> `pilotInCommand` (PIC carve out of the seat time)
  //   - CRCP                  -> `coPilot` (the credited co-pilot override)
  //   - SPIC                  -> `dual` (the dual carve out of SPIC)
  // Everything else (SIC column on a PIC row, a partial PIC/SIC, dual on STU,
  // instructor, examiner, picus/spic, the cross-role relief column) is ignored
  // by the calculator, so it is not written at all. Night/IFR/multi-pilot/totals
  // are not pilot-function columns and are untouched. An unresolved role clears
  // nothing: the review picker assigns it later (and
  // `clearRedundantCRCPRawTimeOverride` covers CRCP). There is no matched
  // existing entry offline, so no "inherited value" exception is needed.
  if (role !== undefined && roleRaw !== undefined) {
    const calcRole = mapImportedRoleCode(roleRaw);
    let kept: keyof Times | undefined;
    if (CALC_COPILOT_SEAT_FAMILY.has(calcRole)) kept = "pilotInCommand";
    else if (calcRole === "cruiseReliefCoPilot") kept = "coPilot";
    else if (calcRole === "studentPilotInCommand") kept = "dual";
    for (const bucket of PILOT_FUNCTION_BUCKETS) {
      if (bucket === kept) continue;
      // The LogTen partial-SIC review's transient state: a partial co-pilot seat
      // time kept only so the review can credit it as the CRCP override (or clear
      // it). Never survives to the calculator as a co-pilot figure.
      if (bucket === "coPilot" && calcRole === "coPilot" && shouldPreservePartialSeatTime) continue;
      (times as Record<string, unknown>)[bucket] = undefined;
    }
  }

  // Zero-sweep: a stored 0:00 pilot-function bucket means "absent source
  // column", not information, unless it was seeded from a matched existing
  // entry that honours zero overrides, never the case here, offline.
  for (const bucket of PILOT_FUNCTION_BUCKETS) {
    if ((times[bucket] as import("./model.js").Time | undefined)?.totalMinutes === 0) {
      (times as Record<string, unknown>)[bucket] = undefined;
    }
  }

  entry.manualTimes = isEmptyTimes(times) ? undefined : times;
}

/**
 * Applies authoritative FSTD session duration from importer source data. For
 * non-bulk entries session time is derived from startTime/endTime, so
 * `manualTimes.fstdSession` is only set for bulk entries (>=24h).
 */
export function applyAuthoritativeFSTDSessionDuration(entry: ImportedEntry, sessionMinutes: number | undefined): void {
  if (entry.type !== "fstd" || sessionMinutes === undefined || sessionMinutes < 0) return;

  if (sessionMinutes >= 1440) {
    const times: Times = { ...(entry.manualTimes ?? {}) };
    times.fstdSession = time(sessionMinutes);
    entry.manualTimes = times;
    entry.isBulk = true;
    entry.startTime = undefined;
    entry.endTime = undefined;
    return;
  }

  if (entry.startTime === undefined) entry.startTime = time(0);
  if (entry.endTime === undefined) entry.endTime = time(sessionMinutes);
}

/**
 * Checks if any time values are >= 24h and converts the entry to a bulk
 * entry, bulk entries store durations in `manualTimes` instead of
 * time-of-day values.
 */
export function convertToBulkIfNeeded(entry: ImportedEntry): void {
  if (entry.isBulk) return;

  const manualTimesRequireBulk = entry.manualTimes !== undefined && timesContainsDayOrLongerDuration(entry.manualTimes);

  if (entry.type === "flight") {
    const timelineTimes = [entry.offBlocks, entry.onBlocks, entry.airborne, entry.touchdown].filter(
      (t): t is import("./model.js").Time => t !== undefined
    );
    const hasLargeTimelineTime = timelineTimes.some((t) => t.totalMinutes >= 1440);
    if (!hasLargeTimelineTime && !manualTimesRequireBulk) return;

    const times: Times = { ...(entry.manualTimes ?? {}) };
    if (times.totalTimeOfFlight === undefined) {
      if (entry.onBlocks !== undefined && entry.offBlocks !== undefined) {
        const duration = Math.max(0, entry.onBlocks.totalMinutes - entry.offBlocks.totalMinutes);
        if (duration > 0 || hasLargeTimelineTime) times.totalTimeOfFlight = time(duration);
      } else if (hasLargeTimelineTime) {
        const max = [entry.offBlocks, entry.onBlocks].filter((t): t is import("./model.js").Time => t !== undefined);
        if (max.length > 0) times.totalTimeOfFlight = max.reduce((a, b) => (a.totalMinutes >= b.totalMinutes ? a : b));
      }
    }
    entry.manualTimes = isEmptyTimes(times) ? undefined : times;
    entry.isBulk = true;
    entry.offBlocks = undefined;
    entry.onBlocks = undefined;
    entry.airborne = undefined;
    entry.touchdown = undefined;
    entry.from = undefined;
    entry.to = undefined;
    entry.actualFrom = undefined;
    entry.actualTo = undefined;
  }

  if (entry.type === "fstd") {
    const timelineTimes = [entry.startTime, entry.endTime].filter((t): t is import("./model.js").Time => t !== undefined);
    const hasLargeTimelineTime = timelineTimes.some((t) => t.totalMinutes >= 1440);
    if (!hasLargeTimelineTime && !manualTimesRequireBulk) return;

    const times: Times = { ...(entry.manualTimes ?? {}) };
    if (times.fstdSession === undefined) {
      if (entry.endTime !== undefined && entry.startTime !== undefined) {
        const duration = Math.max(0, entry.endTime.totalMinutes - entry.startTime.totalMinutes);
        if (duration > 0 || hasLargeTimelineTime) times.fstdSession = time(duration);
      } else if (hasLargeTimelineTime) {
        const max = [entry.startTime, entry.endTime].filter((t): t is import("./model.js").Time => t !== undefined);
        if (max.length > 0) times.fstdSession = max.reduce((a, b) => (a.totalMinutes >= b.totalMinutes ? a : b));
      }
    }
    entry.manualTimes = isEmptyTimes(times) ? undefined : times;
    entry.isBulk = true;
    entry.startTime = undefined;
    entry.endTime = undefined;
  }
}
