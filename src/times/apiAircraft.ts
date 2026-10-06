/**
 * Aircraft SE/ME/MP classification for the logged-in API path. Composes two
 * endpoints: `/api/cli/v1/aircraft` (registration -> ICAO type code) and
 * `/api/system_aircraft_types` (ICAO type code -> engine count / EASA
 * certification) into a single lookup function shaped like
 * `CalcContext.lookupAircraftType`.
 *
 * `/api/system_aircraft_types` is outside the `/api/cli/v1/*` scope but
 * still reachable by this CLI's PAT bearer token (the server
 * gates tokens by exact method and path regardless of router scope, and no
 * `x-client-version` header is required since this CLI never sends one).
 */
import type { ApiClient } from "../api/client.js";
import type { AircraftTypeInfo } from "./types.js";

interface ApiAircraft {
  id: string | number;
  use_system?: boolean;
  aircraft_icao_code?: string | null;
  system_aircraft_icao_code?: string | null;
}

interface ApiSystemAircraftType {
  icao_code: string;
  engine_count: number | null;
  easa_certification: string;
  is_deleted?: boolean;
}

function normalizeCertification(raw: string): AircraftTypeInfo["easaCertification"] {
  return raw === "SP" || raw === "HPA" || raw === "MP" ? raw : "unknown";
}

/**
 * Builds the two lookups the calculator needs: by registration (non-bulk entries: the user's aircraft row, then its
 * `useSystem ? systemIcao : icao`, no fallback, exactly like the backend and iOS) and by ICAO type code (bulk
 * entries). Keeping them apart matters: an imported registration like "MD11" or "NXT" has an aircraft row without
 * an ICAO code and must NOT be read as a type code.
 *
 * Resolves each key to its `AircraftTypeInfo`. Fetches both endpoints once (in parallel). If either
 * fetch fails (e.g. an older server without `/api/system_aircraft_types`
 * PAT access, or empty data), logs a warning to stderr and returns a lookup
 * that always returns `undefined` rather than failing the whole command.
 */
export interface ApiAircraftLookups {
  /** Non-bulk: registration -> the user's aircraft row -> ICAO type -> info. */
  lookupAircraftType: (registration: string) => AircraftTypeInfo | undefined;
  /** Bulk: ICAO type code -> info. */
  lookupAircraftTypeByIcao: (icao: string) => AircraftTypeInfo | undefined;
}

export async function buildApiAircraftLookup(client: ApiClient): Promise<ApiAircraftLookups> {
  try {
    const [aircraftResponse, typesResponse] = await Promise.all([
      client.get<{ aircraft: ApiAircraft[] }>("/api/cli/v1/aircraft"),
      client.get<{ system_aircraft_types: ApiSystemAircraftType[]; sync_cursor: number | null }>("/api/system_aircraft_types")
    ]);

    const typesByIcao = new Map<string, AircraftTypeInfo>();
    for (const t of typesResponse.system_aircraft_types) {
      if (t.is_deleted) continue;
      typesByIcao.set(t.icao_code, {
        easaCertification: normalizeCertification(t.easa_certification),
        engineCount: t.engine_count ?? undefined
      });
    }

    const icaoByRegistration = new Map<string, string | undefined>();
    for (const a of aircraftResponse.aircraft) {
      // Mirrors iOS's `Aircraft.derivedAircraftIcaoCode` exactly
      // (`useSystem ? systemAircraftIcaoCode : aircraftIcaoCode`).
      const icaoCode = a.use_system ? a.system_aircraft_icao_code : a.aircraft_icao_code;
      icaoByRegistration.set(String(a.id), icaoCode || undefined);
    }

    return {
      lookupAircraftType: (registration) => {
        const icaoCode = icaoByRegistration.get(registration);
        return icaoCode === undefined ? undefined : typesByIcao.get(icaoCode);
      },
      lookupAircraftTypeByIcao: (icao) => typesByIcao.get(icao)
    };
  } catch (err) {
    console.error(
      `warning: could not load aircraft type data for SE/ME/MP classification (${(err as Error).message}); classification will be empty`
    );
    return { lookupAircraftType: () => undefined, lookupAircraftTypeByIcao: () => undefined };
  }
}
