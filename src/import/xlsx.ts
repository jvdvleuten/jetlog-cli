/**
 * Minimal, synchronous OOXML (`.xlsx`) reader.
 *
 * The iOS app's `.xlsx` reading is itself a from-scratch, dependency-light
 * reader: no Apple spreadsheet framework, no third-party xlsx library, just
 * a zip library to unzip plus an XML parser (SAX) to read each XML part. This
 * port mirrors that shape rather than pulling in a full xlsx library, for one
 * load-bearing reason beyond fidelity: this CLI's `Importer.parse()` is
 * synchronous (see
 * `importer.ts`), and every maintained xlsx-reading npm package considered
 * (`exceljs`, `read-excel-file`) is async-only; their zip/XML parsing is
 * promise-based with no sync variant. Rather than changing `Importer.parse`
 * to `async` for one format (which would ripple through `convertFile`/the
 * CLI/MCP server), this file implements just enough of the OOXML spreadsheet
 * format to read Jetlog's own exported `.xlsx` shape synchronously, reusing
 * `fflate` (already a dependency for ZIP support, see `zip.ts`) for the
 * container and small regexes for the XML parts.
 *
 * Scope: this is not a general xlsx reader. It covers exactly what
 * Jetlog's own Excel exporter produces and what the app's reader
 * handles (shared strings, inline strings, formula-result
 * strings, booleans, numbers, date-styled numeric serials). See
 * `docs/IMPORTERS.md` for the explicit list of gaps
 * (merged cells don't occur in this format so aren't handled; a workbook
 * from a totally different source with heavy formatting/formulas may read
 * incorrectly).
 */
import { unzipSync } from "fflate";

export interface XLSXSheet {
  name: string;
  /** Dense rows, 0-indexed, each a dense array of cell text (empty string
   * for a blank cell) aligned to spreadsheet column position. */
  rows: string[][];
}

function decode(bytes: Uint8Array | undefined): string {
  return bytes ? Buffer.from(bytes).toString("utf8") : "";
}

/** Decodes the handful of XML entities that appear in cell/string text. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, "&");
}

/** `"A"` -> 0, `"Z"` -> 25, `"AA"` -> 26, ... */
function columnLetterToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseCellRef(ref: string | undefined): { col: number; row: number } | undefined {
  if (!ref) return undefined;
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return undefined;
  return { col: columnLetterToIndex(match[1]!), row: Number.parseInt(match[2]!, 10) - 1 };
}

// ---------------------------------------------------------------------------
// Shared strings
// ---------------------------------------------------------------------------

/** Parses `xl/sharedStrings.xml` into the shared-strings table, each `<si>`
 * entry's concatenated `<t>` text (handles both plain `<si><t>` and rich-text
 * `<si><r><t>...</t></r>...</si>`). */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRegex = /<si[^>]*>(.*?)<\/si>/gs;
  let match: RegExpExecArray | null;
  while ((match = siRegex.exec(xml))) {
    const inner = match[1]!;
    const texts = [...inner.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => decodeXmlEntities(m[1] ?? ""));
    strings.push(texts.join(""));
  }
  return strings;
}

// ---------------------------------------------------------------------------
// Styles, which cellXfs indices are date/time-formatted
// ---------------------------------------------------------------------------

const BUILTIN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** True when a custom `numFmtCode` string looks date/time-formatted, strips
 * quoted literals and `[...]` color/condition brackets first, then checks
 * for a date/time token. */
function numFmtCodeLooksLikeDate(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[ydhms]/i.test(stripped);
}

/** Parses `xl/styles.xml` into the set of `cellXfs` indices that format a
 * numeric cell as a date/time. */
function parseDateStyleIndices(xml: string | undefined): Set<number> {
  if (!xml) return new Set();

  const customFormats = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g)) {
    customFormats.set(Number.parseInt(m[1]!, 10), decodeXmlEntities(m[2]!));
  }

  const cellXfsMatch = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(xml);
  if (!cellXfsMatch) return new Set();
  const xfs = [...cellXfsMatch[1]!.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => m[0]);

  const dateIndices = new Set<number>();
  xfs.forEach((xf, index) => {
    const numFmtIdMatch = /numFmtId="(\d+)"/.exec(xf);
    if (!numFmtIdMatch) return;
    const numFmtId = Number.parseInt(numFmtIdMatch[1]!, 10);
    if (BUILTIN_DATE_FORMAT_IDS.has(numFmtId)) {
      dateIndices.add(index);
    } else {
      const custom = customFormats.get(numFmtId);
      if (custom && numFmtCodeLooksLikeDate(custom)) dateIndices.add(index);
    }
  });
  return dateIndices;
}

// ---------------------------------------------------------------------------
// Excel serial date/time conversion, epoch 1899-12-30 (reproduces Excel's
// 1900 leap-year bug for serial >= 60, same as the iOS app).
// ---------------------------------------------------------------------------

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

export function excelSerialToDate(serial: number): Date {
  if (!Number.isFinite(serial)) return new Date(EXCEL_EPOCH_MS);
  return new Date(EXCEL_EPOCH_MS + serial * 86400 * 1000);
}

export function excelSerialToIsoDate(serial: number): string {
  const d = excelSerialToDate(serial);
  return `${d.getUTCFullYear().toString().padStart(4, "0")}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}-${d
    .getUTCDate()
    .toString()
    .padStart(2, "0")}`;
}

export function excelSerialToClockMinutes(serial: number): number {
  if (!Number.isFinite(serial)) return 0;
  const fractionalDay = serial - Math.floor(serial);
  const minutes = Math.round(fractionalDay * 1440);
  return Math.min(1439, Math.max(0, minutes));
}

// ---------------------------------------------------------------------------
// Worksheet parsing
// ---------------------------------------------------------------------------

interface RawCell {
  text: string;
}

function parseCellValue(cellXml: string, type: string | undefined, isDateStyle: boolean, sharedStrings: string[]): RawCell {
  if (type === "s") {
    const v = /<v[^>]*>(.*?)<\/v>/s.exec(cellXml)?.[1];
    const idx = v !== undefined ? Number.parseInt(v, 10) : NaN;
    return { text: Number.isFinite(idx) ? (sharedStrings[idx] ?? "") : "" };
  }
  if (type === "inlineStr") {
    const texts = [...cellXml.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => decodeXmlEntities(m[1] ?? ""));
    return { text: texts.join("") };
  }
  if (type === "str") {
    const v = /<v[^>]*>(.*?)<\/v>/s.exec(cellXml)?.[1];
    return { text: v !== undefined ? decodeXmlEntities(v) : "" };
  }
  if (type === "b") {
    const v = /<v[^>]*>(.*?)<\/v>/s.exec(cellXml)?.[1];
    return { text: v === "1" || v?.toLowerCase() === "true" ? "TRUE" : "FALSE" };
  }
  if (type === "e") {
    return { text: "" };
  }

  // Default/numeric.
  const v = /<v[^>]*>(.*?)<\/v>/s.exec(cellXml)?.[1];
  if (v === undefined || v.length === 0) return { text: "" };
  const num = Number.parseFloat(v);
  if (!Number.isFinite(num)) return { text: "" };
  if (isDateStyle) {
    const timePart = excelSerialToClockMinutes(num);
    // Pure date (no time-of-day component) vs. date+time vs. pure time
    // (small serial, no whole-day part): format whichever is informative.
    const hasWholeDayPart = Math.floor(num) >= 1;
    if (hasWholeDayPart && timePart === 0) return { text: excelSerialToIsoDate(num) };
    if (!hasWholeDayPart) {
      const h = Math.floor(timePart / 60);
      const m = timePart % 60;
      return { text: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
    }
    return { text: excelSerialToIsoDate(num) };
  }
  return { text: Number.isInteger(num) ? String(num) : String(num) };
}

function parseWorksheetXml(xml: string, sharedStrings: string[], dateStyleIndices: Set<number>): string[][] {
  const grid: string[][] = [];
  const rowRegex = /<row\b([^>]*)>(.*?)<\/row>/gs;
  let rowMatch: RegExpExecArray | null;
  let fallbackRowIndex = 0;

  while ((rowMatch = rowRegex.exec(xml))) {
    const rowAttrs = rowMatch[1]!;
    const rowContent = rowMatch[2]!;
    const rAttr = /\br="(\d+)"/.exec(rowAttrs)?.[1];
    const rowIndex = rAttr !== undefined ? Number.parseInt(rAttr, 10) - 1 : fallbackRowIndex;
    fallbackRowIndex = rowIndex + 1;

    const row: string[] = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gs;
    let cellMatch: RegExpExecArray | null;
    let fallbackCol = 0;
    while ((cellMatch = cellRegex.exec(rowContent))) {
      const attrs = cellMatch[1]!;
      const inner = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const parsedRef = parseCellRef(ref);
      const col = parsedRef?.col ?? fallbackCol;
      fallbackCol = col + 1;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const styleIdx = /\bs="(\d+)"/.exec(attrs)?.[1];
      const isDateStyle = styleIdx !== undefined && dateStyleIndices.has(Number.parseInt(styleIdx, 10));
      const { text } = parseCellValue(inner, type, isDateStyle, sharedStrings);
      while (row.length < col) row.push("");
      row[col] = text;
    }
    while (grid.length < rowIndex) grid.push([]);
    grid[rowIndex] = row;
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Workbook-level assembly
// ---------------------------------------------------------------------------

export function readXlsxWorkbookSync(buffer: Buffer | Uint8Array): XLSXSheet[] {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = unzipSync(data);

  const sharedStrings = parseSharedStrings(decode(entries["xl/sharedStrings.xml"]));
  const dateStyleIndices = parseDateStyleIndices(decode(entries["xl/styles.xml"]));

  const workbookXml = decode(entries["xl/workbook.xml"]);
  const sheetDefs = [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g)].map((m) => ({
    name: decodeXmlEntities(m[1]!),
    rId: m[2]!
  }));

  const relsXml = decode(entries["xl/_rels/workbook.xml.rels"]);
  const relTargets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/>/g)) {
    relTargets.set(m[1]!, m[2]!);
  }

  const sheets: XLSXSheet[] = [];
  for (const def of sheetDefs) {
    const target = relTargets.get(def.rId);
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const sheetXml = decode(entries[path]);
    if (!sheetXml) continue;
    sheets.push({ name: def.name, rows: parseWorksheetXml(sheetXml, sharedStrings, dateStyleIndices) });
  }
  return sheets;
}

export function findSheetByName(sheets: XLSXSheet[], name: string): XLSXSheet | undefined {
  return sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
}
