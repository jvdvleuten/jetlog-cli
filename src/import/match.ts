/**
 * Matches a parsed `ImportedEntry`/`ImportedPerson`/`ImportedAircraft` row
 * against the user's existing remote logbook data (`RemoteMirror`, fetched
 * via the read API, see `remote-mirror.ts`).
 *
 * Every CLI importer (`src/import/importers/*`) produces unmatched rows
 * (`isExisting: { existing: false }`), see `model.ts`'s file doc comment:
 * offline, there is nothing to match against. The iOS app resolves
 * `isExisting` while parsing each row; this CLI instead matches in a separate
 * pass over an already-parsed `ImportResult`, right before `merge.ts` runs.
 * The match functions and their priority order are the same as the app's.
 *
 * People are matched with the full person-matcher rules (see
 * `person-matcher.ts`), including its fuzzy-name step, now that the remote
 * mirror gives this CLI real existing people to match against (see
 * `docs/IMPORTERS.md`).
 *
 * `normalizeFlightNumber` below takes an optional airline catalog: when given
 * (the user is logged in and the fetch/cache succeeded, see `airlines.ts`),
 * the ICAO (3-letter) to IATA (2-letter) airline-prefix rewrite (e.g.
 * "KLM1017" -> "KL1017") runs before the usual strip-whitespace-and-upcase;
 * when absent (offline, or no login), only the latter happens.
 */
import { normalizeEmployee, normalizeName, levenshtein } from "./person-matcher.js";
import { normalizeWithAirlineCatalog, type AirlineCatalog } from "./airlines.js";
import type { RemoteAircraft, RemoteEntry, RemoteFstd, RemoteMirror, RemotePerson } from "./remote-mirror.js";
import type { DateOnly, Time } from "./model.js";

export function normalizeFlightNumber(raw: string | undefined, catalog?: AirlineCatalog): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const base = catalog ? normalizeWithAirlineCatalog(trimmed, catalog) : trimmed;
  return base.toUpperCase().replace(/\s+/g, "");
}

export function cleanRegistration(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface EntryMatch {
  entry: RemoteEntry;
  /** True when the match was found only by normalizing the raw flight
   * number, see `ImportedEntry.matchedViaFlightNumberNormalization`; the
   * merge step treats such a match conservatively (gap-filling only). */
  matchedViaFlightNumberNormalization: boolean;
}

/**
 * Looks up
 * same-date candidates by flight number first (falling back to
 * registration), then disambiguates by departure/arrival airport, finally
 * falling back to "exactly one candidate" or "no route set on either side".
 */
export function matchExistingEntry(
  mirror: RemoteMirror,
  params: { date: DateOnly; from?: string; flightNumber?: string; registration?: string },
  catalog?: AirlineCatalog
): EntryMatch | undefined {
  const trimmedFlightNumber = params.flightNumber?.trim();
  const flightNumber = trimmedFlightNumber ? normalizeFlightNumber(trimmedFlightNumber, catalog) : undefined;
  const matchedViaFlightNumberNormalization = !!trimmedFlightNumber && trimmedFlightNumber !== flightNumber;
  const registration = cleanRegistration(params.registration);

  if (!flightNumber && !registration) return undefined;

  let candidates: RemoteEntry[];
  if (flightNumber) {
    candidates = mirror.entries.filter(
      (e) =>
        e.date === params.date &&
        normalizeFlightNumber((e.flight_number as string | undefined) ?? undefined, catalog) === flightNumber
    );
  } else {
    candidates = mirror.entries.filter((e) => e.date === params.date && cleanRegistration((e.registration as string | undefined) ?? undefined) === registration);
  }

  if (candidates.length === 0) return undefined;

  const from = params.from;
  const matched =
    candidates.find((e) => e.from === from) ??
    candidates.find((e) => e.to === from) ??
    candidates.find((e) => !e.from && !e.to) ??
    (candidates.length === 1 ? candidates[0] : undefined);

  if (!matched) return undefined;
  return { entry: matched, matchedViaFlightNumberNormalization };
}

/**
 * Matches an FSTD session: date+fstdId first (preferring a start-time match
 * among same-day/same-id candidates), then a deliberately eager same-day
 * fallback (pilots rarely log two FSTD sessions a day).
 */
export function matchExistingFSTDEntry(
  mirror: RemoteMirror,
  params: { date: DateOnly; fstdId?: string; startTime?: Time }
): RemoteEntry | undefined {
  const cleanedFstdId = params.fstdId?.trim();
  const sameDayFstd = mirror.entries.filter((e) => e.date === params.date && e.type === "fstd");

  if (cleanedFstdId) {
    const byId = sameDayFstd.filter((e) => (e.fstd_id as string | undefined) === cleanedFstdId);
    if (params.startTime) {
      const startMatch = byId.find((e) => startTimeMatches(e.start_time, params.startTime));
      if (startMatch) return startMatch;
    }
    if (byId.length > 0) return byId[0];
  }

  if (params.startTime) {
    const startMatch = sameDayFstd.find((e) => startTimeMatches(e.start_time, params.startTime));
    if (startMatch) return startMatch;
  }

  const candidates = sameDayFstd.filter((e) => !params.startTime || !e.start_time);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, current) => {
    const bestMinutes = startTimeMinutes(best.start_time);
    const currentMinutes = startTimeMinutes(current.start_time);
    if (currentMinutes !== bestMinutes) return currentMinutes < bestMinutes ? current : best;
    return current.id < best.id ? current : best;
  });
}

function startTimeMinutes(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return -1;
  const [h, m] = raw.split(":").map((n) => Number.parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

function startTimeMatches(raw: unknown, time: Time | undefined): boolean {
  if (!time) return false;
  return startTimeMinutes(raw) === time.totalMinutes;
}

/** Finds the remote aircraft whose id is the registration. */
export function matchExistingAircraft(mirror: RemoteMirror, registration: string | undefined): RemoteAircraft | undefined {
  if (!registration) return undefined;
  return mirror.aircraft.find((a) => a.id === registration);
}

/** Referenced-id lookup (not a "match", just a presence check): an FSTD catalog row is keyed by its own
 * id string, there's nothing to disambiguate). */
export function findExistingFstd(mirror: RemoteMirror, fstdId: string | undefined): RemoteFstd | undefined {
  if (!fstdId) return undefined;
  return mirror.fstd.find((f) => f.id === fstdId);
}

/**
 * Full person-matcher rules against the remote mirror's real
 * people: Jetlog id (when the row's own id happens to be a real UUID, true
 * for Excel/deeplink-json re-imports of a previous Jetlog export) -> employee
 * number -> exact normalized name -> a single, confident fuzzy name match.
 * Built once per `jetlog import` run (`buildPersonMatcher`) from the full people list.
 */
export class PersonMatcher {
  private readonly byId = new Map<string, RemotePerson>();
  private readonly byEmployee = new Map<string, RemotePerson>();
  private readonly byNormalizedName = new Map<string, RemotePerson[]>();

  constructor(people: RemotePerson[]) {
    const employeeCandidates = new Map<string, RemotePerson>();
    const collidedEmployees = new Set<string>();

    for (const person of people) {
      this.byId.set(person.id, person);

      const employee = (person.employee_number ?? undefined)?.toString().trim();
      if (employee) {
        const key = normalizeEmployee(employee);
        if (key.length > 0) {
          if (employeeCandidates.has(key)) collidedEmployees.add(key);
          else employeeCandidates.set(key, person);
        }
      }

      const fullName = [person.first_name, person.last_name].filter(Boolean).join(" ");
      const normalized = normalizeName(fullName);
      if (normalized.length > 0) {
        const existing = this.byNormalizedName.get(normalized);
        if (existing) existing.push(person);
        else this.byNormalizedName.set(normalized, [person]);
      }
    }

    for (const key of collidedEmployees) employeeCandidates.delete(key);
    this.byEmployee = employeeCandidates;
  }

  match(params: { id?: string; employeeNumber?: string; firstName?: string; lastName?: string }): RemotePerson | undefined {
    if (params.id) {
      const byId = this.byId.get(params.id);
      if (byId) return byId;
    }

    if (params.employeeNumber) {
      const trimmed = params.employeeNumber.trim();
      if (trimmed.length > 0) {
        const byEmployee = this.byEmployee.get(normalizeEmployee(trimmed));
        if (byEmployee) return byEmployee;
      }
    }

    const fullName = [params.firstName, params.lastName].filter(Boolean).join(" ");
    return this.matchByName(fullName);
  }

  matchByName(fullName: string): RemotePerson | undefined {
    const name = normalizeName(fullName);
    if (name.length === 0) return undefined;

    const exact = this.byNormalizedName.get(name);
    if (exact) return exact.length === 1 ? exact[0] : undefined;

    return this.fuzzyMatch(name);
  }

  private fuzzyMatch(normalizedName: string): RemotePerson | undefined {
    if (normalizedName.length < 5) return undefined;
    const budget = Math.max(1, Math.floor(normalizedName.length / 6));
    let best: { person: RemotePerson; distance: number } | undefined;
    let tied = false;

    for (const [candidateName, people] of this.byNormalizedName) {
      const distance = levenshtein(normalizedName, candidateName);
      if (distance > budget) continue;
      const person = people[0];
      if (!person) continue;
      if (!best || distance < best.distance) {
        best = { person, distance };
        tied = false;
      } else if (distance === best.distance) {
        tied = true;
      }
    }

    if (!best || tied) return undefined;
    return best.person;
  }
}
