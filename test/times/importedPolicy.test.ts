import { describe, expect, it } from "vitest";
import { calculateEntryTimes } from "../../src/times/calculator.js";
import type { CalcEntry, CalcTimes, EntryPersonRoleName } from "../../src/times/types.js";

/** Imported pilot-function columns: the ROLE leads (one rule for native and imported rows). Only the
 * override tiles are honoured; everything else of an imported row's manualTimes is ignored. */
function calc(role: EntryPersonRoleName, manualTimes: CalcTimes, imported = true, activeCrewCount = 2) {
  const entry: CalcEntry = {
    date: "2026-01-10",
    type: "flight",
    offBlocks: "10:00",
    onBlocks: "13:00", // 180 min block
    updateFlightData: false,
    ifr: false,
    isImportedFromOtherLogbook: imported,
    isBulk: false,
    people: [],
    manualTimes
  };
  return calculateEntryTimes(entry, { selfRole: role, activeCrewCount, lookupAirport: () => undefined, lookupAircraftType: () => undefined }).detailedTimes;
}

describe("imported pilot-function columns: the role leads", () => {
  it("ignores the SIC column on a PIC row (no double count)", () => {
    const d = calc("pilotInCommand", { pilotInCommand: 180, coPilot: 180 });
    expect(d.pilotInCommandRole).toBe(180);
    expect(d.coPilotRole).toBeUndefined();
  });

  it("ignores a partial PIC column on a PIC row", () => {
    expect(calc("pilotInCommand", { pilotInCommand: 60 }).pilotInCommandRole).toBe(180);
  });

  it("honours the PIC column on a co-pilot seat row as the PIC carve", () => {
    for (const role of ["coPilot", "lineCheckAirmanInitialFO", "seniorInstructorCoPilot", "routeInstructorCoPilot"] as const) {
      const d = calc(role, { pilotInCommand: 60 });
      expect(d.pilotInCommandRole, role).toBe(60);
      const seat = role === "seniorInstructorCoPilot" ? d.seniorInstructorCoPilotRole : role === "routeInstructorCoPilot" ? d.routeInstructorCoPilotRole : d.coPilotRole;
      expect(seat, role).toBe(120);
    }
  });

  it("ignores a partial SIC column on a co-pilot row (full block)", () => {
    expect(calc("coPilot", { coPilot: 60 }).coPilotRole).toBe(180);
  });

  it("CRCP: coPilot is the credited override, the raw relief column is ignored", () => {
    const d = calc("cruiseReliefCoPilot", { coPilot: 45, cruiseReliefCoPilot: 30 }, true, 3);
    expect(d.cruiseReliefRawBlock).toBe(180);
    expect(d.cruiseReliefCoPilotCredited).toBe(45);
  });

  it("SPIC: dual is carved out of the block", () => {
    const d = calc("studentPilotInCommand", { dual: 50 });
    expect(d.dualRole).toBe(50);
    expect(d.spicRole).toBe(130);
  });

  it("ignores dual on STU, instructor on FI/RI/RI-CP and examiner on FE", () => {
    expect(calc("student", { dual: 60 }).dualRole).toBe(180);
    expect(calc("flightInstructor", { instructor: 60 }).flightInstructorRole).toBe(180);
    expect(calc("routeInstructor", { instructor: 60 }).routeInstructorRole).toBe(180);
    expect(calc("routeInstructorCoPilot", { instructor: 60, coPilot: 30 }).routeInstructorCoPilotRole).toBe(180);
    expect(calc("flightExaminer", { examiner: 60 }).flightExaminerRole).toBe(180);
  });

  it("ignores the cross-role cruise-relief column", () => {
    const d = calc("pilotInCommand", { cruiseReliefCoPilot: 120 });
    expect(d.cruiseReliefRawBlock).toBeUndefined();
    expect(d.cruiseReliefCoPilotCredited).toBeUndefined();
  });

  it("a zero is not a value on an imported row (but is on a native one)", () => {
    expect(calc("coPilot", { pilotInCommand: 0 }).pilotInCommandRole).toBeUndefined();
    expect(calc("coPilot", { pilotInCommand: 0 }, false).pilotInCommandRole).toBe(0);
  });

  it("night / IFR overrides still apply", () => {
    const d = calc("pilotInCommand", { night: 30, ifr: 40 });
    expect(d.night).toBe(30);
    expect(d.ifr).toBe(40);
  });
});
