/**
 * Port of the Jetlog iOS app's in-file duplicate detector.
 *
 * Detects rows that duplicate other rows of the same import file and decides
 * which copy wins, so every importer surfaces the same review behaviour: the
 * losing copies are flagged (`ImportedEntry.isDuplicateInFile`) and one
 * `duplicateRowsInFile` warning per group explains it.
 *
 * Rules (same as the iOS app):
 *  - Flights: duplicate = same date + flight number + route. Rows without a
 *    flight number never participate.
 *  - FSTD: same-day sessions are treated as the same, except rows carrying
 *    *different explicit* start times, which are kept as a genuine
 *    double-session day; a missing start time can't prove difference.
 *  - Winner: a row that resolved to an entry already in the system beats any
 *    unmatched row, then the most complete copy, then file order. Offline,
 *    every row is unmatched (see `model.ts`'s file doc comment), so the
 *    winner is always "most complete, then file order".
 */
import { entryTypeRawValue, type EntryType, type ImportError, type ImportedEntry, type Time } from "./model.js";

export interface DuplicateRow {
  index?: number;
  type: EntryType;
  dateString: string;
  flightNumber?: string;
  from?: string;
  to?: string;
  startTime?: Time;
  matchedExistingId?: string;
  completeness: number;
  label: string;
  /** Line of the source file (header = 1), when the importer recorded it. */
  sourceRow?: number;
}

/** ` (rows 2, 6)` for the copies whose source rows are known, else empty. */
function rowsSuffix(group: DuplicateRow[]): string {
  const rows = group.map((r) => r.sourceRow).filter((r): r is number => r !== undefined).sort((a, b) => a - b);
  return rows.length > 0 ? ` (rows ${rows.join(", ")})` : "";
}

export interface DuplicateOutcome {
  loserIndexes: Set<number>;
  warnings: ImportError[];
}

/** The identity under which a row groups with other rows of the same file
 * (`undefined` = the row never participates). */
export function groupKey(row: DuplicateRow): string | undefined {
  const type = entryTypeRawValue(row.type);
  if (type === "flight") {
    const flightNumber = row.flightNumber?.toUpperCase();
    if (!flightNumber) return undefined;
    return `flight|${row.dateString}|${flightNumber}|${row.from ?? "-"}|${row.to ?? "-"}`;
  }
  if (type === "fstd") return `fstd|${row.dateString}`;
  return undefined;
}

function winnerIndex(group: DuplicateRow[]): number {
  let best = 0;
  for (let i = 1; i < group.length; i++) {
    const a = group[i]!;
    const b = group[best]!;
    const aMatched = a.matchedExistingId !== undefined;
    const bMatched = b.matchedExistingId !== undefined;
    if (aMatched !== bMatched) {
      if (aMatched) best = i;
      continue;
    }
    if (a.completeness !== b.completeness) {
      if (a.completeness > b.completeness) best = i;
      continue;
    }
    // lower index wins ties, `best` is already lower, keep it.
  }
  return best;
}

export function detect(rows: DuplicateRow[]): DuplicateOutcome {
  const loserIndexes = new Set<number>();
  const warnings: ImportError[] = [];

  const flightGroups = new Map<string, DuplicateRow[]>();
  const flightOrder: string[] = [];
  const fstdByDay = new Map<string, DuplicateRow[]>();
  const fstdDayOrder: string[] = [];

  for (const row of rows) {
    const key = groupKey(row);
    if (key === undefined) continue;
    const type = entryTypeRawValue(row.type);
    if (type === "flight") {
      if (!flightGroups.has(key)) {
        flightOrder.push(key);
        flightGroups.set(key, []);
      }
      flightGroups.get(key)!.push(row);
    } else if (type === "fstd") {
      if (!fstdByDay.has(row.dateString)) {
        fstdDayOrder.push(row.dateString);
        fstdByDay.set(row.dateString, []);
      }
      fstdByDay.get(row.dateString)!.push(row);
    }
  }

  for (const key of flightOrder) {
    const group = flightGroups.get(key)!;
    if (group.length <= 1) continue;
    const winner = winnerIndex(group);
    group.forEach((row, offset) => {
      if (offset !== winner && row.index !== undefined) loserIndexes.add(row.index);
    });
    const sample = group[winner]!;
    const bothLocal = new Set(group.map((r) => r.matchedExistingId).filter((id) => id !== undefined)).size > 1;
    const reason = bothLocal
      ? `${sample.label} is listed ${group.length}× in this file on ${sample.dateString}${rowsSuffix(group)}. Your logbook already contains both copies, so the extra row is skipped.`
      : `${sample.label} is listed ${group.length}× in this file on ${sample.dateString}${rowsSuffix(group)}. Only the most complete copy is imported and the others are skipped.`;
    warnings.push({ code: "duplicateRowsInFile", reason, dateString: sample.dateString, flightNumber: sample.flightNumber });
  }

  for (const day of fstdDayOrder) {
    const sameDay = fstdByDay.get(day)!;
    if (sameDay.length <= 1) continue;

    const buckets: DuplicateRow[][] = [];
    for (const row of sameDay) {
      const bucketIndex = buckets.findIndex((bucket) =>
        bucket.every(
          (other) =>
            row.startTime === undefined || other.startTime === undefined || row.startTime.totalMinutes === other.startTime.totalMinutes
        )
      );
      if (bucketIndex >= 0) buckets[bucketIndex]!.push(row);
      else buckets.push([row]);
    }

    let flaggedAny = false;
    for (const bucket of buckets) {
      if (bucket.length <= 1) continue;
      const winner = winnerIndex(bucket);
      bucket.forEach((row, offset) => {
        if (offset !== winner) {
          if (row.index !== undefined) loserIndexes.add(row.index);
          flaggedAny = true;
        }
      });
    }

    const bothLocal = new Set(sameDay.map((r) => r.matchedExistingId).filter((id) => id !== undefined)).size > 1;
    const reason = flaggedAny
      ? bothLocal
        ? `${sameDay.length} FSTD sessions on ${day}${rowsSuffix(sameDay)}. Your logbook already contains them as separate sessions, so the extra row is skipped.`
        : `${sameDay.length} FSTD sessions on ${day}${rowsSuffix(sameDay)}. They are treated as the same session, so the extra row is skipped.`
      : `${sameDay.length} FSTD sessions on ${day}${rowsSuffix(sameDay)} with different start times. All of them are imported; check that they are not the same session listed twice.`;
    warnings.push({ code: "duplicateRowsInFile", reason, dateString: day });
  }

  return { loserIndexes, warnings };
}

/**
 * Convenience for importers whose emitted entries carry their full row data:
 * flags the losing entries and appends the group warnings, in place.
 */
export function flagDuplicates(entries: ImportedEntry[], importErrors: ImportError[]): void {
  const ordered = [...entries].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rows: DuplicateRow[] = ordered.map((entry, index) => {
    let completeness =
      [entry.offBlocks, entry.airborne, entry.touchdown, entry.onBlocks, entry.startTime, entry.endTime].filter(
        (t) => t !== undefined
      ).length +
      entry.crew.length +
      (entry.remarks !== undefined ? 1 : 0) +
      (entry.fstdId !== undefined ? 1 : 0) +
      (entry.sessionType !== undefined ? 1 : 0);
    if (entry.takeoffsAndLandings?.type === "manual") {
      const t = entry.takeoffsAndLandings;
      if (t.takeoffsDay + t.takeoffsNight + t.landingsDay + t.landingsNight > 0) completeness += 1;
    }
    if ((entry.fstdTakeoffs ?? 0) > 0) completeness += 1;
    if ((entry.fstdLandings ?? 0) > 0) completeness += 1;

    const matchedId = entry.isExisting.existing ? entry.isExisting.id : undefined;
    const label =
      entryTypeRawValue(entry.type) === "flight"
        ? `${entry.flightNumber ?? "?"} ${entry.from ?? "?"}–${entry.to ?? "?"}`
        : entry.fstdId
          ? `FSTD session ${entry.fstdId}`
          : "FSTD session";

    return {
      index,
      type: entry.type,
      dateString: entry.date,
      flightNumber: entry.flightNumber,
      from: entry.from,
      to: entry.to,
      startTime: entry.startTime,
      matchedExistingId: matchedId,
      completeness,
      label,
      sourceRow: entry.sourceRow
    };
  });

  const outcome = detect(rows);
  if (outcome.warnings.length === 0) return;
  for (const index of outcome.loserIndexes) {
    const row = ordered[index]!;
    row.isDuplicateInFile = true;
    if (row.isExisting.existing) row.matchedResolution = "createNew";
  }
  entries.splice(0, entries.length, ...ordered);
  importErrors.push(...outcome.warnings);
}
