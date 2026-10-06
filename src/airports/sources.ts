/**
 * Where the resolver's rows come from. The package ships no airport data.
 *
 * - Logged in: the server catalog (`GET /api/system_places`, paged by
 *   `after_version`, cached per profile on disk and refreshed by delta) plus the
 *   user's own places (`GET /api/places`). Both routes are readable with a PAT and,
 *   without a device id, do not touch sync cursors.
 * - Not logged in, or `--offline`: no rows. Codes pass through as written and
 *   nothing resolves to a position.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiClient } from "../api/client.js";
import { configDir } from "../auth/credentials.js";
import type { CatalogRow, UserPlace } from "./resolver.js";

// ---------------------------------------------------------------------------
// Logged-in sources
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 1000;

interface ApiSystemPlace {
  id: string;
  version?: number | null;
  icao?: string | null;
  iata?: string | null;
  local_code?: string | null;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  country_code?: string | null;
  timezone?: string | null;
  is_deleted?: boolean;
  updated_at?: string | null;
}

interface ApiPlace {
  id: string;
  version?: number | null;
  code?: string | null;
  icao?: string | null;
  iata?: string | null;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  country_code?: string | null;
  timezone?: string | null;
  is_deleted?: boolean;
  updated_at?: string | null;
}

function toCatalogRow(p: ApiSystemPlace): CatalogRow {
  return {
    id: p.id,
    icao: p.icao ?? null,
    iata: p.iata ?? null,
    localCode: p.local_code ?? null,
    lat: p.latitude ?? null,
    lon: p.longitude ?? null,
    timezone: p.timezone ?? null,
    name: p.name ?? null,
    countryCode: p.country_code ?? null,
    version: p.version ?? null,
    updatedAt: p.updated_at ?? null,
    isDeleted: p.is_deleted === true
  };
}

function toUserPlace(p: ApiPlace): UserPlace {
  return {
    id: p.id,
    code: p.code ?? null,
    icao: p.icao ?? null,
    iata: p.iata ?? null,
    lat: p.latitude ?? null,
    lon: p.longitude ?? null,
    timezone: p.timezone ?? null,
    name: p.name ?? null,
    countryCode: p.country_code ?? null,
    version: p.version ?? null,
    updatedAt: p.updated_at ?? null,
    isDeleted: p.is_deleted === true
  };
}

/** Pages one version-ordered sync endpoint until it runs dry. `onPage` receives each page's rows. */
async function pageByVersion<T extends { version?: number | null }>(
  client: ApiClient,
  endpoint: string,
  key: string,
  startAfter: number,
  onPage: (rows: T[]) => void
): Promise<void> {
  let after = startAfter;
  for (;;) {
    const page = await client.get<Record<string, unknown>>(endpoint, { after_version: after, limit: PAGE_LIMIT });
    const rows = (page[key] as T[] | null | undefined) ?? [];
    onPage(rows);
    const maxVersion = rows.reduce((m, r) => Math.max(m, r.version ?? 0), after);
    // A short page is the last one; a page that does not advance the cursor would loop forever.
    if (rows.length < PAGE_LIMIT || maxVersion <= after) return;
    after = maxVersion;
  }
}

interface CatalogCache {
  baseUrl: string;
  maxVersion: number;
  rows: Record<string, CatalogRow>;
}

export function catalogCachePath(profile: string): string {
  return path.join(configDir(), "cache", `system-places-${profile.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

async function readCache(file: string, baseUrl: string): Promise<CatalogCache | undefined> {
  try {
    const cache = JSON.parse(await readFile(file, "utf8")) as CatalogCache;
    if (cache.baseUrl !== baseUrl || typeof cache.maxVersion !== "number" || typeof cache.rows !== "object" || cache.rows === null) {
      return undefined;
    }
    return cache;
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, cache: CatalogCache): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, file);
  } catch {
    // The cache is only an optimization.
  }
}

/** The server catalog, tombstones included (they replace cached rows by id), refreshed by delta from the profile's disk cache. */
export async function fetchSystemCatalog(client: ApiClient, profile: string, baseUrl: string): Promise<CatalogRow[]> {
  const file = catalogCachePath(profile);
  const cached = await readCache(file, baseUrl);
  const rows = new Map<string, CatalogRow>(cached ? Object.entries(cached.rows) : []);
  const startAfter = cached?.maxVersion ?? 0;
  let maxVersion = startAfter;
  let changed = false;

  await pageByVersion<ApiSystemPlace>(client, "/api/system_places", "system_places", startAfter, (page) => {
    for (const raw of page) {
      const row = toCatalogRow(raw);
      rows.set(row.id, row);
      maxVersion = Math.max(maxVersion, row.version ?? 0);
      changed = true;
    }
  });

  if (changed && rows.size > 0) {
    await writeCache(file, { baseUrl, maxVersion, rows: Object.fromEntries(rows) });
  }
  return [...rows.values()];
}

/** The user's own places (small, always fetched fresh), tombstones included. */
export async function fetchUserPlaces(client: ApiClient): Promise<UserPlace[]> {
  const out: UserPlace[] = [];
  await pageByVersion<ApiPlace>(client, "/api/places", "places", 0, (page) => {
    for (const raw of page) out.push(toUserPlace(raw));
  });
  return out;
}
