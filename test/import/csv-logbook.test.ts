import { zipSync } from "fflate";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildAirportIndex, setActiveAirportIndex, type CatalogRow } from "../../src/airports/index.js";
import { csvLogbookImporter, parseJetlogCsvFiles, JETLOG_CSV_HEADERS } from "../../src/import/importers/csv-logbook.js";

/**
 * Behavior coverage for the Jetlog-own-CSV-export importer, including the
 * ZIP-archive support. All fixtures here are
 * hand-built inline, not copied from any real export.
 */

function csv(headers: readonly string[], rows: string[][]): string {
  return [headers, ...rows].map((r) => r.map((cell) => (cell.includes(",") ? `"${cell}"` : cell)).join(",")).join("\n");
}

const FLIGHTS_ROW = [
  "",
  "2024-05-01",
  "KL123",
  "PHBXA",
  "EHAM",
  "EGLL",
  "",
  "",
  "",
  "10:00",
  "10:10",
  "11:20",
  "11:30",
  "",
  "0",
  "0",
  "1",
  "0",
  "N",
  "Test flight",
  "Jane Doe",
  "PIC",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  ""
];

function flightsRow(overrides: Record<string, string>): string[] {
  const base: Record<string, string> = {};
  JETLOG_CSV_HEADERS.flights.forEach((h, i) => (base[h] = FLIGHTS_ROW[i] ?? ""));
  return JETLOG_CSV_HEADERS.flights.map((h) => overrides[h] ?? base[h] ?? "");
}

describe("jetlog-csv importer (loose CSV files)", () => {
  it("parses a Flights sheet", () => {
    const flightsCsv = csv(JETLOG_CSV_HEADERS.flights, [FLIGHTS_ROW]);
    const result = parseJetlogCsvFiles([flightsCsv]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.flightNumber).toBe("KL123");
    expect(result.entries[0]?.from).toBe("EHAM");
  });

  it("canonicalizes IATA, lowercase and padded From/To cells like the iOS Excel importer", () => {
    const catalogRow = (id: string, icao: string, iata: string): CatalogRow => ({
      id, icao, iata, localCode: null, lat: null, lon: null, timezone: null, name: null, countryCode: null, version: 1, updatedAt: null, isDeleted: false
    });
    setActiveAirportIndex(buildAirportIndex([catalogRow("a", "EHAM", "AMS"), catalogRow("b", "EGLL", "LHR")]));
    onTestFinished(() => setActiveAirportIndex(undefined));
    const row = flightsRow({ From: " ams ", To: "lhr", "Planned From": "EHAM", "Planned To": "EGLL" });
    const result = parseJetlogCsvFiles([csv(JETLOG_CSV_HEADERS.flights, [row])]);
    expect(result.entries[0]?.from).toBe("EHAM");
    expect(result.entries[0]?.to).toBe("EGLL");
    expect(result.entries[0]?.actualFrom).toBe("EHAM");
    expect(result.entries[0]?.actualTo).toBe("EGLL");
  });

  it("keeps an unknown From/To code as typed (uppercased)", () => {
    const row = flightsRow({ From: "zzzz" });
    const result = parseJetlogCsvFiles([csv(JETLOG_CSV_HEADERS.flights, [row])]);
    expect(result.entries[0]?.from).toBe("ZZZZ");
  });

  it("accepts a decimal-hours Manual Total Time cell (XLSXValueParser leniency)", () => {
    const row = flightsRow({ "Manual Total Time": "1.5" });
    const flightsCsv = csv(JETLOG_CSV_HEADERS.flights, [row]);
    const result = parseJetlogCsvFiles([flightsCsv]);
    expect(result.entries[0]?.manualTimes?.totalTimeOfFlight?.totalMinutes).toBe(90);
  });

  it("still accepts a bare-integer-minutes Manual Total Time cell (this format's own export convention)", () => {
    const row = flightsRow({ "Manual Total Time": "90" });
    const flightsCsv = csv(JETLOG_CSV_HEADERS.flights, [row]);
    const result = parseJetlogCsvFiles([flightsCsv]);
    expect(result.entries[0]?.manualTimes?.totalTimeOfFlight?.totalMinutes).toBe(90);
  });

  it("still accepts an H:MM Manual Total Time cell", () => {
    const row = flightsRow({ "Manual Total Time": "1:30" });
    const flightsCsv = csv(JETLOG_CSV_HEADERS.flights, [row]);
    const result = parseJetlogCsvFiles([flightsCsv]);
    expect(result.entries[0]?.manualTimes?.totalTimeOfFlight?.totalMinutes).toBe(90);
  });

  it("accepts a 4-digit no-colon Off Blocks cell (XLSXValueParser leniency)", () => {
    const row = flightsRow({ "Off Blocks": "0835" });
    const flightsCsv = csv(JETLOG_CSV_HEADERS.flights, [row]);
    const result = parseJetlogCsvFiles([flightsCsv]);
    expect(result.entries[0]?.offBlocks?.totalMinutes).toBe(8 * 60 + 35);
  });

  it("detect() recognizes the Flights sheet header", () => {
    const flightsCsv = csv(JETLOG_CSV_HEADERS.flights, [FLIGHTS_ROW]);
    expect(csvLogbookImporter.detect(Buffer.from(flightsCsv, "utf8"), "Flights.csv")).toBeGreaterThan(0);
  });
});

describe("jetlog-csv importer (ZIP archive, CSVLogbookArchive port)", () => {
  const flightsCsv = csv(JETLOG_CSV_HEADERS.flights, [FLIGHTS_ROW]);

  it("parse() unwraps Flights.csv/People.csv/Aircraft.csv from a zip archive", async () => {
    const peopleCsv = csv(JETLOG_CSV_HEADERS.people, [["", "JD", "Jane", "Doe", "12345", "PIC"]]);
    const aircraftCsv = csv(JETLOG_CSV_HEADERS.aircraft, [["PHBXA", "B738", "73H"]]);
    const zipped = Buffer.from(
      zipSync({
        "Flights.csv": new TextEncoder().encode(flightsCsv),
        "People.csv": new TextEncoder().encode(peopleCsv),
        "Aircraft.csv": new TextEncoder().encode(aircraftCsv),
        "README.txt": new TextEncoder().encode("Role codes: PIC = Pilot in Command")
      })
    );
    const result = await csvLogbookImporter.parse(zipped, { filename: "export.zip" });
    expect(result.entries).toHaveLength(1);
    expect(result.aircraft.some((a) => a.registration === "PHBXA")).toBe(true);
  });

  it("parse() skips __MACOSX resource-fork copies, mirroring collectCSVURLs(under:)", async () => {
    const zipped = Buffer.from(
      zipSync({
        "Flights.csv": new TextEncoder().encode(flightsCsv),
        "__MACOSX/._Flights.csv": new TextEncoder().encode("garbage")
      })
    );
    const result = await csvLogbookImporter.parse(zipped, { filename: "export.zip" });
    expect(result.entries).toHaveLength(1);
    expect(result.importErrors.some((e) => /no recognizable/i.test(e.reason))).toBe(false);
  });

  it("parse() reports a clear error for a zip with no recognizable sheets", async () => {
    const zipped = Buffer.from(zipSync({ "notes.txt": new TextEncoder().encode("hello") }));
    const result = await csvLogbookImporter.parse(zipped, { filename: "export.zip" });
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/no recognizable logbook files/i);
  });

  it("detect() recognizes a zipped export via its contained Flights.csv", () => {
    const zipped = Buffer.from(zipSync({ "Flights.csv": new TextEncoder().encode(flightsCsv) }));
    expect(csvLogbookImporter.detect(zipped, "export.zip")).toBeGreaterThan(0);
  });
});
