/** Human-readable output for `jetlog totals` and `jetlog times` (the `--json` forms print the raw objects). */
import type { AtplCaps, EntryTimesForTotals, Totals } from "../times/aggregator.js";
import type { Period } from "../times/period.js";
import { toTable } from "./output.js";

/** 247 minutes -> `4:07`. Hours are not capped, 12345 minutes -> `205:45`. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

function periodText(period: Period | undefined): string {
  if (!period || (!period.from && !period.to)) return "all dates";
  if (period.from && period.to) return `${period.from} to ${period.to}`;
  return period.from ? `from ${period.from}` : `up to ${period.to}`;
}

interface Line {
  label: string;
  minutes: number;
  note?: string;
}

function group(title: string, lines: Line[]): string[] {
  const shown = lines.filter((l) => l.minutes > 0);
  if (shown.length === 0) return [];
  const width = Math.max(...shown.map((l) => l.label.length));
  const valueWidth = Math.max(...shown.map((l) => formatMinutes(l.minutes).length));
  return [
    "",
    title,
    ...shown.map((l) => `  ${l.label.padEnd(width)}  ${formatMinutes(l.minutes).padStart(valueWidth)}${l.note ? `  ${l.note}` : ""}`)
  ];
}

/** The default `jetlog totals` output: grouped, `H:MM`, all-zero lines and groups left out. */
export function formatTotalsSummary(totals: Totals & { atplCaps: AtplCaps }, period?: Period): string {
  const out: string[] = [];
  const entries = `${totals.entryCount} entr${totals.entryCount === 1 ? "y" : "ies"}`;
  out.push(`Totals: ${entries}, ${periodText(period)}`);

  out.push(
    ...group("Time", [
      { label: "Block", minutes: totals.totalBlockMinutes },
      { label: "Air", minutes: totals.totalAirMinutes },
      { label: "Taxi", minutes: totals.taxiTimeMinutes }
    ])
  );
  out.push(
    ...group("Function", [
      { label: "PIC", minutes: totals.totalPicMinutes },
      { label: "PICUS", minutes: totals.totalPicusMinutes },
      { label: "SPIC", minutes: totals.totalSpicMinutes },
      { label: "Co-pilot", minutes: totals.totalCoPilotMinutes },
      { label: "Dual", minutes: totals.totalDualMinutes },
      { label: "Instructor", minutes: totals.totalInstructorMinutes }
    ])
  );
  out.push(
    ...group("Conditions", [
      { label: "Night", minutes: totals.totalNightMinutes },
      { label: "IFR", minutes: totals.totalIfrMinutes },
      { label: "Cross country", minutes: totals.crossCountryMinutes, note: totals.crossCountryIsEstimated ? "(estimated from airport distance)" : undefined }
    ])
  );
  out.push(
    ...group("Aircraft class", [
      { label: "Single-pilot single-engine", minutes: totals.singlePilotSingleEngineMinutes },
      { label: "Single-pilot multi-engine", minutes: totals.singlePilotMultiEngineMinutes },
      { label: "Multi-pilot", minutes: totals.multiPilotMinutes }
    ])
  );

  const simLines = group("Simulator", [
    { label: "FSTD sessions", minutes: totals.totalFstdSessionMinutes },
    { label: "of which FNPT", minutes: totals.fnptSessionMinutes },
    { label: "of which not creditable", minutes: totals.nonCreditableSimSessionMinutes }
  ]);
  if (simLines.length > 0 && (totals.totalFSTDTraineeSessions > 0 || totals.totalFSTDInstructedSessions > 0)) {
    simLines.push(`  sessions: ${totals.totalFSTDTraineeSessions} as trainee, ${totals.totalFSTDInstructedSessions} instructed`);
  }
  out.push(...simLines);

  const caps = totals.atplCaps;
  out.push(
    ...group("ATPL credit", [
      { label: "Total flight time", minutes: hoursToMinutes(caps.totalFlightTimeCreditedHours) },
      { label: "Real aeroplane", minutes: hoursToMinutes(caps.realAeroplaneCreditedHours) },
      { label: "Multi-pilot", minutes: hoursToMinutes(caps.multiPilotCreditedHours) },
      { label: "Cruise relief (capped)", minutes: hoursToMinutes(caps.crcpCreditedHours), note: caps.crcpExcessHours > 0 ? `(${formatMinutes(hoursToMinutes(caps.crcpExcessHours))} over the cap)` : undefined },
      { label: "FNPT", minutes: hoursToMinutes(caps.fnptCreditedHours) },
      { label: "FFS", minutes: hoursToMinutes(caps.ffsCreditedHours) },
      { label: "Synthetic", minutes: hoursToMinutes(caps.syntheticCreditedHours) }
    ])
  );

  if (out.length === 1) out.push("", "No time to report.");
  return out.join("\n");
}

const ROLE_LABELS: Record<string, string> = {
  pilotInCommand: "PIC",
  coPilot: "co-pilot",
  fstdTrainee: "sim trainee",
  fstdInstructor: "sim instructor"
};

function cell(minutes: number | undefined): string {
  return minutes && minutes > 0 ? formatMinutes(minutes) : "";
}

/** The default `jetlog times` output: one row per entry. */
export function formatEntryTimesTable(entries: EntryTimesForTotals[]): string {
  const rows = entries.map((e, i) => ({
    "#": i + 1,
    date: e.date ?? "",
    route: e.type === "fstd" ? "sim" : e.fromIcao && e.toIcao ? `${e.fromIcao}-${e.toIcao}` : "",
    role: e.selfRole ? (ROLE_LABELS[e.selfRole] ?? e.selfRole) : "",
    block: cell(e.detailedTimes.totalTimeOfFlight),
    air: cell(e.detailedTimes.totalAirTime),
    night: cell(e.night ?? e.detailedTimes.night),
    ifr: cell(e.detailedTimes.ifr),
    pic: cell(e.easaTimesSigned.pilotInCommand),
    "co-pilot": cell(e.easaTimesSigned.coPilot),
    sim: cell(e.detailedTimes.fstdSession ?? e.detailedTimes.fstdInstructorTime ?? e.detailedTimes.fstdExaminerTime ?? e.detailedTimes.fstdSeniorInstructorTime)
  }));
  return toTable(rows, ["#", "date", "route", "role", "block", "air", "night", "ifr", "pic", "co-pilot", "sim"]);
}
