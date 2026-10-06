import { describe, expect, it } from "vitest";
import { excelImporter, parseXlsxWorkbook } from "../../src/import/importers/excel.js";
import { JETLOG_CSV_HEADERS } from "../../src/import/importers/csv-logbook.js";
import { excelSerialToIsoDate, excelSerialToClockMinutes, readXlsxWorkbookSync } from "../../src/import/xlsx.js";
import { buildTestXlsx } from "./_xlsx-test-helpers.js";

/**
 * Behavior coverage for the Excel (.xlsx) importer, ported from
 * the Jetlog iOS app's Excel importer. Since the app's real fixtures are
 * genuine xlsx binaries (some containing a real user's data, which are not
 * copied here), every `.xlsx` fixture in this file is built in-memory by
 * `./_xlsx-test-helpers.ts`, a minimal synthetic OOXML writer.
 */

describe("xlsx.ts low-level serial conversions", () => {
  it("converts an Excel date serial to an ISO date (epoch 1899-12-30)", () => {
    // 45413 = 2024-05-01 in Excel's serial date system.
    expect(excelSerialToIsoDate(45413)).toBe("2024-05-01");
  });

  it("converts the fractional part of a serial to clock minutes", () => {
    expect(excelSerialToClockMinutes(45413.5)).toBe(720); // 12:00
    expect(excelSerialToClockMinutes(0.0625)).toBe(90); // 01:30
  });
});

describe("Excel importer (.xlsx Flights/People/Aircraft sheets)", () => {
  const flightsHeader = [...JETLOG_CSV_HEADERS.flights];
  const flightsRow = flightsHeader.map((h) => {
    switch (h) {
      case "Flight Number":
        return "KL123";
      case "Registration":
        return "PHBXA";
      case "From":
        return "EHAM";
      case "To":
        return "EGLL";
      case "Off Blocks":
        return "10:00";
      case "On Blocks":
        return "11:30";
      case "Crew 1 Name":
        return "Jane Doe";
      case "Crew 1 Role":
        return "PIC";
      case "Remarks":
        return "Excel import test";
      default:
        return "";
    }
  });
  // Overwrite the Date column with a date-styled numeric serial cell to
  // exercise the Excel-specific serial->ISO leniency, not plain text.
  const dateColIndex = flightsHeader.indexOf("Date");
  const flightsRowWithSerialDate: Array<string | { date: number }> = [...flightsRow];
  flightsRowWithSerialDate[dateColIndex] = { date: 45413 }; // 2024-05-01

  const peopleHeader = [...JETLOG_CSV_HEADERS.people];
  const peopleRow = peopleHeader.map((h) => ({ "First Name": "Jane", "Last Name": "Doe", "Default Role": "PIC" })[h] ?? "");

  const aircraftHeader = [...JETLOG_CSV_HEADERS.aircraft];
  const aircraftRow = aircraftHeader.map((h) => ({ Registration: "PHBXA", "ICAO Type": "B738" })[h] ?? "");

  const xlsx = buildTestXlsx([
    { name: "Flights", rows: [flightsHeader, flightsRowWithSerialDate] },
    { name: "People", rows: [peopleHeader, peopleRow] },
    { name: "Aircraft", rows: [aircraftHeader, aircraftRow] }
  ]);

  it("reads sheet names and dense row grids", () => {
    const sheets = readXlsxWorkbookSync(xlsx);
    expect(sheets.map((s) => s.name).sort()).toEqual(["Aircraft", "Flights", "People"]);
  });

  it("parses a flight entry, resolving the date-styled serial cell to ISO", () => {
    const result = parseXlsxWorkbook(xlsx);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.date).toBe("2024-05-01");
    expect(entry.flightNumber).toBe("KL123");
    expect(entry.registration).toBe("PHBXA");
    expect(entry.from).toBe("EHAM");
    expect(entry.to).toBe("EGLL");
    expect(entry.offBlocks?.totalMinutes).toBe(10 * 60);
  });

  it("imports the crew person and aircraft from the People/Aircraft sheets", () => {
    const result = parseXlsxWorkbook(xlsx);
    expect(result.people.some((p) => p.firstName === "Jane" && p.lastName === "Doe")).toBe(true);
    expect(result.aircraft.some((a) => a.registration === "PHBXA" && a.icaoCode === "B738")).toBe(true);
  });

  it("detect() recognizes the workbook via its Flights sheet header", () => {
    expect(excelImporter.detect(xlsx, "export.xlsx")).toBeGreaterThan(0);
  });

  it("parse() via the Importer interface matches parseXlsxWorkbook", async () => {
    const result = await excelImporter.parse(xlsx, { filename: "export.xlsx" });
    expect(result.entries).toHaveLength(1);
  });

  it("parse() reports a clear error for a non-zip (non-xlsx) buffer", async () => {
    const result = await excelImporter.parse(Buffer.from("not an xlsx"), { filename: "export.xlsx" });
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/not a readable \.xlsx/i);
  });
});
