import { describe, it, expect } from "vitest";
import { calculateEntryTimes } from "../../src/times/calculator.js";
import { roleSortKey } from "../../src/times/roleCodes.js";
import { importedEntryToCalcEntry } from "../../src/times/importedEntryAdapter.js";
import { newImportedEntry, time } from "../../src/import/model.js";
import type { EntryPersonRole } from "../../src/import/model.js";

function calcFstd(role: EntryPersonRole) {
  const entry = newImportedEntry({
    date: "2026-01-01",
    type: "fstd",
    startTime: time(10 * 60),
    endTime: time(12 * 60),
    crew: [{ refId: "SELF", role }]
  });
  const adapted = importedEntryToCalcEntry(entry)!;
  return calculateEntryTimes(adapted.calcEntry, {
    selfRole: adapted.selfRole,
    activeCrewCount: adapted.activeCrewCount,
    lookupAirport: () => undefined,
    lookupAircraftType: () => undefined
  });
}

describe("non-logging FSTD roles", () => {
  for (const wire of ["FSTD_ACC", "FSTD_TECH", "FSTD_STANDIN", "FSTD_INSP"] as const) {
    it(`${wire} tracks the session in fstdNonTrainingTime only`, () => {
      const result = calcFstd(wire);
      expect(result.detailedTimes.fstdNonTrainingTime).toBe(120);
      expect(result.detailedTimes.fstdSession).toBeUndefined();
      expect(result.detailedTimes.fstdInstructorTime).toBeUndefined();
      expect(result.detailedTimes.fstdExaminerTime).toBeUndefined();
    });

    it(`${wire} logs no EASA time, signed or unsigned`, () => {
      const result = calcFstd(wire);
      expect(result.easaTimesSigned).toEqual({});
      expect(result.easaTimesUnsigned).toEqual({});
    });
  }

  it("a trainee still logs fstdSession and no non-training time", () => {
    const result = calcFstd("FSTD_TRN");
    expect(result.detailedTimes.fstdSession).toBe(120);
    expect(result.detailedTimes.fstdNonTrainingTime).toBeUndefined();
  });

  it("sorts right after the senior FSTD instructor", () => {
    const si = roleSortKey("fstdSeniorInstructor", "FSTD_SI")[0];
    expect(roleSortKey("fstdAcceptancePilot", "FSTD_ACC")[0]).toBe(si + 1);
    expect(roleSortKey("fstdTechnicalPilot", "FSTD_TECH")[0]).toBe(si + 2);
    expect(roleSortKey("fstdStandIn", "FSTD_STANDIN")[0]).toBe(si + 3);
    expect(roleSortKey("fstdFlightInspector", "FSTD_INSP")[0]).toBe(si + 4);
  });
});
