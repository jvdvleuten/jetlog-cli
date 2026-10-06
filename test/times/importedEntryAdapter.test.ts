import { describe, it, expect } from "vitest";
import { importedEntryToCalcEntry } from "../../src/times/importedEntryAdapter.js";
import { newImportedEntry, time } from "../../src/import/model.js";
import type { ImportedEntry } from "../../src/import/model.js";

describe("importedEntryToCalcEntry", () => {
  it("round-trips a flight entry with manual overrides into CalcTimes", () => {
    const entry: ImportedEntry = newImportedEntry({
      date: "2026-01-01",
      type: "flight",
      from: "EHAM",
      to: "EGLL",
      offBlocks: time(10 * 60),
      onBlocks: time(11 * 60 + 30),
      crew: [{ refId: "SELF", role: "PIC" }],
      manualTimes: { night: time(45), ifr: time(90), pilotInCommand: time(90) }
    });

    const result = importedEntryToCalcEntry(entry);
    expect(result).toBeDefined();
    expect(result!.selfRole).toBe("pilotInCommand");
    expect(result!.calcEntry.manualTimes).toEqual({ night: 45, ifr: 90, pilotInCommand: 90 });
    expect(result!.calcEntry.offBlocks).toBe("10:00");
    expect(result!.calcEntry.onBlocks).toBe("11:30");
    expect(result!.activeCrewCount).toBe(1);
  });

  it("maps an FSTD entry's startTime/endTime", () => {
    const entry: ImportedEntry = newImportedEntry({
      date: "2026-02-02",
      type: "fstd",
      startTime: time(9 * 60),
      endTime: time(11 * 60),
      crew: [{ refId: "SELF", role: "FSTD_TRN" }]
    });

    const result = importedEntryToCalcEntry(entry);
    expect(result).toBeDefined();
    expect(result!.calcEntry.type).toBe("fstd");
    expect(result!.calcEntry.startTime).toBe("09:00");
    expect(result!.calcEntry.endTime).toBe("11:00");
    expect(result!.selfRole).toBe("fstdTrainee");
  });

  it("maps a bulk entry's manualTimes.totalTimeOfFlight", () => {
    const entry: ImportedEntry = newImportedEntry({
      date: "2026-03-03",
      type: "flight",
      isBulk: true,
      manualTimes: { totalTimeOfFlight: time(3000), pilotInCommand: time(3000) },
      crew: [{ refId: "SELF", role: "PIC" }]
    });

    const result = importedEntryToCalcEntry(entry);
    expect(result).toBeDefined();
    expect(result!.calcEntry.isBulk).toBe(true);
    expect(result!.calcEntry.manualTimes?.totalTimeOfFlight).toBe(3000);
  });

  it("passes isImportedFromOtherLogbook through", () => {
    const entry: ImportedEntry = newImportedEntry({
      date: "2026-04-04",
      type: "flight",
      isImportedFromOtherLogbook: true,
      crew: [{ refId: "SELF", role: "CP" }]
    });

    const result = importedEntryToCalcEntry(entry);
    expect(result).toBeDefined();
    expect(result!.calcEntry.isImportedFromOtherLogbook).toBe(true);
  });

  it("returns undefined when there's no SELF crew member", () => {
    const entry: ImportedEntry = newImportedEntry({
      date: "2026-05-05",
      type: "flight",
      crew: [{ refId: "person-1", role: "PIC" }]
    });

    expect(importedEntryToCalcEntry(entry)).toBeUndefined();
  });
});
