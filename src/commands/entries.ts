import { ApiClient, DEFAULT_BASE_URL, type EntriesPage } from "../api/client.js";
import { resolveToken, resolveBaseUrl } from "../auth/credentials.js";
import { printRows, withPresentColumns, type OutputFormat } from "./output.js";

export interface EntriesListOptions {
  profile: string;
  baseUrl?: string;
  format: OutputFormat;
  from?: string;
  to?: string;
  type?: string;
  registration?: string;
  airport?: string;
  flightNumber?: string;
  personId?: string;
  role?: string;
  includeDeleted?: boolean;
  limit?: number;
  afterDate?: string;
  afterId?: string;
  /** Fetch every page instead of just the first (used by `export` too). */
  all?: boolean;
}

const COLUMNS = [
  "id",
  "date",
  "type",
  "flight_number",
  "registration",
  "from",
  "to",
  "off_blocks",
  "on_blocks",
  "is_deleted"
];

/** Columns the facade sends only from the attachments release on; shown when present. `files` is `attachment_count`. */
function withFileColumns(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; columns: string[] } {
  const shaped = rows.map((r) => (r.attachment_count !== undefined ? { ...r, files: r.attachment_count } : r));
  return { rows: shaped, columns: withPresentColumns(shaped, COLUMNS, ["signature", "files"]) };
}

export async function requireClient(profile: string, baseUrlOverride?: string): Promise<ApiClient> {
  const token = await resolveToken(profile);
  if (!token) {
    throw new Error(`not logged in (profile: ${profile}). Run \`jetlog login\`.`);
  }
  const baseUrl = baseUrlOverride ?? (await resolveBaseUrl(profile)) ?? DEFAULT_BASE_URL;
  return new ApiClient({ baseUrl, token });
}

export function entriesQuery(opts: EntriesListOptions): Record<string, string | number | boolean | undefined> {
  return {
    from: opts.from,
    to: opts.to,
    type: opts.type,
    registration: opts.registration,
    airport: opts.airport,
    flight_number: opts.flightNumber,
    person_id: opts.personId,
    role: opts.role,
    include_deleted: opts.includeDeleted,
    limit: opts.limit,
    after_date: opts.afterDate,
    after_id: opts.afterId
  };
}

/** Fetches every page of `/api/cli/v1/entries` for the given filters. */
export async function fetchAllEntries(
  client: ApiClient,
  opts: EntriesListOptions
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let afterDate = opts.afterDate;
  let afterId = opts.afterId;

  for (;;) {
    const page = await client.get<EntriesPage>("/api/cli/v1/entries", {
      ...entriesQuery({ ...opts, afterDate, afterId }),
      limit: opts.limit ?? 200
    });
    all.push(...page.entries);
    if (!page.pagination.has_more || !page.pagination.next_cursor) break;
    afterDate = String(page.pagination.next_cursor.date);
    afterId = String(page.pagination.next_cursor.id);
  }

  return all;
}

export async function entriesList(opts: EntriesListOptions): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);

  const rows = opts.all
    ? await fetchAllEntries(client, opts)
    : (await client.get<EntriesPage>("/api/cli/v1/entries", entriesQuery(opts))).entries;

  if (opts.format === "json") {
    printRows(rows, COLUMNS, opts.format);
    return;
  }
  const shaped = withFileColumns(rows);
  printRows(shaped.rows, shaped.columns, opts.format);
}
