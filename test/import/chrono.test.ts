import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { chronoImporter, makeChronoSimulatorEntry, parseChronoLines } from "../../src/import/importers/chrono.js";
import { entryPersonRoleRawValue } from "../../src/import/model.js";

/** Builds a tiny synthetic PDF (via `pdf-lib`) whose pdfjs-extracted,
 * layout-reconstructed text is one line per given string, enough to
 * exercise the real `%PDF` -> `extractTextByLayout` -> `parseChronoLines`
 * path end to end without a real pilot's real Chrono statement (see the
 * file doc comment on why those can't be copied into this repo). */
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
 * Behavior coverage for the Chrono importer (KLM "Chronologisch overzicht
 * Vlieguren" / cema-staat monthly flight-hours PDF), ported from
 * the Jetlog iOS app's Chrono importer tests.
 *
 * Unlike every other ported importer, there's no real external export
 * format to anchor a fixture file to here: the iOS app's own tests load
 * real pilots' PDF exports, which can't be copied into this repo (personal
 * data). Every `lines: string[]` array below is hand-built
 * directly in this file, constructed to match the one active flight-row
 * regex / simulator duty-code regex, rather than loaded from a fixture.
 */

describe("findPeriod (via parseChronoLines)", () => {
  it("detects month/year from a 'T/M' period line", () => {
    const result = parseChronoLines(["Overzicht periode 01-10-2024 T/M 31-10-2024", "05 KL1234 PHBXA 10:15 AMS CP JFK 18:30"], "chrono.pdf");

    expect(result.importErrors.find((e) => e.reason === "No month and year found")).toBeUndefined();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.date).toBe("2024-10-05");
  });

  it("falls back to a 'Datum:' line when no 'T/M' period is found", () => {
    const result = parseChronoLines(["Datum: 15-11-24", "12 KL5678 PHABC 06:00 AMS CP LHR 08:30"], "chrono.pdf");

    expect(result.importErrors.find((e) => e.reason === "No month and year found")).toBeUndefined();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.date).toBe("2024-11-12");
  });

  it("reports a clear error and zero entries when no period can be found at all", () => {
    const result = parseChronoLines(["just some header text", "nothing date-shaped here"], "chrono.pdf");

    expect(result.entries).toHaveLength(0);
    expect(result.people).toHaveLength(0);
    expect(result.aircraft).toHaveLength(0);
    const error = result.importErrors.find((e) => e.reason === "No month and year found");
    expect(error).toBeDefined();
    expect(error!.sourceFileName).toBe("chrono.pdf");
  });
});

describe("flight-row matching", () => {
  it("matches a basic flight row: date/from/to/times/flightNumber/registration, and remaps CP -> PIC", () => {
    const result = parseChronoLines(
      ["Overzicht periode 01-10-2024 T/M 31-10-2024", "05 KL1234 PHBXA 10:15 AMS CP JFK 18:30"],
      "chrono.pdf"
    );

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe("flight");
    expect(entry.date).toBe("2024-10-05");
    expect(entry.flightNumber).toBe("KL1234");
    expect(entry.registration).toBe("PHBXA");
    expect(entry.from).toBe("AMS"); // no airport data in the test: the code passes through as written
    expect(entry.to).toBe("JFK");
    expect(entry.offBlocks?.totalMinutes).toBe(10 * 60 + 15);
    expect(entry.onBlocks?.totalMinutes).toBe(18 * 60 + 30);

    expect(entry.crew).toHaveLength(1);
    expect(entry.crew[0]!.refId).toBe("SELF");
    expect(entryPersonRoleRawValue(entry.crew[0]!.role)).toBe("PIC"); // CP -> PIC remap

    expect(result.people).toHaveLength(1);
    expect(result.people[0]!.refId).toBe("SELF");
    expect(result.aircraft).toHaveLength(1);
    expect(result.aircraft[0]!.registration).toBe("PHBXA");
  });

  it("passes a non-CP role code straight through unmapped", () => {
    const result = parseChronoLines(
      ["Overzicht periode 01-10-2024 T/M 31-10-2024", "06 KL4321 PHXYZ 09:00 LHR FI ams 11:00".toUpperCase()],
      "chrono.pdf"
    );

    expect(result.entries).toHaveLength(1);
    expect(entryPersonRoleRawValue(result.entries[0]!.crew[0]!.role)).toBe("FI");
  });
});

describe("simulator (FSTD) session rows", () => {
  it("matches a VT1 duty-code row as an FSTD entry with the fstdIdentifierMissing error and the cemaDuty role", () => {
    const result = parseChronoLines(
      ["Overzicht periode 01-10-2024 T/M 31-10-2024", "12 VT1 SIM DUTY 06:00-09:30"],
      "chrono.pdf"
    );

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe("fstd");
    expect(entry.date).toBe("2024-10-12");
    expect(entry.sessionType).toBe("Type Recurrent 1");
    // Statement gives only a duty window, not a real session length -> the
    // 3.5h (210min) default, 00:00-03:30.
    expect(entry.startTime?.totalMinutes).toBe(0);
    expect(entry.endTime?.totalMinutes).toBe(210);

    expect(entry.crew).toHaveLength(1);
    expect(entry.crew[0]!.refId).toBe("SELF");
    expect(entryPersonRoleRawValue(entry.crew[0]!.role)).toBe("FSTD_TRN");

    expect(result.people.some((p) => p.refId === "SELF")).toBe(true);

    const fstdError = result.importErrors.find((e) => e.code === "fstdIdentifierMissing");
    expect(fstdError).toBeDefined();
    expect(fstdError!.dateString).toBe("2024-10-12");
  });

  it("matches a VK duty-code row (another cemaDuty code) as a trainee FSTD session", () => {
    const result = parseChronoLines(["Datum: 01-10-24", "03 VK TYPE QUAL 14:00-17:00"], "chrono.pdf");

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.sessionType).toBe("Type Qualification");
    expect(entryPersonRoleRawValue(result.entries[0]!.crew[0]!.role)).toBe("FSTD_TRN");
  });

  it("does not match non-simulator 'V…' duty codes (VI/VN/VRT)", () => {
    const result = parseChronoLines(["Datum: 01-10-24", "03 VI VRIJ BUREAU", "04 VN NEVENOPDRACHT", "05 VRT VRYE TYD"], "chrono.pdf");

    expect(result.entries).toHaveLength(0);
  });
});

describe("makeChronoSimulatorEntry (ported MonthlyStatementSimulator.makeSession, new-session branch)", () => {
  it("pushes roleMissingSimulator (and still fstdIdentifierMissing) when role is left undetermined", () => {
    const importErrors: ReturnType<typeof parseChronoLines>["importErrors"] = [];
    const entry = makeChronoSimulatorEntry("2024-10-20", "Train SIM Other Duty", undefined, importErrors);

    expect(entry.type).toBe("fstd");
    expect(entry.crew).toHaveLength(0);
    expect(importErrors.some((e) => e.code === "fstdIdentifierMissing")).toBe(true);
    expect(importErrors.some((e) => e.code === "roleMissingSimulator")).toBe(true);
  });

  it("does not push roleMissingSimulator when a role is given", () => {
    const importErrors: ReturnType<typeof parseChronoLines>["importErrors"] = [];
    const entry = makeChronoSimulatorEntry("2024-10-20", "LOE", "FSTD_TRN", importErrors);

    expect(entry.crew).toHaveLength(1);
    expect(importErrors.some((e) => e.code === "roleMissingSimulator")).toBe(false);
    expect(importErrors.some((e) => e.code === "fstdIdentifierMissing")).toBe(true);
  });
});

describe("chronoImporter.parse: real PDF input (pdfjs layout extraction)", () => {
  it("extracts text from a synthetic PDF and parses the reconstructed lines", async () => {
    const pdf = await buildSyntheticPdf(["Overzicht periode 01-10-2024 T/M 31-10-2024", "05 KL1234 PHBXA 10:15 AMS CP JFK 18:30"]);
    const result = await chronoImporter.parse(pdf, { filename: "statement.pdf" });

    expect(result.importErrors.filter((e) => e.reason.includes("Could not extract text"))).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.flightNumber).toBe("KL1234");
    expect(entry.registration).toBe("PHBXA");
  });

  it("reports a clear, non-crashing error for a corrupt PDF instead of throwing", async () => {
    const corrupt = Buffer.from("%PDF-1.4 not actually a valid pdf body");
    const result = await chronoImporter.parse(corrupt, { filename: "statement.pdf" });

    expect(result.entries).toHaveLength(0);
    expect(result.importErrors).toHaveLength(1);
    expect(result.importErrors[0]!.reason).toMatch(/Could not extract text from the PDF/);
    expect(result.importErrors[0]!.sourceFileName).toBe("statement.pdf");
  });

  it("treats non-PDF input as already-extracted plain text lines", async () => {
    const text = "Overzicht periode 01-10-2024 T/M 31-10-2024\n05 KL1234 PHBXA 10:15 AMS CP JFK 18:30";
    const result = await chronoImporter.parse(text, { filename: "statement.txt" });

    expect(result.importErrors.filter((e) => e.reason.includes("PDF text extraction"))).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
  });
});

describe("chronoImporter.detect", () => {
  it("is always low/zero confidence (never auto-detected, only explicit --from chrono)", () => {
    expect(chronoImporter.detect(Buffer.from("%PDF-1.4"), "statement.pdf")).toBe(0);
    expect(chronoImporter.detect(Buffer.from("some plain text"), "statement.txt")).toBe(0);
    expect(chronoImporter.detect(Buffer.alloc(0), undefined)).toBe(0);
  });
});
