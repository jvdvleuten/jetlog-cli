/**
 * Ported from the Jetlog iOS app's deeplink JSON importer (the External Partner API / import
 * deeplink JSON shape, the same shape this CLI's own `schema.ts` models).
 *
 * Only the unmatched ("brand-new row") branch is ported, see `model.ts`'s
 * file doc comment: there is no local store offline, so every row here
 * behaves like an existing-entry lookup miss in the iOS app.
 * Concretely this means:
 *  - `ImportedEntry.clearedFields`/`actualTimeFieldsCarriedByPayload` are
 *    still parsed (an explicit JSON `null` on a clearable field is still
 *    detected) and threaded onto the row for parity/documentation, but they
 *    have no effect without a merge step to consult them.
 *  - IATA->ICAO airport code conversion
 *    is backed by the airport resolver (logged-in catalog only, none offline) in `../../../airports/index.js`
 *    (`canonicalCode`): `from`/`to`/`actual_from`/`actual_to` resolve to
 *    ICAO when the code is a known IATA alias, and are passed through
 *    uppercased/unconverted otherwise (unknown code, or already ICAO).
 *  - Person/aircraft "match existing" lookups are skipped; every person and
 *    aircraft is produced as new (`isExisting: { existing: false }`), except
 *    `ref_id: "SELF"`, which this CLI has no user record for either, it's
 *    still emitted as a placeholder `ImportedPerson` so crew links resolve,
 *    same shape a new person would get.
 */
import { canonicalCode } from "../../airports/index.js";
import type { Importer, ImporterOptions } from "../importer.js";
import {
  emptyImportResult,
  newImportedEntry,
  truncatedRemarks,
  type ApproachCount,
  type EntryPersonRole,
  type ImportError,
  type ImportResult,
  type ImportedAircraft,
  type ImportedEntryCrewMember,
  type ImportedPerson,
  type TakeoffsAndLandings,
  type Time
} from "../model.js";

function isPlausibleISODate(s: string): boolean {
  const parts = s.split("-");
  if (parts.length !== 3) return false;
  const [y, m, d] = parts as [string, string, string];
  if (y.length !== 4 || m.length > 2 || d.length > 2) return false;
  const year = Number.parseInt(y, 10);
  const month = Number.parseInt(m, 10);
  const day = Number.parseInt(d, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  return year >= 1900 && year <= 2999 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function parseTimeOfDay(raw: string | null | undefined): Time | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/Z$/i, "");
  const m = cleaned.match(/^(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const h = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  if (!(h >= 0 && h < 24) || !(min >= 0 && min < 60)) return undefined;
  return { totalMinutes: h * 60 + min };
}

/** Normalizes a raw raw EntryPersonRole wire string to the model's canonical
 * union, falling back to `{ unknown: raw }`. The iOS app's lenient-alias
 * decode is collapsed onto just the canonical codes (this CLI doesn't need the full alias table that
 * decode supports; importers that need aliases define their own). */
function normalizeRole(raw: string | undefined): EntryPersonRole | undefined {
  if (raw === undefined) return undefined;
  const CANON = [
    "PIC",
    "CP",
    "CRCP",
    "PICUS",
    "SPIC",
    "RI",
    "RI_CP",
    "LCA",
    "LCAI",
    "LCAIFO",
    "FI",
    "FE",
    "SI_PIC",
    "SI_CP",
    "SI_OBS",
    "STU",
    "DH",
    "CA",
    "CS",
    "Purser",
    "SP",
    "FSTD_TRN",
    "FSTD_INS",
    "FSTD_EXA",
    "FSTD_OBS",
    "FSTD_SI"
  ] as const;
  const match = CANON.find((c) => c === raw);
  return match ?? { unknown: raw };
}

function cleanRegistration(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

interface JSONTakeoffsAndLandings {
  type?: string;
  takeoffs?: number;
  landings?: number;
  takeoffs_day?: number;
  takeoffs_night?: number;
  landings_day?: number;
  landings_night?: number;
}

type TALResolved =
  | { kind: "value"; value: TakeoffsAndLandings }
  | { kind: "incomplete" }
  | { kind: "unknownType"; rawType: string }
  | { kind: "absent" };

function resolveTakeoffsAndLandings(raw: JSONTakeoffsAndLandings): TALResolved {
  const resolveAuto = (): TALResolved =>
    raw.takeoffs !== undefined && raw.landings !== undefined
      ? { kind: "value", value: { type: "auto", takeoffs: raw.takeoffs, landings: raw.landings } }
      : { kind: "incomplete" };
  const resolveManual = (): TALResolved =>
    raw.takeoffs_day !== undefined && raw.takeoffs_night !== undefined && raw.landings_day !== undefined && raw.landings_night !== undefined
      ? {
          kind: "value",
          value: {
            type: "manual",
            takeoffsDay: raw.takeoffs_day,
            takeoffsNight: raw.takeoffs_night,
            landingsDay: raw.landings_day,
            landingsNight: raw.landings_night
          }
        }
      : { kind: "incomplete" };

  if (raw.type === "auto") return resolveAuto();
  if (raw.type === "manual") return resolveManual();
  if (raw.type !== undefined) return { kind: "unknownType", rawType: raw.type };

  if (raw.takeoffs !== undefined || raw.landings !== undefined) return resolveAuto();
  if (
    raw.takeoffs_day !== undefined ||
    raw.takeoffs_night !== undefined ||
    raw.landings_day !== undefined ||
    raw.landings_night !== undefined
  ) {
    return resolveManual();
  }
  return { kind: "absent" };
}

interface JSONEntryPersonLink {
  ref_id: string;
  role: string;
}

interface JSONEntry {
  type?: string | null;
  date: string;
  flight_number?: string | null;
  scheduled_off_blocks?: string | null;
  scheduled_on_blocks?: string | null;
  registration?: string | null;
  from?: string | null;
  to?: string | null;
  off_blocks?: string | null;
  airborne?: string | null;
  touchdown?: string | null;
  on_blocks?: string | null;
  actual_from?: string | null;
  actual_to?: string | null;
  update_flight_data?: boolean | null;
  people?: JSONEntryPersonLink[] | null;
  takeoffs_and_landings?: JSONTakeoffsAndLandings | null;
  approaches?: Array<{ type: string; count: number; autolands?: number }> | null;
  go_arounds?: number | null;
  passengers_on_board?: number | null;
  fuel_planned?: number | null;
  fuel_used?: number | null;
  remarks?: string | null;
  is_deleted?: boolean | null;
}

interface JSONImportedPerson {
  ref_id: string;
  first_name?: string | null;
  last_name?: string | null;
  default_role?: string | null;
  employee_number?: string | null;
}

interface DeepLinkData {
  entries?: unknown[];
  people?: unknown[];
}

function isJSONEntry(v: unknown): v is JSONEntry {
  return typeof v === "object" && v !== null && typeof (v as JSONEntry).date === "string";
}

function isJSONImportedPerson(v: unknown): v is JSONImportedPerson {
  return typeof v === "object" && v !== null && typeof (v as JSONImportedPerson).ref_id === "string";
}

function parse(input: Buffer | string): ImportResult {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const importErrors: ImportError[] = [];

  let data: DeepLinkData;
  try {
    data = JSON.parse(text) as DeepLinkData;
  } catch (err) {
    importErrors.push({ reason: `Could not parse JSON: ${(err as Error).message}` });
    return { ...emptyImportResult(), importErrors };
  }

  const people: ImportedPerson[] = [];
  const peopleByRefId = new Map<string, ImportedPerson>();
  const rawPeople = Array.isArray(data.people) ? data.people : [];
  rawPeople.forEach((raw, index) => {
    if (!isJSONImportedPerson(raw)) {
      importErrors.push({ reason: "Skipped a malformed person", rowNumber: index + 1 });
      return;
    }
    const hasContent = !!raw.employee_number || !!raw.first_name || !!raw.last_name;
    if (!hasContent) {
      importErrors.push({ reason: "Empty person provided, need at least employeenumber or name" });
      return;
    }
    const person: ImportedPerson = {
      refId: raw.ref_id,
      firstName: raw.first_name ?? undefined,
      lastName: raw.last_name ?? undefined,
      defaultRole: normalizeRole(raw.default_role ?? undefined),
      employeeNumber: raw.employee_number ?? undefined,
      isExisting: { existing: false },
      isImportedFromOtherLogbook: false
    };
    people.push(person);
    peopleByRefId.set(person.refId.toUpperCase(), person);
  });

  function ensureSelfPerson(): void {
    if (peopleByRefId.has("SELF")) return;
    const self: ImportedPerson = { refId: "SELF", isExisting: { existing: false } };
    people.push(self);
    peopleByRefId.set("SELF", self);
  }

  const aircraftByRegistration = new Map<string, ImportedAircraft>();
  const entries: ReturnType<typeof newImportedEntry>[] = [];
  const rawEntries = Array.isArray(data.entries) ? data.entries : [];

  rawEntries.forEach((raw, index) => {
    if (!isJSONEntry(raw)) {
      importErrors.push({ reason: "Skipped a malformed entry", rowNumber: index + 1 });
      return;
    }
    const jsonEntry = raw;
    const type = jsonEntry.type ?? "flight";
    if (type !== "flight") {
      importErrors.push({
        reason: `Unsupported entry type '${type}'`,
        dateString: jsonEntry.date,
        flightNumber: jsonEntry.flight_number ?? undefined,
        registration: jsonEntry.registration ?? undefined,
        from: jsonEntry.from ?? undefined,
        to: jsonEntry.to ?? undefined
      });
      return;
    }

    if (!isPlausibleISODate(jsonEntry.date)) {
      importErrors.push({
        reason: "Invalid date format",
        dateString: jsonEntry.date,
        flightNumber: jsonEntry.flight_number ?? undefined,
        registration: jsonEntry.registration ?? undefined,
        from: jsonEntry.from ?? undefined,
        to: jsonEntry.to ?? undefined
      });
      return;
    }

    const flightNumber = jsonEntry.flight_number || undefined;
    const cleanedRegistration = cleanRegistration(jsonEntry.registration);
    if (!flightNumber && !cleanedRegistration) {
      importErrors.push({
        reason: "Missing Flight Number and Registration",
        dateString: jsonEntry.date,
        flightNumber: jsonEntry.flight_number ?? undefined,
        registration: jsonEntry.registration ?? undefined,
        from: jsonEntry.from ?? undefined,
        to: jsonEntry.to ?? undefined
      });
      return;
    }

    const crew: ImportedEntryCrewMember[] = [];
    for (const link of jsonEntry.people ?? []) {
      if (link.ref_id.toUpperCase() === "SELF") ensureSelfPerson();
      const role = normalizeRole(link.role);
      if (role !== undefined) crew.push({ refId: link.ref_id, role });
    }

    const scheduledOffBlocks = parseTimeOfDay(jsonEntry.scheduled_off_blocks);
    const scheduledOnBlocks = parseTimeOfDay(jsonEntry.scheduled_on_blocks);
    const offBlocks = parseTimeOfDay(jsonEntry.off_blocks);
    const airborne = parseTimeOfDay(jsonEntry.airborne);
    const touchdown = parseTimeOfDay(jsonEntry.touchdown);
    const onBlocks = parseTimeOfDay(jsonEntry.on_blocks);
    const from = canonicalCode(jsonEntry.from ?? undefined);
    const to = canonicalCode(jsonEntry.to ?? undefined);
    const actualFrom = canonicalCode(jsonEntry.actual_from ?? undefined);
    const actualTo = canonicalCode(jsonEntry.actual_to ?? undefined);

    if (cleanedRegistration && !aircraftByRegistration.has(cleanedRegistration)) {
      aircraftByRegistration.set(cleanedRegistration, { registration: cleanedRegistration, isImportedFromOtherLogbook: false });
    }

    let takeoffsAndLandings: TakeoffsAndLandings | undefined;
    if (jsonEntry.takeoffs_and_landings) {
      const resolved = resolveTakeoffsAndLandings(jsonEntry.takeoffs_and_landings);
      if (resolved.kind === "value") takeoffsAndLandings = resolved.value;
      else if (resolved.kind === "incomplete") {
        importErrors.push({
          reason: "Incomplete takeoffs/landings counts",
          dateString: jsonEntry.date,
          flightNumber,
          registration: cleanedRegistration,
          from,
          to
        });
      } else if (resolved.kind === "unknownType") {
        importErrors.push({
          reason: `Invalid takeoffs/landings type "${resolved.rawType}"`,
          dateString: jsonEntry.date,
          flightNumber,
          registration: cleanedRegistration,
          from,
          to
        });
      }
    }

    let approaches: ApproachCount[] | undefined;
    if (jsonEntry.approaches) {
      const valid: ApproachCount[] = [];
      const dropped: string[] = [];
      const autolandAdjustments: string[] = [];
      const KNOWN_APPROACH_TYPES = new Set([
        "ils_cat1",
        "ils_cat2",
        "ils_cat3",
        "gls",
        "rnp",
        "rnp_ar",
        "loc",
        "vor",
        "ndb",
        "visual",
        "circling",
        "par"
      ]);
      const AUTOLAND_CAPABLE = new Set(["ils_cat1", "ils_cat2", "ils_cat3", "gls"]);
      for (const item of jsonEntry.approaches) {
        if (!KNOWN_APPROACH_TYPES.has(item.type)) {
          dropped.push(`unrecognized type "${item.type}"`);
          continue;
        }
        if (item.count <= 0) {
          dropped.push(`${item.type} with count ${item.count}`);
          continue;
        }
        const sanitized: ApproachCount = { type: item.type as ApproachCount["type"], count: item.count, autolands: item.autolands };
        if (sanitized.autolands !== undefined) {
          if (sanitized.autolands < 1) sanitized.autolands = undefined;
          else if (!AUTOLAND_CAPABLE.has(item.type)) {
            autolandAdjustments.push(`${item.type} does not support autoland (dropped ${sanitized.autolands})`);
            sanitized.autolands = undefined;
          } else if (sanitized.autolands > sanitized.count) {
            autolandAdjustments.push(`${item.type} autolands ${sanitized.autolands} clamped to count ${sanitized.count}`);
            sanitized.autolands = sanitized.count;
          }
        }
        valid.push(sanitized);
      }
      if (dropped.length > 0) {
        importErrors.push({
          reason: `Invalid approaches dropped: ${dropped.join(", ")}`,
          dateString: jsonEntry.date,
          flightNumber,
          registration: cleanedRegistration,
          from,
          to
        });
      }
      if (autolandAdjustments.length > 0) {
        importErrors.push({
          reason: `Invalid autoland counts adjusted: ${autolandAdjustments.join(", ")}`,
          dateString: jsonEntry.date,
          flightNumber,
          registration: cleanedRegistration,
          from,
          to
        });
      }
      approaches = valid.length > 0 ? valid : undefined;
    }

    const explicitUpdateFlightData = jsonEntry.update_flight_data ?? undefined;
    const inferredUpdateFlightData = !(offBlocks || airborne || touchdown || onBlocks);

    const entry = newImportedEntry({
      date: jsonEntry.date,
      type: "flight",
      flightNumber,
      registration: cleanedRegistration,
      from,
      to,
      actualFrom,
      actualTo,
      scheduledOffBlocks,
      scheduledOnBlocks,
      offBlocks,
      airborne,
      touchdown,
      onBlocks,
      updateFlightData: explicitUpdateFlightData ?? inferredUpdateFlightData,
      takeoffsAndLandings,
      approaches,
      goArounds: jsonEntry.go_arounds ?? undefined,
      passengersOnBoard: jsonEntry.passengers_on_board ?? undefined,
      fuelPlanned: jsonEntry.fuel_planned ?? undefined,
      fuelUsed: jsonEntry.fuel_used ?? undefined,
      isImportedFromOtherLogbook: false,
      crew,
      isDeleted: jsonEntry.is_deleted ?? undefined
    });

    entry.remarks = truncatedRemarks(jsonEntry.remarks ?? undefined, importErrors, {
      dateString: jsonEntry.date,
      flightNumber,
      registration: cleanedRegistration
    });

    entries.push(entry);
  });

  return {
    entries,
    people,
    aircraft: [...aircraftByRegistration.values()],
    importErrors,
    skippedUnchangedCount: 0
  };
}

export const deepLinkJSONImporter: Importer = {
  id: "deeplink-json",
  displayName: "Jetlog import deeplink JSON",
  extensions: ["json"],
  detect(buffer: Buffer): number {
    const text = buffer.toString("utf8").trim();
    if (!text.startsWith("{")) return 0;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (Array.isArray(parsed.entries)) return 0.8;
      return 0;
    } catch {
      return 0;
    }
  },
  async parse(input: Buffer | string, _options?: ImporterOptions): Promise<ImportResult> {
    return parse(input);
  }
};
