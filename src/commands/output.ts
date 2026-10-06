/** Shared output helpers for the read commands (`entries`, `people`, `aircraft`). */

export type OutputFormat = "table" | "json" | "csv";

export function parseOutputFormat(opts: { json?: boolean; csv?: boolean; table?: boolean }): OutputFormat {
  if (opts.csv) return "csv";
  if (opts.json) return "json";
  return "table";
}

/** RFC 4180-ish CSV field escaping: quote if it contains a comma, quote, CR or LF. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
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
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function printRows(rows: Record<string, unknown>[], columns: string[], format: OutputFormat): void {
  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else if (format === "csv") {
    process.stdout.write(toCsv(rows, columns));
  } else {
    console.log(toTable(rows, columns));
  }
}
