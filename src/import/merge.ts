/**
 * Port of the Jetlog iOS app's entry merge (`mergeImported`/`resolvedRemarks`).
 * Produces the final sync JSON fields for one entry, either brand new or
 * merged onto the `RemoteEntry` it matched (`match.ts`).
 *
 * ## `update_flight_data` / `adoptSystemFlightData`
 *
 * The remote mirror gives this CLI the matched entry's real
 * `*_system`/`system_date`/`system_from`/`system_to` columns (`EntryJSON`
 * includes them, see `remote-mirror.ts`), so the auto/manual switch works as
 * in the app:
 *
 * - A brand-new row (`existing` undefined) starts from the app's default of
 *   `update_flight_data: true`, not `false`. A plain historical import (every
 *   importer's non-intent `updateFlightData: false` +
 *   `updateFlightDataIsNonIntentDefault: true`, or an importer's own genuine
 *   "this format has no off/on columns" `false`) still switches it to manual
 *   below, but a row that does not state an intent
 *   (`imported.updateFlightData === undefined`) keeps the live-tracking
 *   default `true`.
 * - `adoptSystemFlightData`: switching from auto (`update_flight_data: true`)
 *   to manual first seeds the manual columns (`registration`/`off_blocks`/
 *   `airborne`/`touchdown`/`on_blocks`/`date`) from the system columns, so a
 *   currently auto-tracked matched entry doesn't blank out when flipped to
 *   manual. `actual_from`/`actual_to` are seeded only on a genuine diversion
 *   (`routeDiverges`: the system airport differs from the planned one,
 *   comparing canonical codes via `src/airports`'s `canonicalCode`, the
 *   single airport resolver: logged-in catalog plus the user's places when a
 *   command installed them, else none). No-op when already
 *   manual, or brand-new (no system columns to adopt).
 * - The future-flight auto-track rule: `isNonIntentManualDefault` (the
 *   row's `updateFlightData: false` carries no real intent, see
 *   `ImportedEntry.updateFlightDataIsNonIntentDefault`'s doc comment) on a
 *   new, non-bulk, flight-numbered row dated today-or-later keeps
 *   auto-tracking (`update_flight_data: true`) instead of switching to
 *   manual; a matched row in the same shape keeps its stored
 *   `update_flight_data` untouched (a plain re-import never flips an
 *   already-auto-tracked future entry to manual).
 *
 * ## What is not ported (scope cut for this CLI)
 *
 * - `materializeAsNewEntry` (a matched row committed as an independent copy
 *   instead of an update) has no interactive per-row Merge/New review step
 *   here; `jetlog import --as-new` instead forces every row that
 *   would have matched onto the brand-new path before it reaches this
 *   function (see `resolve.ts`), so `mergeImported` itself never needs the
 *   detach-from-original-identity logic `materializeAsNewEntry` layers on
 *   top.
 * - `clearedFields`/`actualTimeFieldsCarriedByPayload`/
 *   `isDuplicateOfEarlierRow`/`logTenCustomSwitchIndices` resolution: no
 *   current CLI importer sets these (every one is a plain "brand-new row"
 *   producer, see `model.ts`), so the merge below needs none of their
 *   special cases. A future importer that starts setting them needs the same
 *   handling the iOS app has for them.
 * - `updateFlightDataIsInferredGapFill`'s own branch is ported (see
 *   `wouldWriteActualTime`/`mergeWritesNewActualTime` below), even though no
 *   current importer sets that flag (reserved for a future matched-row
 *   importer, e.g. a richer deeplink-json re-import). It reuses the same
 *   `writes*` computation the plain conservative-actual-time gate already
 *   needs.
 *
 * Everything else is ported field for field: route/time conservative-gating
 * (flight-number-normalization-only matches only fill gaps, never
 * overwrite), remarks append/replace, bulk conversion, manual-times
 * authoritative overwrite, crew replace-vs-union-add, and `isDeleted`'s "nil
 * always un-deletes" rule.
 */
import { randomUUID } from "node:crypto";
import { canonicalCode } from "../airports/index.js";
import {
  entryPersonRoleRawValue,
  entryTypeRawValue,
  formatTimeOfDay,
  type DateOnly,
  type EntryPersonRole,
  type ImportedEntry
} from "./model.js";
import type { RemoteEntry } from "./remote-mirror.js";

export const MAX_REMARKS_LENGTH = 1000;

/** Remarks merge: append or replace, per `remarksMergeMode`. */
export function resolvedRemarks(imported: ImportedEntry, existingRemarks: string | null | undefined): string | undefined {
  const incoming = imported.remarks?.trim();
  const stored = existingRemarks?.trim();
  if (imported.remarksMergeMode !== "append" || !incoming || !stored) {
    return imported.remarks;
  }
  if (stored.includes(incoming)) return existingRemarks ?? undefined;
  return `${stored}\n${incoming}`.slice(0, MAX_REMARKS_LENGTH);
}

export interface MergedEntry {
  /** The id to PUT under, the matched remote id, or a fresh uuid v4 for a new row. */
  id: string;
  isNew: boolean;
  /** Sync-API field map (snake_case), ready for `PUT /api/entries` (minus `timestamp`, server-stamped). */
  fields: Record<string, unknown>;
  /** Final crew list: remote person id -> role (SELF already resolved). */
  crew: { personId: string; role: string }[];
}

function apply<T>(value: T | undefined, current: T | undefined, conservative: boolean): T | undefined {
  if (value === undefined) return current;
  if (conservative && current !== undefined && current !== null) return current;
  return value;
}

function timeStr(t: { totalMinutes: number } | undefined): string | undefined {
  return t ? formatTimeOfDay(t) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function todayDateOnly(): DateOnly {
  return new Date().toISOString().slice(0, 10);
}

/** True when the recorded airport differs from the planned one (canonical codes compared). */
function routeDiverges(recorded: string | undefined, planned: string | undefined): boolean {
  if (!planned || !recorded) return false;
  if (recorded === planned) return false;
  return canonicalCode(recorded) !== canonicalCode(planned);
}

/** The manual-layer fields `adoptSystemFlightData`/the plain merge below
 * read and write; mirrors the subset of `Entry`'s manual columns that
 * participate in the auto/manual switch. */
interface RouteTimeState {
  registration?: string;
  from?: string;
  to?: string;
  actualFrom?: string;
  actualTo?: string;
  offBlocks?: string;
  airborne?: string;
  touchdown?: string;
  onBlocks?: string;
  date: DateOnly;
}

interface SystemState {
  registration?: string;
  from?: string;
  to?: string;
  offBlocks?: string;
  airborne?: string;
  touchdown?: string;
  onBlocks?: string;
  date?: DateOnly;
}

function systemStateFrom(existing: RemoteEntry | undefined): SystemState {
  return {
    registration: str(existing?.registration_system),
    from: str(existing?.system_from),
    to: str(existing?.system_to),
    offBlocks: str(existing?.off_blocks_system),
    airborne: str(existing?.airborne_system),
    touchdown: str(existing?.touchdown_system),
    onBlocks: str(existing?.on_blocks_system),
    date: str(existing?.system_date)
  };
}

/**
 * Mutates `manual` in place, seeding it from `system`. Called only while still
 * auto-tracked (always before `updateFlightData` itself flips to `false`), so
 * the "recorded" side of the diversion check is always the system value, not
 * the about-to-be-superseded manual one.
 */
function adoptSystemFlightData(manual: RouteTimeState, system: SystemState): void {
  if (system.registration !== undefined) manual.registration = system.registration;
  if (system.offBlocks !== undefined) manual.offBlocks = system.offBlocks;
  if (system.airborne !== undefined) manual.airborne = system.airborne;
  if (system.touchdown !== undefined) manual.touchdown = system.touchdown;
  if (system.onBlocks !== undefined) manual.onBlocks = system.onBlocks;
  if (system.from !== undefined && routeDiverges(system.from, manual.from)) manual.actualFrom = system.from;
  if (system.to !== undefined && routeDiverges(system.to, manual.to)) manual.actualTo = system.to;
  if (system.date !== undefined) manual.date = system.date;
}

/**
 * Merges `imported` onto `existing` (`undefined` for a brand-new row).
 * `matchedViaFlightNumberNormalization` (from `match.ts`) drives the
 * conservative gate. `resolvedCrew` maps each `ImportedEntryCrewMember.refId`
 * (including `"SELF"`) to the remote person id to write. `today` drives the
 * future-flight auto-track rule (see this file's doc comment); defaults to
 * the real current date, overridable for tests.
 */
export function mergeImported(
  imported: ImportedEntry,
  existing: RemoteEntry | undefined,
  matchedViaFlightNumberNormalization: boolean,
  resolvedCrew: Map<string, string>,
  today: DateOnly = todayDateOnly()
): MergedEntry {
  const conservative = matchedViaFlightNumberNormalization;
  const id = existing?.id ?? imported.preferredNewId ?? randomUUID();
  const isNew = !existing;

  const fields: Record<string, unknown> = {
    id,
    date: imported.date,
    type: entryTypeRawValue(imported.type)
  };

  const existingFlightNumber = str(existing?.flight_number);

  // A brand new row starts auto-tracked (`update_flight_data: true`), same as
  // the app, not manual. `existing`'s stored value otherwise carries over as
  // the starting point for the switch logic below.
  let updateFlightData = existing ? Boolean(existing.update_flight_data) : true;

  const manual: RouteTimeState = {
    registration: str(existing?.registration),
    from: str(existing?.from),
    to: str(existing?.to),
    actualFrom: str(existing?.actual_from),
    actualTo: str(existing?.actual_to),
    offBlocks: str(existing?.off_blocks),
    airborne: str(existing?.airborne),
    touchdown: str(existing?.touchdown),
    onBlocks: str(existing?.on_blocks),
    date: existing ? String(existing.date) : imported.date
  };
  const system = systemStateFrom(existing);

  function switchToManualFlightData(): void {
    if (!updateFlightData) return; // no-op when already manual.
    adoptSystemFlightData(manual, system);
    updateFlightData = false;
  }

  // Future-flight auto-track rule (see file doc comment).
  const isNonIntentManualDefault = imported.updateFlightData === false && imported.updateFlightDataIsNonIntentDefault === true;
  const effectiveFlightNumber = imported.flightNumber ?? existingFlightNumber;
  const isFutureOrTodayRegularFlight =
    imported.type === "flight" && !imported.isBulk && !!effectiveFlightNumber && imported.date >= today;
  const appliesFutureAutoTrackRule = isNonIntentManualDefault && isFutureOrTodayRegularFlight;

  // Conservative actual-time "would this write a NEW value" check, reused
  // both to decide the switch (`updateFlightDataIsInferredGapFill`) and to
  // apply the four actual-time fields below; mirrors
  // `wouldWriteActualTime`/`writesOffBlocks` et al.
  function wouldWriteActualTime(value: string | undefined, current: string | undefined): boolean {
    if (value === undefined) return false;
    return !(conservative && current !== undefined);
  }
  const writesOffBlocks = wouldWriteActualTime(timeStr(imported.offBlocks), manual.offBlocks);
  const writesAirborne = wouldWriteActualTime(timeStr(imported.airborne), manual.airborne);
  const writesTouchdown = wouldWriteActualTime(timeStr(imported.touchdown), manual.touchdown);
  const writesOnBlocks = wouldWriteActualTime(timeStr(imported.onBlocks), manual.onBlocks);
  const mergeWritesNewActualTime = writesOffBlocks || writesAirborne || writesTouchdown || writesOnBlocks;

  if (imported.updateFlightDataIsInferredGapFill) {
    if (mergeWritesNewActualTime) switchToManualFlightData();
  } else if (imported.updateFlightData === false) {
    if (!(appliesFutureAutoTrackRule && !isNew)) switchToManualFlightData();
  }

  // After the switch, unconditionally (adopting system_date must not win
  // over the imported row's own date).
  manual.date = imported.date;

  // Identity-defining fields: plain overwrite whenever the row carries a
  // value (flightNumber/from/to), conservative apply for registration,
  // mirrors `mergeImported`'s own non-`apply()` vs. `apply()` split.
  fields.flight_number = imported.flightNumber ?? existingFlightNumber;
  manual.registration = apply(imported.registration, manual.registration, conservative);
  manual.from = imported.from ?? manual.from;
  manual.to = imported.to ?? manual.to;
  manual.actualFrom = imported.actualFrom ?? manual.actualFrom;
  manual.actualTo = imported.actualTo ?? manual.actualTo;

  // Planned schedule, conservative, not clearable.
  const scheduledOffBlocks = apply(timeStr(imported.scheduledOffBlocks), str(existing?.scheduled_off_blocks), conservative);
  if (scheduledOffBlocks !== undefined) fields.scheduled_off_blocks = scheduledOffBlocks;

  // Actual times, via the pre-switch `writes*` decisions computed above
  // (not a fresh conservative check against the post-adopt manual value):
  // a field the
  // payload doesn't carry keeps whatever `switchToManualFlightData()`
  // already adopted from the system columns.
  if (writesOffBlocks) manual.offBlocks = timeStr(imported.offBlocks);
  if (writesAirborne) manual.airborne = timeStr(imported.airborne);
  if (writesTouchdown) manual.touchdown = timeStr(imported.touchdown);
  if (writesOnBlocks) manual.onBlocks = timeStr(imported.onBlocks);

  // FSTD-specific fields.
  const startTime = apply(timeStr(imported.startTime), (existing?.start_time as string | undefined) ?? undefined, conservative);
  if (startTime !== undefined) fields.start_time = startTime;
  const endTime = apply(timeStr(imported.endTime), (existing?.end_time as string | undefined) ?? undefined, conservative);
  if (endTime !== undefined) fields.end_time = endTime;
  const fstdId = apply(imported.fstdId, (existing?.fstd_id as string | undefined) ?? undefined, conservative);
  if (fstdId !== undefined) fields.fstd_id = fstdId;
  const sessionType = apply(imported.sessionType, (existing?.session_type as string | undefined) ?? undefined, conservative);
  if (sessionType !== undefined) fields.session_type = sessionType;

  // `update_flight_data` final decision: a future-auto-track new row forces
  // auto-tracking; a matched one in the same shape keeps its stored value
  // untouched; everything else is a plain overwrite when the row states an
  // intent (`updateFlightDataIsInferredGapFill` rows never reach here with
  // their own value, the switch above already decided it).
  if (appliesFutureAutoTrackRule) {
    if (isNew) updateFlightData = true;
  } else if (imported.updateFlightData !== undefined && !imported.updateFlightDataIsInferredGapFill) {
    updateFlightData = imported.updateFlightData;
  }
  fields.update_flight_data = updateFlightData;

  fields.date = manual.date;
  fields.registration = manual.registration;
  fields.from = manual.from;
  fields.to = manual.to;
  if (manual.actualFrom !== undefined) fields.actual_from = manual.actualFrom;
  if (manual.actualTo !== undefined) fields.actual_to = manual.actualTo;
  if (manual.offBlocks !== undefined) fields.off_blocks = manual.offBlocks;
  if (manual.airborne !== undefined) fields.airborne = manual.airborne;
  if (manual.touchdown !== undefined) fields.touchdown = manual.touchdown;
  if (manual.onBlocks !== undefined) fields.on_blocks = manual.onBlocks;

  // Counts/flags, conservative apply.
  const takeoffsAndLandings = apply(
    imported.takeoffsAndLandings ? toWireTakeoffsAndLandings(imported.takeoffsAndLandings) : undefined,
    existing?.takeoffs_and_landings,
    conservative
  );
  if (takeoffsAndLandings !== undefined) fields.takeoffs_and_landings = takeoffsAndLandings;

  const approaches = apply(
    imported.approaches?.map((a) => ({
      type: typeof a.type === "string" ? a.type : a.type.unknown,
      count: a.count,
      autolands: a.autolands
    })),
    existing?.approaches,
    conservative
  );
  if (approaches !== undefined) fields.approaches = approaches;

  const goArounds = apply(imported.goArounds, existing?.go_arounds as number | undefined, conservative);
  if (goArounds !== undefined) fields.go_arounds = goArounds;
  const passengersOnBoard = apply(imported.passengersOnBoard, existing?.passengers_on_board as number | undefined, conservative);
  if (passengersOnBoard !== undefined) fields.passengers_on_board = passengersOnBoard;
  const fuelPlanned = apply(imported.fuelPlanned, existing?.fuel_planned as number | undefined, conservative);
  if (fuelPlanned !== undefined) fields.fuel_planned = fuelPlanned;
  const fuelUsed = apply(imported.fuelUsed, existing?.fuel_used as number | undefined, conservative);
  if (fuelUsed !== undefined) fields.fuel_used = fuelUsed;
  const cargoOnBoard = apply(imported.cargoOnBoard, existing?.cargo_on_board as number | undefined, conservative);
  if (cargoOnBoard !== undefined) fields.cargo_on_board = cargoOnBoard;

  const resolvedRemarksValue = resolvedRemarks(imported, (existing?.remarks as string | null | undefined) ?? undefined);
  const remarks = apply(resolvedRemarksValue, (existing?.remarks as string | undefined) ?? undefined, conservative);
  if (remarks !== undefined) fields.remarks = remarks.length > MAX_REMARKS_LENGTH ? remarks.slice(0, MAX_REMARKS_LENGTH) : remarks;

  // `ifr`, plain overwrite when stated.
  if (imported.ifr !== undefined) fields.ifr = imported.ifr;
  else if (existing && existing.ifr !== undefined) fields.ifr = existing.ifr;

  const fstdTakeoffs = apply(imported.fstdTakeoffs, existing?.fstd_takeoffs as number | undefined, conservative);
  if (fstdTakeoffs !== undefined) fields.fstd_takeoffs = fstdTakeoffs;
  const fstdLandings = apply(imported.fstdLandings, existing?.fstd_landings as number | undefined, conservative);
  if (fstdLandings !== undefined) fields.fstd_landings = fstdLandings;

  if (imported.isImportedFromOtherLogbook !== undefined) {
    fields.is_imported_from_other_logbook = imported.isImportedFromOtherLogbook;
  }

  // Manual-times authoritative overwrite vs. conservative gap-fill,
  // mirrors `if conservative || !imported.manualTimesAreAuthoritative`.
  const manualTimesWire = imported.manualTimes ? toWireManualTimes(imported.manualTimes) : undefined;
  if (conservative || !imported.manualTimesAreAuthoritative) {
    const merged = apply(manualTimesWire, existing?.manual_times, conservative);
    if (merged !== undefined) fields.manual_times = merged;
  } else {
    fields.manual_times = manualTimesWire ?? null;
  }

  // `isDeleted`, "nil always un-deletes", ported verbatim.
  fields.is_deleted = imported.isDeleted ?? false;

  // Bulk conversion.
  if (imported.isBulk) {
    fields.is_bulk = true;
    if (imported.aircraftIcaoCode) fields.aircraft_icao_code = imported.aircraftIcaoCode;
    fields.is_imported_from_other_logbook = true;
    if (imported.type === "flight") {
      fields.from = null;
      fields.to = null;
      fields.actual_from = null;
      fields.actual_to = null;
      fields.off_blocks = null;
      fields.airborne = null;
      fields.touchdown = null;
      fields.on_blocks = null;
    } else {
      fields.start_time = null;
      fields.end_time = null;
    }
  } else if (!conservative && imported.manualTimesAreAuthoritative) {
    fields.is_bulk = false;
  } else if (existing && existing.is_bulk !== undefined) {
    fields.is_bulk = existing.is_bulk;
  } else {
    fields.is_bulk = false;
  }

  const crew = mergeCrew(imported, existing, resolvedCrew, conservative);
  fields.people = crew.map((c) => ({ person_id: c.personId, role: c.role, is_deleted: false }));

  return { id, isNew, fields, crew };
}

/**
 * Commits a matched row as an independent copy: resolves every field via `mergeImported` exactly
 * like an ordinary merge (route, times, crew, remarks, bulk, ...), then
 * detaches the result from the matched entry's identity so it lands as a
 * brand-new, independent entry instead of an update:
 *
 * - **id**: always a fresh uuid, never the matched `existing.id`, so this
 *   never collides with (or silently overwrites) the entry it matched.
 * - If the merge left the copy auto-tracked (`update_flight_data` still
 *   `true`, the normal outcome when the imported row itself didn't ask
 *   for manual), the system data is adopted onto the manual columns now,
 *   before `update_flight_data` is forced to `false`, so whatever the
 *   user currently sees on the original entry survives as a plain manual
 *   value on the copy, rather than the copy quietly losing its times.
 * - `is_deleted` is forced to `false`; a row's deletion intent is a
 *   statement about the original matched entry, never this copy.
 *
 * Not ported (this CLI's write model never reads or carries these, so
 * there is nothing to clear): `version`/`isCompleted`/`signature*` reset,
 * and the scheduled/estimate/airport-ops system columns
 * (`estimated_*`/`departure_*`/`ctot`/`tobt`/`tsat`/`ttot`), none of
 * those are part of the write surface this CLI uses.
 */
export function materializeAsNewEntry(
  imported: ImportedEntry,
  existing: RemoteEntry | undefined,
  matchedViaFlightNumberNormalization: boolean,
  resolvedCrew: Map<string, string>,
  today: DateOnly = todayDateOnly()
): MergedEntry {
  const merged = mergeImported(imported, existing, matchedViaFlightNumberNormalization, resolvedCrew, today);
  const id = randomUUID();
  const fields: Record<string, unknown> = { ...merged.fields, id };

  if (fields.update_flight_data !== false) {
    const system = systemStateFrom(existing);
    const manual: RouteTimeState = {
      registration: str(fields.registration),
      from: str(fields.from),
      to: str(fields.to),
      actualFrom: str(fields.actual_from),
      actualTo: str(fields.actual_to),
      offBlocks: str(fields.off_blocks),
      airborne: str(fields.airborne),
      touchdown: str(fields.touchdown),
      onBlocks: str(fields.on_blocks),
      date: String(fields.date)
    };
    adoptSystemFlightData(manual, system);
    fields.registration = manual.registration;
    fields.from = manual.from;
    fields.to = manual.to;
    if (manual.actualFrom !== undefined) fields.actual_from = manual.actualFrom;
    if (manual.actualTo !== undefined) fields.actual_to = manual.actualTo;
    if (manual.offBlocks !== undefined) fields.off_blocks = manual.offBlocks;
    if (manual.airborne !== undefined) fields.airborne = manual.airborne;
    if (manual.touchdown !== undefined) fields.touchdown = manual.touchdown;
    if (manual.onBlocks !== undefined) fields.on_blocks = manual.onBlocks;
  }
  fields.update_flight_data = false;
  fields.is_deleted = false;

  return { id, isNew: true, fields, crew: merged.crew };
}

function toWireTakeoffsAndLandings(t: ImportedEntry["takeoffsAndLandings"]): Record<string, unknown> | undefined {
  if (!t) return undefined;
  return t.type === "auto"
    ? { type: "auto", takeoffs: t.takeoffs, landings: t.landings }
    : {
        type: "manual",
        takeoffs_day: t.takeoffsDay,
        takeoffs_night: t.takeoffsNight,
        landings_day: t.landingsDay,
        landings_night: t.landingsNight
      };
}

const MANUAL_TIMES_WIRE_KEYS: [keyof NonNullable<ImportedEntry["manualTimes"]>, string][] = [
  ["singlePilotSingleEngine", "single_pilot_single_engine"],
  ["singlePilotMultiEngine", "single_pilot_multi_engine"],
  ["multiPilot", "multi_pilot"],
  ["night", "night"],
  ["ifr", "ifr"],
  ["totalTimeOfFlight", "total_time_of_flight"],
  ["pilotInCommand", "pilot_in_command"],
  ["coPilot", "co_pilot"],
  ["dual", "dual"],
  ["spic", "spic"],
  ["picus", "picus"],
  ["instructor", "instructor"],
  ["examiner", "examiner"],
  ["crossCountry", "cross_country"],
  ["totalAirTime", "total_air_time"],
  ["cruiseReliefCoPilot", "cruise_relief_co_pilot"],
  ["fstdSession", "fstd_session"]
];

function toWireManualTimes(times: NonNullable<ImportedEntry["manualTimes"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, wireKey] of MANUAL_TIMES_WIRE_KEYS) {
    const value = times[key] as { totalMinutes: number } | undefined;
    if (value) out[wireKey] = formatDurationHMM(value.totalMinutes);
  }
  if (times.isMultiPilot !== undefined) out.is_multi_pilot = times.isMultiPilot;
  return out;
}

function formatDurationHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/**
 * Final crew list for the merged entry: a non-conservative, `replaceCrew`
 * row (every member resolved) REPLACES the stored crew entirely; otherwise
 * imported members are added on top of the existing crew, overriding the
 * role of anyone already present, mirrors `UniqueEntryPeople.add`'s
 * replace-by-personId semantics. No current CLI importer sets `replaceCrew`
 * (see file doc comment), so the union-add branch is the one that actually
 * runs today; the replace branch is kept for parity and future importers.
 */
function mergeCrew(
  imported: ImportedEntry,
  existing: RemoteEntry | undefined,
  resolvedCrew: Map<string, string>,
  conservative: boolean
): { personId: string; role: string }[] {
  const resolvedImportedCrew = imported.crew
    .map((c) => {
      const personId = resolvedCrew.get(c.refId);
      return personId ? { personId, role: entryPersonRoleRawValue(c.role as EntryPersonRole) } : undefined;
    })
    .filter((c): c is { personId: string; role: string } => c !== undefined);

  const everyoneResolved = imported.crew.every((c) => resolvedCrew.has(c.refId));

  if (imported.replaceCrew && !conservative && everyoneResolved) {
    return resolvedImportedCrew;
  }

  const byPersonId = new Map<string, string>();
  for (const member of existing?.people ?? []) {
    if (!member.is_deleted) byPersonId.set(member.person_id, member.role);
  }
  for (const member of resolvedImportedCrew) {
    byPersonId.set(member.personId, member.role);
  }
  return Array.from(byPersonId, ([personId, role]) => ({ personId, role }));
}
