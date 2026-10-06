import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertFile, convertFiles } from "../../src/convert/index.js";
import { payloadSchema } from "../../src/schema.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/ios/${name}`, import.meta.url), "utf-8");
}

const FLYLOG_FIELDS = [
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
const FLYLOG_HEADER = FLYLOG_FIELDS.join(",");

function flylogRow(date: string, flightNumber: string): string {
  const row: Record<string, string> = {
    DATE: date,
    AIRCRAFT_TYPE: "A320",
    AIRCRAFT_REGISTRATION: "PHFAKE",
    DEPARTURE_AIRPORT: "EHAM",
    ARRIVAL_AIRPORT: "EDDF",
    TIME_BLOCK_START: "08:00",
    TIME_BLOCK_END: "09:10",
    TIME_TAKEOFF: "08:10",
    TIME_LANDING: "09:00",
    DURATION_BLOCK: "1:10",
    FLIGHT_NUMBER: flightNumber,
    TAKEOFFS_DAY: "1",
    TAKEOFFS_NIGHT: "0",
    LDGS_DAY: "1",
    LDGS_NIGHT: "0",
    DURATION_PIC: "1:10",
    NAME_PIC: "John Roe"
  };
  return FLYLOG_FIELDS.map((f) => row[f] ?? "").join(",");
}

describe("convertFile via the importer registry", () => {
  it("--from logten converts a real LogTen fixture and reports dropped fields", async () => {
    const content = fixture("logten/basic-flights.txt");
    const { payload, droppedFieldCount, importResult } = await convertFile("logten", content, {}, Buffer.from(content));
    expect(importResult).toBeDefined();
    expect(payloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.entries!.length).toBeGreaterThan(0);
    expect(typeof droppedFieldCount).toBe("number");
  });

  it("--from pilotlog converts a real PilotLog fixture", async () => {
    const content = fixture("pilotlog/mcc-classic.csv");
    const { payload } = await convertFile("pilotlog", content, { filename: "mcc-classic.csv" }, Buffer.from(content));
    expect(payloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.entries!.length).toBeGreaterThan(0);
  });

  it("--from auto detects a deeplink JSON payload", async () => {
    const content = JSON.stringify({ entries: [{ date: "2026-01-01", flight_number: "KL1023" }] });
    const { payload } = await convertFile("auto", content, {}, Buffer.from(content));
    expect(payloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.entries).toHaveLength(1);
  });

  it("--from auto throws when nothing matches", async () => {
    await expect(convertFile("auto", "not a recognizable logbook export at all", {}, Buffer.from("x"))).rejects.toThrow(
      /auto-detect/
    );
  });
});

describe("excludingFutureEntries wiring (mirrors ImportViewModel.processLogbookFile's default)", () => {
  const content = [FLYLOG_HEADER, flylogRow("2020-01-10", "FL100"), flylogRow("2999-01-10", "FL200")].join("\n");

  it("drops future-dated rows by default for an other-logbook importer (flylog) and reports the count", async () => {
    const { payload, futureEntriesExcludedCount } = await convertFile(
      "flylog",
      content,
      { today: "2024-06-01" },
      Buffer.from(content)
    );
    expect(payload.entries?.length).toBe(1);
    expect(futureEntriesExcludedCount).toBe(1);
  });

  it("--include-future (includeFuture: true) keeps the future-dated row", async () => {
    const { payload, futureEntriesExcludedCount } = await convertFile(
      "flylog",
      content,
      { today: "2024-06-01", includeFuture: true },
      Buffer.from(content)
    );
    expect(payload.entries?.length).toBe(2);
    expect(futureEntriesExcludedCount).toBeUndefined();
  });

  it("does NOT apply the filter to Jetlog's own re-import formats (deeplink-json)", async () => {
    const deeplinkContent = JSON.stringify({ entries: [{ date: "2999-01-01", flight_number: "KL1023" }] });
    const { payload, futureEntriesExcludedCount } = await convertFile(
      "deeplink-json",
      deeplinkContent,
      { today: "2024-06-01" },
      Buffer.from(deeplinkContent)
    );
    expect(payload.entries?.length).toBe(1);
    expect(futureEntriesExcludedCount).toBeUndefined();
  });
});

describe("convertFiles: multi-file formats", () => {
  function file(content: string, filename: string) {
    return { content, buffer: Buffer.from(content, "utf-8"), filename };
  }

  it("routes a 3-file RB Logbook export through parseRBLogbookFiles via Importer.parseMany", async () => {
    const flights = fixture("rblogbook/flights.csv");
    const aircraft = fixture("rblogbook/aircraft.csv");
    const people = fixture("rblogbook/people.csv");
    const { payload } = await convertFiles("rblogbook", [
      file(aircraft, "rb_logbook_aircraft.csv"),
      file(people, "rb_logbook_people.csv"),
      file(flights, "rb_logbook_flights.csv")
    ]);
    expect(payloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.entries!.length).toBeGreaterThan(0);
  });

  it("a single-file array is routed straight back through convertFile", async () => {
    const content = fixture("pilotlog/mcc-classic.csv");
    const { payload } = await convertFiles("pilotlog", [file(content, "mcc-classic.csv")]);
    expect(payloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.entries!.length).toBeGreaterThan(0);
  });

  it("throws for a format with no parseMany given multiple files", async () => {
    const content = fixture("pilotlog/mcc-classic.csv");
    await expect(
      convertFiles("pilotlog", [file(content, "a.csv"), file(content, "b.csv")])
    ).rejects.toThrow(/does not support multiple input files/);
  });
});
