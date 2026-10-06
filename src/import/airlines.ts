/**
 * Airline ICAO<->IATA prefix catalog, fetched from
 * `GET /api/cli/v1/airlines` (read scope) when logged in, and used by
 * `normalizeFlightNumber` (`match.ts`) the way the Jetlog iOS app normalizes
 * flight numbers. The algorithm is a field-for-field port: a 2-letter IATA prefix is tried first, then a
 * 3-letter ICAO prefix, each only when what follows actually looks like a
 * flight-number suffix (optional single space, digits, optional one
 * trailing letter), so "KLM1017" normalizes to "KL1017" but "KL" alone, or
 * "KLX" (not a real suffix shape), is returned unchanged.
 *
 * Long-cached under `~/.cache/jetlog/airlines-cache.json`
 * (`$XDG_CACHE_HOME/jetlog/...` when set, same convention as
 * `commands/import.ts`'s `last-import-batch-*.json`), revalidated with
 * `If-None-Match`/`ETag` rather than refetched every run (the route is
 * read-scope, ETag'd and long-cache; the catalog changes rarely). A cache read/write failure (first run, no `~/.cache`,
 * read-only filesystem) is non-fatal: this degrades to an uncached fetch,
 * never to a crash.
 *
 * Offline (no login, or the fetch fails outright): `fetchAirlineCatalog`
 * returns `undefined` and `normalizeFlightNumber` falls back to today's
 * behavior (trim + uppercase only, no airline-prefix rewrite).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiClient, AirlineRow } from "../api/client.js";

export interface AirlineCatalog {
  byIata: Map<string, AirlineRow>;
  byIcao: Map<string, AirlineRow>;
}

interface AirlinesCacheFile {
  etag?: string;
  airlines: AirlineRow[];
}

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "jetlog", "airlines-cache.json");
}

async function readCache(): Promise<AirlinesCacheFile | undefined> {
  try {
    const raw = await readFile(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as AirlinesCacheFile;
    if (!Array.isArray(parsed.airlines)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCache(cache: AirlinesCacheFile): Promise<void> {
  try {
    await mkdir(join(cachePath(), ".."), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(cache), "utf-8");
  } catch {
    // Non-fatal, see file doc comment.
  }
}

function buildCatalog(airlines: AirlineRow[]): AirlineCatalog {
  const byIata = new Map<string, AirlineRow>();
  const byIcao = new Map<string, AirlineRow>();
  for (const airline of airlines) {
    const iata = airline.iata?.toUpperCase();
    const icao = airline.icao?.toUpperCase();
    if (iata) byIata.set(iata, airline);
    if (icao) byIcao.set(icao, airline);
  }
  return { byIata, byIcao };
}

/**
 * Fetches (or reuses the cached copy of) the airline catalog. Returns
 * `undefined` on any failure (not logged in, network error, server
 * error), callers treat that exactly like "no catalog available",
 * never as a fatal error for the surrounding command.
 */
export async function fetchAirlineCatalog(client: ApiClient): Promise<AirlineCatalog | undefined> {
  const cached = await readCache();

  try {
    const result = await client.getWithETag<{ airlines: AirlineRow[] }>("/api/cli/v1/airlines", cached?.etag);

    if (result.status === 304 && cached) {
      return buildCatalog(cached.airlines);
    }

    if (result.status === 200) {
      await writeCache({ etag: result.etag, airlines: result.body.airlines });
      return buildCatalog(result.body.airlines);
    }

    // 304 with no cached body to revalidate against (cache cleared between
    // sending the ETag and reading it back, or a stale/foreign ETag),
    // treat as a miss rather than returning an empty catalog.
    return cached ? buildCatalog(cached.airlines) : undefined;
  } catch {
    // Network/5xx/auth failure, fall back to whatever's cached, else give up.
    return cached ? buildCatalog(cached.airlines) : undefined;
  }
}

/** True when `suffix` looks like a flight-number tail: an optional single
 * leading space already stripped by the caller, then digits with at most
 * one trailing letter. Ported from `looksLikeFlightNumberSuffix`. */
function looksLikeFlightNumberSuffix(suffix: string): boolean {
  if (suffix.length === 0 || !/^[0-9]/.test(suffix)) return false;
  const digits = /[A-Za-z]$/.test(suffix) ? suffix.slice(0, -1) : suffix;
  return digits.length > 0 && /^[0-9]+$/.test(digits);
}

function dropOptionalLeadingSpace(s: string): string {
  return s.startsWith(" ") ? s.slice(1) : s;
}

/**
 * Ported from `AirlineCodeService.matchAirlinePrefix`: a 2-letter IATA
 * prefix is tried first (requires at least 3 input characters total), then
 * a 3-letter ICAO prefix (requires at least 4), each only when the
 * remainder looks like a flight-number suffix. `trimmed` must already be
 * trimmed + uppercased.
 */
function matchAirlinePrefix(trimmed: string, catalog: AirlineCatalog): { airline: AirlineRow; rest: string } | undefined {
  if (trimmed.length >= 3) {
    const candidate = trimmed.slice(0, 2);
    const rest = dropOptionalLeadingSpace(trimmed.slice(2));
    if (looksLikeFlightNumberSuffix(rest)) {
      const airline = catalog.byIata.get(candidate);
      if (airline) return { airline, rest };
    }
  }

  if (trimmed.length >= 4) {
    const candidate = trimmed.slice(0, 3);
    const rest = dropOptionalLeadingSpace(trimmed.slice(3));
    if (looksLikeFlightNumberSuffix(rest)) {
      const airline = catalog.byIcao.get(candidate);
      if (airline) return { airline, rest };
    }
  }

  return undefined;
}

/**
 * Port of the iOS app's flight-number normalization: rewrites a
 * recognized ICAO-style (or already-IATA-style) prefix to its canonical
 * IATA form, e.g. "KLM1017" -> "KL1017". An unrecognized prefix is returned
 * **unchanged** (not even trimmed/uppercased), exactly like the app,
 * so a flight number this catalog can't explain is never mangled.
 */
export function normalizeWithAirlineCatalog(flightNumber: string, catalog: AirlineCatalog): string {
  const trimmed = flightNumber.trim().toUpperCase();
  const match = matchAirlinePrefix(trimmed, catalog);
  if (!match) return flightNumber;
  return match.airline.iata.toUpperCase() + match.rest;
}
