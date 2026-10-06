/**
 * Turns an `ImportResult`'s flat `importErrors` into structured, row-aware
 * notices, and formats them for a terminal.
 *
 * The importers (ports of the iOS ones) report warnings as `ImportError`s that
 * carry the flight identity (`dateString`, `flightNumber`, `registration`) and
 * the `entryId` of the row they are about, but not which line of the file that
 * row came from. This module resolves the row through the entry's `sourceRow`
 * (set by the line-oriented importers) and adds the entry's route, so every
 * consumer (`convert`, `import`, `times`, `totals`, the MCP tools) shows the same
 * information instead of a bare "Registration missing".
 */
import { importErrorSeverity, type ImportError, type ImportResult } from "./model.js";

export interface ImportNotice {
  /** `skipped`: the row could not be imported at all. `warning`: the row was imported (or deliberately
   * left out as a duplicate) but something about it deserves a look. */
  kind: "skipped" | "warning";
  severity: "error" | "warning";
  code?: string;
  /** The importer's own message, unchanged. */
  message: string;
  /** 1-based line in the source file, header counted as line 1, when the importer knows it. */
  row?: number;
  date?: string;
  flightNumber?: string;
  from?: string;
  to?: string;
  registration?: string;
  /** Short flight identity for display, e.g. `2026-01-13 KL1004 EHAM-EGLL`. */
  identity?: string;
}

function identityOf(parts: { date?: string; flightNumber?: string; from?: string; to?: string; registration?: string; fstdId?: string }): string | undefined {
  const bits: string[] = [];
  if (parts.date) bits.push(parts.date);
  if (parts.flightNumber) bits.push(parts.flightNumber);
  else if (parts.fstdId) bits.push(parts.fstdId);
  if (parts.from && parts.to) bits.push(`${parts.from}-${parts.to}`);
  return bits.length > 0 ? bits.join(" ") : undefined;
}

/** Structured notices for every `importErrors` entry, identical messages for the same row collapsed. */
export function importNotices(result: Pick<ImportResult, "entries" | "importErrors"> & { notes?: string[] }): ImportNotice[] {
  const byId = new Map(result.entries.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const out: ImportNotice[] = [];
  for (const e of result.importErrors) {
    const entry = e.entryId ? byId.get(e.entryId) : undefined;
    const date = entry?.date ?? e.dateString;
    const flightNumber = entry?.flightNumber ?? e.flightNumber;
    const from = entry?.from ?? e.from;
    const to = entry?.to ?? e.to;
    const registration = entry?.registration ?? e.registration;
    const row = entry?.sourceRow ?? e.rowNumber;
    // A row that was dropped outright is reported as skipped; everything else (about a kept row, about the
    // file as a whole, duplicates) is a warning.
    const entryBound = e.entryId !== undefined || row === undefined;
    const notice: ImportNotice = {
      kind: entryBound ? "warning" : "skipped",
      severity: importErrorSeverity(e),
      ...(e.code ? { code: e.code } : {}),
      message: e.reason,
      ...(row !== undefined ? { row } : {}),
      ...(date ? { date } : {}),
      ...(flightNumber ? { flightNumber } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(registration ? { registration } : {})
    };
    const identity = identityOf({ date, flightNumber, from, to, registration, fstdId: entry?.fstdId });
    if (identity && e.code !== "duplicateRowsInFile") notice.identity = identity;
    const key = `${notice.kind}|${row ?? ""}|${identity ?? ""}|${e.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(notice);
  }
  for (const note of result.notes ?? []) out.push({ kind: "warning", severity: "warning", message: note });
  return out;
}

function label(n: ImportNotice): string | undefined {
  if (n.row === undefined && !n.identity) return undefined;
  const row = n.row !== undefined ? `row ${n.row}` : undefined;
  if (row && n.identity) return `${row} (${n.identity})`;
  return row ?? n.identity;
}

/**
 * Terminal lines, one per row: `row 5 (2026-01-13 KL1004): Registration missing; Origin airport missing`.
 * Notices without a row or identity (file-level messages, duplicate groups that already name their
 * flight) keep their own line. Rows that were skipped outright read `skipped row N: reason`.
 * No prefix such as `warning:` is added, the caller owns that.
 */
export function formatNotices(notices: ImportNotice[]): { kind: ImportNotice["kind"]; text: string }[] {
  type Item = { kind: ImportNotice["kind"]; text?: string; head?: string; messages?: string[] };
  const items: Item[] = [];
  const groups = new Map<string, Item>();
  for (const n of notices) {
    if (n.kind === "skipped") {
      items.push({ kind: "skipped", text: n.row !== undefined ? `skipped row ${n.row}: ${n.message}` : `skipped: ${n.message}` });
      continue;
    }
    const head = label(n);
    if (!head) {
      items.push({ kind: "warning", text: n.message });
      continue;
    }
    const existing = groups.get(head);
    if (existing) existing.messages!.push(n.message);
    else {
      const group: Item = { kind: n.kind, head, messages: [n.message] };
      groups.set(head, group);
      items.push(group);
    }
  }
  return items.map((i) => ({ kind: i.kind, text: i.text ?? `${i.head}: ${i.messages!.join("; ")}` }));
}

/** Terminal lines with the standard prefix: `warning: row 5 (...): ...` or `skipped row 5: ...`. */
export function terminalNoticeLines(notices: ImportNotice[], indent = ""): string[] {
  return formatNotices(notices).map((l) => (l.kind === "skipped" ? `${indent}${l.text}` : `${indent}warning: ${l.text}`));
}

/** Convenience: formatted lines straight from an `ImportResult`. */
export function importResultNoticeLines(result: Pick<ImportResult, "entries" | "importErrors"> & { notes?: string[] }): string[] {
  return formatNotices(importNotices(result)).map((l) => l.text);
}

export type { ImportError };
