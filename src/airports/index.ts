/**
 * Process-wide airport resolver: the one code-to-airport path of the CLI,
 * mirroring the Jetlog iOS app's static airport code service.
 *
 * The package ships no airport data. The active index starts empty: codes pass
 * through as written and nothing resolves to a position. A command that has a
 * logged-in client calls `useLoggedInAirports` to swap in the server catalog plus
 * the user's places; `--offline` (or no login) keeps the empty index.
 */
import { ApiClient, DEFAULT_BASE_URL } from "../api/client.js";
import { resolveBaseUrl, resolveToken } from "../auth/credentials.js";
import { buildAirportIndex, canonical, equivalentCodes, resolve, type AirportIndex, type ResolvedAirport } from "./resolver.js";
import { fetchSystemCatalog, fetchUserPlaces } from "./sources.js";

export * from "./resolver.js";

let active: AirportIndex | undefined;
let emptyIndex: AirportIndex | undefined;

/** The offline index: no airports at all. */
export function getEmptyAirportIndex(): AirportIndex {
  if (!emptyIndex) emptyIndex = buildAirportIndex([]);
  return emptyIndex;
}

/** The index everything resolves against: logged-in data when installed, else the empty index. */
export function getActiveAirportIndex(): AirportIndex {
  if (!active) active = getEmptyAirportIndex();
  return active;
}

/** Installs `index` (or, with `undefined`, goes back to the empty index). */
export function setActiveAirportIndex(index: AirportIndex | undefined): void {
  active = index;
}

/** `canonical` against the active index. Blank is `undefined`; an unknown code is its own identity. */
export function canonicalCode(code: string | null | undefined): string | undefined {
  return canonical(getActiveAirportIndex(), code) ?? undefined;
}

/** `resolve` against the active index. */
export function resolveAirport(code: string | null | undefined): ResolvedAirport | undefined {
  return resolve(getActiveAirportIndex(), code) ?? undefined;
}

/** `equivalentCodes` against the active index. */
export function equivalentAirportCodes(code: string | null | undefined): string[] {
  return equivalentCodes(getActiveAirportIndex(), code);
}

/** Builds the logged-in index: server catalog (disk-cached, delta refreshed) + the user's places. */
export async function loadLoggedInAirportIndex(client: ApiClient, profile: string, baseUrl: string): Promise<AirportIndex> {
  const catalog = await fetchSystemCatalog(client, profile, baseUrl);
  const places = await fetchUserPlaces(client);
  return buildAirportIndex(catalog, places);
}

/**
 * Installs the logged-in index as the active one. Never throws: a failed fetch
 * (old server, network) warns on stderr and leaves the empty index active.
 * Returns whether the logged-in index is now active.
 */
export async function useLoggedInAirports(client: ApiClient, profile: string): Promise<boolean> {
  try {
    setActiveAirportIndex(await loadLoggedInAirportIndex(client, profile, client.baseUrl));
    return true;
  } catch (err) {
    console.error(`warning: could not load the airport catalog from Jetlog (${(err as Error).message}); continuing without airport data`);
    return false;
  }
}

/**
 * `useLoggedInAirports` for a command that has a profile but no client yet: does nothing (the empty
 * index stays active) with `offline`, or when the profile has no token. Returns whether the
 * logged-in index was installed.
 */
export async function useLoggedInAirportsIfAvailable(opts: { profile: string; baseUrl?: string; offline?: boolean }): Promise<boolean> {
  if (opts.offline) return false;
  const token = await resolveToken(opts.profile);
  if (!token) return false;
  const baseUrl = opts.baseUrl ?? (await resolveBaseUrl(opts.profile)) ?? DEFAULT_BASE_URL;
  return useLoggedInAirports(new ApiClient({ baseUrl, token }), opts.profile);
}
