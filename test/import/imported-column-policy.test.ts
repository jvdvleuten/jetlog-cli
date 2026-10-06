import { describe, expect, it } from "vitest";
import { normalizeImportedFlightManualTimes, retaggedLosslessPICUSRole } from "../../src/import/normalization.js";
import { newImportedEntry, time } from "../../src/import/model.js";
import type { EntryPersonRole, ImportedEntry, Times } from "../../src/import/model.js";

function row(times: Times): ImportedEntry {
  return newImportedEntry({ date: "2026-01-10", type: "flight", offBlocks: time(600), onBlocks: time(780), manualTimes: times });
}

function allColumns(): Times {
  return {
    pilotInCommand: time(60),
    coPilot: time(60),
    cruiseReliefCoPilot: time(30),
    picus: time(60),
    spic: time(60),
    dual: time(60),
    instructor: time(60),
    examiner: time(60),
    night: time(20)
  };
}

function normalized(role: EntryPersonRole, strategy?: "creditFullBlock" | "preserveLoggedSeatTime"): Times {
  const e = row(allColumns());
  normalizeImportedFlightManualTimes(e, role, strategy);
  return e.manualTimes ?? {};
}

const PILOT_FUNCTION = ["pilotInCommand", "coPilot", "cruiseReliefCoPilot", "picus", "spic", "dual", "instructor", "examiner"] as const;
function keptColumns(t: Times): string[] {
  return PILOT_FUNCTION.filter((k) => t[k] !== undefined);
}

describe("normalizeImportedFlightManualTimes keeps only the role's tile column", () => {
  it("co-pilot seat family keeps only the PIC column", () => {
    for (const role of ["CP", "LCAIFO", "SI_CP", "RI_CP"] as const) {
      expect(keptColumns(normalized(role)), role).toEqual(["pilotInCommand"]);
    }
  });

  it("CRCP keeps only coPilot (the credited override); the raw relief column is dropped", () => {
    expect(keptColumns(normalized("CRCP"))).toEqual(["coPilot"]);
  });

  it("SPIC keeps only dual", () => {
    expect(keptColumns(normalized("SPIC"))).toEqual(["dual"]);
  });

  it("every other role keeps no pilot-function column; night survives", () => {
    for (const role of ["PIC", "PICUS", "STU", "FI", "RI", "FE", "LCA", "DH"] as const) {
      const t = normalized(role);
      expect(keptColumns(t), role).toEqual([]);
      expect(t.night?.totalMinutes, role).toBe(20);
    }
  });

  it("a partial co-pilot column is dropped under creditFullBlock and kept (transiently) under preserveLoggedSeatTime", () => {
    const mk = () => row({ coPilot: time(90) });
    const full = mk();
    normalizeImportedFlightManualTimes(full, "CP", "creditFullBlock");
    expect(full.manualTimes?.coPilot).toBeUndefined();
    const kept = mk();
    normalizeImportedFlightManualTimes(kept, "CP", "preserveLoggedSeatTime");
    expect(kept.manualTimes?.coPilot?.totalMinutes).toBe(90);
  });

  it("an unresolved role clears nothing", () => {
    const e = row(allColumns());
    normalizeImportedFlightManualTimes(e, undefined);
    expect(keptColumns(e.manualTimes ?? {}).length).toBe(8);
  });
});

describe("retaggedLosslessPICUSRole uses the iOS co-pilot seat family", () => {
  const picusFullBlock = () => row({ picus: time(180) });

  it("retags CP, LCAIFO, SI_CP and RI_CP rows whose picus equals the block", () => {
    for (const role of ["CP", "LCAIFO", "SI_CP", "RI_CP"] as const) {
      expect(retaggedLosslessPICUSRole(picusFullBlock(), role), role).toBe("PICUS");
    }
  });

  it("leaves a CRCP row (relief credit) alone even when picus equals the block", () => {
    expect(retaggedLosslessPICUSRole(picusFullBlock(), "CRCP")).toBe("CRCP");
  });

  it("does not retag when picus differs from the block", () => {
    expect(retaggedLosslessPICUSRole(row({ picus: time(90) }), "CP")).toBe("CP");
  });
});
