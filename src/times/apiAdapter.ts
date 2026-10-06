/**
 * Adapter from the logged-in read API's `/api/cli/v1/entries` entry shape
 * into the calculator's `CalcEntry`, used by `jetlog totals` (no file) and
 * the `compute_totals` MCP tool's profile-based mode. Notes: `manual_times.*`
 * are "H:MM"/"H...H:MM" DURATION strings (not integer minutes), and "self"
 * is identified by matching `self_person_id` against `people[].person_id`
 * (not the `ref_id: "SELF"` convention used by the file-import side).
 */
import { mapApiRoleCode, roleSortKey, ACTIVE_CREW_ROLES } from "./roleCodes.js";
import type { CalcEntry, CalcPerson, CalcTimes, EntryPersonRoleName } from "./types.js";

/**
 * Parses a duration string into total minutes, mirroring
 * `Time.parseDurationMinutes` (iOS) and the backend's input builder: a
 * trailing/leading "Z" is trimmed, the string is split on ":" dropping empty
 * parts, at least two parts are required (only the first two count), hours
 * can be any length (no 1440 ceiling) and minutes must be 0..59. Anything
 * else is `undefined` (treated as absent). Distinct from `time.ts`'s
 * `parseTimeOfDay`, which is for time-OF-DAY fields.
 */
export function parseDurationMinutes(s: string): number | undefined {
  const parts = s.replace(/^Z+|Z+$/g, "").split(":").filter((part) => part.length > 0);
  if (parts.length < 2) return undefined;
  const [hoursStr, minutesStr] = parts as [string, string];
  if (!/^[+-]?\d+$/.test(hoursStr) || !/^[+-]?\d+$/.test(minutesStr)) return undefined;
  const hours = Number(hoursStr);
  const minutes = Number(minutesStr);
  if (hours < 0 || minutes < 0 || minutes >= 60) return undefined;
  const total = hours * 60 + minutes;
  return Number.isSafeInteger(total) ? total : undefined;
}

interface ApiManualTimes {
  total_time_of_flight?: string;
  pilot_in_command?: string;
  co_pilot?: string;
  dual?: string;
  spic?: string;
  picus?: string;
  instructor?: string;
  examiner?: string;
  cross_country?: string;
  total_air_time?: string;
  cruise_relief_co_pilot?: string;
  fstd_session?: string;
  single_pilot_single_engine?: string;
  single_pilot_multi_engine?: string;
  /** Legacy `H:MM` minutes, or (older payloads) a boolean. */
  multi_pilot?: string | boolean;
  night?: string;
  ifr?: string;
  is_multi_pilot?: boolean;
}

function toCalcTimes(manualTimes: ApiManualTimes | null | undefined): CalcTimes | undefined {
  if (!manualTimes) return undefined;
  const parse = (s: string | undefined | null): number | undefined => (typeof s === "string" ? parseDurationMinutes(s) : undefined);
  // `Times.init(from:)`: `is_multi_pilot` (a boolean) is preferred; when absent a
  // legacy boolean stored under `multi_pilot` is the state. A legacy H:MM
  // `multi_pilot` string stays as minutes (the calculator reads `> 0` from it).
  const legacyMultiPilot = manualTimes.multi_pilot;
  const isMultiPilot =
    typeof manualTimes.is_multi_pilot === "boolean"
      ? manualTimes.is_multi_pilot
      : typeof legacyMultiPilot === "boolean"
        ? legacyMultiPilot
        : undefined;
  return {
    singlePilotSingleEngine: parse(manualTimes.single_pilot_single_engine),
    singlePilotMultiEngine: parse(manualTimes.single_pilot_multi_engine),
    multiPilot: parse(typeof legacyMultiPilot === "string" ? legacyMultiPilot : undefined),
    night: parse(manualTimes.night),
    ifr: parse(manualTimes.ifr),
    totalTimeOfFlight: parse(manualTimes.total_time_of_flight),
    pilotInCommand: parse(manualTimes.pilot_in_command),
    coPilot: parse(manualTimes.co_pilot),
    dual: parse(manualTimes.dual),
    spic: parse(manualTimes.spic),
    picus: parse(manualTimes.picus),
    instructor: parse(manualTimes.instructor),
    examiner: parse(manualTimes.examiner),
    crossCountry: parse(manualTimes.cross_country),
    totalAirTime: parse(manualTimes.total_air_time),
    cruiseReliefCoPilot: parse(manualTimes.cruise_relief_co_pilot),
    fstdSession: parse(manualTimes.fstd_session),
    isMultiPilot
  };
}

interface ApiPerson {
  person_id: string | number;
  role: string;
  is_deleted?: boolean;
}

interface ApiDerived {
  date?: string;
  registration?: string;
  from?: string;
  to?: string;
  off_blocks?: string | null;
  airborne?: string | null;
  touchdown?: string | null;
  on_blocks?: string | null;
}

/**
 * Converts one `/api/cli/v1/entries` entry (a loose `Record<string, unknown>`;
 * the server is the source of truth, see `src/api/client.ts`'s response
 * shapes) into a `CalcEntry` + the context fields the calculator needs.
 * Returns `undefined` when no person on the entry matches `selfPersonId`,
 * except for FSTD entries: iOS (`calculateFSTDTimes`) and the backend log the
 * session time of an FSTD entry whose user has no live person row (the
 * `default:` role branch), so those come back with `selfRole: undefined` and are
 * counted as trainee sessions by the aggregator, like the other two platforms.
 * A non-FSTD entry without a self person stays skipped (counted by the caller).
 */
export function apiEntryToCalcEntry(
  entry: Record<string, unknown>,
  selfPersonId: string | number
): { calcEntry: CalcEntry; selfRole: EntryPersonRoleName | undefined; activeCrewCount: number } | undefined {
  const derived = (entry.derived ?? {}) as ApiDerived;
  const people = (entry.people as ApiPerson[] | undefined) ?? [];

  // `Entry.derivedPeople` is sorted by (role rank, person id) and the calculator
  // takes the first live row for the user, so a user with several rows resolves
  // to the lowest-ranked role.
  const selfPersonIdStr = String(selfPersonId);
  const selfPerson = people
    .filter((p) => String(p.person_id) === selfPersonIdStr && !p.is_deleted && p.role !== null && p.role !== undefined)
    .map((p) => ({ person: p, key: roleSortKey(mapApiRoleCode(p.role), p.role) }))
    .sort((a, b) => a.key[0] - b.key[0] || (a.key[1] < b.key[1] ? -1 : a.key[1] > b.key[1] ? 1 : 0))[0]?.person;
  if (!selfPerson && entry.type !== "fstd") return undefined;

  const calcPeople: CalcPerson[] = people.map((p) => ({
    personId: String(p.person_id),
    role: mapApiRoleCode(p.role),
    isDeleted: p.is_deleted
  }));
  const selfRole = selfPerson ? mapApiRoleCode(selfPerson.role) : undefined;
  const activeCrewCount = calcPeople.filter((p) => !p.isDeleted && ACTIVE_CREW_ROLES.has(p.role)).length;

  const calcEntry: CalcEntry = {
    date: String(derived.date ?? entry.date),
    type: String(entry.type ?? "flight"),
    from: derived.from ?? undefined,
    to: derived.to ?? undefined,
    offBlocks: derived.off_blocks ?? undefined,
    onBlocks: derived.on_blocks ?? undefined,
    airborne: derived.airborne ?? undefined,
    touchdown: derived.touchdown ?? undefined,
    registration: derived.registration ?? undefined,
    // These are already the server-derived values, hand them to CalcEntry
    // as the non-system fields with updateFlightData: false, so the
    // calculator's own derivation resolves to exactly what was passed in
    // without re-deriving from raw system/actual columns (the server
    // already did that work).
    updateFlightData: false,
    // Tracked entries (`update_flight_data`) log the whole block as IFR whatever the flag says (calculator:
    // `updateFlightData || ifr`); `updateFlightData` is pinned to false below, so fold it in here.
    ifr: ((entry.ifr as boolean | null | undefined) ?? true) || entry.update_flight_data === true,
    isImportedFromOtherLogbook: (entry.is_imported_from_other_logbook as boolean | undefined) ?? false,
    isBulk: (entry.is_bulk as boolean | undefined) ?? false,
    aircraftIcaoCode: (entry.aircraft_icao_code as string | undefined) ?? undefined,
    startTime: (entry.start_time as string | null | undefined) ?? undefined,
    endTime: (entry.end_time as string | null | undefined) ?? undefined,
    people: calcPeople,
    manualTimes: toCalcTimes(entry.manual_times as ApiManualTimes | null | undefined)
  };

  return { calcEntry, selfRole, activeCrewCount };
}
