import { listPlacesPage, PLACES_MAX_LIMIT, type ApiClient } from "../api/client.js";
import { requireClient } from "./entries.js";
import { printRows, type OutputFormat } from "./output.js";

const COLUMNS = ["id", "code", "icao", "iata", "name", "country_code", "timezone", "latitude", "longitude"];

export interface PlacesListOptions {
  profile: string;
  baseUrl?: string;
  format: OutputFormat;
  /** Code prefix (code, ICAO or IATA) or part of the name, any case. */
  search?: string;
  /** One page of this size instead of every place. */
  limit?: number;
  /** One page from this offset instead of every place. */
  offset?: number;
  /** Where the "more places" hint goes (stderr by default). */
  log?: (line: string) => void;
}

/** Every page of `/api/cli/v1/places` for `q`, following `next_offset` until the last page. */
export async function fetchAllPlaces(client: ApiClient, q?: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const page = await listPlacesPage(client, { q, limit: PLACES_MAX_LIMIT, offset });
    all.push(...page.places);
    const next = page.next_offset;
    // An offset that does not move forward would refetch the same page forever.
    if (typeof next !== "number" || next <= offset) break;
    offset = next;
  }
  return all;
}

/** The server's cap on `q`, in UTF-8 bytes (not characters). */
export const PLACES_MAX_QUERY_BYTES = 255;

export function placesQueryTooLong(q: string): boolean {
  return Buffer.byteLength(q, "utf8") > PLACES_MAX_QUERY_BYTES;
}

function checkPaging(name: string, value: number | undefined, min: number, max?: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new Error(`${name} must be a whole number from ${min}${max !== undefined ? ` to ${max}` : " up"}`);
  }
}

/**
 * `jetlog places`: the pilot's own places (airports and custom places). Lists every place like `jetlog people`
 * and `jetlog aircraft` do, unless `--limit` or `--offset` asks for one page.
 */
export async function placesList(opts: PlacesListOptions): Promise<void> {
  checkPaging("--limit", opts.limit, 1, PLACES_MAX_LIMIT);
  checkPaging("--offset", opts.offset, 0);
  const q = opts.search?.trim() || undefined;
  if (q !== undefined && placesQueryTooLong(q)) {
    throw new Error(`--search must be at most ${PLACES_MAX_QUERY_BYTES} bytes`);
  }
  const client = await requireClient(opts.profile, opts.baseUrl);

  if (opts.limit === undefined && opts.offset === undefined) {
    printRows(await fetchAllPlaces(client, q), COLUMNS, opts.format);
    return;
  }

  const page = await listPlacesPage(client, { q, limit: opts.limit, offset: opts.offset });
  printRows(page.places, COLUMNS, opts.format);
  if (typeof page.next_offset === "number") {
    (opts.log ?? ((line: string) => console.error(line)))(`More places with --offset ${page.next_offset}.`);
  }
}
