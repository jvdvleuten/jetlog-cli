/**
 * Adapter from the importers' rich `ImportedEntry` model
 * (`src/import/model.ts`) into the calculator's `CalcEntry`, the DEFAULT
 * path for `jetlog times`/`jetlog totals <file>` whenever `convertFile`/
 * `convertFiles` resolved to one of the ported importers (see
 * `ConvertFileResult.importResult` in `src/convert/index.ts`). Replaces the
 * lossy public-payload adapter (`src/times/adapter.ts`) for those formats,
 * that adapter is still used as a fallback for the plain `csv`/`foreflight`/
 * `jetlog` formats, which have no `ImportResult`.
 */
import { entryPersonRoleRawValue, entryTypeRawValue, formatTimeOfDay } from "../import/model.js";
import type { ImportedEntry, Time, Times } from "../import/model.js";
import { mapImportedRoleCode, ACTIVE_CREW_ROLES } from "./roleCodes.js";
import type { CalcEntry, CalcPerson, CalcTimes, EntryPersonRoleName } from "./types.js";

function maybeFormatTimeOfDay(t: Time | undefined): string | undefined {
  return t === undefined ? undefined : formatTimeOfDay(t);
}

/** `ImportedEntry.manualTimes` (`Times`) is field-for-field identical to
 * `CalcTimes`, just with values wrapped as `{ totalMinutes }`, unwrap. */
function toCalcTimes(t: Times | undefined): CalcTimes | undefined {
  if (t === undefined) return undefined;
  return {
    singlePilotSingleEngine: t.singlePilotSingleEngine?.totalMinutes,
    singlePilotMultiEngine: t.singlePilotMultiEngine?.totalMinutes,
    multiPilot: t.multiPilot?.totalMinutes,
    night: t.night?.totalMinutes,
    ifr: t.ifr?.totalMinutes,
    totalTimeOfFlight: t.totalTimeOfFlight?.totalMinutes,
    pilotInCommand: t.pilotInCommand?.totalMinutes,
    coPilot: t.coPilot?.totalMinutes,
    dual: t.dual?.totalMinutes,
    spic: t.spic?.totalMinutes,
    picus: t.picus?.totalMinutes,
    instructor: t.instructor?.totalMinutes,
    examiner: t.examiner?.totalMinutes,
    crossCountry: t.crossCountry?.totalMinutes,
    totalAirTime: t.totalAirTime?.totalMinutes,
    cruiseReliefCoPilot: t.cruiseReliefCoPilot?.totalMinutes,
    fstdSession: t.fstdSession?.totalMinutes,
    isMultiPilot: t.isMultiPilot
  };
}

/**
 * Converts one `ImportedEntry` into a `CalcEntry` + the context fields the
 * calculator needs. Returns `undefined` when there's no `refId === "SELF"`
 * crew member, same "can't compute times without knowing which person is
 * you" contract as `payloadEntryToCalcEntry`.
 */
export function importedEntryToCalcEntry(
  entry: ImportedEntry
): { calcEntry: CalcEntry; selfRole: EntryPersonRoleName; activeCrewCount: number } | undefined {
  const selfCrew = entry.crew.find((c) => c.refId === "SELF");
  if (!selfCrew) return undefined;

  const calcPeople: CalcPerson[] = entry.crew.map((c) => ({
    personId: c.refId,
    role: mapImportedRoleCode(entryPersonRoleRawValue(c.role))
  }));
  const selfRole = mapImportedRoleCode(entryPersonRoleRawValue(selfCrew.role));
  const activeCrewCount = calcPeople.filter((p) => ACTIVE_CREW_ROLES.has(p.role)).length;

  const calcEntry: CalcEntry = {
    date: entry.date,
    type: entryTypeRawValue(entry.type),
    from: entry.from,
    to: entry.to,
    offBlocks: maybeFormatTimeOfDay(entry.offBlocks),
    onBlocks: maybeFormatTimeOfDay(entry.onBlocks),
    airborne: maybeFormatTimeOfDay(entry.airborne),
    touchdown: maybeFormatTimeOfDay(entry.touchdown),
    registration: entry.registration,
    // No live-tracking concept offline, ImportedEntry has no
    // systemFrom/systemTo/registrationSystem/off_blocks_system/etc at all.
    actualFrom: entry.actualFrom,
    actualTo: entry.actualTo,
    updateFlightData: entry.updateFlightData ?? false,
    ifr: entry.ifr ?? true,
    isImportedFromOtherLogbook: entry.isImportedFromOtherLogbook ?? false,
    isBulk: entry.isBulk,
    aircraftIcaoCode: entry.aircraftIcaoCode,
    startTime: maybeFormatTimeOfDay(entry.startTime),
    endTime: maybeFormatTimeOfDay(entry.endTime),
    people: calcPeople,
    manualTimes: toCalcTimes(entry.manualTimes)
  };

  return { calcEntry, selfRole, activeCrewCount };
}
