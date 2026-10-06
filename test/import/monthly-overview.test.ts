import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { monthlyOverviewImporter, parseMonthlyOverviewText } from "../../src/import/importers/monthly-overview.js";

/** Builds a tiny synthetic PDF (via `pdf-lib`) whose extracted text is one
 * line per given string, enough to exercise the real `%PDF` -> `unpdf`
 * extraction -> `parseMonthlyOverviewText` path end to end without a real
 * exported KLC statement (see the file doc comment on why those can't be
 * copied into this repo). */
async function buildSyntheticPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const fontSize = 10;
  let y = 760;
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: fontSize, font });
    y -= fontSize + 4;
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Behavior coverage for the KLC Monthly Overview (PDF statement) importer,
 * ported from the Jetlog iOS app's Monthly Overview importer tests. The
 * app's real fixtures are genuine pilots' monthly statement PDFs (real
 * names and crew numbers embedded), so they are not copied here. This file instead tests the regex-parsing core
 * (`parseMonthlyOverviewText`) against a hand-built, fully synthetic TEXT
 * fixture shaped like plausible PDF-extracted output (see
 * `docs/IMPORTERS.md`'s Monthly Overview section for why real PDF-fidelity
 * testing isn't attempted here).
 */

const FIXTURE_TEXT = readFileSync(
  join(__dirname, "..", "fixtures", "ios", "monthly-overview", "synthetic-extracted-text.txt"),
  "utf8"
);

describe("parseMonthlyOverviewText", () => {
  const result = parseMonthlyOverviewText(FIXTURE_TEXT);

  it("extracts the statement period and dates every flight leg against it", () => {
    const flights = result.entries.filter((e) => e.type === "flight");
    expect(flights.map((e) => e.date).sort()).toEqual(["2025-03-04", "2025-03-10", "2025-03-15"]);
  });

  it("parses flight-leg fields (flight number, route, registration, block times)", () => {
    const flight = result.entries.find((e) => e.flightNumber === "KL1111");
    expect(flight?.from).toBe("AMS"); // no airport data in the test: the code passes through as written
    expect(flight?.to).toBe("LHR");
    expect(flight?.registration).toBe("PHEZA");
    expect(flight?.offBlocks?.totalMinutes).toBe(8 * 60);
    expect(flight?.onBlocks?.totalMinutes).toBe(9 * 60 + 30);
  });

  it("an INITIAL line-check day leaves the role open and flags roleMissingFlight", () => {
    const flight = result.entries.find((e) => e.flightNumber === "KL1111");
    expect(flight?.crew).toHaveLength(0);
    expect(result.importErrors.some((e) => e.code === "roleMissingFlight" && e.flightNumber === "KL1111")).toBe(true);
  });

  it("a RECURRENT line-check day (TCRMI + TLCI on the same day) assigns LCA", () => {
    const flight = result.entries.find((e) => e.flightNumber === "KL2222");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toBe("LCA");
  });

  it("a day with no line-check duty defaults to an unknown role", () => {
    const flight = result.entries.find((e) => e.flightNumber === "KL3333");
    expect(flight?.crew.find((c) => c.refId === "SELF")?.role).toEqual({ unknown: "Unknown" });
  });

  it("merges a day's simulator duty code into a 3.5h FSTD session with the matching role", () => {
    const sim = result.entries.find((e) => e.type === "fstd");
    expect(sim?.date).toBe("2025-03-20");
    expect(sim?.sessionType).toBe("Type Recurrent 1");
    expect(sim?.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_INS");
    expect(sim?.startTime?.totalMinutes).toBe(0);
    expect(sim?.endTime?.totalMinutes).toBe(210);
  });

  it("always flags fstdIdentifierMissing for a statement-derived simulator session", () => {
    expect(result.importErrors.some((e) => e.code === "fstdIdentifierMissing")).toBe(true);
  });

  it("collects distinct aircraft registrations seen across flight legs", () => {
    expect(result.aircraft.map((a) => a.registration).sort()).toEqual(["PHENB", "PHENC", "PHEZA"]);
  });
});

describe("parseMonthlyOverviewText (error cases)", () => {
  it("reports a clear error when no period line is found", () => {
    const result = parseMonthlyOverviewText("no period information here");
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/no month and year found/i);
  });

  it("tolerates an older unpadded period date (e.g. 2007-era single-digit day/month)", () => {
    const result = parseMonthlyOverviewText("Period: From 1-11-2007 to 30-11-2007\nno flights or duties here");
    expect(result.importErrors.some((e) => /no month and year found/i.test(e.reason))).toBe(false);
  });
});

describe("monthlyOverviewImporter (Importer interface)", () => {
  it("parse() accepts pre-extracted text directly", async () => {
    const result = await monthlyOverviewImporter.parse(FIXTURE_TEXT);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("parse() accepts a raw PDF buffer directly, extracting text via unpdf first", async () => {
    const pdf = await buildSyntheticPdf([
      "Period: From 04-03-2025 to 04-03-2025",
      "04 FLT KL1111 08:00 AMS LHR EZA 09:30"
    ]);
    const result = await monthlyOverviewImporter.parse(pdf, { filename: "statement.pdf" });
    expect(result.importErrors.filter((e) => e.reason.includes("Could not extract text"))).toHaveLength(0);
    const flight = result.entries.find((e) => e.flightNumber === "KL1111");
    expect(flight?.date).toBe("2025-03-04");
    expect(flight?.from).toBe("AMS"); // no airport data in the test: the code passes through as written
    expect(flight?.to).toBe("LHR");
  });

  it("parse() reports a clear, non-crashing error for a corrupt PDF instead of throwing", async () => {
    const corrupt = Buffer.from("%PDF-1.4 not actually a valid pdf body");
    const result = await monthlyOverviewImporter.parse(corrupt, { filename: "statement.pdf" });
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/Could not extract text from the PDF/);
    expect(result.importErrors[0]?.sourceFileName).toBe("statement.pdf");
  });

  it("detect() recognizes extracted text containing a Period line", () => {
    expect(monthlyOverviewImporter.detect(Buffer.from(FIXTURE_TEXT, "utf8"), "statement.txt")).toBeGreaterThan(0);
  });
});
