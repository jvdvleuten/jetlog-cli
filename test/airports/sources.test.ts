import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../../src/api/client.js";
import {
  buildAirportIndex,
  canonicalCode,
  loadLoggedInAirportIndex,
  resolve,
  resolveAirport,
  setActiveAirportIndex,
  getEmptyAirportIndex,
  isEmptyAirportIndex,
  canonical
} from "../../src/airports/index.js";
import { catalogCachePath, fetchSystemCatalog } from "../../src/airports/sources.js";
import { TestServer, jsonHandler, type Handler } from "../helpers/test-server.js";

describe("empty offline index", () => {
  const index = getEmptyAirportIndex();

  it("resolves nothing: known, unknown and blank codes are all null", () => {
    for (const code of ["EHAM", "ams", "ZZZZ", "", "   ", undefined]) expect(resolve(index, code)).toBeNull();
  });

  it("gives every non-blank code its own identity", () => {
    expect(canonical(index, " ams ")).toBe("AMS");
    expect(canonical(index, "EHAM")).toBe("EHAM");
    expect(canonical(index, "  ")).toBeNull();
  });

  it("is reported as empty", () => {
    expect(isEmptyAirportIndex(index)).toBe(true);
    expect(isEmptyAirportIndex(buildAirportIndex([], [{ id: "p1", code: "QQ01", lat: 1, lon: 2 }]))).toBe(false);
  });
});

describe("active index", () => {
  afterEach(() => setActiveAirportIndex(undefined));

  it("defaults to the empty index: codes pass through, nothing resolves", () => {
    expect(canonicalCode("ams")).toBe("AMS");
    expect(canonicalCode("zzzz")).toBe("ZZZZ");
    expect(canonicalCode(" ")).toBeUndefined();
    expect(resolveAirport("AMS")).toBeUndefined();
  });

  it("can be swapped for another index and back", () => {
    setActiveAirportIndex(buildAirportIndex([], [{ id: "p1", code: "QQ01", iata: "AMS", lat: 1, lon: 2 }]));
    expect(canonicalCode("QQ01")).toBe("AMS");
    expect(resolveAirport("EHAM")).toBeUndefined();
    setActiveAirportIndex(undefined);
    expect(canonicalCode("QQ01")).toBe("QQ01");
  });
});

function systemPlace(version: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sp-${version}`,
    version,
    icao: `X${String(version).padStart(3, "0")}`,
    iata: null,
    local_code: null,
    name: `Place ${version}`,
    latitude: 1,
    longitude: 2,
    country_code: "NL",
    timezone: "Europe/Amsterdam",
    kind: "airport",
    is_deleted: false,
    updated_at: "2024-01-01T00:00:00.000000Z",
    ...over
  };
}

describe("logged-in sources", () => {
  let dir: string;
  let server: TestServer | undefined;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-airports-"));
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await server?.stop();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function startRouted(route: (path: string, query: URLSearchParams) => unknown): Promise<ApiClient> {
    const handler: Handler = (req, res) => {
      const url = new URL(req.path, "http://x");
      jsonHandler(200, route(url.pathname, url.searchParams))(req, res);
    };
    server = new TestServer(Array.from({ length: 40 }, () => handler));
    await server.start();
    return new ApiClient({ baseUrl: server.baseUrl, token: "jlp_test" });
  }

  it("pages the catalog by version and caches it per profile", async () => {
    const all = Array.from({ length: 1500 }, (_, i) => systemPlace(i + 1));
    const client = await startRouted((path, q) => {
      expect(path).toBe("/api/system_places");
      const after = Number(q.get("after_version"));
      return { system_places: all.filter((r) => (r.version as number) > after).slice(0, Number(q.get("limit"))), sync_cursor: 0 };
    });

    const rows = await fetchSystemCatalog(client, "default", client.baseUrl);
    expect(rows).toHaveLength(1500);
    expect(server!.requests.map((r) => r.path)).toEqual([
      "/api/system_places?after_version=0&limit=1000",
      "/api/system_places?after_version=1000&limit=1000"
    ]);

    const cache = JSON.parse(await readFile(catalogCachePath("default"), "utf8"));
    expect(cache.maxVersion).toBe(1500);
    expect(Object.keys(cache.rows)).toHaveLength(1500);
  });

  it("refreshes a cached catalog by delta, applying tombstones by id", async () => {
    let phase = 1;
    const client = await startRouted((path, q) => {
      if (phase === 1) return { system_places: [systemPlace(1), systemPlace(2)] };
      expect(q.get("after_version")).toBe("2");
      return { system_places: [systemPlace(3, { id: "sp-1", is_deleted: true }), systemPlace(4, { icao: "EHAM", iata: "AMS" })] };
    });

    expect(await fetchSystemCatalog(client, "default", client.baseUrl)).toHaveLength(2);
    phase = 2;
    const rows = await fetchSystemCatalog(client, "default", client.baseUrl);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === "sp-1")?.isDeleted).toBe(true);
    expect(server!.requests.map((r) => r.path)).toEqual([
      "/api/system_places?after_version=0&limit=1000",
      "/api/system_places?after_version=2&limit=1000"
    ]);

    const index = buildAirportIndex(rows);
    expect(resolve(index, "X001")).toBeNull(); // tombstoned by the delta
    expect(resolve(index, "ams")?.identity).toBe("EHAM");
  });

  it("ignores a cache written for another base URL or profile", async () => {
    const client = await startRouted(() => ({ system_places: [systemPlace(1)] }));
    await fetchSystemCatalog(client, "default", "https://elsewhere.example");
    await fetchSystemCatalog(client, "default", client.baseUrl);
    await fetchSystemCatalog(client, "other", client.baseUrl);
    expect(server!.requests.every((r) => r.path.includes("after_version=0"))).toBe(true);
    expect(server!.requests).toHaveLength(3);
  });

  it("builds the logged-in index from the catalog plus the user's places", async () => {
    const client = await startRouted((path) =>
      path === "/api/system_places"
        ? {
            system_places: [
              systemPlace(1, { icao: "EHAM", iata: "AMS", latitude: 52.3086, longitude: 4.7639 }),
              systemPlace(2, { icao: "EGLL", iata: "LHR", latitude: 51.47, longitude: -0.4543 })
            ]
          }
        : {
            places: [
              { id: "p1", version: 1, code: "MYF", iata: "AMS", icao: null, latitude: null, longitude: null, name: null, timezone: null, country_code: null, is_deleted: false },
              { id: "p2", version: 2, code: "GONE", icao: null, iata: null, latitude: 9, longitude: 9, is_deleted: true }
            ]
          }
    );

    const index = await loadLoggedInAirportIndex(client, "default", client.baseUrl);
    expect(resolve(index, "MYF")).toMatchObject({ identity: "AMS", lat: 52.3086, lon: 4.7639, hasPosition: true });
    expect(resolve(index, "lhr")?.identity).toBe("EGLL");
    expect(resolve(index, "GONE")).toBeNull();
    expect(server!.requests.map((r) => r.path)).toEqual(["/api/system_places?after_version=0&limit=1000", "/api/places?after_version=0&limit=1000"]);
  });

  it("stops paging when a full page does not advance the cursor", async () => {
    const client = await startRouted(() => ({ system_places: Array.from({ length: 1000 }, (_, i) => systemPlace(5, { id: `dup-${i}` })) }));
    const rows = await fetchSystemCatalog(client, "default", client.baseUrl);
    expect(rows).toHaveLength(1000);
    expect(server!.requests).toHaveLength(2);
  });
});
