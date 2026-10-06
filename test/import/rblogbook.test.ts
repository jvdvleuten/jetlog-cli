import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rbLogbookImporter, parseRBLogbookFiles, classifyRBLogbookFiles, identifyRBFile } from "../../src/import/importers/rblogbook.js";

/**
 * Behavior coverage for the RB Logbook (RosterBuster) importer, ported from
 * the Jetlog iOS app's RB Logbook importer tests. All fixtures here are
 * small, hand-built, and synthetic (fake names/registrations). The app's
 * real test fixtures are still real exports, so they were not copied; this file's fixtures exercise the same
 * structural behaviors (flight/FSTD split, ground-duty skip, role
 * inference buckets, mismatched FSTD clocks) with invented data.
 */

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ios", "rblogbook");
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("identifyRBFile (content sniffing)", () => {
  it("identifies flights/aircraft/people by header substrings", () => {
    expect(identifyRBFile(readFixture("flights.csv"))).toBe("flights");
    expect(identifyRBFile(readFixture("aircraft.csv"))).toBe("aircraft");
    expect(identifyRBFile(readFixture("people.csv"))).toBe("people");
    expect(identifyRBFile("just,some,other,csv\n1,2,3,4")).toBeUndefined();
  });

  it("classifyRBLogbookFiles groups files regardless of order", () => {
    const files = classifyRBLogbookFiles([readFixture("people.csv"), readFixture("aircraft.csv"), readFixture("flights.csv")]);
    expect(files).toBeDefined();
    expect(files?.flights).toContain("Duty Type");
    expect(files?.aircraft).toContain("Manufacturer");
    expect(files?.people).toContain("Function");
  });
});

describe("rblogbook importer (all three files)", () => {
  const result = parseRBLogbookFiles({
    flights: readFixture("flights.csv"),
    aircraft: readFixture("aircraft.csv"),
    people: readFixture("people.csv")
  });

  it("splits flight and FSTD entries, skipping ground duties", () => {
    expect(result.entries.filter((e) => e.type === "flight")).toHaveLength(2);
    expect(result.entries.filter((e) => e.type === "fstd")).toHaveLength(1);
  });

  it("maps the explicit-PIC flight's core fields", () => {
    const flight = result.entries.find((e) => e.flightNumber === "KL123");
    expect(flight?.registration).toBe("PHBXA");
    expect(flight?.from).toBe("EHAM");
    expect(flight?.to).toBe("EGLL");
    expect(flight?.offBlocks?.totalMinutes).toBe(10 * 60);
    expect(flight?.onBlocks?.totalMinutes).toBe(11 * 60 + 30);
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");
  });

  it("imports the crew person from the People.csv enrichment", () => {
    expect(result.people.some((p) => p.firstName === "John" && p.lastName === "Smith")).toBe(true);
  });

  it("imports aircraft with ICAO code hint from Aircraft.csv", () => {
    const aircraft = result.aircraft.find((a) => a.registration === "PHBXA");
    expect(aircraft?.icaoCode).toBe("B738");
  });

  it("the FSTD session has a non-null fstdId and no route", () => {
    const fstd = result.entries.find((e) => e.type === "fstd");
    expect(fstd?.fstdId).toBe("SIM1");
    expect(fstd?.from).toBeUndefined();
    expect(fstd?.to).toBeUndefined();
    expect(fstd?.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_TRN");
  });

  it("infers Co-pilot with a missing-seat warning when a flight has no crew columns and no function times", () => {
    const flight = result.entries.find((e) => e.flightNumber === "KL456");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
    expect(result.importErrors.some((e) => e.code === "roleInferenceWarningMissingSeat" && e.flightNumber === "KL456")).toBe(true);
  });
});

describe("rblogbook importer (flights file only)", () => {
  it("still imports entries and a SELF person without the optional files", () => {
    const result = parseRBLogbookFiles({ flights: readFixture("flights.csv") });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.people.some((p) => p.refId === "SELF")).toBe(true);
  });
});

describe("rblogbook importer (mismatched FSTD clocks)", () => {
  it("clears session start/end times when they disagree with the authoritative simulator duration by >=30min", () => {
    const flights = [
      "Date,Duty Type,Departure,Arrival,Aircraft ID,Sched Out,Sched In,Out,In,Off,On,Day Takeoff,Night Takeoff,Day Landing,Night Landing,Total Block,Simulator,Crew PIC",
      "2024-06-01,1,,,SIM2,10:00,11:00,,,,,0,0,0,0,,180,Self+++"
    ].join("\n");
    const result = parseRBLogbookFiles({ flights });
    const fstd = result.entries.find((e) => e.type === "fstd");
    expect(fstd?.startTime).toBeUndefined();
    expect(fstd?.endTime).toBeUndefined();
    expect(fstd?.manualTimes?.fstdSession?.totalMinutes).toBe(180);
    expect(result.importErrors.some((e) => /disagree with the authoritative/i.test(e.reason))).toBe(true);
  });
});

describe("rbLogbookImporter (single-file Importer interface)", () => {
  it("detect() recognizes a standalone flights CSV", () => {
    expect(rbLogbookImporter.detect(Buffer.from(readFixture("flights.csv"), "utf8"), "flights.csv")).toBeGreaterThan(0);
  });

  it("parse() works on just the flights file", async () => {
    const result = await rbLogbookImporter.parse(readFixture("flights.csv"));
    expect(result.entries.length).toBeGreaterThan(0);
  });
});
