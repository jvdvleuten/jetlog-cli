/**
 * Ported from the Jetlog iOS app's LogTen custom switch mapping.
 *
 * LogTen "Duty" custom switches (`flight_customCapacity1...20`) are on/off
 * columns the pilot configures per-installation, there is no way to know
 * from the export alone what a populated switch means (line check duty,
 * route instruction, a genuine deadhead, or something else entirely). This
 * mapping is user-supplied (interactively, in the iOS review sheet; here via
 * `ImporterOptions`/a CLI flag that the caller is responsible for building)
 * and reused across a re-import of the same file signature.
 */
import type { EntryPersonRole } from "../../model.js";
import { colonMinutes } from "../../time-parsing.js";

/** Switch column index (1...20) -> role. A switch absent from `roles` means
 * "Ignore" (the default): rows carrying only that switch resolve exactly as
 * before this feature existed. */
export interface LogTenCustomSwitchMapping {
  roles: Record<number, EntryPersonRole>;
  /** Pairwise conflict winners for two DIFFERENT mapped switches that
   * co-occur on at least one row. Keyed by `pairKey(a, b)`. */
  winners: Record<number, number>;
}

export function newLogTenCustomSwitchMapping(): LogTenCustomSwitchMapping {
  return { roles: {}, winners: {} };
}

export function pairKey(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo * 100 + hi;
}

export function winner(mapping: LogTenCustomSwitchMapping, a: number, b: number): number | undefined {
  return mapping.winners[pairKey(a, b)];
}

export function setWinner(mapping: LogTenCustomSwitchMapping, win: number, a: number, b: number): void {
  mapping.winners[pairKey(a, b)] = win;
}

/** Whether every pair from `mappedIndices` that has DIFFERENT roles has a
 * recorded winner, i.e. the mapping sheet's Continue gate. Same-role pairs
 * need no winner (there's nothing to resolve between them). */
export function hasUnresolvedConflicts(mapping: LogTenCustomSwitchMapping, mappedIndices: number[]): boolean {
  for (let i = 0; i < mappedIndices.length; i++) {
    for (let j = i + 1; j < mappedIndices.length; j++) {
      const a = mappedIndices[i]!;
      const b = mappedIndices[j]!;
      if (mapping.roles[a] === mapping.roles[b]) continue;
      if (winner(mapping, a, b) === undefined) return true;
    }
  }
  return false;
}

/** Per-switch scan info: which column, how many normal-flight rows carry it,
 * over what date range, and the most common remark on those rows (context
 * only, never used to pre-fill a role). */
export interface LogTenCustomSwitchInfo {
  index: number;
  rowCount: number;
  minDate?: string;
  maxDate?: string;
  mostCommonRemark?: string;
}

/** Co-occurrence of two populated switches: `coOccurrenceCount` rows carry
 * BOTH `a` and `b` set. */
export interface LogTenCustomSwitchCoOccurrence {
  a: number;
  b: number;
  coOccurrenceCount: number;
}

export interface LogTenCustomSwitchScan {
  switches: LogTenCustomSwitchInfo[];
  coOccurrences: LogTenCustomSwitchCoOccurrence[];
}

/** Whether any normal-flight row in the file carries a populated custom
 * switch, the importer only asks the mapping question when this is true. */
export function isCustomSwitchScanSignificant(scan: LogTenCustomSwitchScan): boolean {
  return scan.switches.length > 0;
}

/** The file signature a saved mapping is keyed on: the sorted set of
 * populated switch column indices. A re-import with the SAME populated
 * switches reuses the saved mapping; a changed set asks again. */
export function customSwitchScanFileSignature(scan: LogTenCustomSwitchScan): string {
  return scan.switches
    .map((s) => s.index)
    .sort((a, b) => a - b)
    .join(",");
}

/**
 * Whether a `flight_customCapacityN` cell counts as "set". `"1"` (the
 * confirmed real-export value) and any other non-zero number/duration count
 * as set; empty and zero-ish values (`"0"`, `"0:00"`, `"00:00"`) do not, a
 * real export has been seen with every capacity column populated as a
 * literal "0" on every row, which must not trigger the mapping sheet.
 */
export function isCustomSwitchValueSet(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  const intValue = Number.parseInt(trimmed, 10);
  if (Number.isFinite(intValue) && /^-?\d+$/.test(trimmed)) return intValue !== 0;
  const doubleValue = Number.parseFloat(trimmed);
  if (Number.isFinite(doubleValue) && /^-?\d*\.\d+$/.test(trimmed)) return doubleValue !== 0;
  if (trimmed.includes(":")) return colonMinutes(trimmed) !== 0;
  return true;
}
