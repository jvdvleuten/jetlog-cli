import { parse } from "csv-parse/sync";
import type { EntryInput, PayloadInput } from "../schema.js";

export interface SkippedRow {
  row: number;
  reason: string;
}

export interface ConvertResult {
  payload: PayloadInput;
  skipped: SkippedRow[];
}

export type DateFormat = "YMD" | "DMY" | "MDY";

/**
 * Case-insensitive header aliases -> canonical Jetlog field name. Each
 * logbook app/export uses slightly different header text; list every
 * variant we know about here so the generic csv converter and the
 * per-app presets can share the alias table.
 */
export const HEADER_ALIASES: Record<string, string[]> = {
  date: ["date", "flight date"],
  flight_number: ["flight_number", "flight no", "flight no.", "flight number", "flight"],
  registration: ["registration", "reg", "tail", "tail number", "aircraft id", "aircraftid"],
  from: ["from", "dep", "departure", "origin", "departed from"],
  to: ["to", "arr", "arrival", "destination", "arrived at"],
  scheduled_off_blocks: ["scheduled off blocks", "sched out", "std"],
  scheduled_on_blocks: ["scheduled on blocks", "sched in", "sta"],
  off_blocks: ["out", "off blocks", "off-blocks", "block out", "blockout"],
  airborne: ["off", "takeoff", "airborne", "take off time"],
  touchdown: ["on", "landing", "touchdown", "land"],
  on_blocks: ["in", "on blocks", "on-blocks", "block in", "blockin"],
  remarks: ["remarks", "notes", "comments"],
  takeoffs_day: ["day takeoffs", "takeoffs day", "day to"],
  takeoffs_night: ["night takeoffs", "takeoffs night", "night to"],
  landings_day: ["day landings", "landings day", "day ldg", "day"],
  landings_night: ["night landings", "landings night", "night ldg", "night"],
  go_arounds: ["go arounds", "go-arounds", "goarounds"],
  passengers_on_board: ["passengers", "pax", "passengers on board"],
  fuel_planned: ["fuel planned", "planned fuel"],
  fuel_used: ["fuel used", "used fuel", "fuel burn"]
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildHeaderMap(
  headers: string[],
  overrides: Record<string, string> = {},
  aliases: Record<string, string[]> = HEADER_ALIASES
): Map<string, string> {
  const map = new Map<string, string>();
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  for (const [field, header] of Object.entries(overrides)) {
    const norm = normalizeHeader(header);
    const match = normalizedHeaders.find((h) => h.norm === norm);
    if (match) map.set(field, match.raw);
  }

  for (const [field, candidates] of Object.entries(aliases)) {
    if (map.has(field)) continue;
    for (const candidate of candidates) {
      const match = normalizedHeaders.find((h) => h.norm === candidate);
      if (match) {
        map.set(field, match.raw);
        break;
      }
    }
  }

  return map;
}

export function normalizeDate(raw: string, format: DateFormat = "YMD"): string | null {
  const value = raw.trim();
  if (!value) return null;

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return value;

  const slashMatch = value.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/);
  if (slashMatch) {
    const [, a, b, c] = slashMatch;
    if (a!.length === 4) {
      return `${a}-${b!.padStart(2, "0")}-${c!.padStart(2, "0")}`;
    }
    if (c!.length === 4) {
      // a/b/c with a 4-digit year last: ambiguous between DMY and MDY.
      if (format === "MDY") {
        return `${c}-${a!.padStart(2, "0")}-${b!.padStart(2, "0")}`;
      }
      return `${c}-${b!.padStart(2, "0")}-${a!.padStart(2, "0")}`;
    }
  }

  return null;
}

export function normalizeTime(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const hhmm = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (hhmm) return `${hhmm[1]!.padStart(2, "0")}:${hhmm[2]}`;

  const compact = value.match(/^([01]?\d|2[0-3])([0-5]\d)$/);
  if (compact) return `${compact[1]!.padStart(2, "0")}:${compact[2]}`;

  const z = value.match(/^([01]?\d|2[0-3])([0-5]\d)[zZ]$/);
  if (z) return `${z[1]!.padStart(2, "0")}:${z[2]}`;

  return null;
}

export interface GenericCsvOptions {
  map?: Record<string, string>;
  dateFormat?: DateFormat;
  selfRole?: string;
  aliases?: Record<string, string[]>;
  /** Pre-parsed records, used by presets that handle multi-section CSVs themselves. */
  records?: Record<string, string>[];
  /** Original filename, when known, forwarded to the importers'
   * `ImporterOptions.filename` (e.g. PilotLog's CSV-vs-zip routing). */
  filename?: string;
}

export function parseCsv(content: string): Record<string, string>[] {
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  }) as Record<string, string>[];
}

function getField(record: Record<string, string>, headerMap: Map<string, string>, field: string): string | undefined {
  const header = headerMap.get(field);
  if (!header) return undefined;
  const value = record[header];
  return value === undefined ? undefined : value.trim();
}

export function convertGenericCsv(content: string, options: GenericCsvOptions = {}): ConvertResult {
  const records = options.records ?? parseCsv(content);
  const skipped: SkippedRow[] = [];
  const entries: EntryInput[] = [];

  if (records.length === 0) {
    return { payload: { entries: [], people: [] }, skipped };
  }

  // Union headers across all records: csv-parse (with relax_column_count)
  // omits a trailing key entirely from a row that's shorter than the
  // header line, so relying on just the first record can miss columns.
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const headerMap = buildHeaderMap(headers, options.map, options.aliases);
  const selfRole = options.selfRole;

  records.forEach((record, i) => {
    const rowNumber = i + 2; // header is row 1
    const rawDate = getField(record, headerMap, "date");
    if (!rawDate) {
      skipped.push({ row: rowNumber, reason: "missing date" });
      return;
    }
    const date = normalizeDate(rawDate, options.dateFormat);
    if (!date) {
      skipped.push({ row: rowNumber, reason: `unparsable date: "${rawDate}"` });
      return;
    }

    const entry: EntryInput = { date };

    const flightNumber = getField(record, headerMap, "flight_number");
    if (flightNumber) entry.flight_number = flightNumber;

    const registration = getField(record, headerMap, "registration");
    if (registration) entry.registration = registration.toUpperCase().replace(/[^A-Z0-9]/g, "");

    const from = getField(record, headerMap, "from");
    if (from) entry.from = from.toUpperCase();

    const to = getField(record, headerMap, "to");
    if (to) entry.to = to.toUpperCase();

    for (const [field, target] of [
      ["scheduled_off_blocks", "scheduled_off_blocks"],
      ["scheduled_on_blocks", "scheduled_on_blocks"],
      ["off_blocks", "off_blocks"],
      ["airborne", "airborne"],
      ["touchdown", "touchdown"],
      ["on_blocks", "on_blocks"]
    ] as const) {
      const raw = getField(record, headerMap, field);
      if (raw) {
        const time = normalizeTime(raw);
        if (time) (entry as Record<string, unknown>)[target] = time;
      }
    }

    const remarks = getField(record, headerMap, "remarks");
    if (remarks) entry.remarks = remarks.slice(0, 1000);

    let takeoffsDay = getField(record, headerMap, "takeoffs_day");
    let takeoffsNight = getField(record, headerMap, "takeoffs_night");
    let landingsDay = getField(record, headerMap, "landings_day");
    let landingsNight = getField(record, headerMap, "landings_night");
    if (takeoffsDay || takeoffsNight || landingsDay || landingsNight) {
      entry.takeoffs_and_landings = {
        takeoffs_day: toInt(takeoffsDay),
        takeoffs_night: toInt(takeoffsNight),
        landings_day: toInt(landingsDay),
        landings_night: toInt(landingsNight)
      };
    }

    const goArounds = getField(record, headerMap, "go_arounds");
    if (goArounds) entry.go_arounds = toInt(goArounds);

    const pax = getField(record, headerMap, "passengers_on_board");
    if (pax) entry.passengers_on_board = toInt(pax);

    const fuelPlanned = getField(record, headerMap, "fuel_planned");
    if (fuelPlanned) entry.fuel_planned = toInt(fuelPlanned);

    const fuelUsed = getField(record, headerMap, "fuel_used");
    if (fuelUsed) entry.fuel_used = toInt(fuelUsed);

    if (selfRole) {
      entry.people = [{ ref_id: "SELF", role: selfRole }];
    }

    entries.push(entry);
  });

  return { payload: { entries, people: [] }, skipped };
}

function toInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
