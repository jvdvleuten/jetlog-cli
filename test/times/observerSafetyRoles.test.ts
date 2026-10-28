import { describe, it, expect } from "vitest";
import { calculateEntryTimes } from "../../src/times/calculator.js";
import { easaTimes } from "../../src/times/easa.js";
import { roleSortKey } from "../../src/times/roleCodes.js";
import { importedEntryToCalcEntry } from "../../src/times/importedEntryAdapter.js";
import { newImportedEntry, time } from "../../src/import/model.js";
import type { EntryPersonRole } from "../../src/import/model.js";

function calc(role: EntryPersonRole) {
  const entry = newImportedEntry({
    date: "2026-01-01",
    type: "flight",
    from: "EHAM",
    to: "EGLL",
    offBlocks: time(10 * 60),
    onBlocks: time(11 * 60 + 30),
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

describe("observer and safety pilot roles", () => {
  const cases = [
    ["OBS", "observerRole"],
    ["SAFETY", "safetyPilotRole"]
  ] as const;

  for (const [wire, bucket] of cases) {
    it(`${wire} fills only ${bucket} with the block time`, () => {
      const result = calc(wire);
      expect(result.detailedTimes[bucket]).toBe(90);
      expect(result.detailedTimes.pilotInCommandRole).toBeUndefined();
      expect(result.detailedTimes.coPilotRole).toBeUndefined();
      expect(result.detailedTimes.deadHeadRole).toBeUndefined();
    });

    it(`${wire} logs no EASA time, signed or unsigned`, () => {
      const result = calc(wire);
      expect(result.easaTimesSigned).toEqual({});
      expect(result.easaTimesUnsigned).toEqual({});
    });

    it(`easaTimes is empty when only ${bucket} is set`, () => {
      expect(easaTimes({ [bucket]: 60, totalTimeOfFlight: 60, multiPilot: 60 }, true, 2)).toEqual({});
    });
  }

  it("sorts right after deadhead", () => {
    const dh = roleSortKey("deadHead", "DH")[0];
    expect(roleSortKey("observer", "OBS")[0]).toBe(dh + 1);
    expect(roleSortKey("safetyPilot", "SAFETY")[0]).toBe(dh + 2);
  });
});
