import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flightLoggerImporter, parseFlightLoggerCsv } from "../../src/import/importers/flightlogger.js";

/**
 * Behavior coverage for the FlightLogger importer, ported from
 * the Jetlog iOS app's FlightLogger importer tests. Fixtures are hand-built
 * and synthetic (not the app's real fixtures, even though they share the
 * same generic names here for readability).
 */

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ios", "flightlogger");
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("FlightLogger importer (dot-date file)", () => {
  const result = parseFlightLoggerCsv(readFixture("FlightLoggerFile1.csv"));

  it("imports flight and FSTD entries", () => {
    expect(result.entries.filter((e) => e.type === "flight")).toHaveLength(2);
    expect(result.entries.filter((e) => e.type === "fstd")).toHaveLength(1);
  });

  it("parses dot-separated dates", () => {
    expect(result.entries.some((e) => e.date === "2023-10-30")).toBe(true);
  });

  it("detects FSTD entries via synthetic_training with nil route", () => {
    const fstd = result.entries.find((e) => e.type === "fstd");
    expect(fstd?.fstdId).toBe("FNPT2");
    expect(fstd?.from).toBeUndefined();
    expect(fstd?.to).toBeUndefined();
    expect(fstd?.fstdDeviceCategory).toBe("fnpt");
  });

  it("assigns PIC role from pilot_in_command_time", () => {
    const flight = result.entries.find((e) => e.registration === "PHABC");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");
  });

  it("assigns student role from dual and adds the named PIC as crew", () => {
    const flight = result.entries.find((e) => e.registration === "PHDEF");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("STU");
    expect(flight?.crew.some((c) => c.role === "PIC" && c.refId !== "SELF")).toBe(true);
  });

  it("parses landings into takeoffs/landings (takeoffs assumed from landings>0)", () => {
    const flight = result.entries.find((e) => e.registration === "PHABC");
    expect(flight?.takeoffsAndLandings).toMatchObject({ type: "manual", takeoffsDay: 1, landingsDay: 1 });
  });

  it("imports remarks", () => {
    expect(result.entries.some((e) => e.remarks === "Solo flight")).toBe(true);
  });
});

describe("FlightLogger importer (dash-date file)", () => {
  it("parses dash-separated dates", () => {
    const result = parseFlightLoggerCsv(readFixture("FlightLoggerFile2.csv"));
    expect(result.entries.some((e) => e.date === "2023-10-30")).toBe(true);
  });
});

describe("FlightLogger importer (zero override survives)", () => {
  it("keeps an explicit 0:00 night override rather than dropping it as 'not logged'", () => {
    const headers = "date,departure_airport_name,arrival_airport_name,registration,off_block,on_block,total,landings_day,landings_night,night";
    const row = '"01.01.2024","EHAM","EHRD","PHXYZ","10:00","10:30","0:30","1","0","0:00"';
    const result = parseFlightLoggerCsv([headers, row].join("\n"));
    expect(result.entries[0]?.manualTimes?.night?.totalMinutes).toBe(0);
  });
});

describe("flightLoggerImporter (Importer interface)", () => {
  it("detect() recognizes the FlightLogger header shape", () => {
    const buf = Buffer.from(readFixture("FlightLoggerFile1.csv"), "utf8");
    expect(flightLoggerImporter.detect(buf, "export.csv")).toBeGreaterThan(0);
  });

  it("parse() delegates to parseFlightLoggerCsv", async () => {
    const result = await flightLoggerImporter.parse(readFixture("FlightLoggerFile1.csv"));
    expect(result.entries.length).toBeGreaterThan(0);
  });
});
