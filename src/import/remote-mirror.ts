/**
 * Fetches the logged-in user's own existing logbook data over the read API
 * so `jetlog import` can match/merge against it instead of blindly creating
 * duplicates on every re-import, the CLI-side equivalent of the iOS app's
 * local store that its import matching runs against (see `docs/IMPORTERS.md`).
 *
 * Deliberately a plain in-memory snapshot refetched per `jetlog import` run,
 * not a persistent cache with incremental cursors. A plain re-fetch is slower
 * but no less correct.
 */
import type { ApiClient, EntriesPage, PeopleResponse, AircraftResponse, SyncFstdPage, MeResponse } from "../api/client.js";

export interface RemoteEntry {
  [key: string]: unknown;
  id: string;
  date: string;
  type: string;
  flight_number?: string | null;
  registration?: string | null;
  from?: string | null;
  to?: string | null;
  start_time?: string | null;
  fstd_id?: string | null;
  is_deleted?: boolean;
  people?: { person_id: string; role: string; is_deleted?: boolean }[];
}

export interface RemotePerson {
  [key: string]: unknown;
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  employee_number?: string | null;
  is_deleted?: boolean;
}

export interface RemoteAircraft {
  [key: string]: unknown;
  id: string;
  is_deleted?: boolean;
}

export interface RemoteFstd {
  [key: string]: unknown;
  id: string;
  device_category?: string | null;
  is_deleted?: boolean;
}

export interface RemoteMirror {
  selfPersonId: string;
  entries: RemoteEntry[];
  people: RemotePerson[];
  aircraft: RemoteAircraft[];
  fstd: RemoteFstd[];
}

/** Pages through `/api/cli/v1/entries` (keyset, not deleted) collecting every row. */
async function fetchAllEntries(client: ApiClient): Promise<RemoteEntry[]> {
  const all: RemoteEntry[] = [];
  let afterDate: string | undefined;
  let afterId: string | undefined;
  for (;;) {
    const page = await client.get<EntriesPage>("/api/cli/v1/entries", {
      limit: 200,
      after_date: afterDate,
      after_id: afterId
    });
    all.push(...(page.entries as RemoteEntry[]));
    if (!page.pagination.has_more || !page.pagination.next_cursor) break;
    afterDate = String(page.pagination.next_cursor.date);
    afterId = String(page.pagination.next_cursor.id);
  }
  return all;
}

/** Pages through `/api/fstd`'s version cursor, the only FSTD list endpoint
 * (there is no `/api/cli/v1/fstd` facade). */
async function fetchAllFstd(client: ApiClient): Promise<RemoteFstd[]> {
  const all: RemoteFstd[] = [];
  let afterVersion = 0;
  for (;;) {
    const page = await client.get<SyncFstdPage>("/api/fstd", { after_version: afterVersion, limit: 1000 });
    const rows = (page.fstd ?? []) as RemoteFstd[];
    if (rows.length === 0) break;
    all.push(...rows);
    const maxVersion = Math.max(...rows.map((r) => Number(r.version ?? 0)));
    if (!Number.isFinite(maxVersion) || maxVersion <= afterVersion) break;
    afterVersion = maxVersion;
    if (rows.length < 1000) break;
  }
  return all;
}

export async function fetchRemoteMirror(client: ApiClient): Promise<RemoteMirror> {
  const [me, entries, people, aircraft, fstd] = await Promise.all([
    client.get<MeResponse>("/api/cli/v1/me"),
    fetchAllEntries(client),
    client.get<PeopleResponse>("/api/cli/v1/people"),
    client.get<AircraftResponse>("/api/cli/v1/aircraft"),
    fetchAllFstd(client)
  ]);

  return {
    selfPersonId: String(me.self_person_id),
    entries: entries.filter((e) => !e.is_deleted),
    people: (people.people as RemotePerson[]).filter((p) => !p.is_deleted),
    aircraft: (aircraft.aircraft as RemoteAircraft[]).filter((a) => !a.is_deleted),
    fstd: fstd.filter((f) => !f.is_deleted)
  };
}
