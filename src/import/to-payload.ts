/**
 * `ImportResult` -> the public deeplink/API payload (`src/schema.ts`).
 *
 * Deliberately small and isolated: the public payload is narrower than
 * `ImportedEntry` (FSTD sessions, function-time buckets, approaches, crew
 * roles beyond the public payload's string role, etc.). This mapper exists so
 * `jetlog link` can keep building deeplinks from a dedicated importer's
 * output. It does the simplest thing that works and drops whatever the public
 * payload has no field for, rather than trying to be a faithful or complete
 * mapping.
 *
 * Only flight entries with a flight number or registration survive: that's
 * what `src/schema.ts`'s deeplink/API mode requires (see
 * `checkModeRequirements`), same constraint the existing CSV presets work
 * under.
 */
import type { EntryInput, PayloadInput } from "../schema.js";
import type { ImportResult, ImportedEntry } from "./model.js";
import { formatTimeOfDay } from "./model.js";

export interface ToPayloadResult {
  payload: PayloadInput;
  /** Count of fields dropped because the public payload has no slot for
   * them (FSTD sessions entirely, approaches, function-time buckets,
   * crew beyond ref_id+role, etc.), a simple count, not a field-by-field
   * breakdown; see the file doc comment for why this stays minimal. */
  droppedFieldCount: number;
  /** Entries dropped entirely (FSTD sessions, or flight rows with neither a
   * flight number nor a registration). */
  droppedEntryCount: number;
}

function entryToPayloadInput(entry: ImportedEntry, dropped: { count: number }): EntryInput | undefined {
  if (entry.type !== "flight") return undefined;
  if (!entry.flightNumber && !entry.registration) return undefined;

  const out: EntryInput = { date: entry.date };
  if (entry.flightNumber) out.flight_number = entry.flightNumber;
  if (entry.registration) out.registration = entry.registration;
  if (entry.from) out.from = entry.from;
  if (entry.to) out.to = entry.to;
  if (entry.scheduledOffBlocks) out.scheduled_off_blocks = formatTimeOfDay(entry.scheduledOffBlocks);
  if (entry.scheduledOnBlocks) out.scheduled_on_blocks = formatTimeOfDay(entry.scheduledOnBlocks);
  if (entry.offBlocks) out.off_blocks = formatTimeOfDay(entry.offBlocks);
  if (entry.airborne) out.airborne = formatTimeOfDay(entry.airborne);
  if (entry.touchdown) out.touchdown = formatTimeOfDay(entry.touchdown);
  if (entry.onBlocks) out.on_blocks = formatTimeOfDay(entry.onBlocks);
  if (entry.remarks) out.remarks = entry.remarks;
  if (entry.updateFlightData !== undefined) out.update_flight_data = entry.updateFlightData;
  if (entry.goArounds !== undefined) out.go_arounds = entry.goArounds;
  if (entry.passengersOnBoard !== undefined) out.passengers_on_board = entry.passengersOnBoard;
  if (entry.fuelPlanned !== undefined) out.fuel_planned = entry.fuelPlanned;
  if (entry.fuelUsed !== undefined) out.fuel_used = entry.fuelUsed;
  if (entry.cargoOnBoard !== undefined) out.cargo_on_board = entry.cargoOnBoard;
  if (entry.takeoffsAndLandings) {
    out.takeoffs_and_landings =
      entry.takeoffsAndLandings.type === "auto"
        ? { takeoffs: entry.takeoffsAndLandings.takeoffs, landings: entry.takeoffsAndLandings.landings }
        : {
            takeoffs_day: entry.takeoffsAndLandings.takeoffsDay,
            takeoffs_night: entry.takeoffsAndLandings.takeoffsNight,
            landings_day: entry.takeoffsAndLandings.landingsDay,
            landings_night: entry.takeoffsAndLandings.landingsNight
          };
  }
  if (entry.crew.length > 0) {
    out.people = entry.crew.map((c) => ({ ref_id: c.refId, role: typeof c.role === "string" ? c.role : c.role.unknown }));
  }

  // Dropped (counted, not itemized, see the file doc comment): approaches,
  // goArounds already handled above, FSTD-only fields, manualTimes/Times
  // function buckets, ifr flag, actualFrom/actualTo, approaches autolands,
  // aircraftIcaoCode, fstdTakeoffs/fstdLandings.
  if (entry.approaches && entry.approaches.length > 0) dropped.count += 1;
  if (entry.manualTimes) dropped.count += 1;
  if (entry.ifr !== undefined) dropped.count += 1;
  if (entry.actualFrom || entry.actualTo) dropped.count += 1;

  return out;
}

export function importResultToPayload(result: ImportResult): ToPayloadResult {
  const dropped = { count: 0 };
  let droppedEntryCount = 0;

  const entries: EntryInput[] = [];
  for (const entry of result.entries) {
    const mapped = entryToPayloadInput(entry, dropped);
    if (mapped) entries.push(mapped);
    else droppedEntryCount += 1;
  }

  const people = result.people
    .filter((p) => p.firstName || p.lastName)
    .map((p) => ({
      ref_id: p.refId,
      first_name: p.firstName ?? "",
      last_name: p.lastName ?? "",
      default_role: p.defaultRole ? (typeof p.defaultRole === "string" ? p.defaultRole : p.defaultRole.unknown) : undefined,
      employee_number: p.employeeNumber
    }));

  return {
    payload: { entries, people },
    droppedFieldCount: dropped.count,
    droppedEntryCount
  };
}
