/**
 * Shared tab-separated-row parsing for LogTen's TXT exports (both the
 * Flights/Simulator export and the separate Address Book export use the same
 * quoting rules). Ported from the identical private helpers duplicated in the iOS app's
 * LogTen flights and address book importers, kept as one shared module here
 * rather than duplicated.
 *
 * Rules (RFC 4180-ish, but tab-delimited, not comma):
 *  - Fields are separated by tabs.
 *  - A field may be wrapped in double quotes, in which case it may contain
 *    literal tabs and newlines; `""` inside a quoted field is an escaped `"`.
 *  - CR characters are stripped outright (handles CRLF and lone-CR line endings).
 */

/** Splits raw TXT content into logical lines, respecting quoted fields that
 * may contain embedded newlines. */
export function splitIntoProperLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  const chars = Array.from(text);
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

    if (ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === '"') {
      if (inQuotes && chars[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i += 1;
      continue;
    }

    if (ch === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
    i += 1;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Splits one logical line into tab-delimited columns, respecting quoted
 * fields that may contain literal tabs. Each column is trimmed, same as the
 * iOS app. */
export function parseRow(row: string): string[] {
  const columns: string[] = [];
  let current = "";
  let inQuotes = false;
  const chars = Array.from(row);
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

    if (ch === '"') {
      if (inQuotes && chars[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i += 1;
      continue;
    }

    if (ch === "\t" && !inQuotes) {
      columns.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
    i += 1;
  }
  columns.push(current.trim());
  return columns;
}

/** Column value by header name; `undefined` only when the header itself
 * isn't in this export's schema (a present-but-blank cell is `""`, not
 * `undefined`), mirrors `getValue(for:from:headers:)`. */
export function getValue(header: string, columns: string[], headers: string[]): string | undefined {
  const index = headers.indexOf(header);
  if (index < 0) return undefined;
  return columns[index];
}

/** Whether `header` exists in this export's schema AND the row's cell for it
 * is non-blank. Mirrors `hasExplicitValue(for:columns:headers:)`. */
export function hasExplicitValue(header: string, columns: string[], headers: string[]): boolean {
  const index = headers.indexOf(header);
  if (index < 0 || index >= columns.length) return false;
  return columns[index] !== "";
}
