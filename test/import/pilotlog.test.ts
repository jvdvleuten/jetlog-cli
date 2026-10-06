import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { pilotLogImporter, pilotLogFileKind, parsePilotLogCsv } from "../../src/import/importers/pilotlog.js";
import { excludingFutureEntries, personDisplayName } from "../../src/import/model.js";

/**
 * Behavior coverage for the PilotLog/CrewLounge/mccPILOTLOG importer, ported
 * from the Jetlog iOS app's PilotLog importer tests. The app's real-named
 * fixtures are deliberately not copied into this repo. All fixtures here
 * are small and hand-built with synthetic names/registrations.
 */

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ios", "pilotlog");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function csv(headers: string[], rows: string[][]): string {
  for (const row of rows) {
    if (row.length !== headers.length) throw new Error(`row length ${row.length} != headers length ${headers.length}`);
  }
  return [headers, ...rows].map((r) => r.join(",")).join("\n");
}

describe("pilotLogFileKind / detect (file-kind routing)", () => {
  it("routes .csv/.txt to the csv kind, everything else to zip", () => {
    expect(pilotLogFileKind("export.csv")).toBe("csv");
    expect(pilotLogFileKind("EXPORT.CSV")).toBe("csv");
    expect(pilotLogFileKind("export.txt")).toBe("csv");
    expect(pilotLogFileKind("backup.zip")).toBe("zip");
    expect(pilotLogFileKind("backup.dat")).toBe("zip");
    expect(pilotLogFileKind(undefined)).toBe("zip");
  });

  it("parse() reports a clear, non-crashing error for a corrupt/truncated zip instead of throwing", async () => {
    const zipLike = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const result = await pilotLogImporter.parse(zipLike, { filename: "backup.zip" });
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason.length).toBeGreaterThan(0);
  });

  it("parse() reports a clear error when a valid zip has no CSV inside", async () => {
    const zipped = Buffer.from(zipSync({ "readme.txt": new TextEncoder().encode("not a csv") }));
    const result = await pilotLogImporter.parse(zipped, { filename: "backup.zip" });
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/no csv file found/i);
  });

  it("parse() unwraps a zipped mccPILOTLOG backup, reading the first top-level .csv", async () => {
    const csvText = readFixture("mcc-classic.csv");
    const zipped = Buffer.from(
      zipSync({
        "readme.txt": new TextEncoder().encode("not a csv"),
        "backup.csv": new TextEncoder().encode(csvText)
      })
    );
    const result = await pilotLogImporter.parse(zipped, { filename: "backup.zip" });
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("parse() ignores a .csv nested in a subfolder (top-level scan only, mirrors the iOS app's non-recursive scan)", async () => {
    const csvText = readFixture("mcc-classic.csv");
    const zipped = Buffer.from(zipSync({ "nested/backup.csv": new TextEncoder().encode(csvText) }));
    const result = await pilotLogImporter.parse(zipped, { filename: "backup.zip" });
    expect(result.entries).toHaveLength(0);
    expect(result.importErrors[0]?.reason).toMatch(/no csv file found/i);
  });

  it("detect() recognizes a zipped mccPILOTLOG backup via its contained CSV", () => {
    const csvText = readFixture("mcc-classic.csv");
    const zipped = Buffer.from(zipSync({ "backup.csv": new TextEncoder().encode(csvText) }));
    expect(pilotLogImporter.detect(zipped, "backup.zip")).toBeGreaterThan(0);
  });

  it("detect() recognizes classic mccPILOTLOG CSV shape", () => {
    const buf = Buffer.from(readFixture("mcc-classic.csv"), "utf8");
    expect(pilotLogImporter.detect(buf, "export.csv")).toBeGreaterThan(0);
  });
});

describe("classic mccPILOTLOG desktop export (comma, lowercase headers, mcc_date)", () => {
  const result = parsePilotLogCsv(readFixture("mcc-classic.csv"));

  it("imports one entry per row, including the FSTD row", () => {
    expect(result.entries).toHaveLength(5);
    expect(result.entries.filter((e) => e.type === "fstd")).toHaveLength(1);
    expect(result.entries.filter((e) => e.type === "flight")).toHaveLength(4);
  });

  it("resolves SELF's role from time columns, not just seat position", () => {
    const picFlight = result.entries.find((e) => e.flightNumber === "KL1001" && !e.isDuplicateInFile);
    expect(picFlight?.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");

    const coPilotFlight = result.entries.find((e) => e.flightNumber === "KL1002");
    expect(coPilotFlight?.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
    // Pilot1 in that row is a named captain, not SELF, and gets the PIC seat role.
    const captain = result.people.find((p) => personDisplayName(p) === "Anna Bakker");
    expect(captain).toBeDefined();
    expect(coPilotFlight?.crew.find((c) => c.refId === captain!.refId)?.role).toBe("PIC");
  });

  it("flags missing registration/origin/destination on a row with blank fields", () => {
    const errors = result.importErrors.filter((e) => e.flightNumber === "KL1004");
    expect(errors.map((e) => e.code).sort()).toEqual(["destinationAirportMissing", "originAirportMissing", "registrationMissing"]);
  });

  it("detects the in-file duplicate (same date/flight number/route) and keeps the more complete copy", () => {
    const dupWarning = result.importErrors.find((e) => e.code === "duplicateRowsInFile");
    expect(dupWarning).toBeDefined();
    const kl1001Rows = result.entries.filter((e) => e.flightNumber === "KL1001");
    expect(kl1001Rows).toHaveLength(2);
    expect(kl1001Rows.filter((e) => e.isDuplicateInFile)).toHaveLength(1);
    expect(kl1001Rows.find((e) => e.isDuplicateInFile)?.crew ?? []).toHaveLength(0);
  });

  it("the FSTD row with no sessionType-implying text defaults SELF to FSTD trainee", () => {
    const fstd = result.entries.find((e) => e.type === "fstd");
    expect(fstd?.fstdId).toBe("NL-249");
    expect(fstd?.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_TRN");
  });

  it("also collects the FSTD device id as an 'aircraft' registration (ported iOS app quirk, not a bug introduced here)", () => {
    expect(result.aircraft.map((a) => a.registration).sort()).toEqual(["NL249", "PHABC"]);
  });
});

describe("raw CrewLounge/PilotLog web export (semicolon, UPPERCASE, is_prevexp, DD-MM-YYYY, integer minutes, BOM+CRLF)", () => {
  const result = parsePilotLogCsv(readFixture("crewlounge-raw.csv"));

  it("imports flights and a previous-experience bulk row", () => {
    const flights = result.entries.filter((e) => e.type === "flight" && !e.isBulk);
    const bulk = result.entries.filter((e) => e.isBulk);
    expect(flights).toHaveLength(2);
    expect(bulk).toHaveLength(1);
  });

  it("parses DD-MM-YYYY dates correctly (not misread as YYYY-MM-DD)", () => {
    const owner = result.entries.find((e) => e.flightNumber === "KL2001");
    expect(owner?.date).toBe("2026-01-10");
  });

  it("folds the dominant PILOT1 name into SELF instead of creating a duplicate person", () => {
    expect(result.people.some((p) => personDisplayName(p) === "Jan de Vries")).toBe(false);
    const owner = result.entries.find((e) => e.flightNumber === "KL2001");
    expect(owner?.crew.find((c) => c.refId === "SELF")).toBeDefined();
    expect(result.importErrors.some((e) => e.code === "roleMissingFlight")).toBe(false);
  });

  it("blank-pilot-slot CRCP credit: derives coPilot time as block - 60 - relief, not raw relief minutes", () => {
    const reliefFlight = result.entries.find((e) => e.flightNumber === "KL2002");
    expect(reliefFlight?.crew.find((c) => c.refId === "SELF")?.role).toBe("CRCP");
    expect(reliefFlight?.manualTimes?.coPilot?.totalMinutes).toBe(390); // 600 - 60 - 150
    expect(reliefFlight?.manualTimes?.cruiseReliefCoPilot).toBeUndefined();
  });

  it("previous-experience bulk row keeps an explicit zero night/IFR override instead of dropping it", () => {
    const bulk = result.entries.find((e) => e.isBulk);
    expect(bulk?.manualTimes?.totalTimeOfFlight?.totalMinutes).toBe(50000);
    expect(bulk?.manualTimes?.night?.totalMinutes).toBe(0);
    expect(bulk?.manualTimes?.ifr?.totalMinutes).toBe(0);
    expect(bulk?.from).toBeUndefined();
    expect(bulk?.to).toBeUndefined();
  });
});

describe("blank-pilot-slot SELF fallback on a NON-raw export (no is_prevexp header)", () => {
  const headers = [
    "mcc_date",
    "flightnumber",
    "ac_reg",
    "af_dep",
    "af_arr",
    "time_dep",
    "time_to",
    "time_ldg",
    "time_arr",
    "to_day",
    "to_night",
    "ldg_day",
    "ldg_night",
    "time_total",
    "time_picus",
    "pilot1_id",
    "pilot1_name"
  ];

  it("fires when the row has an own pilot-function time signal", () => {
    const row = ["2026-02-01", "KL500", "PHDEF", "EHAM", "LEMD", "08:00", "08:10", "11:10", "11:20", "1", "0", "1", "0", "3:20", "3:20", "", ""];
    const result = parsePilotLogCsv(csv(headers, [row]));
    const entry = result.entries[0]!;
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("PICUS");
    expect(result.importErrors.some((e) => e.code === "roleMissingFlight")).toBe(false);
  });

  it("stays roleMissingFlight when the row has no name AND no own-time signal", () => {
    const row = ["2026-02-02", "KL501", "PHDEF", "EHAM", "LEMD", "08:00", "08:10", "11:10", "11:20", "1", "0", "1", "0", "3:20", "0:00", "", ""];
    const result = parsePilotLogCsv(csv(headers, [row]));
    const entry = result.entries[0]!;
    expect(entry.crew.find((c) => c.refId === "SELF")).toBeUndefined();
    expect(result.importErrors.some((e) => e.code === "roleMissingFlight" && e.entryId === entry.id)).toBe(true);
  });
});

describe("zero-time overrides on a flight row are KEPT, not filtered (step 5b zero-sweep exemption for explicit values)", () => {
  it("an explicit 0:00 time_night/time_ifr survives as a manual override", () => {
    const headers = [
      "pilotlog_date",
      "is_prevexp",
      "flightnumber",
      "ac_reg",
      "af_dep",
      "af_arr",
      "time_dep",
      "time_to",
      "time_ldg",
      "time_arr",
      "to_day",
      "to_night",
      "ldg_day",
      "ldg_night",
      "time_total",
      "time_night",
      "time_ifr"
    ];
    const row = [
      "2026-01-05",
      "FALSE",
      "KL123",
      "PHBXA",
      "EHAM",
      "EGLL",
      "10:00",
      "10:15",
      "11:15",
      "11:30",
      "1",
      "0",
      "1",
      "0",
      "1:30",
      "0:00",
      "0:00"
    ];
    const result = parsePilotLogCsv(csv(headers, [row]));
    const entry = result.entries[0]!;
    expect(entry.manualTimes?.night?.totalMinutes).toBe(0);
    expect(entry.manualTimes?.ifr?.totalMinutes).toBe(0);
  });

  it("the role-attribution zero-sweep still clears a stray 0:00 pilot-function bucket left over from a blank column", () => {
    // time_sic is present but "0:00" on a PIC row, a blank-cell artifact, not a deliberate zero override.
    const headers = [
      "mcc_date",
      "flightnumber",
      "ac_reg",
      "af_dep",
      "af_arr",
      "time_dep",
      "time_to",
      "time_ldg",
      "time_arr",
      "to_day",
      "to_night",
      "ldg_day",
      "ldg_night",
      "time_total",
      "time_pic",
      "time_sic",
      "pilot1_id",
      "pilot1_name"
    ];
    const row = ["2026-01-06", "KL700", "PHGHI", "EHAM", "LOWW", "09:00", "09:10", "10:35", "10:40", "1", "0", "1", "0", "1:40", "1:40", "0:00", "1", "SELF"];
    const result = parsePilotLogCsv(csv(headers, [row]));
    const entry = result.entries[0]!;
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("PIC");
    expect(entry.manualTimes?.coPilot).toBeUndefined();
  });
});

describe("PICUS lossless retag (co-pilot seat row whose TIME_PICUS equals the full block)", () => {
  const headers = [
    "pilotlog_date",
    "is_prevexp",
    "flightnumber",
    "ac_reg",
    "af_dep",
    "af_arr",
    "time_dep",
    "time_to",
    "time_ldg",
    "time_arr",
    "to_day",
    "to_night",
    "ldg_day",
    "ldg_night",
    "time_total",
    "time_sic",
    "time_picus",
    "pilot1_id",
    "pilot1_name",
    "pilot2_id",
    "pilot2_name"
  ];

  it("retags a full-block PICUS-on-SIC row to PICUS and clears the now-redundant picus override", () => {
    const row = [
      "2026-03-01",
      "FALSE",
      "KL800",
      "PHJKL",
      "EHAM",
      "LFPG",
      "10:00",
      "10:10",
      "11:10",
      "11:20",
      "1",
      "0",
      "1",
      "0",
      "3:00",
      "0:00",
      "3:00",
      "9001",
      "Captain Smith",
      "9002",
      "SELF"
    ];
    const result = parsePilotLogCsv(csv(headers, [row]));
    const entry = result.entries[0]!;
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("PICUS");
    expect(entry.manualTimes?.picus).toBeUndefined();
  });

  it("a plain full-block SIC row (no picus column) stays Co-pilot", () => {
    const row = [
      "2026-03-02",
      "FALSE",
      "KL801",
      "PHJKL",
      "LFPG",
      "EHAM",
      "10:00",
      "10:10",
      "11:10",
      "11:20",
      "1",
      "0",
      "1",
      "0",
      "3:00",
      "3:00",
      "0:00",
      "9001",
      "Captain Smith",
      "9002",
      "SELF"
    ];
    const result = parsePilotLogCsv(csv(headers, [row]));
    const entry = result.entries[0]!;
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("CP");
  });
});

describe("FSTD training-session codes (KLM TS-codes decoded from flightlog/training free text)", () => {
  const headers = [
    "pilotlog_date",
    "flightnumber",
    "ac_reg",
    "time_dep",
    "time_arr",
    "time_total",
    "time_instructor",
    "ac_issim",
    "pilot1_id",
    "pilot1_name",
    "flightlog",
    "training"
  ];

  function trainingRow(date: string, text: string, timeInstructor = "00:00"): string[] {
    return [date, "", "NL-249", "10:00", "13:30", "03:30", timeInstructor, "sim", "1001", "SELF", text, ""];
  }

  it("TSLOEI maps sessionType LOE and role fstdInstructor", () => {
    const result = parsePilotLogCsv(csv(headers, [trainingRow("2026-04-01", "TSLOEI")]));
    const entry = result.entries[0]!;
    expect(entry.sessionType).toBe("LOE");
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_INS");
  });

  it("a code with no role implication (TSLPC) falls back to the time_instructor heuristic", () => {
    const result = parsePilotLogCsv(csv(headers, [trainingRow("2026-04-02", "TSLPC", "01:00")]));
    const entry = result.entries[0]!;
    expect(entry.sessionType).toBe("LPC");
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_INS");
  });

  it("an unrecognised TS-shaped code is never guessed at: sessionType stays undefined, role falls back unchanged", () => {
    const result = parsePilotLogCsv(csv(headers, [trainingRow("2026-04-03", "TSXYZ", "01:00")]));
    const entry = result.entries[0]!;
    expect(entry.sessionType).toBeUndefined();
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_INS");
  });

  it("more than one distinct code on a row is ambiguous: never guess", () => {
    const result = parsePilotLogCsv(csv(headers, [trainingRow("2026-04-04", "TSLPC TSPQS", "00:00")]));
    const entry = result.entries[0]!;
    expect(entry.sessionType).toBeUndefined();
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_TRN");
  });

  it("TSEAOC maps the logging pilot as the examiner assessee (unreachable via the time_instructor fallback alone)", () => {
    const result = parsePilotLogCsv(csv(headers, [trainingRow("2026-04-05", "TSEAOC", "00:00")]));
    const entry = result.entries[0]!;
    expect(entry.sessionType).toBe("Assessment of Competence");
    expect(entry.crew.find((c) => c.refId === "SELF")?.role).toBe("FSTD_EXA");
  });
});

describe("Priority-3 free-text simulator fallback (isSimulatorEntry's last-resort path)", () => {
  const headers = [
    "pilotlog_date",
    "flightnumber",
    "ac_reg",
    "af_dep",
    "af_arr",
    "time_dep",
    "time_to",
    "time_ldg",
    "time_arr",
    "to_day",
    "to_night",
    "ldg_day",
    "ldg_night",
    "time_total",
    "time_air",
    "time_night",
    "time_xc",
    "time_pic",
    "time_dual",
    "ac_issim",
    "flightlog",
    "remarks",
    "training"
  ];

  function baseRow(date: string, overrides: Record<string, string> = {}): string[] {
    const values: Record<string, string> = {
      pilotlog_date: date,
      flightnumber: "",
      ac_reg: "",
      af_dep: "AMS",
      af_arr: "AMS",
      time_dep: "10:00",
      time_to: "00:00",
      time_ldg: "00:00",
      time_arr: "11:00",
      to_day: "0",
      to_night: "0",
      ldg_day: "0",
      ldg_night: "0",
      time_total: "03:30",
      time_air: "00:00",
      time_night: "00:00",
      time_xc: "00:00",
      time_pic: "00:00",
      time_dual: "00:00",
      ac_issim: "",
      flightlog: "",
      remarks: "",
      training: "",
      ...overrides
    };
    return headers.map((h) => values[h] ?? "");
  }

  it("free-text keyword match (5a) classifies a same-airport, no-reg, nonzero-duration row as FSTD", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-01", { flightlog: "Simulator sessie D1" })]));
    expect(result.entries[0]?.type).toBe("fstd");
  });

  it("an explicit ac_issim value vetoes the free-text fallback even when the text mentions 'sim'", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-02", { ac_issim: "false", flightlog: "simulator session" })]));
    expect(result.entries[0]?.type).toBe("flight");
  });

  it("different departure/arrival airports veto the fallback regardless of free text", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-03", { af_arr: "LHR", flightlog: "simulator session" })]));
    expect(result.entries[0]?.type).toBe("flight");
  });

  it("a real registration vetoes the fallback even with sim-shaped structure and text", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-04", { ac_reg: "PHBXA", flightlog: "simulator session" })]));
    expect(result.entries[0]?.type).toBe("flight");
  });

  it("structural no-text path (5b): a blank flightnumber + sim-shaped row with NO sim text still classifies as FSTD", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-05")]));
    expect(result.entries[0]?.type).toBe("fstd");
  });

  it("structural no-text path is vetoed by a real flight number (returns to departure airport is still a real flight)", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-06", { flightnumber: "KL1551" })]));
    expect(result.entries[0]?.type).toBe("flight");
  });

  it("structural no-text path accepts a sim-slot designator flight number (e.g. 'E2')", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-07", { flightnumber: "E2" })]));
    expect(result.entries[0]?.type).toBe("fstd");
  });

  it("a zero time_total (no logged duration) is never swept up as a sim purely from free text", () => {
    const result = parsePilotLogCsv(csv(headers, [baseRow("2026-05-08", { time_total: "00:00", flightlog: "Sim briefing" })]));
    expect(result.entries[0]?.type).toBe("flight");
  });
});

describe("raw-integer-minutes duration parsing (PilotLog's own duration variant vs. H:MM)", () => {
  it("TIME_TOTAL as a bare integer (raw export) parses the same as the equivalent H:MM would", () => {
    const headers = [
      "pilotlog_date",
      "is_prevexp",
      "flightnumber",
      "ac_reg",
      "af_dep",
      "af_arr",
      "time_dep",
      "time_to",
      "time_ldg",
      "time_arr",
      "to_day",
      "to_night",
      "ldg_day",
      "ldg_night",
      "time_total"
    ];
    const row = ["2026-06-01", "FALSE", "KL900", "PHMNO", "EHAM", "EDDF", "08:00", "08:10", "09:15", "09:20", "1", "0", "1", "0", "75"];
    const result = parsePilotLogCsv(csv(headers, [row]));
    const entry = result.entries[0]!;
    // 75 raw minutes == 1:15, applied as the authoritative block duration on top of offBlocks 08:00 -> 09:15.
    expect(entry.onBlocks?.totalMinutes).toBe(9 * 60 + 15);
  });
});

describe("date parsing: DD/MM/YYYY and dotted DD.MM.YYYY variants", () => {
  const headers = [
    "pilotlog_date",
    "is_prevexp",
    "flightnumber",
    "ac_reg",
    "af_dep",
    "af_arr",
    "time_dep",
    "time_to",
    "time_ldg",
    "time_arr",
    "to_day",
    "to_night",
    "ldg_day",
    "ldg_night",
    "time_total"
  ];

  it("parses DD/MM/YYYY (slash-separated)", () => {
    const row = ["30/09/2026", "FALSE", "KL1", "PHAAA", "EHAM", "EDDF", "08:00", "08:10", "09:00", "09:10", "0", "0", "0", "0", "60"];
    const result = parsePilotLogCsv(csv(headers, [row]));
    expect(result.entries[0]?.date).toBe("2026-09-30");
  });

  it("parses dotted DD.MM.YYYY (Swiss/German-locale export)", () => {
    const row = ["30.09.2026", "FALSE", "KL1", "PHAAA", "EHAM", "EDDF", "08:00", "08:10", "09:00", "09:10", "0", "0", "0", "0", "60"];
    const result = parsePilotLogCsv(csv(headers, [row]));
    expect(result.entries[0]?.date).toBe("2026-09-30");
  });
});

describe("excludingFutureEntries integration (caller-level, same as every other-logbook importer)", () => {
  it("a PilotLog result with a future-dated roster row drops only that row and reports one skip notice", () => {
    const headers = [
      "pilotlog_date",
      "is_prevexp",
      "flightnumber",
      "ac_reg",
      "af_dep",
      "af_arr",
      "time_dep",
      "time_to",
      "time_ldg",
      "time_arr",
      "to_day",
      "to_night",
      "ldg_day",
      "ldg_night",
      "time_total"
    ];
    const past = ["2026-07-01", "FALSE", "KL10", "PHAAA", "EHAM", "EDDF", "08:00", "08:10", "09:00", "09:10", "0", "0", "0", "0", "60"];
    const future = ["2026-07-20", "FALSE", "KL11", "PHAAA", "EDDF", "EHAM", "08:00", "08:10", "09:00", "09:10", "0", "0", "0", "0", "60"];
    const result = parsePilotLogCsv(csv(headers, [past, future]));
    expect(result.entries).toHaveLength(2);

    const filtered = excludingFutureEntries(result, "2026-07-14");
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0]?.flightNumber).toBe("KL10");
    expect(filtered.importErrors.some((e) => e.code === "futureEntriesSkipped")).toBe(true);
  });
});
