import { describe, expect, it } from "vitest";
import { formatEntryTimesTable, formatMinutes, formatTotalsSummary } from "../../src/commands/times-format.js";
import { aggregateTotals, applyAtplCaps, type EntryTimesForTotals } from "../../src/times/aggregator.js";

const flight = (over: Partial<EntryTimesForTotals> = {}): EntryTimesForTotals => ({
  type: "flight",
  date: "2026-01-10",
  selfRole: "pilotInCommand",
  detailedTimes: { totalTimeOfFlight: 247, totalAirTime: 230, pilotInCommandRole: 247, ifr: 247, night: 30 },
  easaTimesSigned: { totalTimeOfFlight: 247, night: 30, ifr: 247, pilotInCommand: 247 },
  night: 30,
  fromIcao: "EHAM",
  toIcao: "EGLL",
  ...over
});

describe("formatMinutes", () => {
  it("prints H:MM without capping hours", () => {
    expect(formatMinutes(247)).toBe("4:07");
    expect(formatMinutes(0)).toBe("0:00");
    expect(formatMinutes(12345)).toBe("205:45");
  });
});

describe("formatTotalsSummary", () => {
  const totals = aggregateTotals([flight()]);
  const full = { ...totals, atplCaps: applyAtplCaps(totals) };

  it("groups the non-zero lines as H:MM and leaves all-zero lines and groups out", () => {
    const text = formatTotalsSummary(full);
    expect(text).toContain("Totals: 1 entry, all dates");
    expect(text).toMatch(/Block\s+4:07/);
    expect(text).toMatch(/PIC\s+4:07/);
    expect(text).toMatch(/Night\s+0:30/);
    expect(text).not.toMatch(/PICUS|SPIC|Instructor|Simulator|Dual/);
  });

  it("names the period when one is given", () => {
    expect(formatTotalsSummary(full, { from: "2026-01-01", to: "2026-03-31" })).toContain("2026-01-01 to 2026-03-31");
    expect(formatTotalsSummary(full, { from: "2026-01-01" })).toContain("from 2026-01-01");
    expect(formatTotalsSummary(full, { to: "2026-03-31" })).toContain("up to 2026-03-31");
  });

  it("says so when there is nothing to report", () => {
    const empty = aggregateTotals([]);
    expect(formatTotalsSummary({ ...empty, atplCaps: applyAtplCaps(empty) })).toContain("No time to report.");
  });
});

describe("formatEntryTimesTable", () => {
  it("prints one row per entry with H:MM cells", () => {
    const text = formatEntryTimesTable([flight()]);
    expect(text.split("\n")[0]).toMatch(/^#\s+date\s+route\s+role\s+block/);
    expect(text).toMatch(/2026-01-10\s+EHAM-EGLL\s+PIC\s+4:07/);
  });
});
