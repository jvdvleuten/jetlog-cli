/**
 * Ported from the Jetlog iOS app's Excel importer: Jetlog's own `.xlsx` export
 * (Flights/Simulator/People/Aircraft sheets, same schema as `jetlog-csv`'s `.csv` export).
 *
 * The Excel logbook format is the single source of truth both the CSV and Excel
 * exporters/importers key off of; `jetlog-csv`'s port
 * (`csv-logbook.ts`) already carries that column schema
 * (`JETLOG_CSV_HEADERS`) and the full parse-only row->`ImportedEntry`
 * mapping (planned/actual route, manual-time columns, IFR flag, crew-slot
 * resolution, takeoffs/landings). This importer reuses that mapping
 * directly (`parseSheets`) rather than re-deriving it, the only genuinely
 * new work here is reading the `.xlsx` container into the same
 * `Record<string, string>[]` per-sheet shape `csv-logbook.ts` already
 * consumes. See `../xlsx.ts`'s file doc comment for why that reader is a
 * small hand-rolled synchronous OOXML parser (on `fflate`) rather than a
 * full xlsx library.
 *
 * Scope cut vs. the iOS app (see `model.ts`'s file doc comment + this
 * file's sibling `csv-logbook.ts` for the general "no local store offline"
 * rule): the bulk of the iOS importer is UUID-based
 * matching/diffing against the user's existing entries/people/aircraft
 * (existing-entry/person/aircraft lookups, the per-field change diffing,
 * skipped-unchanged counting, preferred entry ids), none of that applies offline,
 * same as every other importer here; every row is produced brand-new.
 *
 * Cell-type leniency: a date/time
 * cell may be a resolved Excel serial (`xlsx.ts`'s `excelSerialToIsoDate`/
 * `excelSerialToClockMinutes`, via the cell's date-formatted style) or a
 * plain literal string (Jetlog's own exporter writes dates/times as text
 * for exact round-tripping), `xlsx.ts`'s cell reader already resolves a
 * date-styled numeric cell to the same `YYYY-MM-DD`/`HH:MM` text shape
 * `csv-logbook.ts` expects, so no extra handling is needed at this layer.
 * Not ported: decimal-hours duration cells (e.g. a hand-typed `1.5` meaning
 * 1h30m) and 4-digit no-colon time text (`"1435"`), `csv-logbook.ts`'s
 * `parseManualTime`/`timeOfDay` only accept `H:MM` text or a bare integer
 * (duration columns) / `HH:MM` (clock columns); see `docs/IMPORTERS.md`'s
 * Excel section for this and other documented gaps. Merged cells are not
 * handled (the format doesn't use them).
 */
import type { Importer, ImporterOptions } from "../importer.js";
import { emptyImportResult, type ImportError, type ImportResult } from "../model.js";
import { detectSheet, parseSheets, type ParsedFiles, type Sheet } from "./csv-logbook.js";
import { findSheetByName, readXlsxWorkbookSync, type XLSXSheet } from "../xlsx.js";

const SHEET_NAMES: Record<Sheet, string> = { flights: "Flights", simulator: "Simulator", people: "People", aircraft: "Aircraft" };

function looksLikeXlsxZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** Converts one `XLSXSheet`'s dense row grid into the `Record<string,
 * string>[]` shape `csv-logbook.ts`'s mapping functions consume, row 0 is
 * the header row (by position), matched by name so reordered/missing columns behave exactly
 * like the CSV path (a missing column reads as `undefined` everywhere). */
function sheetToRecords(sheet: XLSXSheet): Record<string, string>[] {
  const headers = (sheet.rows[0] ?? []).map((h) => h.trim());
  const records: Record<string, string>[] = [];
  for (const row of sheet.rows.slice(1)) {
    if (row.every((cell) => cell.trim().length === 0)) continue;
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header.length === 0) return;
      record[header] = row[index] ?? "";
    });
    records.push(record);
  }
  return records;
}

export function parseXlsxWorkbook(buffer: Buffer): ImportResult {
  const importErrors: ImportError[] = [];
  let sheets: XLSXSheet[];
  try {
    sheets = readXlsxWorkbookSync(buffer);
  } catch (err) {
    importErrors.push({ reason: `Could not read .xlsx file: ${err instanceof Error ? err.message : String(err)}` });
    return { ...emptyImportResult(), importErrors };
  }

  const parsed: ParsedFiles = { flights: [], simulator: [], people: [], aircraft: [] };
  for (const sheetKey of Object.keys(SHEET_NAMES) as Sheet[]) {
    const sheet = findSheetByName(sheets, SHEET_NAMES[sheetKey]);
    if (!sheet || sheet.rows.length === 0) continue;
    parsed[sheetKey] = sheetToRecords(sheet);
  }

  return parseSheets(parsed, importErrors);
}

export const excelImporter: Importer = {
  id: "excel",
  displayName: "Jetlog Excel export (.xlsx, Flights/Simulator/People/Aircraft)",
  extensions: ["xlsx"],
  detect(buffer: Buffer, filename?: string): number {
    if (!looksLikeXlsxZip(buffer) && !filename?.toLowerCase().endsWith(".xlsx")) return 0;
    try {
      const sheets = readXlsxWorkbookSync(buffer);
      const hasRecognizableSheet = Object.values(SHEET_NAMES).some((name) => {
        const sheet = findSheetByName(sheets, name);
        return sheet && detectSheet((sheet.rows[0] ?? []).map((h) => h.trim())) !== undefined;
      });
      return hasRecognizableSheet ? 0.8 : 0;
    } catch {
      return 0;
    }
  },
  async parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult> {
    const buffer = typeof input === "string" ? Buffer.from(input, "binary") : input;
    if (!looksLikeXlsxZip(buffer)) {
      return {
        ...emptyImportResult(),
        importErrors: [{ reason: "Not a readable .xlsx file (not a ZIP container).", sourceFileName: options?.filename }]
      };
    }
    return parseXlsxWorkbook(buffer);
  }
};
