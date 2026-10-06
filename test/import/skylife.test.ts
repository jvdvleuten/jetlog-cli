import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skylifeImporter, parseSkylifeCsv, cleanSkylifeName, parseSkylifeName } from "../../src/import/importers/skylife.js";
import { personDisplayName } from "../../src/import/model.js";

/**
 * Behavior coverage for the Skylife importer, ported from
 * the Jetlog iOS app's Skylife importer tests. The app's real-named fixture
 * (~2000 rows of a real pilot's logbook) is not copied into this repo. All fixtures here are small and hand-built with synthetic
 * names/registrations/flight numbers.
 *
 * Skipped app test groups (no offline equivalent / DB-matched-row
 * behavior, see `model.ts`'s file doc comment and this importer's own):
 *  - Tests that run against the real 2000-row fixture for whole-logbook
 *    regression totals are not reproducible without that file;
 *    the structural behaviors they exercise (FSTD split, role resolution,
 *    date range) are covered here with small synthetic rows instead.
 *  - The top-level `importLogbook` "most frequent crew member is SELF"
 *    reconciliation pass is DB-backed and skipped
 *    entirely in this port, see the importer's file doc comment.
 */

const FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "ios", "skylife", "synthetic.csv"), "utf8");

describe("skylifeImporter.detect", () => {
  it("recognizes the Skylife header shape", () => {
    const buf = Buffer.from(FIXTURE, "utf8");
    expect(skylifeImporter.detect(buf, "export.csv")).toBeGreaterThan(0);
  });

  it("does not claim an unrelated CSV", () => {
    const buf = Buffer.from('"date","flight","from","to"\n"2026-01-01","123","AMS","LHR"\n', "utf8");
    expect(skylifeImporter.detect(buf, "export.csv")).toBe(0);
  });
});

describe("header rejection", () => {
  it("reports a clear import error (not a throw) when a required header is missing", () => {
    const csv = '"DATE";"FLIGHT";"FROM";"TO"\n"01/01/2026";"1234";"AMS";"LHR"\n';
    const result = parseSkylifeCsv(csv);
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/not found/i);
  });

  it("reports a clear import error for empty CSV content", () => {
    const result = parseSkylifeCsv("");
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/empty/i);
  });
});

describe("parsing the synthetic fixture", () => {
  const result = parseSkylifeCsv(FIXTURE);

  it("splits SIM rows into FSTD entries and the rest into flight entries", () => {
    const fstdEntries = result.entries.filter((e) => e.type === "fstd");
    const flightEntries = result.entries.filter((e) => e.type === "flight");
    expect(fstdEntries).toHaveLength(2);
    expect(flightEntries.length).toBeGreaterThan(0);
  });

  it("resolves the holder's role from which of PIC/COP literally says 'Self', not seat position", () => {
    const pilotRole = result.entries.find((e) => e.flightNumber === "1001");
    expect(pilotRole?.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");

    // 1002: COP=Self but PIC also != "Self" -> still resolves via the PIC column, CP.
    const copilotRole = result.entries.find((e) => e.flightNumber === "1002");
    expect(copilotRole?.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
    const namedPic = result.people.find((p) => personDisplayName(p) === "IAN FROST");
    expect(namedPic).toBeDefined();
    expect(copilotRole?.crew.find((c) => c.refId === namedPic!.refId)?.role).toBe("PIC");
  });

  it("parses dd/MM/yyyy dates (not misread as yyyy/MM/dd)", () => {
    const entry = result.entries.find((e) => e.flightNumber === "1001");
    expect(entry?.date).toBe("2026-01-10");
  });

  it("imports a night-time flight with the NIGHT column as an authoritative manual time", () => {
    const entry = result.entries.find((e) => e.flightNumber === "1002");
    expect(entry?.manualTimes?.night?.totalMinutes).toBe(86);
  });

  it("imports an IFR flight with the IFR column as an authoritative manual time", () => {
    const entry = result.entries.find((e) => e.flightNumber === "1001");
    expect(entry?.manualTimes?.ifr?.totalMinutes).toBe(291);
  });

  it("handles a block that crosses midnight (red-eye wrap)", () => {
    const entry = result.entries.find((e) => e.flightNumber === "1003");
    expect(entry?.offBlocks?.totalMinutes).toBe(23 * 60 + 10);
    expect(entry?.onBlocks?.totalMinutes).toBe(40);
  });

  it("FSTD role: no instructor time -> trainee, instructor time logged -> instructor", () => {
    const fstdEntries = result.entries.filter((e) => e.type === "fstd");
    const trainee = fstdEntries.find((e) => e.fstdId === "XOA");
    const instructor = fstdEntries.find((e) => e.fstdId === "XBH");
    expect(trainee?.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_TRN");
    expect(instructor?.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_INS");
    expect(trainee?.startTime?.totalMinutes).toBe(18 * 60 + 30);
    expect(trainee?.endTime?.totalMinutes).toBe(22 * 60 + 30);
  });

  it("ground-training rows (no FROM/TO/REG) are imported anyway, flagged with missing-field errors", () => {
    const groundTraining = result.entries.find((e) => e.type === "flight" && e.remarks === "Ground training");
    expect(groundTraining).toBeDefined();
    expect(groundTraining?.registration).toBeUndefined();
    expect(groundTraining?.from).toBeUndefined();
    expect(groundTraining?.to).toBeUndefined();

    const errorsForRow = result.importErrors.filter((e) => e.entryId === groundTraining?.id);
    expect(errorsForRow.map((e) => e.code).sort()).toEqual(["destinationAirportMissing", "originAirportMissing", "registrationMissing"]);
  });

  it("DAY LDG/NIGHT LDG is a day/night flag, OWN LDG is the per-pilot count; takeoffs are always 0", () => {
    const withLanding = result.entries.find((e) => e.flightNumber === "1001");
    expect(withLanding?.takeoffsAndLandings).toEqual({ type: "manual", takeoffsDay: 0, takeoffsNight: 0, landingsDay: 1, landingsNight: 0 });

    const nightLanding = result.entries.find((e) => e.flightNumber === "1002");
    expect(nightLanding?.takeoffsAndLandings).toEqual({ type: "manual", takeoffsDay: 0, takeoffsNight: 0, landingsDay: 0, landingsNight: 0 });
  });

  it("flags the in-file duplicate (same date/flight/route) and keeps the more complete copy", () => {
    const dupWarning = result.importErrors.find((e) => e.code === "duplicateRowsInFile");
    expect(dupWarning).toBeDefined();
    const copies = result.entries.filter((e) => e.flightNumber === "1001");
    expect(copies).toHaveLength(2);
    expect(copies.filter((e) => e.isDuplicateInFile)).toHaveLength(1);
    // The more complete copy (crew + remarks) survives unflagged.
    expect(copies.find((e) => !e.isDuplicateInFile)?.remarks).toBe("Normal sector test");
  });

  it("de-duplicates a crew name across decorated and clean spellings into one person", () => {
    const matches = result.people.filter((p) => p.lastName === "DE HAAN" && p.firstName === "STEPHAN");
    expect(matches).toHaveLength(1);
  });

  it("retags a co-pilot-seat row whose P1/S (picus) column equals the full block as PICUS", () => {
    const entry = result.entries.find((e) => e.flightNumber === "1010");
    expect(entry?.crew.find((c) => c.refId === "SELF")?.role).toBe("PICUS");
  });
});

describe("cleanSkylifeName", () => {
  it("strips rank tags, star noise, percentages, and parenthesized/truncated tokens", () => {
    expect(cleanSkylifeName("DE HAAN STEPHAN***")).toBe("DE HAAN STEPHAN");
    expect(cleanSkylifeName("PENDRY Chris SR")).toBe("PENDRY Chris");
    expect(cleanSkylifeName("ANSELL PHILIP 50%")).toBe("ANSELL PHILIP");
    expect(cleanSkylifeName("BAARS RODERICK (PAS")).toBe("BAARS RODERICK");
    expect(cleanSkylifeName("")).toBeUndefined();
  });
});

describe("parseSkylifeName", () => {
  it("splits SURNAME FIRSTNAME, keeping leading particles with the surname", () => {
    expect(parseSkylifeName("FROST IAN")).toEqual({ firstName: "IAN", lastName: "FROST" });
    expect(parseSkylifeName("VAN DE WIEL MICHIEL")).toEqual({ firstName: "MICHIEL", lastName: "VAN DE WIEL" });
    expect(parseSkylifeName("DE VRIES SJOERD")).toEqual({ firstName: "SJOERD", lastName: "DE VRIES" });
    expect(parseSkylifeName("SMITH")).toEqual({ firstName: undefined, lastName: "SMITH" });
  });
});
