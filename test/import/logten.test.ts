import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";
import { logTenImporter, type LogTenImportOptions } from "../../src/import/importers/logten/logten.js";
import { parseLogTenAddressBook, mergeLogTenPeople } from "../../src/import/importers/logten/address-book.js";
import type { ImportedEntryCrewMember, ImportResult } from "../../src/import/model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ios", "logten");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function parse(fixtureName: string, options?: LogTenImportOptions) {
  // Most fixtures list two crew names equally often, which the importer refuses to guess; name the user.
  return logTenImporter.parse(fixture(fixtureName), { selfName: "Jane Doe", ...options });
}

function crewRole(crew: ImportedEntryCrewMember[], refId: string): string | undefined {
  const member = crew.find((c) => c.refId === refId);
  return member ? (typeof member.role === "string" ? member.role : member.role.unknown) : undefined;
}

describe("logTenImporter.detect", () => {
  it("recognizes a LogTen Flights export by header", () => {
    const confidence = logTenImporter.detect(Buffer.from(fixture("basic-flights.txt")), "basic-flights.txt");
    expect(confidence).toBeGreaterThan(0);
  });

  it("does not claim a LogTen Address Book export", () => {
    const confidence = logTenImporter.detect(Buffer.from(fixture("address-book.txt")), "address-book.txt");
    expect(confidence).toBe(0);
  });

  it("does not claim unrelated content", () => {
    const confidence = logTenImporter.detect(Buffer.from("not,a,logten,file\n1,2,3,4"), "x.csv");
    expect(confidence).toBe(0);
  });
});

describe("basic flight row parsing and role resolution", () => {
  let result: ImportResult;
  beforeAll(async () => {
    result = await parse("basic-flights.txt");
  });

  it("parses PIC/CP/CRCP/deadhead rows with no fatal errors", () => {
    // 5 source rows -> 5 entries (no bulk splitting here).
    expect(result.entries.length).toBe(5);
  });

  it("resolves the self person (most frequent crew name) to PIC on a PIC row", () => {
    const picRow = result.entries.find((e) => e.flightNumber === "KL1023" && e.crew.length > 0)!;
    expect(crewRole(picRow.crew, "SELF")).toBe("PIC");
  });

  it("resolves the self person to CP (co-pilot) on an SIC row", () => {
    const entry = result.entries.find((e) => e.flightNumber === "KL1024")!;
    expect(crewRole(entry.crew, "SELF")).toBe("CP");
  });

  it("resolves a positive relief time to CRCP regardless of the selected crew seat", () => {
    const entry = result.entries.find((e) => e.flightNumber === "KL1900")!;
    expect(crewRole(entry.crew, "SELF")).toBe("CRCP");
    // CRCP role-based attribution supersedes the raw relief override.
    expect(entry.manualTimes?.cruiseReliefCoPilot).toBeUndefined();
  });

  it("gives a deadhead row the DH role and skips the 'Dead Heading' placeholder name", () => {
    const entry = result.entries.find((e) => e.flightNumber === "KL605")!;
    expect(entry.crew.some((c) => c.refId === "Dead Heading")).toBe(false);
    expect(crewRole(entry.crew, "SELF")).toBe("DH");
  });

  it("flags the less-complete duplicate-in-file KL1023 row and keeps the complete one selected", () => {
    const kl1023Rows = result.entries.filter((e) => e.flightNumber === "KL1023");
    expect(kl1023Rows.length).toBe(2);
    const flagged = kl1023Rows.filter((e) => e.isDuplicateInFile);
    const winner = kl1023Rows.find((e) => !e.isDuplicateInFile)!;
    expect(flagged.length).toBe(1);
    // The flagged (less-complete) copy only ever gained the self person via
    // the generic second pass; the winning copy kept its real PIC+SIC crew.
    expect(flagged[0]!.crew.length).toBeLessThan(winner.crew.length);
    expect(result.importErrors.some((e) => e.code === "duplicateRowsInFile")).toBe(true);
  });

  it("produces people for every distinct crew name seen", () => {
    const refIds = result.people.map((p) => p.refId);
    expect(refIds).toContain("SELF");
    expect(refIds).not.toContain("Jane Doe");
    expect(refIds).toContain("John Smith");
  });

  it("resolves the registration via Aircraft.clean_registration-equivalent cleaning", () => {
    const entry = result.entries.find((e) => e.flightNumber === "KL1023" && e.crew.length > 0)!;
    expect(entry.registration).toBe("PHABC");
  });
});

describe("partial-SIC strategy", () => {
  it("creditFullBlock (default): drops the partial co-pilot column (the role gets the full block)", async () => {
    const result = await parse("partial-sic.txt");
    const entry = result.entries.find((e) => e.flightNumber === "KL201")!;
    expect(crewRole(entry.crew, "SELF")).toBe("CP");
    expect(entry.manualTimes?.coPilot).toBeUndefined();
  });

  it("preserveLoggedSeatTime: keeps the logged partial amount as a manual override", async () => {
    const result = await parse("partial-sic.txt", { partialSICStrategy: "preserveLoggedSeatTime" });
    const entry = result.entries.find((e) => e.flightNumber === "KL201")!;
    expect(crewRole(entry.crew, "SELF")).toBe("CP");
    expect(entry.manualTimes?.coPilot?.totalMinutes).toBe(90);
  });
});

describe("custom Duty switch mapping", () => {
  it("leaves an unmapped switch alone (resolves via the normal function-time columns)", async () => {
    const result = await parse("custom-switches.txt");
    const entry = result.entries.find((e) => e.flightNumber === "KL301")!;
    // flight_sic equals the whole block -> CP (no mapping applied).
    expect(crewRole(entry.crew, "SELF")).toBe("CP");
  });

  it("a mapped switch overrides the function-time-derived role and clears the stale columns", async () => {
    const result = await parse("custom-switches.txt", {
      customSwitchMapping: { roles: { 1: "RI" }, winners: {} }
    });
    const entry = result.entries.find((e) => e.flightNumber === "KL301")!;
    expect(crewRole(entry.crew, "SELF")).toBe("RI");
    expect(entry.manualTimes?.coPilot).toBeUndefined();
  });

  it("two mapped switches to different roles with no recorded winner report a conflict", async () => {
    const result = await parse("custom-switches.txt", {
      customSwitchMapping: { roles: { 1: "RI", 2: "PIC" }, winners: {} }
    });
    expect(result.importErrors.some((e) => e.code === "logTenCustomSwitchConflict")).toBe(true);
  });

  it("two mapped switches to different roles WITH a recorded winner resolve to the winner", async () => {
    const result = await parse("custom-switches.txt", {
      customSwitchMapping: { roles: { 1: "RI", 2: "PIC" }, winners: { [1 * 100 + 2]: 2 } }
    });
    const entry = result.entries.find((e) => e.flightNumber === "KL302")!;
    expect(crewRole(entry.crew, "SELF")).toBe("PIC");
  });
});

describe("bulk (>=24h) mixed-role split", () => {
  let result: ImportResult;
  beforeAll(async () => {
    result = await parse("bulk-split.txt");
  });

  it("splits a mixed PIC+SIC bulk row into one entry per role plus an unassigned remainder", () => {
    const ferryEntries = result.entries.filter((e) => e.flightNumber === "FERRY1");
    // PIC (20h) + SIC (8h) + remainder (2h) = 3 entries from 1 source row.
    expect(ferryEntries.length).toBe(3);
    expect(ferryEntries.every((e) => e.isBulk)).toBe(true);

    const remainder = ferryEntries.find((e) => (e.remarks ?? "").includes("[Unassigned remainder]"));
    expect(remainder).toBeDefined();
    expect(remainder!.manualTimes?.totalTimeOfFlight?.totalMinutes).toBe(2 * 60);

    expect(result.importErrors.some((e) => e.reason.includes("Mixed bulk flight row split"))).toBe(true);
  });

  it("each split component carries only its own role's manual time", () => {
    const ferryEntries = result.entries.filter((e) => e.flightNumber === "FERRY1");
    const picSplit = ferryEntries.find((e) => (e.remarks ?? "").includes("[Split PIC]"));
    const sicSplit = ferryEntries.find((e) => (e.remarks ?? "").includes("[Split SIC]"));
    expect(picSplit!.manualTimes?.totalTimeOfFlight?.totalMinutes).toBe(20 * 60);
    expect(sicSplit!.manualTimes?.totalTimeOfFlight?.totalMinutes).toBe(8 * 60);
  });
});

describe("approach + autoland parsing", () => {
  it("merges selectedApproach rows, refines the ILS tally by catII, and attributes the autoland", async () => {
    const result = await parse("approaches.txt");
    const entry = result.entries.find((e) => e.flightNumber === "KL501")!;
    expect(entry.approaches).toBeDefined();
    const ilsCat1 = entry.approaches!.find((a) => a.type === "ils_cat1");
    const ilsCat2 = entry.approaches!.find((a) => a.type === "ils_cat2");
    // 2 selectedApproach ILS, 1 carved out by catII -> 1 remaining CAT I, 1 CAT II.
    expect(ilsCat1?.count).toBe(1);
    expect(ilsCat2?.count).toBe(1);
    // The single autoland attributes to the most specific capable row first (CAT II).
    expect(ilsCat2?.autolands).toBe(1);
  });
});

describe("FSTD / simulator row parsing", () => {
  it("parses a simulator row with trainee + instructor roles and a device-category hint", async () => {
    const result = await parse("simulator.txt");
    expect(result.entries.length).toBe(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe("fstd");
    expect(entry.fstdId).toBe("NL-213");
    expect(entry.fstdDeviceCategory).toBe("ffs");
    expect(crewRole(entry.crew, "SELF")).toBe("FSTD_TRN");
    expect(crewRole(entry.crew, "Mark Otten")).toBe("FSTD_INS");
    expect(entry.startTime?.totalMinutes).toBe(0);
    expect(entry.endTime?.totalMinutes).toBe(4 * 60);
  });
});

describe("LogTen Address Book crew resolution", () => {
  it("parses Name/Full Name/ID/Comment/This is Me columns into ImportedPerson rows", () => {
    const { people, importErrors } = parseLogTenAddressBook(fixture("address-book.txt"));
    expect(importErrors).toHaveLength(0);
    expect(people.length).toBe(2);
    const john = people.find((p) => p.refId === "John Smith")!;
    expect(john.employeeNumber).toBe("4821");
  });

  it("merges address-book people onto base crew without overwriting already-known fields", () => {
    const base = [{ refId: "John Smith", firstName: "John", isExisting: { existing: false as const } }];
    const { people: addressBookPeople } = parseLogTenAddressBook(fixture("address-book.txt"));
    const merged = mergeLogTenPeople(base, addressBookPeople);
    const john = merged.find((p) => p.refId === "John Smith")!;
    expect(john.firstName).toBe("John");
    expect(john.employeeNumber).toBe("4821");
  });

  it("the main importer merges in address book data when addressBookContent is supplied", async () => {
    const result = await parse("basic-flights.txt", { addressBookContent: fixture("address-book.txt") });
    const john = result.people.find((p) => p.refId === "John Smith")!;
    expect(john.employeeNumber).toBe("4821");
  });
});

describe("user in a Custom crew field (augmented crew) is never cabin crew", () => {
  const headers = [
    "flight_flightDate", "flight_type", "flight_flightNumber", "flight_from", "flight_to",
    "flight_selectedCrewPIC", "flight_selectedCrewSIC", "flight_selectedCrewCustom3",
    "flight_actualDepartureTime", "flight_actualArrivalTime", "flight_totalTime",
    "flight_pic", "flight_sic", "flight_p1us", "flight_dualReceived"
  ];
  function row(date: string, n: string, pic: string, sic: string, cols: { pic?: string; sic?: string; p1us?: string; dual?: string } = {}): string {
    return [date, "0", n, "EHAM", "LFPG", pic, sic, "Third Pilot", "08:00", "10:00", "2:00",
      cols.pic ?? "", cols.sic ?? "", cols.p1us ?? "", cols.dual ?? ""].join("\t");
  }
  const text =
    [
      headers.join("\t"),
      row("2024-01-01", "T1", "Alice A", "Bob B", { sic: "2:00" }),
      row("2024-01-02", "T2", "Carol C", "Dave D", { p1us: "2:00" }),
      row("2024-01-03", "T3", "Erin E", "Frank F", { dual: "2:00" }),
      row("2024-01-04", "T4", "Gina G", "Hank H"),
      row("2024-01-05", "T5", "Ivy I", "Jack J", { p1us: "1:00", dual: "1:00" }),
      row("2024-01-06", "T6", "Kim K", "Leo L", { pic: "2:00" })
    ].join("\n") + "\n";

  it("derives the user's role from the function columns", async () => {
    const result = await logTenImporter.parse(text, { selfName: "Third Pilot" });
    const role = (n: string) => crewRole(result.entries.find((e) => e.flightNumber === n)!.crew, "SELF");
    expect(role("T1")).toBe("CP");
    expect(role("T2")).toBe("PICUS");
    expect(role("T3")).toBe("STU");
    expect(role("T5")).toBe("SPIC");
    expect(role("T6")).toBe("PIC");
    // No positive function column: legacy behavior kept.
    expect(role("T4")).toBe("CA");
  });

  it("a Custom/FA field does not overwrite a pilot role set for the same person", async () => {
    const t =
      [
        ["flight_flightDate", "flight_type", "flight_flightNumber", "flight_from", "flight_to", "flight_selectedCrewPIC", "flight_selectedCrewSIC", "flight_selectedCrewCustom1", "flight_actualDepartureTime", "flight_actualArrivalTime", "flight_totalTime", "flight_sic"].join("\t"),
        ["2024-02-01", "0", "S1", "EHAM", "LFPG", "Alice A", "Bob B", "Bob B", "08:00", "10:00", "2:00", "2:00"].join("\t"),
        ["2024-02-02", "0", "S2", "EHAM", "LFPG", "Alice A", "Bob B", "Bob B", "08:00", "10:00", "2:00", "2:00"].join("\t")
      ].join("\n") + "\n";
    const result = await logTenImporter.parse(t);
    for (const e of result.entries) expect(e.crew.some((c) => c.role === "CA")).toBe(false);
  });
});

describe("who is the user (SELF)", () => {
  it("treats the most frequent crew name as SELF, like the app does, and says so", async () => {
    const result = await logTenImporter.parse(fixture("basic-flights.txt"));
    const entry = result.entries.find((e) => e.flightNumber === "KL1023")!;
    expect(crewRole(entry.crew, "SELF")).toBe("PIC");
    expect(entry.crew.some((c) => c.refId === "Jane Doe")).toBe(false);
    expect(result.people.map((p) => p.refId)).toContain("SELF");
    expect(result.people.map((p) => p.refId)).not.toContain("Jane Doe");
    expect(result.notes?.join(" ")).toMatch(/"Jane Doe" as you/);
  });

  it("selfName picks another crew name, case-insensitively", async () => {
    const result = await logTenImporter.parse(fixture("basic-flights.txt"), { selfName: "john smith" });
    const entry = result.entries.find((e) => e.flightNumber === "KL1024")!;
    // John is the listed PIC on this row, but the row's own function columns say he flew the right seat.
    expect(crewRole(entry.crew, "SELF")).toBe("CP");
    expect(entry.crew.some((c) => c.refId === "John Smith")).toBe(false);
    expect(result.notes?.join(" ")).toMatch(/"John Smith" as you \(--self\)/);
  });

  it("does not guess when a name is not in the file: nobody becomes SELF", async () => {
    const result = await logTenImporter.parse(fixture("basic-flights.txt"), { selfName: "Nobody Here" });
    expect(result.entries.some((e) => e.crew.some((c) => c.refId === "SELF"))).toBe(false);
    expect(result.importErrors.map((e) => e.reason).join(" ")).toMatch(/no crew member with that name/);
  });

  it("does not guess when two names appear equally often", async () => {
    const text = [
      "flight_flightDate\tflight_type\tflight_flightNumber\tflight_from\tflight_to\tflight_selectedCrewPIC\tflight_selectedCrewSIC\tflight_actualDepartureTime\tflight_actualArrivalTime\tflight_totalTime",
      "2026-01-05\t0\tKL1\tEHAM\tEGLL\tAnn A\tBen B\t10:00\t11:10\t1:10"
    ].join("\n");
    const result = await logTenImporter.parse(text);
    expect(result.entries.some((e) => e.crew.some((c) => c.refId === "SELF"))).toBe(false);
    expect(result.importErrors.map((e) => e.reason).join(" ")).toMatch(/appear equally often/);
  });
});
