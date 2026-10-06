import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flylogImporter, parseFlylogCsv, parseFlylogName } from "../../src/import/importers/flylog.js";
import { excludingFutureEntries } from "../../src/import/model.js";

/**
 * Behavior coverage for the Flylog importer, ported from
 * the Jetlog iOS app's Flylog importer tests. Skipped: DB-matched-row
 * re-import tests with no offline equivalent, and the app's real-named
 * export fixture, which is not copied here. All fixtures/CSV rows here are hand-built
 * with synthetic names/registrations.
 */

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ios", "flylog");

const HEADERS = [
  "DATE",
  "AIRCRAFT_TYPE",
  "AIRCRAFT_REGISTRATION",
  "DEPARTURE_AIRPORT",
  "ARRIVAL_AIRPORT",
  "TIME_BLOCK_START",
  "TIME_BLOCK_END",
  "TIME_TAKEOFF",
  "TIME_LANDING",
  "DURATION_BLOCK",
  "FLIGHT_NUMBER",
  "TAKEOFFS_DAY",
  "TAKEOFFS_NIGHT",
  "LDGS_DAY",
  "LDGS_NIGHT",
  "REMARKS",
  "PERSONAL_NOTE",
  "DURATION_PIC",
  "DURATION_SIC",
  "DURATION_PICUS",
  "DURATION_DUAL",
  "DURATION_INSTRUCTOR",
  "DURATION_EXAMINER",
  "DURATION_NIGHT",
  "DURATION_IFR",
  "DURATION_XC",
  "DURATION_MULTI_PILOT",
  "NAME_PIC",
  "NAME_COPILOT",
  "NAME_INSTRUCTOR",
  "NAME_EXAMINER",
  "NAME_STUDENT",
  "DURATION_SIMULATOR"
];

function csv(rows: string[][]): string {
  for (const row of rows) {
    if (row.length !== HEADERS.length) throw new Error(`row length ${row.length} != headers length ${HEADERS.length}`);
  }
  return [HEADERS, ...rows].map((r) => r.join(",")).join("\n");
}

/** Builds one Flylog row from a partial field map, defaulting everything else blank. */
function row(fields: Partial<Record<(typeof HEADERS)[number], string>>): string[] {
  return HEADERS.map((h) => fields[h] ?? "");
}

describe("detect()", () => {
  it("recognizes the Flylog header shape", () => {
    const buf = Buffer.from(readFileSync(join(FIXTURES_DIR, "sample.csv"), "utf8"), "utf8");
    expect(flylogImporter.detect(buf, "sample.csv")).toBeGreaterThan(0);
  });

  it("rejects an unrelated CSV shape", () => {
    const buf = Buffer.from("foo,bar\n1,2\n", "utf8");
    expect(flylogImporter.detect(buf, "export.csv")).toBe(0);
  });

  it("rejects an empty file", () => {
    expect(flylogImporter.detect(Buffer.from(""), "export.csv")).toBe(0);
  });
});

describe("required-header validation", () => {
  it("reports a clear error and imports nothing when DATE/AIRCRAFT_TYPE are missing", () => {
    const result = parseFlylogCsv("FOO,BAR\n1,2\n");
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/DATE not found|AIRCRAFT_TYPE not found/);
  });

  it("reports an error for genuinely empty input", () => {
    const result = parseFlylogCsv("");
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/empty/i);
  });
});

describe("fixture-based parse (test/fixtures/ios/flylog/sample.csv)", () => {
  it("imports the one flight row with SELF as PIC and a named co-pilot", () => {
    const result = parseFlylogCsv(readFileSync(join(FIXTURES_DIR, "sample.csv"), "utf8"));
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.flightNumber).toBe("FL100");
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");
    const copilot = result.people.find((p) => p.refId === "John Roe");
    expect(copilot).toBeDefined();
    expect(entry.crew.find((c) => c.refId === "John Roe")?.role).toBe("CP");
  });
});

describe("role resolution: duration-column priority (examiner > instructor > PIC > PICUS > SIC > dual)", () => {
  it("DURATION_PIC alone resolves SELF to PIC", () => {
    const r = row({ DATE: "2026-01-10", AIRCRAFT_TYPE: "A320", AIRCRAFT_REGISTRATION: "PHAAA", DEPARTURE_AIRPORT: "EHAM", ARRIVAL_AIRPORT: "EDDF", DURATION_PIC: "1:00", FLIGHT_NUMBER: "FL1" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");
  });

  it("DURATION_SIC alone resolves SELF to CP", () => {
    const r = row({ DATE: "2026-01-10", AIRCRAFT_TYPE: "A320", AIRCRAFT_REGISTRATION: "PHAAA", DEPARTURE_AIRPORT: "EHAM", ARRIVAL_AIRPORT: "EDDF", DURATION_SIC: "1:00", FLIGHT_NUMBER: "FL2" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
  });

  it("DURATION_EXAMINER wins over a simultaneously logged DURATION_PIC", () => {
    const r = row({
      DATE: "2026-01-10",
      AIRCRAFT_TYPE: "A320",
      AIRCRAFT_REGISTRATION: "PHAAA",
      DEPARTURE_AIRPORT: "EHAM",
      ARRIVAL_AIRPORT: "EDDF",
      DURATION_PIC: "1:00",
      DURATION_EXAMINER: "1:00",
      FLIGHT_NUMBER: "FL3"
    });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.crew.find((c) => c.refId === "SELF")?.role).toBe("FE");
  });

  it("every duration column blank falls back to the name-column heuristic (NAME_PIC populated alone -> holder is CP)", () => {
    const r = row({
      DATE: "2026-01-10",
      AIRCRAFT_TYPE: "A320",
      AIRCRAFT_REGISTRATION: "PHAAA",
      DEPARTURE_AIRPORT: "EHAM",
      ARRIVAL_AIRPORT: "EDDF",
      FLIGHT_NUMBER: "FL4",
      NAME_PIC: "Jane Doe"
    });
    const result = parseFlylogCsv(csv([r]));
    const entry = result.entries[0]!;
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
    // NAME_PIC's fixed role (PIC) differs from the holder's resolved role (CP), so it's also added.
    const namedPic = result.people.find((p) => p.refId === "Jane Doe");
    expect(entry.crew.find((c) => c.refId === namedPic?.refId)?.role).toBe("PIC");
  });
});

describe("validation errors for missing required fields", () => {
  it("flags registration/origin/destination missing on an otherwise-valid row", () => {
    const r = row({ DATE: "2026-01-12", AIRCRAFT_TYPE: "A320", DURATION_PIC: "1:00", FLIGHT_NUMBER: "FL300" });
    const result = parseFlylogCsv(csv([r]));
    const codes = result.importErrors.filter((e) => e.flightNumber === "FL300").map((e) => e.code);
    expect(codes.sort()).toEqual(["destinationAirportMissing", "originAirportMissing", "registrationMissing"]);
  });

  it("flags fstdIdentifierMissing on a simulator row with no AIRCRAFT_REGISTRATION", () => {
    const r = row({ DATE: "2026-01-13", AIRCRAFT_TYPE: "SIM", DURATION_SIMULATOR: "1:00" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.importErrors.some((e) => e.code === "fstdIdentifierMissing")).toBe(true);
  });

  it("reports an incorrect-date-format error and skips the row instead of importing garbage", () => {
    const r = row({ DATE: "not-a-date", AIRCRAFT_TYPE: "A320", AIRCRAFT_REGISTRATION: "PHAAA", DEPARTURE_AIRPORT: "EHAM", ARRIVAL_AIRPORT: "EDDF" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors.some((e) => e.reason.includes("Incorrect date format"))).toBe(true);
  });
});

describe("FSTD (simulator) rows: AIRCRAFT_TYPE == 'SIM'", () => {
  it("defaults SELF to FSTD_TRN with no instructor/examiner duration logged, and credits a named NAME_PIC as FSTD_INS", () => {
    const r = row({
      DATE: "2026-01-14",
      AIRCRAFT_TYPE: "SIM",
      AIRCRAFT_REGISTRATION: "FTD1",
      TIME_BLOCK_START: "09:00",
      TIME_BLOCK_END: "10:30",
      DURATION_SIMULATOR: "1:30",
      NAME_PIC: "Jane Doe"
    });
    const result = parseFlylogCsv(csv([r]));
    const entry = result.entries[0]!;
    expect(entry.type).toBe("fstd");
    expect(entry.fstdId).toBe("FTD1");
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_TRN");
    const instructor = result.people.find((p) => p.refId === "Jane Doe");
    expect(entry.crew.find((c) => c.refId === instructor?.refId)?.role).toBe("FSTD_INS");
  });

  it("DURATION_INSTRUCTOR logged resolves SELF to FSTD_INS and does NOT also credit NAME_PIC", () => {
    const r = row({
      DATE: "2026-01-15",
      AIRCRAFT_TYPE: "SIM",
      AIRCRAFT_REGISTRATION: "FTD1",
      DURATION_SIMULATOR: "1:00",
      DURATION_INSTRUCTOR: "1:00",
      NAME_PIC: "Jane Doe"
    });
    const result = parseFlylogCsv(csv([r]));
    const entry = result.entries[0]!;
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_INS");
    expect(entry.crew.some((c) => c.role === "FSTD_INS" && c.refId !== "SELF")).toBe(false);
  });

  it("DURATION_EXAMINER wins over DURATION_INSTRUCTOR for FSTD role", () => {
    const r = row({
      DATE: "2026-01-16",
      AIRCRAFT_TYPE: "SIM",
      AIRCRAFT_REGISTRATION: "FTD1",
      DURATION_SIMULATOR: "1:00",
      DURATION_INSTRUCTOR: "1:00",
      DURATION_EXAMINER: "1:00"
    });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_EXA");
  });

  it("derives start/end directly from TIME_BLOCK_START/END (no duration-derived timeline, unlike PilotLog)", () => {
    const r = row({ DATE: "2026-01-17", AIRCRAFT_TYPE: "SIM", AIRCRAFT_REGISTRATION: "FTD1", TIME_BLOCK_START: "14:00", TIME_BLOCK_END: "15:45", DURATION_SIMULATOR: "1:45" });
    const result = parseFlylogCsv(csv([r]));
    const entry = result.entries[0]!;
    expect(entry.startTime?.totalMinutes).toBe(14 * 60);
    expect(entry.endTime?.totalMinutes).toBe(15 * 60 + 45);
  });
});

describe("session-type matching from REMARKS", () => {
  it("recognizes a compound LPC/OPC remark", () => {
    const r = row({ DATE: "2026-01-18", AIRCRAFT_TYPE: "SIM", AIRCRAFT_REGISTRATION: "FTD1", DURATION_SIMULATOR: "1:00", REMARKS: "Annual LPC and OPC check" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.sessionType).toBe("LPC/OPC");
  });

  it("recognizes a standalone LOE remark", () => {
    const r = row({ DATE: "2026-01-19", AIRCRAFT_TYPE: "SIM", AIRCRAFT_REGISTRATION: "FTD1", DURATION_SIMULATOR: "1:00", REMARKS: "LOE scenario A" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.sessionType).toBe("LOE");
  });

  it("returns undefined sessionType for unrecognized remarks", () => {
    const r = row({ DATE: "2026-01-20", AIRCRAFT_TYPE: "SIM", AIRCRAFT_REGISTRATION: "FTD1", DURATION_SIMULATOR: "1:00", REMARKS: "Just a normal session" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.sessionType).toBeUndefined();
  });
});

describe("remarks: REMARKS + PERSONAL_NOTE combine with a semicolon separator, as the app does", () => {
  it("joins both fields when both are present", () => {
    const r = row({
      DATE: "2026-01-21",
      AIRCRAFT_TYPE: "A320",
      AIRCRAFT_REGISTRATION: "PHAAA",
      DEPARTURE_AIRPORT: "EHAM",
      ARRIVAL_AIRPORT: "EDDF",
      DURATION_PIC: "1:00",
      REMARKS: "Smooth flight",
      PERSONAL_NOTE: "Good landing"
    });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.remarks).toBe("Smooth flight; Good landing");
  });

  it("is undefined when both fields are blank", () => {
    const r = row({ DATE: "2026-01-22", AIRCRAFT_TYPE: "A320", AIRCRAFT_REGISTRATION: "PHAAA", DEPARTURE_AIRPORT: "EHAM", ARRIVAL_AIRPORT: "EDDF", DURATION_PIC: "1:00" });
    const result = parseFlylogCsv(csv([r]));
    expect(result.entries[0]?.remarks).toBeUndefined();
  });
});

describe("duplicate detection (same date + flight number + route)", () => {
  it("flags the extra copy and keeps the more complete row", () => {
    const complete = row({
      DATE: "2026-01-23",
      AIRCRAFT_TYPE: "A320",
      AIRCRAFT_REGISTRATION: "PHAAA",
      DEPARTURE_AIRPORT: "EHAM",
      ARRIVAL_AIRPORT: "EDDF",
      DURATION_PIC: "1:00",
      FLIGHT_NUMBER: "FL500",
      REMARKS: "Has remarks"
    });
    const sparse = row({
      DATE: "2026-01-23",
      AIRCRAFT_TYPE: "A320",
      AIRCRAFT_REGISTRATION: "PHAAA",
      DEPARTURE_AIRPORT: "EHAM",
      ARRIVAL_AIRPORT: "EDDF",
      DURATION_PIC: "1:00",
      FLIGHT_NUMBER: "FL500"
    });
    const result = parseFlylogCsv(csv([complete, sparse]));
    expect(result.importErrors.some((e) => e.code === "duplicateRowsInFile")).toBe(true);
    const rows = result.entries.filter((e) => e.flightNumber === "FL500");
    expect(rows).toHaveLength(2);
    expect(rows.filter((e) => e.isDuplicateInFile)).toHaveLength(1);
  });
});

describe("parseFlylogName", () => {
  it("parses an initials-prefixed name", () => {
    expect(parseFlylogName("T.M.Eriksson")).toEqual({ firstName: "T.M.", lastName: "Eriksson" });
  });

  it("parses a single-initial name with a space", () => {
    expect(parseFlylogName("P. Tjittes")).toEqual({ firstName: "P.", lastName: "Tjittes" });
  });

  it("parses a plain first/last name", () => {
    expect(parseFlylogName("John Smith")).toEqual({ firstName: "John", lastName: "Smith" });
  });

  it("treats a single word as a last name", () => {
    expect(parseFlylogName("Smith")).toEqual({ lastName: "Smith" });
  });

  it("returns {} for a blank name", () => {
    expect(parseFlylogName("   ")).toEqual({});
  });
});

describe("excludingFutureEntries integration (caller-level, same as every other-logbook importer)", () => {
  it("a Flylog result with a future-dated row drops only that row and reports one skip notice", () => {
    const past = row({ DATE: "2026-01-01", AIRCRAFT_TYPE: "A320", AIRCRAFT_REGISTRATION: "PHAAA", DEPARTURE_AIRPORT: "EHAM", ARRIVAL_AIRPORT: "EDDF", DURATION_PIC: "1:00", FLIGHT_NUMBER: "FL600" });
    const future = row({ DATE: "2026-02-01", AIRCRAFT_TYPE: "A320", AIRCRAFT_REGISTRATION: "PHAAA", DEPARTURE_AIRPORT: "EDDF", ARRIVAL_AIRPORT: "EHAM", DURATION_PIC: "1:00", FLIGHT_NUMBER: "FL601" });
    const result = parseFlylogCsv(csv([past, future]));
    expect(result.entries).toHaveLength(2);

    const filtered = excludingFutureEntries(result, "2026-01-15");
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0]?.flightNumber).toBe("FL600");
    expect(filtered.importErrors.some((e) => e.code === "futureEntriesSkipped")).toBe(true);
  });
});
