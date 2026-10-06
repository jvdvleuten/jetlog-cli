/**
 * Shared convert -> calculate -> aggregate glue used by both `jetlog
 * times`/`jetlog totals` (`src/cli.ts`) and the `compute_totals` MCP tool
 * (`src/mcp.ts`), so the two don't duplicate the same wiring.
 */
import { formatNotices } from "../import/warnings.js";
import { convertFile, type ConvertFormat } from "../convert/index.js";
import { validatePayload } from "../schema.js";
import { normalize } from "../airports/resolver.js";
import { getActiveAirportIndex, getEmptyAirportIndex, isEmptyAirportIndex, loadLoggedInAirportIndex, resolve, type AirportIndex } from "../airports/index.js";
import { payloadEntryToCalcEntry } from "./adapter.js";
import { importedEntryToCalcEntry } from "./importedEntryAdapter.js";
import { apiEntryToCalcEntry } from "./apiAdapter.js";
import { buildApiAircraftLookup } from "./apiAircraft.js";
import { calculateEntryTimes, derivedDate, derivedRoute } from "./calculator.js";
import { inPeriod, type Period } from "./period.js";
import { aggregateTotals, applyAtplCaps, type AtplCaps, type EntryTimesForTotals, type Totals } from "./aggregator.js";
import type { Airport, AircraftTypeInfo, CalcContext } from "./types.js";
import type { ApiClient, MeResponse, EntriesPage } from "../api/client.js";

/** The calculator/aggregator airport lookup: the ONE resolver (`src/airports`), against `index` or the
 * active one (logged-in catalog + places when a command installed it, else the empty index). The
 * calculator hands over the RAW derived code; normalization, IATA/local-code aliasing and user places
 * all happen inside `resolve`. A resolved airport without both coordinates has `hasPosition: false`. */
function makeLookupAirport(index?: AirportIndex): (code: string) => Airport | undefined {
  return (code) => {
    const airport = resolve(index ?? getActiveAirportIndex(), code);
    if (!airport) return undefined;
    return airport.hasPosition ? { hasPosition: true, lat: airport.lat!, lon: airport.lon! } : { hasPosition: false, lat: null, lon: null };
  };
}

/** No local aircraft-type catalog exists offline, always `undefined`. See
 * docs/TIMES.md "Known limitations": SE/ME/MP classification will always
 * come out empty for `jetlog times`/`jetlog totals <file>` on real files. */
function noAircraftTypeLookup(_key: string): AircraftTypeInfo | undefined {
  return undefined;
}

/** The DERIVED from/to codes (`Entry.derivedFrom`/`derivedTo`), raw, for the cross-country heuristic.
 * iOS feeds the aggregator the derived route, not the planned one. */
function routeCodes(calcEntry: Parameters<typeof derivedRoute>[0]): { fromIcao?: string; toIcao?: string } {
  const { from, to } = derivedRoute(calcEntry);
  return { fromIcao: from, toIcao: to };
}

export interface FileEntryTimesResult {
  calculated: EntryTimesForTotals[];
  skippedNoSelfPersonCount: number;
  parseWarnings: string[];
  /** Plain notes for stderr (not parse problems), e.g. that night time could not be computed. */
  notes: string[];
}

/** The one line printed when entries have from/to codes but there is no airport data to place them. */
export const NO_AIRPORT_DATA_NOTE =
  "note: no airport data without a login, so night time and distance-based figures are not computed. Run `jetlog login` to use your Jetlog airport catalog.";

/** Totals-level summary of entries with an airport that could not be placed. */
export interface UnresolvedAirportsSummary {
  entryCount: number;
  codes: string[];
}

/** `entry` plus `unresolvedAirports` (only when non-empty): the from/to codes the calculation's own
 * lookup could not place (not found, or no position). Simulator entries and entries without codes never count. */
function withUnresolved(entry: EntryTimesForTotals, lookupAirport: (code: string) => Airport | undefined): EntryTimesForTotals {
  if (entry.type === "fstd") return entry;
  const codes: string[] = [];
  for (const raw of [entry.fromIcao, entry.toIcao]) {
    const code = normalize(raw);
    if (code === null || codes.includes(code)) continue;
    const airport = lookupAirport(raw as string);
    if (!airport || !airport.hasPosition) codes.push(code);
  }
  return codes.length > 0 ? { ...entry, unresolvedAirports: codes } : entry;
}

/** The entries `aggregateTotals` counts for `period`: same inclusion rule and period predicate. */
function entriesInScope(calculated: readonly EntryTimesForTotals[], period?: Period): EntryTimesForTotals[] {
  return calculated.filter(
    (e) => (e.type === "fstd" || e.detailedTimes.totalTimeOfFlight !== undefined) && (period === undefined || inPeriod(e.date, period))
  );
}

function summarizeUnresolved(scope: readonly EntryTimesForTotals[]): UnresolvedAirportsSummary {
  const withCodes = scope.filter((e) => e.unresolvedAirports && e.unresolvedAirports.length > 0);
  const codes = [...new Set(withCodes.flatMap((e) => e.unresolvedAirports!))].sort();
  return { entryCount: withCodes.length, codes };
}

/** At most one stderr note: no airport data at all, or entries with an airport missing from the catalog. */
function airportDataNotes(calculated: readonly EntryTimesForTotals[], index?: AirportIndex, period?: Period): string[] {
  if (isEmptyAirportIndex(index ?? getActiveAirportIndex())) {
    return calculated.some((e) => e.fromIcao || e.toIcao) ? [NO_AIRPORT_DATA_NOTE] : [];
  }
  const scope = entriesInScope(calculated, period);
  const { entryCount, codes } = summarizeUnresolved(scope);
  if (entryCount === 0) return [];
  const shown = codes.slice(0, 8).join(", ");
  const list = codes.length > 8 ? `${shown} and ${codes.length - 8} more` : shown;
  return [
    `note: ${entryCount} of ${scope.length} ${entryCount === 1 ? "entries uses an airport that is" : "entries use an airport that is"} not in your Jetlog airport catalog (${list}), so night time and distance-based figures are not computed for them.`
  ];
}

/**
 * Converts `content` (via `convertFile`) and runs the calculator over every
 * entry. Prefers the richer `ImportResult` (via `importedEntryToCalcEntry`)
 * when `convertFile` resolved to one of the ported importers; falls back to
 * the lossy public-payload adapter for `csv`/`foreflight`/`jetlog`, which
 * have no `ImportResult`. Entries with no resolvable "self" person are
 * skipped (counted, not thrown).
 */
export interface FileSelfOptions {
  /** Role to credit yourself on every entry, for formats whose rows do not say (csv, foreflight). */
  selfRole?: string;
  /** Which crew name in the file is you (LogTen). */
  selfName?: string;
}

export async function computeFileEntryTimes(
  format: ConvertFormat,
  content: string,
  filename?: string,
  self: FileSelfOptions = {}
): Promise<FileEntryTimesResult> {
  const lookupAirport = makeLookupAirport();
  const result = await convertFile(format, content, { filename, selfRole: self.selfRole, selfName: self.selfName });
  // Importer-backed formats: row-aware grouped lines; plain CSV presets: their skipped rows.
  const parseWarnings = result.notices
    ? formatNotices(result.notices).map((l) => l.text)
    : result.skipped.map((row) => `skipped row ${row.row}: ${row.reason}`);

  const calculated: EntryTimesForTotals[] = [];
  let skippedNoSelfPersonCount = 0;

  if (result.importResult) {
    for (const entry of result.importResult.entries) {
      const adapted = importedEntryToCalcEntry(entry);
      if (!adapted) {
        skippedNoSelfPersonCount++;
        continue;
      }
      const ctx: CalcContext = {
        selfRole: adapted.selfRole,
        activeCrewCount: adapted.activeCrewCount,
        lookupAirport,
        lookupAircraftType: noAircraftTypeLookup
      };
      const calculatedTimes = calculateEntryTimes(adapted.calcEntry, ctx);
      calculated.push(withUnresolved({
        ...calculatedTimes,
        type: adapted.calcEntry.type,
        isBulk: entry.isBulk,
        selfRole: adapted.selfRole,
        fstdDeviceCategory: entry.fstdDeviceCategory,
        date: derivedDate(adapted.calcEntry),
        ...routeCodes(adapted.calcEntry)
      }, lookupAirport));
    }
  } else {
    const validated = validatePayload(result.payload);
    if (!validated.valid || !validated.payload) {
      throw new Error(
        `converted payload failed validation: ${validated.structuralErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`
      );
    }

    for (const entry of validated.payload.entries ?? []) {
      const adapted = payloadEntryToCalcEntry(entry);
      if (!adapted) {
        skippedNoSelfPersonCount++;
        continue;
      }
      const ctx: CalcContext = {
        selfRole: adapted.selfRole,
        activeCrewCount: adapted.activeCrewCount,
        lookupAirport,
        lookupAircraftType: noAircraftTypeLookup
      };
      const calculatedTimes = calculateEntryTimes(adapted.calcEntry, ctx);
      calculated.push(withUnresolved({
        ...calculatedTimes,
        type: adapted.calcEntry.type,
        isBulk: adapted.calcEntry.isBulk,
        selfRole: adapted.selfRole,
        date: derivedDate(adapted.calcEntry),
        ...routeCodes(adapted.calcEntry)
      }, lookupAirport));
    }
  }

  return { calculated, skippedNoSelfPersonCount, parseWarnings, notes: airportDataNotes(calculated) };
}

export async function computeFileTotals(
  format: ConvertFormat,
  content: string,
  filename?: string,
  opts: { period?: Period } & FileSelfOptions = {}
): Promise<Totals & { atplCaps: AtplCaps; unresolvedAirports: UnresolvedAirportsSummary; entryTimesResult: FileEntryTimesResult }> {
  const entryTimesResult = await computeFileEntryTimes(format, content, filename, { selfRole: opts.selfRole, selfName: opts.selfName });
  const totals = aggregateTotals(entryTimesResult.calculated, { lookupAirport: makeLookupAirport(), period: opts.period });
  const atplCaps = applyAtplCaps(totals);
  const unresolvedAirports = summarizeUnresolved(entriesInScope(entryTimesResult.calculated, opts.period));
  const notes = airportDataNotes(entryTimesResult.calculated, undefined, opts.period);
  return { ...totals, atplCaps, unresolvedAirports, entryTimesResult: { ...entryTimesResult, notes } };
}

// ---------------------------------------------------------------------------
// Logged-in profile totals (no file), `jetlog totals` / `compute_totals`
// without `path`/`format`.
// ---------------------------------------------------------------------------

/** Pages through `/api/cli/v1/entries` for every non-deleted entry. Mirrors
 * `fetchAllEntries`'s cursor-paging contract (`src/commands/entries.ts`)
 * without importing from `src/commands/**`. */
async function fetchAllOwnEntries(client: ApiClient): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let afterDate: string | undefined;
  let afterId: string | undefined;

  for (;;) {
    const page = await client.get<EntriesPage>("/api/cli/v1/entries", {
      after_date: afterDate,
      after_id: afterId,
      limit: 200,
      include_deleted: false
    });
    all.push(...page.entries);
    if (!page.pagination.has_more || !page.pagination.next_cursor) break;
    afterDate = String(page.pagination.next_cursor.date);
    afterId = String(page.pagination.next_cursor.id);
  }

  return all;
}

export interface ProfileTotalsResult extends Totals {
  atplCaps: AtplCaps;
  unresolvedAirports: UnresolvedAirportsSummary;
  skippedNoSelfPersonCount: number;
  notes: string[];
}

/** Computes aggregate totals from the LOGGED-IN user's own Jetlog data via
 * the read API, instead of a converted file. */
export async function computeProfileTotals(
  client: ApiClient,
  opts: { profile?: string; offline?: boolean; period?: Period } = {}
): Promise<ProfileTotalsResult> {
  // Logged in: the server catalog plus the user's own places, so IATA and user-place codes resolve
  // like in the app. `offline` (or a failed fetch) leaves no airports.
  let index: AirportIndex | undefined = opts.offline ? getEmptyAirportIndex() : undefined;
  if (!opts.offline) {
    try {
      index = await loadLoggedInAirportIndex(client, opts.profile ?? "default", client.baseUrl);
    } catch (err) {
      console.error(`warning: could not load the airport catalog from Jetlog (${(err as Error).message}); continuing without airport data`);
    }
  }
  const lookupAirport = makeLookupAirport(index);
  const me = await client.get<MeResponse>("/api/cli/v1/me");
  const entries = (await fetchAllOwnEntries(client)).filter((e) => !(e.is_deleted as boolean | undefined));
  const aircraftLookups = await buildApiAircraftLookup(client);

  const calculated: EntryTimesForTotals[] = [];
  let skippedNoSelfPersonCount = 0;

  for (const entry of entries) {
    const adapted = apiEntryToCalcEntry(entry, me.self_person_id);
    if (!adapted) {
      skippedNoSelfPersonCount++;
      continue;
    }
    const ctx: CalcContext = {
      selfRole: adapted.selfRole,
      activeCrewCount: adapted.activeCrewCount,
      lookupAirport,
      ...aircraftLookups
    };
    const calculatedTimes = calculateEntryTimes(adapted.calcEntry, ctx);
    calculated.push(withUnresolved({
      ...calculatedTimes,
      type: adapted.calcEntry.type,
      isBulk: adapted.calcEntry.isBulk,
      selfRole: adapted.selfRole,
      date: derivedDate(adapted.calcEntry),
      ...routeCodes(adapted.calcEntry)
    }, lookupAirport));
  }

  const totals = aggregateTotals(calculated, { lookupAirport, period: opts.period });
  const atplCaps = applyAtplCaps(totals);
  const unresolvedAirports = summarizeUnresolved(entriesInScope(calculated, opts.period));
  return { ...totals, atplCaps, unresolvedAirports, skippedNoSelfPersonCount, notes: airportDataNotes(calculated, index, opts.period) };
}
