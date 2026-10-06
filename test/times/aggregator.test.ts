import { describe, it, expect } from "vitest";
import { aggregateTotals, applyAtplCaps, type EntryTimesForTotals } from "../../src/times/aggregator.js";
import type { Airport } from "../../src/times/types.js";

function entry(d: EntryTimesForTotals["detailedTimes"], e: EntryTimesForTotals["easaTimesSigned"] = {}): EntryTimesForTotals {
  return { detailedTimes: d, easaTimesSigned: e };
}

/** A simulator session: not gated on a block time, eligible for the FSTD-only routing. */
function fstdEntry(d: EntryTimesForTotals["detailedTimes"], extra: Partial<EntryTimesForTotals> = {}): EntryTimesForTotals {
  return { type: "fstd", detailedTimes: d, easaTimesSigned: {}, ...extra };
}

describe("aggregateTotals", () => {
  it("sums strict command-PIC separately from PICUS/SPIC", () => {
    const totals = aggregateTotals([
      entry({ pilotInCommandRole: 120, totalTimeOfFlight: 120 }),
      entry({ picusRole: 60, totalTimeOfFlight: 60 }),
      entry({ spicRole: 30, totalTimeOfFlight: 30 })
    ]);
    expect(totals.totalPicMinutes).toBe(120);
    expect(totals.totalPicusMinutes).toBe(60);
    expect(totals.totalSpicMinutes).toBe(30);
  });

  it("splits CRCP raw vs credited", () => {
    const totals = aggregateTotals([entry({ cruiseReliefRawBlock: 480, cruiseReliefCoPilotCredited: 280, totalTimeOfFlight: 480 })]);
    expect(totals.cruiseReliefRawMinutes).toBe(480);
    expect(totals.cruiseReliefCreditedMinutes).toBe(280);
  });

  it("gates taxi time on air time being logged", () => {
    const withAirTime = aggregateTotals([entry({ totalTimeOfFlight: 120, totalAirTime: 100 })]);
    expect(withAirTime.taxiTimeMinutes).toBe(20);

    const withoutAirTime = aggregateTotals([entry({ totalTimeOfFlight: 120 })]);
    expect(withoutAirTime.taxiTimeMinutes).toBe(0);
  });

  it("never lets taxi time go negative", () => {
    const totals = aggregateTotals([entry({ totalTimeOfFlight: 100, totalAirTime: 120 })]);
    expect(totals.taxiTimeMinutes).toBe(0);
  });

  it("includes bulk entries in block/air totals (career totals include bulk hours)", () => {
    const totals = aggregateTotals([
      entry({ totalTimeOfFlight: 60 }),
      { detailedTimes: { totalTimeOfFlight: 3000, pilotInCommandRole: 3000 }, easaTimesSigned: {}, isBulk: true }
    ]);
    expect(totals.totalBlockMinutes).toBe(3060);
    expect(totals.totalPicMinutes).toBe(3000);
  });

  it("sums EASA-credited co-pilot time (not the raw role bucket)", () => {
    const totals = aggregateTotals([entry({ coPilotRole: 60, totalTimeOfFlight: 60 }, { coPilot: 60 })]);
    expect(totals.totalCoPilotMinutes).toBe(60);
  });

  it("keeps a flight without a calculated block out of every total, FSTD entries are not gated", () => {
    const totals = aggregateTotals([
      entry({ totalTimeOfFlight: 60, night: 10 }),
      // scheduled but not flown: no block, still carries a (manual) night/IFR figure
      entry({ night: 30, ifr: 30, pilotInCommandRole: 45 }),
      fstdEntry({ fstdSession: 90 })
    ]);
    expect(totals.entryCount).toBe(2);
    expect(totals.totalBlockMinutes).toBe(60);
    expect(totals.totalNightMinutes).toBe(10);
    expect(totals.totalIfrMinutes).toBe(0);
    expect(totals.totalPicMinutes).toBe(0);
    expect(totals.totalFstdSessionMinutes).toBe(90);
  });

  it("counts entries", () => {
    const totals = aggregateTotals([entry({ totalTimeOfFlight: 60 }), entry({ totalTimeOfFlight: 60 }), fstdEntry({})]);
    expect(totals.entryCount).toBe(3);
  });

  describe("FSTD device-category routing (5a)", () => {
    it("routes fnpt sessions into fnptSessionMinutes", () => {
      const totals = aggregateTotals([fstdEntry({ fstdSession: 60 }, { fstdDeviceCategory: "fnpt" })]);
      expect(totals.fnptSessionMinutes).toBe(60);
      expect(totals.nonCreditableSimSessionMinutes).toBe(0);
    });

    it("routes ftd and bitd sessions into nonCreditableSimSessionMinutes", () => {
      const totals = aggregateTotals([
        fstdEntry({ fstdSession: 60 }, { fstdDeviceCategory: "ftd" }),
        fstdEntry({ fstdSession: 30 }, { fstdDeviceCategory: "bitd" })
      ]);
      expect(totals.nonCreditableSimSessionMinutes).toBe(90);
      expect(totals.fnptSessionMinutes).toBe(0);
    });

    it("ignores a device category on a non-FSTD entry", () => {
      const totals = aggregateTotals([{ ...entry({ totalTimeOfFlight: 60, fstdSession: 60 }), fstdDeviceCategory: "fnpt" }]);
      expect(totals.fnptSessionMinutes).toBe(0);
    });

    it("routes ffs sessions into neither sub-bucket", () => {
      const totals = aggregateTotals([fstdEntry({ fstdSession: 60 }, { fstdDeviceCategory: "ffs" })]);
      expect(totals.fnptSessionMinutes).toBe(0);
      expect(totals.nonCreditableSimSessionMinutes).toBe(0);
    });
  });

  describe("FSTD trainee vs. instructed session counts (5b)", () => {
    it("counts fstdTrainee as trainee", () => {
      const totals = aggregateTotals([fstdEntry({}, { selfRole: "fstdTrainee" })]);
      expect(totals.totalFSTDTraineeSessions).toBe(1);
      expect(totals.totalFSTDInstructedSessions).toBe(0);
    });

    it("counts fstdInstructor/fstdExaminer/fstdSeniorInstructor as instructed", () => {
      const totals = aggregateTotals([
        fstdEntry({}, { selfRole: "fstdInstructor" }),
        fstdEntry({}, { selfRole: "fstdExaminer" }),
        fstdEntry({}, { selfRole: "fstdSeniorInstructor" })
      ]);
      expect(totals.totalFSTDInstructedSessions).toBe(3);
      expect(totals.totalFSTDTraineeSessions).toBe(0);
    });

    it("counts fstdObserver as neither", () => {
      const totals = aggregateTotals([fstdEntry({}, { selfRole: "fstdObserver" })]);
      expect(totals.totalFSTDTraineeSessions).toBe(0);
      expect(totals.totalFSTDInstructedSessions).toBe(0);
    });

    it("defaults to trainee for nil/non-FSTD roles (deliberate default branch)", () => {
      const totals = aggregateTotals([fstdEntry({}, { selfRole: "pilotInCommand" }), fstdEntry({})]);
      expect(totals.totalFSTDTraineeSessions).toBe(2);
      expect(totals.totalFSTDInstructedSessions).toBe(0);
    });

    it("never counts a flight as an FSTD session", () => {
      const totals = aggregateTotals([{ ...entry({ totalTimeOfFlight: 60 }), selfRole: "pilotInCommand" }]);
      expect(totals.totalFSTDTraineeSessions).toBe(0);
      expect(totals.totalFSTDInstructedSessions).toBe(0);
    });
  });

  describe("cross-country-by-distance (5c)", () => {
    const EHAM: Airport = { lat: 52.3086, lon: 4.7639, hasPosition: true };
    const LFPG: Airport = { lat: 49.0097, lon: 2.5479, hasPosition: true };
    const KJFK: Airport = { lat: 40.6413, lon: -73.7781, hasPosition: true };

    function lookupAirport(icao: string): Airport | undefined {
      return { EHAM, LFPG, KJFK }[icao];
    }

    it("does not classify a short leg (EHAM-LFPG, well under 300NM) as cross-country", () => {
      const totals = aggregateTotals([{ ...entry({ totalTimeOfFlight: 90 }), fromIcao: "EHAM", toIcao: "LFPG" }], {
        lookupAirport
      });
      expect(totals.crossCountryMinutes).toBe(0);
      expect(totals.crossCountryIsEstimated).toBe(true);
    });

    it("classifies a long leg (EHAM-KJFK, well over 300NM) as cross-country", () => {
      const totals = aggregateTotals([{ ...entry({ totalTimeOfFlight: 480 }), fromIcao: "EHAM", toIcao: "KJFK" }], {
        lookupAirport
      });
      expect(totals.crossCountryMinutes).toBe(480);
      expect(totals.crossCountryIsEstimated).toBe(true);
    });

    it("leaves crossCountryIsEstimated false when no lookupAirport is supplied", () => {
      const totals = aggregateTotals([{ ...entry({ totalTimeOfFlight: 480 }), fromIcao: "EHAM", toIcao: "KJFK" }]);
      expect(totals.crossCountryMinutes).toBe(0);
      expect(totals.crossCountryIsEstimated).toBe(false);
    });
  });
});

describe("applyAtplCaps", () => {
  it("credits CRCP in full when flown hours are under the 250h cap", () => {
    const totals = aggregateTotals([
      entry({ totalTimeOfFlight: 60 * 60, cruiseReliefRawBlock: 100 * 60, multiPilot: 60 * 60 })
    ]);
    const caps = applyAtplCaps(totals);
    expect(caps.crcpCreditedHours).toBe(100);
    expect(caps.crcpExcessHours).toBe(0);
    expect(caps.realAeroplaneCreditedHours).toBe(60);
    expect(caps.multiPilotCreditedHours).toBe(60);
  });

  it("caps CRCP at 250h and subtracts the excess from real-aeroplane/multi-pilot credit", () => {
    const totals = aggregateTotals([
      entry({ totalTimeOfFlight: 1000 * 60, cruiseReliefRawBlock: 300 * 60, multiPilot: 900 * 60 })
    ]);
    const caps = applyAtplCaps(totals);
    expect(caps.crcpCreditedHours).toBe(250);
    expect(caps.crcpExcessHours).toBe(50);
    // realAeroplaneHours = totalBlock(1000) - crcpExcess(50) = 950
    expect(caps.realAeroplaneCreditedHours).toBe(950);
    expect(caps.multiPilotCreditedHours).toBe(850);
  });

  it("caps synthetic credit (FNPT 25h + FFS, combined synthetic max 100h)", () => {
    const totals = aggregateTotals([
      fstdEntry({ totalTimeOfFlight: 0 }, { fstdDeviceCategory: "fnpt" })
    ]);
    totals.fnptSessionMinutes = 40 * 60; // 40h FNPT logged, capped at 25h
    totals.totalFstdSessionMinutes = 40 * 60;
    const caps = applyAtplCaps(totals);
    expect(caps.fnptCreditedHours).toBe(25);
    expect(caps.ffsCreditedHours).toBe(0);
    expect(caps.syntheticCreditedHours).toBe(25);
  });
});

describe("derived-date period", () => {
  const flown = (date: string | undefined, minutes: number): EntryTimesForTotals => ({ ...entry({ totalTimeOfFlight: minutes }), date });

  it("counts an entry by its derived date, both ends inclusive", () => {
    const entries = [flown("2024-12-31", 60), flown("2025-01-01", 30), flown("2025-12-31", 20), flown("2026-01-01", 10)];
    const totals = aggregateTotals(entries, { period: { from: "2025-01-01", to: "2025-12-31" } });
    expect(totals.totalBlockMinutes).toBe(50);
    expect(totals.entryCount).toBe(2);
  });

  it("supports open-ended periods", () => {
    const entries = [flown("2024-12-31", 60), flown("2025-01-01", 30)];
    expect(aggregateTotals(entries, { period: { from: "2025-01-01" } }).totalBlockMinutes).toBe(30);
    expect(aggregateTotals(entries, { period: { to: "2024-12-31" } }).totalBlockMinutes).toBe(60);
  });

  it("leaves an entry without a derived date out of any period, and counts everything without one", () => {
    const entries = [flown(undefined, 60), flown("2025-06-01", 30)];
    expect(aggregateTotals(entries, { period: { from: "2025-01-01" } }).totalBlockMinutes).toBe(30);
    expect(aggregateTotals(entries).totalBlockMinutes).toBe(90);
  });

  it("applies to FSTD sessions too", () => {
    const sim: EntryTimesForTotals = { ...fstdEntry({ fstdSession: 120 }), date: "2024-12-31" };
    expect(aggregateTotals([sim], { period: { from: "2024-01-01", to: "2024-12-31" } }).totalFstdSessionMinutes).toBe(120);
    expect(aggregateTotals([sim], { period: { from: "2025-01-01" } }).totalFstdSessionMinutes).toBe(0);
  });

  it("does not let an unresolved position count as a cross-country position", () => {
    const noPosition = (): Airport => ({ hasPosition: false, lat: null, lon: null });
    const totals = aggregateTotals([{ ...entry({ totalTimeOfFlight: 480 }), fromIcao: "AAAA", toIcao: "BBBB" }], {
      lookupAirport: noPosition
    });
    expect(totals.crossCountryMinutes).toBe(0);
    expect(totals.crossCountryIsEstimated).toBe(false);
  });
});
