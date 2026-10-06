/**
 * Turns a parsed `ImportResult` (offline, every row unmatched, see
 * `model.ts`) plus a `RemoteMirror` (the user's existing logbook, fetched
 * via the read API) into a `WritePlan`: the exact sync-API field maps for
 * `PUT /api/people`, `/api/aircraft`, `/api/fstd` and `/api/entries`, plus a
 * preview summary `jetlog import` shows before writing anything.
 *
 * This is the CLI's equivalent of the iOS app's import processing: match, then
 * resolve people/aircraft/fstd first (entries reference them), then merge
 * each entry. See `match.ts`/`merge.ts` for what's ported vs. a documented
 * scope cut.
 *
 * Simplifications compared to the iOS app (documented, not silent):
 * - Entries flagged `isDuplicateInFile` (an exact duplicate row within this
 *   one file, see `duplicate-detector.ts`) are skipped from the write plan
 *   entirely, rather than being committed and silently collapsing. The iOS
 *   review UI pre-deselects these by default; this CLI has no review step,
 *   so it mirrors that default outright instead of writing them anyway.
 * - When two surviving rows in the same file match the same existing
 *   remote entry, the second merges onto the first row's already-merged
 *   result (not onto a fresh demotion pass). This is simpler than the app's
 *   full conservative-gap-fill treatment, but still avoids the second row
 *   silently discarding the first row's edits.
 * - `materializeAsNewEntry` is reachable only via the blanket `asNew` option
 *   (`jetlog import --as-new`) rather than iOS's per-row Merge/New review
 *   choice: every row that would have matched an existing entry in this run
 *   is materialized as an independent new entry instead. There is no per-row
 *   selector, so `--as-new` is all-or-nothing for the run. A finer selector
 *   would need `jetlog import` to show matched rows and let the user pick
 *   some of them before writing, which doesn't fit this CLI's
 *   non-interactive batch model. The all-or-nothing version covers the
 *   concrete use case (re-importing a whole file as fresh copies, e.g.
 *   "treat this LogTen export as a brand new logbook rather than
 *   reconciling it against what's already in Jetlog").
 * - Unchanged-row comparison (`entryUnchanged` below) treats a
 *   `"HH:MM:SS"` wire time as equal to the `"HH:MM"` this CLI itself
 *   produces (`merge.ts`'s `formatTimeOfDay`) when comparing seconds-free.
 *   Neither side's precision is lost by the comparison; it just avoids
 *   a false "changed" on every time field purely from string-format
 *   drift between what this CLI writes and what the read API echoes back.
 */
import { randomUUID } from "node:crypto";
import type { DateOnly, ImportedEntry, ImportedPerson, ImportedAircraft, ImportResult } from "./model.js";
import { fstdDeviceCategoryFromFreeText } from "./model.js";
import {
  cleanRegistration,
  findExistingFstd,
  matchExistingAircraft,
  matchExistingEntry,
  matchExistingFSTDEntry,
  normalizeFlightNumber,
  PersonMatcher
} from "./match.js";
import { materializeAsNewEntry, mergeImported, todayDateOnly, type MergedEntry } from "./merge.js";
import type { RemoteEntry, RemoteMirror } from "./remote-mirror.js";
import type { AirlineCatalog } from "./airlines.js";

export interface PersonWrite {
  fields: Record<string, unknown>;
  isNew: boolean;
  displayName: string;
}

export interface AircraftWrite {
  fields: Record<string, unknown>;
  isNew: boolean;
}

export interface FstdWrite {
  fields: Record<string, unknown>;
  isNew: boolean;
}

export interface EntryWrite {
  fields: Record<string, unknown>;
  isNew: boolean;
  /** The merge result is byte-identical to the stored entry, skipped from
   * the actual write (mirrors the app's unchanged-row skip), but
   * still counted in the preview. */
  unchanged: boolean;
  date: string;
}

export interface WritePlan {
  people: PersonWrite[];
  aircraft: AircraftWrite[];
  fstd: FstdWrite[];
  entries: EntryWrite[];
  skippedDuplicateInFile: number;
  skippedAlreadyDeletedUnmatched: number;
  warnings: string[];
}

export interface BuildWritePlanOptions {
  /** Drives the future-flight auto-track rule in `merge.ts`; defaults to the real current date. */
  today?: DateOnly;
  /** `jetlog import --as-new`: every row that would otherwise MATCH an existing
   * entry is instead materialized as an independent new entry (`materializeAsNewEntry`),
   * see this file's doc comment for why this is all-or-nothing, not per-row. */
  asNew?: boolean;
  /** The ICAO<->IATA airline-prefix catalog (`airlines.ts`), when available
   * (logged in, fetch/cache succeeded), threaded into flight-number
   * normalization for both the pre-match choke point below and
   * `matchExistingEntry` itself. `undefined` offline, same as before this
   * catalog existed, see `match.ts`'s file doc comment. */
  airlineCatalog?: AirlineCatalog;
}

function personDisplayName(p: ImportedPerson): string {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.refId;
}

/** `"HH:MM:SS"` and `"HH:MM"` for the same time must compare equal, see
 * this file's doc comment on `entryUnchanged`. */
const TIME_LIKE_FIELDS = new Set([
  "off_blocks",
  "airborne",
  "touchdown",
  "on_blocks",
  "start_time",
  "end_time",
  "scheduled_off_blocks"
]);

/** `merge.ts` always computes these as an explicit `false` (never omits
 * them); the mirror can still have the column genuinely absent (e.g. a
 * minimal test fixture, or a resource the read API doesn't echo back for
 * an old/never-set row), missing is equivalent to `false` for all three,
 * same as the server's own column defaults, so neither should register
 * as "changed" purely from being unset on the stored side. */
const BOOLEAN_FALSE_DEFAULT_FIELDS = new Set(["is_bulk", "is_deleted", "is_imported_from_other_logbook"]);

function normalizeForCompare(key: string, value: unknown): unknown {
  if (TIME_LIKE_FIELDS.has(key) && typeof value === "string") {
    const m = /^(\d{1,2}):(\d{2})/.exec(value);
    if (m) return `${m[1]!.padStart(2, "0")}:${m[2]}`;
  }
  if (BOOLEAN_FALSE_DEFAULT_FIELDS.has(key) && value === undefined) return false;
  return value ?? undefined;
}

/** Canonical form for structured values (`takeoffs_and_landings`, `manual_times`,
 * `approaches`): object keys sorted and null/undefined members dropped. The read API
 * echoes `takeoffs_and_landings` with all seven keys (the ones the stored `type` does not
 * use come back as `null`) and returns map keys in its own order, while this CLI only
 * sends the keys that apply, so a raw `JSON.stringify` compare reported every flight with
 * landings as changed on an identical re-import. Arrays keep their order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === null || v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

function valuesEqual(key: string, a: unknown, b: unknown): boolean {
  const na = normalizeForCompare(key, a);
  const nb = normalizeForCompare(key, b);
  if (na === nb) return true;
  if (na === undefined || nb === undefined) return false;
  return JSON.stringify(canonicalize(na)) === JSON.stringify(canonicalize(nb));
}

function crewEqual(crew: { personId: string; role: string }[], base: RemoteEntry | undefined): boolean {
  const existing = new Set((base?.people ?? []).filter((p) => !p.is_deleted).map((p) => `${p.person_id}:${p.role}`));
  const next = new Set(crew.map((c) => `${c.personId}:${c.role}`));
  if (existing.size !== next.size) return false;
  for (const key of next) if (!existing.has(key)) return false;
  return true;
}

/**
 * True when `merged` writes nothing `base` doesn't already have, compares
 * every key `merge.ts` actually produced (a key it didn't set carries no
 * claim either way) plus the final crew list. `base` is the entry this row
 * actually merged onto (the original match, or an EARLIER row's own merge
 * result when two rows in this file chained onto the same remote id, see
 * this file's doc comment), never the raw pre-run mirror snapshot, so a
 * chained second row is judged against what the batch will ACTUALLY send
 * first, not what was true before this run started.
 */
function entryUnchanged(merged: MergedEntry, base: RemoteEntry | undefined): boolean {
  if (!base) return false;
  for (const [key, value] of Object.entries(merged.fields)) {
    if (key === "id" || key === "people") continue;
    if (!valuesEqual(key, value, (base as Record<string, unknown>)[key])) return false;
  }
  return crewEqual(merged.crew, base);
}

function resolvePeople(result: ImportResult, mirror: RemoteMirror): { writes: PersonWrite[]; refIdToPersonId: Map<string, string> } {
  const matcher = new PersonMatcher(mirror.people);
  const refIdToPersonId = new Map<string, string>();
  const writes: PersonWrite[] = [];

  for (const person of result.people) {
    if (person.refId === "SELF") {
      refIdToPersonId.set("SELF", mirror.selfPersonId);
      // Strict-mode writes (a write-scoped PAT) reject an `is_deleted:
      // false` is EXPLICIT: `EntryContext.ensure_people_exist_strict/3` only
      // checks that a `people` row with this id already exists; there is
      // NO automatic exemption for `person_id == user_id`
      // (`get_or_create_user_person/1` is External-Partner-API-only, never
      // called from the sync/PAT path). A brand-new account that has never
      // opened the Jetlog app (so its own Person row was never created)
      // would otherwise 422 `unknown_person_ids` on its very first `jetlog
      // import` the moment a row credits "SELF". Ensure it defensively,
      // same minimal shape `get_or_create_user_person/1` itself uses (id
      // only, no name), a harmless no-op PUT when the row already exists.
      if (!mirror.people.some((p) => p.id === mirror.selfPersonId)) {
        writes.push({ fields: { id: mirror.selfPersonId, is_deleted: false }, isNew: true, displayName: "(you)" });
      }
      continue;
    }

    const matched = matcher.match({
      employeeNumber: person.employeeNumber,
      firstName: person.firstName,
      lastName: person.lastName
    });

    const personId = matched?.id ?? person.preferredNewId ?? randomUUID();
    refIdToPersonId.set(person.refId, personId);

    const fields: Record<string, unknown> = {
      id: personId,
      first_name: person.firstName ?? (matched?.first_name as string | undefined) ?? "",
      last_name: person.lastName ?? (matched?.last_name as string | undefined) ?? "",
      is_deleted: false
    };
    if (person.defaultRole) fields.default_role = typeof person.defaultRole === "string" ? person.defaultRole : person.defaultRole.unknown;
    if (person.employeeNumber) fields.employee_number = person.employeeNumber;
    if (person.isImportedFromOtherLogbook !== undefined) fields.is_imported_from_other_logbook = person.isImportedFromOtherLogbook;

    writes.push({ fields, isNew: !matched, displayName: personDisplayName(person) });
  }

  return { writes, refIdToPersonId };
}

function resolveAircraft(result: ImportResult, mirror: RemoteMirror): AircraftWrite[] {
  const writes: AircraftWrite[] = [];
  for (const aircraft of result.aircraft) {
    const registration = cleanRegistration(aircraft.registration) ?? aircraft.registration;
    const existing = matchExistingAircraft(mirror, registration);

    const fields: Record<string, unknown> = { id: registration, is_deleted: false };
    if (aircraft.icaoCode) fields.aircraft_icao_code = aircraft.icaoCode;
    if (aircraft.iataCode) fields.aircraft_iata_code = aircraft.iataCode;
    if (aircraft.systemIcaoCode) fields.system_aircraft_icao_code = aircraft.systemIcaoCode;
    if (aircraft.systemIataCode) fields.system_aircraft_iata_code = aircraft.systemIataCode;
    if (aircraft.useSystem !== undefined) fields.use_system = aircraft.useSystem;
    if (aircraft.isImportedFromOtherLogbook !== undefined) fields.is_imported_from_other_logbook = aircraft.isImportedFromOtherLogbook;

    writes.push({ fields, isNew: !existing });
  }
  return writes;
}

/** Collects every FSTD id referenced by a merged FSTD-type entry, mirroring
 * the app's ensure-exists pass for referenced FSTD ids. */
function resolveFstd(result: ImportResult, mergedEntries: { imported: ImportedEntry; merged: MergedEntry }[], mirror: RemoteMirror): FstdWrite[] {
  const hints = new Map<string, string>();
  for (const row of result.entries) {
    const fstdId = row.fstdId?.trim();
    if (fstdId && row.fstdDeviceCategory) hints.set(fstdId, row.fstdDeviceCategory);
  }

  const referenced = new Set<string>();
  for (const { merged } of mergedEntries) {
    const fstdId = (merged.fields.fstd_id as string | undefined)?.trim();
    if (fstdId) referenced.add(fstdId);
  }

  const writes: FstdWrite[] = [];
  for (const fstdId of Array.from(referenced).sort()) {
    const existing = findExistingFstd(mirror, fstdId);
    const categoryHint = hints.get(fstdId) ?? fstdDeviceCategoryFromFreeText(fstdId);
    if (existing && existing.device_category) continue; // never override a user's own pick.

    const fields: Record<string, unknown> = { id: fstdId, is_deleted: false };
    if (categoryHint) fields.device_category = categoryHint;
    if (!existing) fields.is_imported_from_other_logbook = true;
    if (categoryHint || !existing) writes.push({ fields, isNew: !existing });
  }
  return writes;
}

export function buildWritePlan(result: ImportResult, mirror: RemoteMirror, options: BuildWritePlanOptions = {}): WritePlan {
  const today = options.today ?? todayDateOnly();
  const warnings = result.importErrors.filter((e) => e.code === undefined || e.code === "duplicateRowsInFile").map((e) => e.reason);

  const { writes: people, refIdToPersonId } = resolvePeople(result, mirror);
  const aircraft = resolveAircraft(result, mirror);

  // Normalize flight numbers once, same choke point as the app's import
  // ("Normalize once here" comment), rewrites an ICAO-style prefix to its
  // canonical IATA form when `options.airlineCatalog` is available (logged
  // in), same as every other use below. See match.ts's file doc comment.
  const normalizedEntries = result.entries.map((e) => ({
    ...e,
    flightNumber: e.flightNumber ? normalizeFlightNumber(e.flightNumber, options.airlineCatalog) ?? e.flightNumber : e.flightNumber
  }));

  // Deterministic order, same as the app (sorted by id).
  const ordered = [...normalizedEntries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const mergedByRemoteId = new Map<string, { imported: ImportedEntry; merged: MergedEntry; existing: RemoteEntry | undefined }>();
  const mergedEntries: { imported: ImportedEntry; merged: MergedEntry; unchanged: boolean }[] = [];
  let skippedDuplicateInFile = 0;
  let skippedAlreadyDeletedUnmatched = 0;

  for (const imported of ordered) {
    if (imported.isDuplicateInFile) {
      skippedDuplicateInFile += 1;
      continue;
    }

    let existing: RemoteEntry | undefined;
    let matchedViaFlightNumberNormalization = false;

    if (imported.type === "fstd") {
      existing = matchExistingFSTDEntry(mirror, { date: imported.date, fstdId: imported.fstdId, startTime: imported.startTime });
    } else {
      const match = matchExistingEntry(
        mirror,
        {
          date: imported.date,
          from: imported.from,
          flightNumber: imported.flightNumber,
          registration: imported.registration
        },
        options.airlineCatalog
      );
      existing = match?.entry;
      matchedViaFlightNumberNormalization = match?.matchedViaFlightNumberNormalization ?? false;
    }

    // A second row in this file matching the same remote entry merges onto
    // the first row's own merge result, not the original stored entry, see
    // file doc comment (simplified `mergedById` chaining).
    const chained = existing ? mergedByRemoteId.get(existing.id) : undefined;
    const base = chained ? toRemoteEntryShape(chained.merged) : existing;

    if (!existing && imported.isDeleted) {
      // Nothing local to delete, mirrors the app's unmatched-already-
      // deleted skip.
      skippedAlreadyDeletedUnmatched += 1;
      continue;
    }

    // `--as-new`: a row that WOULD merge onto an existing entry is instead
    // materialized as an independent copy (`materializeAsNewEntry`), see
    // this file's doc comment for why this is all-or-nothing, not per-row.
    const merged =
      existing && options.asNew
        ? materializeAsNewEntry(imported, base, matchedViaFlightNumberNormalization, refIdToPersonId, today)
        : mergeImported(imported, base, matchedViaFlightNumberNormalization, refIdToPersonId, today);

    // Unchanged-row skip (mirrors the app's own skip for a matched,
    // non-createNew row whose merge result is byte-identical to the stored
    // entry), never applies to a materialized-as-new or brand-new row.
    const unchanged = !!existing && !options.asNew && entryUnchanged(merged, base);

    if (existing && !options.asNew) mergedByRemoteId.set(existing.id, { imported, merged, existing });
    mergedEntries.push({ imported, merged, unchanged });
  }

  const fstd = resolveFstd(result, mergedEntries, mirror);

  const entries: EntryWrite[] = mergedEntries.map(({ merged, unchanged }) => ({
    fields: { id: merged.id, ...merged.fields },
    isNew: merged.isNew,
    unchanged,
    date: String(merged.fields.date)
  }));

  return { people, aircraft, fstd, entries, skippedDuplicateInFile, skippedAlreadyDeletedUnmatched, warnings };
}

/** Lets a chained second merge see the first merge's OUTPUT as if it were a
 * freshly fetched `RemoteEntry` (same field names, since `merge.ts` already
 * emits sync-API snake_case keys). */
function toRemoteEntryShape(merged: MergedEntry): RemoteEntry {
  return { id: merged.id, date: String(merged.fields.date), type: String(merged.fields.type), ...merged.fields } as RemoteEntry;
}
