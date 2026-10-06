/**
 * The one airport-code resolver.
 *
 * Pure: no I/O, no globals. `buildAirportIndex(catalog, userPlaces)` builds the
 * index, `canonical`/`resolve`/`equivalentCodes` read it. Catalog rows come from
 * the server (`GET /api/system_places`) when logged in (see `./sources.ts`);
 * user places come from `GET /api/places`. Same precedence as the iOS app's
 * canonical-code lookup plus its field-by-field airport merge. With no rows the
 * index is empty: every code is its own identity and nothing resolves.
 */

/** A catalog row (`system_places` server side). Every code and coordinate may be missing. */
export interface CatalogRow {
  id: string;
  icao?: string | null;
  iata?: string | null;
  localCode?: string | null;
  lat?: number | null;
  lon?: number | null;
  timezone?: string | null;
  name?: string | null;
  countryCode?: string | null;
  version?: number | null;
  updatedAt?: string | null;
  isDeleted?: boolean;
}

/** A user place (`places`). `code` is a free string; user places have no local code. */
export interface UserPlace {
  id: string;
  code?: string | null;
  icao?: string | null;
  iata?: string | null;
  lat?: number | null;
  lon?: number | null;
  timezone?: string | null;
  name?: string | null;
  countryCode?: string | null;
  version?: number | null;
  updatedAt?: string | null;
  isDeleted?: boolean;
}

export interface ResolvedAirport {
  /** `canonical(code)`. */
  identity: string;
  /** Null unless `hasPosition`: never a (0, 0) placeholder. */
  lat: number | null;
  lon: number | null;
  /** True only when BOTH axes are non-null. Treat false exactly like an unresolved code. */
  hasPosition: boolean;
  timezone: string | null;
  name: string;
  countryCode: string | null;
  /** Catalog row with no ICAO (display must not label it ICAO). */
  isIataOnly: boolean;
}

export interface AirportIndex {
  byIdentity: Map<string, CatalogRow>;
  /** IATA alias -> ICAO, icao-ful rows only. */
  iataAlias: Map<string, string>;
  byLocalCode: Map<string, CatalogRow>;
  overlay: Map<string, UserPlace>;
}

/** True when the index holds no airports at all (not logged in, or `--offline`). */
export function isEmptyAirportIndex(index: AirportIndex): boolean {
  return index.byIdentity.size === 0 && index.iataAlias.size === 0 && index.byLocalCode.size === 0 && index.overlay.size === 0;
}

/** Unicode White_Space at both ends (JS `trim()` would also strip U+FEFF, which the other platforms keep). */
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Trim Unicode White_Space, uppercase, blank means null. */
export function normalize(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const t = code.replace(EDGE_WHITE_SPACE, "").toUpperCase();
  return t === "" ? null : t;
}

interface Preferable {
  id: string;
  version?: number | null;
  updatedAt?: string | null;
}

/** Row order: version (null = -1) desc, updated_at desc, id desc. `updatedAt` is compared as a fixed-width ISO string. */
function prefers(a: Preferable, b: Preferable): boolean {
  const av = a.version ?? -1;
  const bv = b.version ?? -1;
  if (av !== bv) return av > bv;
  const au = a.updatedAt ?? "";
  const bu = b.updatedAt ?? "";
  if (au !== bu) return au > bu;
  return a.id.toUpperCase() > b.id.toUpperCase();
}

function setPreferred<T extends Preferable>(map: Map<string, T>, key: string, row: T): void {
  const current = map.get(key);
  if (current === undefined || prefers(row, current)) map.set(key, row);
}

/** Builds the index. Rows with `isDeleted` contribute nothing. */
export function buildAirportIndex(catalog: readonly CatalogRow[], userPlaces: readonly UserPlace[] = []): AirportIndex {
  const live = catalog.filter((r) => !r.isDeleted);

  // Pass A: icao-ful rows.
  const byIdentity = new Map<string, CatalogRow>();
  const aliasRow = new Map<string, CatalogRow>();
  const localA = new Map<string, CatalogRow>();
  for (const row of live) {
    const icao = normalize(row.icao);
    if (icao === null) continue;
    setPreferred(byIdentity, icao, row);
    const iata = normalize(row.iata);
    if (iata !== null) setPreferred(aliasRow, iata, row);
    const local = normalize(row.localCode);
    if (local !== null) setPreferred(localA, local, row);
  }
  const iataAlias = new Map<string, string>();
  for (const [iata, row] of aliasRow) iataAlias.set(iata, normalize(row.icao)!);

  // Pass B: iata-only rows. An icao-ful row wins a contested IATA regardless of version.
  const iataOnly = new Map<string, CatalogRow>();
  const localB = new Map<string, CatalogRow>();
  for (const row of live) {
    if (normalize(row.icao) !== null) continue;
    const iata = normalize(row.iata);
    if (iata === null) continue;
    if (iataAlias.has(iata)) continue;
    if (byIdentity.has(iata)) continue; // an icao-ful row already owns this exact string
    setPreferred(iataOnly, iata, row);
    const local = normalize(row.localCode);
    if (local !== null) setPreferred(localB, local, row);
  }
  for (const [iata, row] of iataOnly) byIdentity.set(iata, row);

  // Pass B2: neither icao nor iata, local code only.
  const localB2 = new Map<string, CatalogRow>();
  for (const row of live) {
    if (normalize(row.icao) !== null || normalize(row.iata) !== null) continue;
    const local = normalize(row.localCode);
    if (local !== null) setPreferred(localB2, local, row);
  }

  // B2 overrides B overrides A on a local-code key.
  const byLocalCode = new Map<string, CatalogRow>(localA);
  for (const [k, v] of localB) byLocalCode.set(k, v);
  for (const [k, v] of localB2) byLocalCode.set(k, v);

  const overlay = new Map<string, UserPlace>();
  for (const place of userPlaces) {
    if (place.isDeleted) continue;
    for (const slot of [normalize(place.code), normalize(place.icao), normalize(place.iata)]) {
      if (slot !== null) setPreferred(overlay, slot, place);
    }
  }

  return { byIdentity, iataAlias, byLocalCode, overlay };
}

function identityOfCatalog(row: CatalogRow): string | null {
  return normalize(row.icao) ?? normalize(row.iata) ?? normalize(row.localCode);
}

function identityOfPlace(place: UserPlace): string | null {
  return normalize(place.icao) ?? normalize(place.iata) ?? normalize(place.code);
}

function catalogIdentity(index: AirportIndex, u: string): string | null {
  if (index.byIdentity.has(u)) return u;
  const alias = index.iataAlias.get(u);
  if (alias !== undefined) return alias;
  const local = index.byLocalCode.get(u);
  if (local !== undefined) return identityOfCatalog(local);
  return null;
}

/** `canonical`: the identity string for a code, or null for blank. An unknown code is its own identity. */
export function canonical(index: AirportIndex, code: string | null | undefined): string | null {
  const u = normalize(code);
  if (u === null) return null;
  const place = index.overlay.get(u);
  if (place !== undefined) return identityOfPlace(place) ?? u;
  return catalogIdentity(index, u) ?? u;
}

function catalogRowFor(index: AirportIndex, s: string): CatalogRow | null {
  const direct = index.byIdentity.get(s);
  if (direct !== undefined) return direct;
  const alias = index.iataAlias.get(s);
  if (alias !== undefined) {
    const viaAlias = index.byIdentity.get(alias);
    if (viaAlias !== undefined) return viaAlias;
  }
  return index.byLocalCode.get(s) ?? null;
}

function hasBoth(lat: number | null | undefined, lon: number | null | undefined): boolean {
  return lat !== null && lat !== undefined && lon !== null && lon !== undefined;
}

function fromCatalog(identity: string, row: CatalogRow): ResolvedAirport {
  const hasPosition = hasBoth(row.lat, row.lon);
  return {
    identity,
    lat: hasPosition ? row.lat! : null,
    lon: hasPosition ? row.lon! : null,
    hasPosition,
    timezone: row.timezone ?? null,
    name: row.name ?? "",
    countryCode: row.countryCode ?? null,
    isIataOnly: normalize(row.icao) === null && normalize(row.iata) !== null
  };
}

function mergedAirport(identity: string, place: UserPlace, catalog: CatalogRow | null): ResolvedAirport {
  // Never inherit from a half-filled catalog row.
  const catalogHasPosition = catalog !== null && hasBoth(catalog.lat, catalog.lon);
  const lat = place.lat ?? (catalogHasPosition ? catalog!.lat! : null);
  const lon = place.lon ?? (catalogHasPosition ? catalog!.lon! : null);
  const hasPosition = lat !== null && lon !== null;
  const userName = place.name === null || place.name === undefined ? "" : place.name.replace(EDGE_WHITE_SPACE, "");
  return {
    identity,
    lat: hasPosition ? lat : null,
    lon: hasPosition ? lon : null,
    hasPosition,
    timezone: place.timezone ?? catalog?.timezone ?? null,
    name: userName !== "" ? userName : (catalog?.name ?? ""),
    countryCode: place.countryCode ?? catalog?.countryCode ?? null,
    isIataOnly: false
  };
}

/** `resolve`: `getAirport(canonical(code))`. Null for blank, unknown or unresolvable codes. */
export function resolve(index: AirportIndex, code: string | null | undefined): ResolvedAirport | null {
  const id = canonical(index, code);
  if (id === null) return null;
  const place = index.overlay.get(id);
  if (place !== undefined) return mergedAirport(id, place, catalogRowFor(index, id));
  const row = index.byIdentity.get(id) ?? index.byLocalCode.get(id);
  return row !== undefined ? fromCatalog(id, row) : null;
}

/**
 * Every normalized string `s` with `canonical(s) === canonical(code)`, drawn from the
 * typed code, its identity, the overlay keys of the owning places and the code slots of the
 * catalog row the identity resolves to. A contested IATA belongs to its winner only.
 */
export function equivalentCodes(index: AirportIndex, code: string | null | undefined): string[] {
  const id = canonical(index, code);
  if (id === null) return [];
  const candidates = new Set<string>();
  candidates.add(id);
  const typed = normalize(code);
  if (typed !== null) candidates.add(typed);
  for (const [key, place] of index.overlay) {
    if (identityOfPlace(place) === id) candidates.add(key);
  }
  const row = index.byIdentity.get(id) ?? index.byLocalCode.get(id);
  if (row !== undefined) {
    for (const slot of [normalize(row.icao), normalize(row.iata), normalize(row.localCode)]) {
      if (slot !== null) candidates.add(slot);
    }
  }
  return [...candidates].filter((s) => canonical(index, s) === id).sort();
}
