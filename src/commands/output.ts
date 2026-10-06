/** Shared output helpers for the read commands (`entries`, `people`, `aircraft`). */

export type OutputFormat = "table" | "json" | "csv";

export function parseOutputFormat(opts: { json?: boolean; csv?: boolean; table?: boolean }): OutputFormat {
  if (opts.csv) return "csv";
  if (opts.json) return "json";
  return "table";
}

/**
 * Strips what a server-supplied string could use against a terminal or a reader: control characters
 * (escape sequences included), bidirectional overrides and isolates, and line or paragraph separators.
 * Tabs and line breaks become one space so a cell stays on its line. File names written by the app are
 * only length-checked on the server, so they can carry any of this.
 */
export function sanitizeForTerminal(value: string): string {
  return value
    .replace(/[\t\n\r\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * RFC 4180-ish CSV field escaping: quote if it contains a comma, quote, CR or LF. With `sanitize`, string
 * values go through `sanitizeForTerminal` first (for output that reaches a terminal; a file export keeps
 * its data as it is).
 */
export function csvEscape(value: unknown, sanitize = false): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? (sanitize ? sanitizeForTerminal(value) : value) : JSON.stringify(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[], sanitize = false): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c], sanitize)).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function toTable(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return "(no rows)";

  const cells = rows.map((row) => columns.map((c) => formatCell(row[c])));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => row[i]!.length))
  );

  const formatRow = (values: string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join("  ");

  const lines = [formatRow(columns), formatRow(widths.map((w) => "-".repeat(w)))];
  for (const row of cells) lines.push(formatRow(row));
  return lines.join("\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return sanitizeForTerminal(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function printRows(rows: Record<string, unknown>[], columns: string[], format: OutputFormat): void {
  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else if (format === "csv") {
    process.stdout.write(toCsv(rows, columns, true));
  } else {
    console.log(toTable(rows, columns));
  }
}

/** `base` plus those of `optional` that at least one row carries, so a column the server does not send yet stays out. */
export function withPresentColumns(rows: Record<string, unknown>[], base: string[], optional: string[]): string[] {
  return [...base, ...optional.filter((c) => rows.some((r) => r[c] !== undefined))];
}
