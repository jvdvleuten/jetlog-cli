import { describe, expect, it } from "vitest";
import {
  hasUnresolvedConflicts,
  isCustomSwitchValueSet,
  newLogTenCustomSwitchMapping,
  pairKey,
  setWinner,
  winner
} from "../../src/import/importers/logten/custom-switch-mapping.js";

describe("isCustomSwitchValueSet", () => {
  it("treats '1' as set", () => {
    expect(isCustomSwitchValueSet("1")).toBe(true);
  });

  it("treats a literal '0' as NOT set (real exports populate every switch with 0)", () => {
    expect(isCustomSwitchValueSet("0")).toBe(false);
    expect(isCustomSwitchValueSet("0:00")).toBe(false);
    expect(isCustomSwitchValueSet("00:00")).toBe(false);
  });

  it("treats blank/undefined as not set", () => {
    expect(isCustomSwitchValueSet(undefined)).toBe(false);
    expect(isCustomSwitchValueSet("")).toBe(false);
    expect(isCustomSwitchValueSet("   ")).toBe(false);
  });

  it("treats any other non-zero number or duration as set", () => {
    expect(isCustomSwitchValueSet("2")).toBe(true);
    expect(isCustomSwitchValueSet("0:30")).toBe(true);
    expect(isCustomSwitchValueSet("yes")).toBe(true);
  });
});

describe("pairKey / winner / setWinner", () => {
  it("is order-independent", () => {
    expect(pairKey(1, 2)).toBe(pairKey(2, 1));
  });

  it("round-trips a recorded winner", () => {
    const mapping = newLogTenCustomSwitchMapping();
    setWinner(mapping, 5, 5, 3);
    expect(winner(mapping, 3, 5)).toBe(5);
    expect(winner(mapping, 5, 3)).toBe(5);
  });

  it("is undefined for a pair with no recorded winner", () => {
    const mapping = newLogTenCustomSwitchMapping();
    expect(winner(mapping, 1, 2)).toBeUndefined();
  });
});

describe("hasUnresolvedConflicts", () => {
  it("ignores pairs mapped to the same role", () => {
    const mapping = newLogTenCustomSwitchMapping();
    mapping.roles = { 1: "RI", 2: "RI" };
    expect(hasUnresolvedConflicts(mapping, [1, 2])).toBe(false);
  });

  it("flags a pair mapped to different roles with no recorded winner", () => {
    const mapping = newLogTenCustomSwitchMapping();
    mapping.roles = { 1: "RI", 2: "PIC" };
    expect(hasUnresolvedConflicts(mapping, [1, 2])).toBe(true);
  });

  it("is resolved once a winner is recorded for every differing pair", () => {
    const mapping = newLogTenCustomSwitchMapping();
    mapping.roles = { 1: "RI", 2: "PIC" };
    setWinner(mapping, 2, 1, 2);
    expect(hasUnresolvedConflicts(mapping, [1, 2])).toBe(false);
  });
});
