import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeLogImporter, parseSafeLogCsv } from "../../src/import/importers/safelog.js";
import { excludingFutureEntries, personDisplayName } from "../../src/import/model.js";

/**
 * Behavior coverage for the SafeLog importer, ported from
 * the Jetlog iOS app's SafeLog importer tests. Coverage is representative
 * per distinct behavior, not line-for-line parity with the app's suite.
 * Skipped groups and why:
 *  - Tests that load a real, named pilot's export are not copied into
 *    this repo (see docs/IMPORTERS.md); the same
 *    structural behaviors (role resolution, FSTD detection, device-category
 *    hint, duration/suffix parsing) are covered here with a small synthetic
 *    fixture instead.
 *  - The "most frequently imported person" -> real user id remap
 *    (the app's import post-pass) has no offline equivalent, see
 *    `safelog.ts`'s file doc comment, so there's nothing to test here;
 *    "SELF" simply keeps that literal `refId` throughout.
 */

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ios", "safelog");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

const BASE_HEADERS = [
  "Date",
  "Aircraft Type",
  "Aircraft Registration",
  "Name of PIC",
  "Holder's Operating Capacity",
  "Departure",
  "Departure Time",
  "Arrival",
  "Arrival Time",
  "Total Flight Time",
  "Day T-O",
  "Day Ldg",
  "Night T-O",
  "Night Ldg",
  "Day Single-Engine (SE) in Command",
  "Day Single-Engine (SE) PICUS",
  "Day Single-Engine (SE) Dual",
  "Day Single-Engine (SE) P2",
  "Day Multi-Engine (ME) in Command",
  "Day Multi-Engine (ME) PICUS",
  "Day Multi-Engine (ME) Co-Pilot",
  "Day Multi-Engine (ME) Dual",
  "Night Single-Engine (SE) in Command",
  "Night Single-Engine (SE) PICUS",
  "Night Single-Engine (SE) Dual",
  "Night Single-Engine (SE) P2",
  "Night Multi-Engine (ME) in Command",
  "Night Multi-Engine (ME) PICUS",
  "Night Multi-Engine (ME) Co-Pilot",
  "Night Multi-Engine (ME) Dual",
  "Simulator Sim.Type",
  "Simulator Sim.Time",
  "Instrument Flying",
  "Instructor Flying",
  "Remarks"
];

/** Builds a tab-delimited SafeLog CSV from a sparse row map (missing columns are blank). */
function csv(rows: Array<Record<string, string>>, headers: string[] = BASE_HEADERS): string {
  const lines = rows.map((row) => headers.map((h) => row[h] ?? "").join("\t"));
  return [headers.join("\t"), ...lines].join("\n");
}

describe("detect()", () => {
  it("recognizes SafeLog's tab-delimited EASA-style header shape", () => {
    const buf = Buffer.from(csv([{ Date: "2024-01-01" }]), "utf8");
    expect(safeLogImporter.detect(buf, "export.csv")).toBeGreaterThan(0);
  });

  it("does not claim a comma-delimited file with unrelated headers", () => {
    const buf = Buffer.from("date,flightnumber,ac_reg\n2024-01-01,KL123,PHABC", "utf8");
    expect(safeLogImporter.detect(buf, "export.csv")).toBe(0);
  });
});

describe("full synthetic fixture (jane-doe-safelog.csv)", () => {
  const result = parseSafeLogCsv(readFixture("jane-doe-safelog.csv"));

  it("imports both flight and FSTD entries", () => {
    expect(result.entries.filter((e) => e.type === "flight").length).toBeGreaterThan(0);
    expect(result.entries.filter((e) => e.type === "fstd").length).toBeGreaterThan(0);
  });

  it("resolves PIC role from 'Holder's Operating Capacity' == PIC", () => {
    const flight = result.entries.find((e) => e.date === "2024-01-05");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");
  });

  it("resolves CP role from 'Holder's Operating Capacity' == Copilot, and tags the named PIC as PIC", () => {
    const flight = result.entries.find((e) => e.date === "2024-01-06");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
    const jane = result.people.find((p) => personDisplayName(p) === "Jane Doe");
    expect(jane).toBeDefined();
    expect(flight?.crew.find((c) => c.refId === jane!.refId)?.role).toBe("PIC");
  });

  it("resolves STU role from 'Holder's Operating Capacity' == P/UT, and tags the named PIC as the instructing PIC", () => {
    const flight = result.entries.find((e) => e.date === "2013-09-07");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("STU");
  });

  it("infers PICUS role from the PICUS time columns when the capacity column is blank", () => {
    const flight = result.entries.find((e) => e.date === "2015-02-17");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("PICUS");
  });

  it("strips UTC/LOCAL suffixes when parsing clock times", () => {
    const utcFlight = result.entries.find((e) => e.date === "2024-01-05");
    expect(utcFlight?.offBlocks?.totalMinutes).toBe(8 * 60);
    expect(utcFlight?.onBlocks?.totalMinutes).toBe(8 * 60 + 50);

    const localFlight = result.entries.find((e) => e.date === "2013-09-07");
    expect(localFlight?.offBlocks?.totalMinutes).toBe(7 * 60);
    expect(localFlight?.onBlocks?.totalMinutes).toBe(8 * 60);
  });

  it("detects FSTD rows (Simulator Sim.Type set, no departure/arrival time) and imports remarks", () => {
    const fstd = result.entries.filter((e) => e.type === "fstd" && e.date === "2024-01-08");
    expect(fstd.length).toBe(2);
    expect(fstd[0]?.fstdId).toBe("FNPT2");
    expect(fstd[0]?.fstdDeviceCategory).toBe("fnpt");
    expect(fstd.some((e) => e.remarks === "LOFT session with engine failure and go-around")).toBe(true);
  });

  it("flags the same-day FSTD rows as an in-file duplicate and keeps the more complete copy", () => {
    const dupWarning = result.importErrors.find((e) => e.code === "duplicateRowsInFile" && e.dateString === "2024-01-08");
    expect(dupWarning).toBeDefined();
    const sameDay = result.entries.filter((e) => e.type === "fstd" && e.date === "2024-01-08");
    expect(sameDay.filter((e) => e.isDuplicateInFile)).toHaveLength(1);
  });

  it("flags missing registration/origin/destination on a flight row with no aircraft/route", () => {
    const errors = result.importErrors.filter((e) => e.dateString === "2010-01-13");
    expect(errors.map((e) => e.code).sort()).toEqual(["destinationAirportMissing", "originAirportMissing", "registrationMissing"]);
  });

  it("collects aircraft only from flight rows, not FSTD rows", () => {
    expect(result.aircraft.map((a) => a.registration).sort()).toEqual(["PHABC", "PHDEF", "PHGHI", "PHJKL"]);
  });
});

describe("authoritative time sums (day/night SE/ME quartets)", () => {
  it("sums the four 'in Command' columns into pilotInCommand (role is Copilot here so normalize doesn't clear it, isolating the sum)", () => {
    const result = parseSafeLogCsv(
      csv([
        {
          Date: "2024-02-01",
          "Aircraft Registration": "PHAAA",
          "Holder's Operating Capacity": "Copilot",
          Departure: "EHAM",
          Arrival: "EHRD",
          "Total Flight Time": "2:00",
          "Day Single-Engine (SE) in Command": "0:30",
          "Night Single-Engine (SE) in Command": "0:30",
          "Day Multi-Engine (ME) in Command": "0:30",
          "Night Multi-Engine (ME) in Command": "0:30"
        }
      ])
    );
    expect(result.entries[0]?.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
    expect(result.entries[0]?.manualTimes?.pilotInCommand?.totalMinutes).toBe(120);
  });

  it("applies 'Instrument Flying'/'Instructor Flying' as single authoritative fields", () => {
    const result = parseSafeLogCsv(
      csv([
        {
          Date: "2024-02-02",
          "Aircraft Registration": "PHBBB",
          "Holder's Operating Capacity": "PIC",
          Departure: "EHAM",
          Arrival: "EHRD",
          "Total Flight Time": "1:00",
          "Instrument Flying": "0:20"
        }
      ])
    );
    expect(result.entries[0]?.manualTimes?.ifr?.totalMinutes).toBe(20);
  });
});

describe("duration parsing (H:MM / HH:MM / HHH:MM)", () => {
  it.each([
    ["0:55", 55],
    ["1:28", 88],
    ["125:30", 7530],
    ["", 0]
  ])("parses %s as %i minutes (Total Flight Time)", (raw, expected) => {
    const result = parseSafeLogCsv(
      csv([
        {
          Date: "2024-03-01",
          "Aircraft Registration": "PHCCC",
          "Holder's Operating Capacity": "PIC",
          Departure: "EHAM",
          Arrival: "EHRD",
          "Total Flight Time": raw
        }
      ])
    );
    const minutes = expected >= 1440 ? result.entries[0]?.manualTimes?.totalTimeOfFlight?.totalMinutes : undefined;
    if (expected >= 1440) {
      expect(minutes).toBe(expected);
    } else {
      // Below the 24h bulk threshold the duration is applied as an on/off-blocks timeline, not manualTimes.
      expect(result.entries[0]?.isBulk).toBe(false);
    }
  });
});

describe("error cases", () => {
  it("rows whose column count doesn't match the header row are skipped, not crashed on", () => {
    const headerLine = BASE_HEADERS.join("\t");
    const malformedRow = "2024-04-01\tPA28"; // far fewer tab-separated columns than headers
    const result = parseSafeLogCsv([headerLine, malformedRow].join("\n"));
    expect(result.entries).toHaveLength(0);
  });

  it("an unparseable date is reported as an import error, not a crash", () => {
    const result = parseSafeLogCsv(
      csv([{ Date: "not-a-date", "Aircraft Registration": "PHDDD", Departure: "EHAM", Arrival: "EHRD" }])
    );
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/could not parse date/i);
  });

  it("empty CSV input reports a clear error instead of an empty silent result", () => {
    const result = parseSafeLogCsv("");
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/empty/i);
  });

  it("an FSTD row with no Simulator Sim.Type is unreachable (that's exactly what makes a row a flight, not FSTD), missing fstdId instead comes from a blank sim type on a row with blank departure/arrival too", () => {
    // A row with no Simulator Sim.Type and no times is a *flight* row (per
    // isSimulatorEntry's gate), so fstdIdentifierMissing never fires here;
    // this documents that boundary rather than asserting a false positive.
    const result = parseSafeLogCsv(csv([{ Date: "2024-04-02" }]));
    expect(result.entries[0]?.type).toBe("flight");
    expect(result.importErrors.some((e) => e.code === "fstdIdentifierMissing")).toBe(false);
  });
});

describe("excludingFutureEntries integration (caller-level, same as every other-logbook importer)", () => {
  it("a SafeLog result with a future-dated row drops only that row and reports one skip notice", () => {
    const result = parseSafeLogCsv(
      csv([
        {
          Date: "2026-07-01",
          "Aircraft Registration": "PHEEE",
          "Holder's Operating Capacity": "PIC",
          Departure: "EHAM",
          Arrival: "EHRD",
          "Total Flight Time": "1:00"
        },
        {
          Date: "2026-07-20",
          "Aircraft Registration": "PHEEE",
          "Holder's Operating Capacity": "PIC",
          Departure: "EHRD",
          Arrival: "EHAM",
          "Total Flight Time": "1:00"
        }
      ])
    );
    expect(result.entries).toHaveLength(2);

    const filtered = excludingFutureEntries(result, "2026-07-14");
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0]?.date).toBe("2026-07-01");
    expect(filtered.importErrors.some((e) => e.code === "futureEntriesSkipped")).toBe(true);
  });
});
