import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import { buildAirportIndex, setActiveAirportIndex, type CatalogRow } from "../../src/airports/index.js";
import { NO_AIRPORT_DATA_NOTE, computeFileEntryTimes, computeFileTotals, computeProfileTotals } from "../../src/times/fromFile.js";
import { TestServer, jsonHandler, type Handler } from "../helpers/test-server.js";

const genericCsv = readFileSync(new URL("../fixtures/generic.csv", import.meta.url), "utf-8");

describe("computeFileEntryTimes", () => {
  it("falls back to the payload adapter for plain csv (no ImportResult)", async () => {
    // The generic CSV fixture has no SELF-role person assigned (no --self-role
    // equivalent passed here), so every row is skipped, this still exercises
    // the fallback path (payloadEntryToCalcEntry) without throwing.
    const result = await computeFileEntryTimes("csv", genericCsv);
    expect(result.calculated).toHaveLength(0);
    expect(result.skippedNoSelfPersonCount).toBe(3);
  });

  it("uses the richer ImportedEntry adapter for a ported-importer format (deeplink-json)", async () => {
    const content = JSON.stringify({
      entries: [
        {
          date: "2026-01-01",
          type: "flight",
          from: "EHAM",
          to: "EGLL",
          flight_number: "KL123",
          off_blocks: "10:00",
          on_blocks: "11:30",
          people: [{ ref_id: "SELF", role: "PIC" }]
        }
      ]
    });

    const result = await computeFileEntryTimes("deeplink-json", content);
    expect(result.calculated).toHaveLength(1);
    expect(result.skippedNoSelfPersonCount).toBe(0);
    expect(result.calculated[0]!.detailedTimes.pilotInCommandRole).toBe(90);
    expect(result.calculated[0]!.selfRole).toBe("pilotInCommand");
  });

  it("skips (and counts) entries with no SELF person via the rich path", async () => {
    const content = JSON.stringify({
      entries: [
        {
          date: "2026-01-01",
          type: "flight",
          from: "EHAM",
          to: "EGLL",
          flight_number: "KL123",
          off_blocks: "10:00",
          on_blocks: "11:30",
          people: [{ ref_id: "other-person", role: "PIC" }]
        }
      ]
    });

    const result = await computeFileEntryTimes("deeplink-json", content);
    expect(result.calculated).toHaveLength(0);
    expect(result.skippedNoSelfPersonCount).toBe(1);
  });
});

describe("computeFileTotals", () => {
  it("includes atplCaps alongside the existing totals shape", async () => {
    const content = JSON.stringify({
      entries: [
        {
          date: "2026-01-01",
          type: "flight",
          from: "EHAM",
          to: "EGLL",
          flight_number: "KL123",
          off_blocks: "10:00",
          on_blocks: "11:30",
          people: [{ ref_id: "SELF", role: "PIC" }]
        }
      ]
    });

    const { atplCaps, entryTimesResult, ...totals } = await computeFileTotals("deeplink-json", content);
    expect(totals.totalPicMinutes).toBe(90);
    expect(atplCaps).toBeDefined();
    expect(atplCaps.crcpCreditedHours).toBe(0);
    expect(entryTimesResult.calculated).toHaveLength(1);
  });
});

/** A deeplink-json file with one night-heavy flight (departs 15:30Z in December) between the given codes. */
function nightFlightFile(from: string, to: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entries: [
      {
        date: "2024-12-15",
        type: "flight",
        from,
        to,
        flight_number: "KL123",
        off_blocks: "15:30",
        on_blocks: "17:00",
        people: [{ ref_id: "SELF", role: "PIC" }],
        ...over
      }
    ]
  });
}

const row = (id: string, icao: string, iata: string, lat: number, lon: number): CatalogRow => ({
  id, icao, iata, localCode: null, lat, lon, timezone: null, name: null, countryCode: null, version: 1, updatedAt: null, isDeleted: false
});
const testIndex = () =>
  buildAirportIndex([
    row("a", "EHAM", "AMS", 52.3086, 4.7639),
    row("b", "EGLL", "LHR", 51.4706, -0.4619),
    row("c", "EGKK", "LGW", 51.1481, -0.1903)
  ]);

describe("airport resolution in the file path (installed index)", () => {
  beforeEach(() => setActiveAirportIndex(testIndex()));
  afterEach(() => setActiveAirportIndex(undefined));

  it("computes the same night time for IATA, lowercase and ICAO codes", async () => {
    const icao = await computeFileEntryTimes("deeplink-json", nightFlightFile("EHAM", "EGLL"));
    expect(icao.calculated[0]!.night).toBeGreaterThan(0);
    for (const [from, to] of [["AMS", "LHR"], [" ams ", "lhr"], ["eham", "egll"]] as const) {
      const result = await computeFileEntryTimes("deeplink-json", nightFlightFile(from, to));
      expect(result.calculated[0]!.night).toBe(icao.calculated[0]!.night);
    }
  });

  it("gives an unknown airport no night time", async () => {
    const result = await computeFileEntryTimes("deeplink-json", nightFlightFile("ZZZZ", "EGLL"));
    expect(result.calculated[0]!.night).toBeUndefined();
  });

  it("carries the derived date and the derived route onto each entry", async () => {
    // A file has no system layer: the derived date is the planned date, and a diversion
    // (actual_to) is the derived destination, resolved to its identity.
    const content = nightFlightFile("EHAM", "EGLL", { actual_to: "LGW" });
    const result = await computeFileEntryTimes("deeplink-json", content);
    expect(result.calculated[0]!.date).toBe("2024-12-15");
    expect(result.calculated[0]!.fromIcao).toBe("EHAM");
    expect(result.calculated[0]!.toIcao).toBe("EGKK");
  });

  it("emits no airport-data note when an index is installed", async () => {
    const result = await computeFileEntryTimes("deeplink-json", nightFlightFile("EHAM", "EGLL"));
    expect(result.notes).toEqual([]);
  });

  it("filters totals by date, both ends inclusive", async () => {
    const content = nightFlightFile("EHAM", "EGLL", { date: "2024-12-31" });
    const inYear = await computeFileTotals("deeplink-json", content, undefined, { period: { from: "2024-01-01", to: "2024-12-31" } });
    expect(inYear.entryCount).toBe(1);
    const nextYear = await computeFileTotals("deeplink-json", content, undefined, { period: { from: "2025-01-01", to: "2025-12-31" } });
    expect(nextYear.entryCount).toBe(0);
  });
});

describe("file totals without airport data", () => {
  afterEach(() => setActiveAirportIndex(undefined));

  it("passes codes through and emits the note once when entries have a from/to code", async () => {
    const totals = await computeFileTotals("deeplink-json", nightFlightFile("AMS", "LHR"));
    expect(totals.entryTimesResult.notes).toEqual([NO_AIRPORT_DATA_NOTE]);
    expect(totals.entryTimesResult.calculated[0]!.fromIcao).toBe("AMS");
    expect(totals.entryTimesResult.calculated[0]!.night).toBeUndefined();
  });

  it("emits no note when no entry has a from/to code", async () => {
    const result = await computeFileEntryTimes("deeplink-json", nightFlightFile("", ""));
    expect(result.notes).toEqual([]);
  });
});

/** A deeplink-json file with several flights, one per (from, to, date) tuple. */
function multiFile(rows: [string, string, string][]): string {
  return JSON.stringify({
    entries: rows.map(([from, to, date]) => ({
      date,
      type: "flight",
      from,
      to,
      flight_number: "KL123",
      off_blocks: "15:30",
      on_blocks: "17:00",
      people: [{ ref_id: "SELF", role: "PIC" }]
    }))
  });
}

describe("unresolved airports", () => {
  afterEach(() => setActiveAirportIndex(undefined));

  it("counts every entry with codes under an empty index and emits only the no-data note", async () => {
    const totals = await computeFileTotals("deeplink-json", multiFile([["EHAM", "EGLL", "2024-12-15"], ["EHAM", "ZZZZ", "2024-12-16"]]));
    expect(totals.unresolvedAirports.entryCount).toBe(2);
    expect(totals.entryTimesResult.notes).toEqual([NO_AIRPORT_DATA_NOTE]);
  });

  it("flags only the entry with an unknown code and still computes night for the rest", async () => {
    setActiveAirportIndex(testIndex());
    const totals = await computeFileTotals("deeplink-json", multiFile([["EHAM", "EGLL", "2024-12-15"], ["EHAM", "zzzz", "2024-12-16"]]));
    expect(totals.unresolvedAirports).toEqual({ entryCount: 1, codes: ["ZZZZ"] });
    expect(totals.totalNightMinutes).toBeGreaterThan(0);
    const [ok, bad] = totals.entryTimesResult.calculated;
    expect(ok!.unresolvedAirports).toBeUndefined();
    expect(ok!.night).toBeGreaterThan(0);
    expect(bad!.unresolvedAirports).toEqual(["ZZZZ"]);
    expect(totals.entryTimesResult.notes).toEqual([
      "note: 1 of 2 entries uses an airport that is not in your Jetlog airport catalog (ZZZZ), so night time and distance-based figures are not computed for them."
    ]);
  });

  it("reports nothing when everything resolves", async () => {
    setActiveAirportIndex(testIndex());
    const totals = await computeFileTotals("deeplink-json", multiFile([["EHAM", "EGLL", "2024-12-15"]]));
    expect(totals.unresolvedAirports).toEqual({ entryCount: 0, codes: [] });
    expect(totals.entryTimesResult.notes).toEqual([]);
  });

  it("does not count an unresolved entry outside the period", async () => {
    setActiveAirportIndex(testIndex());
    const content = multiFile([["EHAM", "EGLL", "2024-12-15"], ["EHAM", "ZZZZ", "2023-01-05"]]);
    const totals = await computeFileTotals("deeplink-json", content, undefined, { period: { from: "2024-01-01", to: "2024-12-31" } });
    expect(totals.unresolvedAirports).toEqual({ entryCount: 0, codes: [] });
    expect(totals.entryTimesResult.notes).toEqual([]);
  });

  it("uses plural grammar and truncates the code list after 8", async () => {
    setActiveAirportIndex(testIndex());
    const rows: [string, string, string][] = Array.from({ length: 10 }, (_, i) => ["EHAM", `ZZ${String.fromCharCode(65 + i)}${i}`, "2024-12-15"]);
    const totals = await computeFileTotals("deeplink-json", multiFile(rows));
    expect(totals.unresolvedAirports.entryCount).toBe(10);
    expect(totals.entryTimesResult.notes[0]).toContain("10 of 10 entries use an airport");
    expect(totals.entryTimesResult.notes[0]).toContain("and 2 more)");
  });
});

describe("computeProfileTotals with the logged-in airport catalog", () => {
  let dir: string;
  let server: TestServer | undefined;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-profile-totals-"));
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await server?.stop();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const apiEntry = (id: string, from: string, to: string, date = "2024-12-15") => ({
    id,
    type: "flight",
    date,
    people: [{ person_id: "self-1", role: "PIC" }],
    derived: { date, from, to, off_blocks: "15:30", on_blocks: "17:00" }
  });

  async function client(entries: unknown[], places: unknown[] = [], catalogOk = true): Promise<ApiClient> {
    const routes: Record<string, () => { status: number; body: unknown }> = {
      "/api/cli/v1/me": () => ({ status: 200, body: { user_id: 1, self_person_id: "self-1" } }),
      "/api/cli/v1/entries": () => ({ status: 200, body: { entries, pagination: { limit: 200, has_more: false, next_cursor: null } } }),
      "/api/cli/v1/aircraft": () => ({ status: 200, body: { aircraft: [] } }),
      "/api/system_aircraft_types": () => ({ status: 200, body: { system_aircraft_types: [], sync_cursor: 0 } }),
      "/api/system_places": () =>
        catalogOk
          ? {
              status: 200,
              body: {
                system_places: [
                  { id: "c1", version: 1, icao: "EHAM", iata: "AMS", latitude: 52.3086, longitude: 4.7639, timezone: "Europe/Amsterdam", is_deleted: false },
                  { id: "c2", version: 2, icao: "EGLL", iata: "LHR", latitude: 51.47, longitude: -0.4543, timezone: "Europe/London", is_deleted: false }
                ]
              }
            }
          : { status: 500, body: { error: "boom" } },
      "/api/places": () => ({ status: 200, body: { places } })
    };
    const handler: Handler = (req, res) => {
      const route = routes[req.path.split("?")[0]!] ?? (() => ({ status: 404, body: {} }));
      const { status, body } = route();
      jsonHandler(status, body)(req, res);
    };
    server = new TestServer(Array.from({ length: 30 }, () => handler));
    await server.start();
    return new ApiClient({ baseUrl: server.baseUrl, token: "jlp_test", maxRetries: 0 } as ConstructorParameters<typeof ApiClient>[0]);
  }

  it("resolves IATA, user-place and lowercase derived codes so night time is computed", async () => {
    const c = await client(
      [apiEntry("e1", "EHAM", "EGLL"), apiEntry("e2", "AMS", "LHR"), apiEntry("e3", "MYF", " lhr "), apiEntry("e4", "ZZZZ", "EGLL")],
      [{ id: "p1", version: 1, code: "MYF", iata: "AMS", is_deleted: false }]
    );
    const totals = await computeProfileTotals(c, { profile: "default" });
    // Three entries resolve to the same airports and share one night figure; the unknown one has none.
    const one = (await computeProfileTotals(await client([apiEntry("e1", "EHAM", "EGLL")]), { profile: "default" })).totalNightMinutes;
    expect(one).toBeGreaterThan(0);
    expect(totals.totalNightMinutes).toBe(one * 3);
    expect(totals.entryCount).toBe(4);
  });

  it("continues without airports when the catalog cannot be loaded, and with offline", async () => {
    const warn: string[] = [];
    const original = console.error;
    console.error = (m: unknown) => void warn.push(String(m));
    try {
      const failing = await computeProfileTotals(await client([apiEntry("e1", "AMS", "LHR")], [], false), { profile: "x" });
      expect(failing.totalNightMinutes).toBe(0);
      expect(failing.notes).toEqual([NO_AIRPORT_DATA_NOTE]);
      expect(warn.some((m) => m.includes("continuing without airport data"))).toBe(true);

      const offline = await computeProfileTotals(await client([apiEntry("e1", "AMS", "LHR")]), { profile: "x", offline: true });
      expect(offline.totalNightMinutes).toBe(0);
      expect(offline.notes).toEqual([NO_AIRPORT_DATA_NOTE]);
      expect(server!.requests.some((r) => r.path.startsWith("/api/system_places"))).toBe(false);
    } finally {
      console.error = original;
    }
  });

  it("logs an FSTD entry with no self person row as a trainee session (not skipped)", async () => {
    const fstd = { id: "s1", type: "fstd", date: "2024-12-15", people: [], start_time: "09:00", end_time: "11:00", derived: { date: "2024-12-15" } };
    const flightNoSelf = { ...apiEntry("e9", "EHAM", "EGLL"), people: [] };
    const totals = await computeProfileTotals(await client([fstd, flightNoSelf]), { profile: "default" });
    expect(totals.totalFstdSessionMinutes).toBe(120);
    expect(totals.totalFSTDTraineeSessions).toBe(1);
    expect(totals.skippedNoSelfPersonCount).toBe(1); // only the flight
  });

  it("filters by the derived date from the server", async () => {
    const c = await client([apiEntry("e1", "EHAM", "EGLL", "2024-12-31"), apiEntry("e2", "EHAM", "EGLL", "2025-01-01")]);
    const totals = await computeProfileTotals(c, { period: { from: "2025-01-01", to: "2025-12-31" } });
    expect(totals.entryCount).toBe(1);
  });
});
