/**
 * Port of the Jetlog iOS app's authoritative-times handling.
 *
 * Applies a per-format table of "authoritative time" fields onto
 * `entry.manualTimes`. `lookup` resolves one export column name to a `Time`
 * (or `undefined` when that column shouldn't override the field, absent
 * from the header row, or, for every format using this table, blank).
 * Fields whose column(s) are absent/blank leave the existing manual override
 * (if any) untouched. Clears `manualTimes` back to `undefined` when nothing
 * ends up set, unless `normalizesEmpty` is `false` (the FSTD session
 * tables), in which case `manualTimes` is only written when a column was
 * present and never collapsed to `undefined`.
 */
import { isEmptyTimes, time, type ImportedEntry, type Time, type Times, type TimesFieldKey } from "./model.js";

export type AuthoritativeTimeField =
  | { kind: "single"; column: string; field: TimesFieldKey }
  | { kind: "sum"; columns: string[]; field: TimesFieldKey };

export function single(column: string, field: TimesFieldKey): AuthoritativeTimeField {
  return { kind: "single", column, field };
}

export function sum(columns: string[], field: TimesFieldKey): AuthoritativeTimeField {
  return { kind: "sum", columns, field };
}

export function applyAuthoritativeTimes(
  fields: AuthoritativeTimeField[],
  lookup: (column: string) => Time | undefined,
  entry: ImportedEntry,
  normalizesEmpty = true
): void {
  const times: Times = { ...(entry.manualTimes ?? {}) };
  let applied = false;

  for (const field of fields) {
    if (field.kind === "single") {
      const t = lookup(field.column);
      if (t !== undefined) {
        times[field.field] = t;
        applied = true;
      }
    } else {
      const minutes = field.columns.map((c) => lookup(c)?.totalMinutes).filter((m): m is number => m !== undefined);
      if (minutes.length > 0) {
        times[field.field] = time(minutes.reduce((a, b) => a + b, 0));
        applied = true;
      }
    }
  }

  if (normalizesEmpty) {
    entry.manualTimes = isEmptyTimes(times) ? undefined : times;
  } else if (applied) {
    entry.manualTimes = times;
  }
}
