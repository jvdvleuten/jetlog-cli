/**
 * Minimal in-memory `.xlsx` builder for tests, mirrors just enough of the
 * OOXML container shape `src/import/xlsx.ts` reads. Not a general xlsx
 * writer; only covers what the Excel importer tests need (one or more named
 * sheets, shared-string text cells, one date-styled numeric cell to test
 * serial->ISO/HH:MM conversion).
 */
import { zipSync } from "fflate";

export interface XlsxSheetSpec {
  name: string;
  /** Each row is a list of cells; a `{ date: <serial> }` cell is written as
   * a date-styled numeric cell (style index 1), everything else as a
   * shared-string text cell (style index 0). */
  rows: Array<Array<string | { date: number }>>;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function buildTestXlsx(sheets: XlsxSheetSpec[]): Buffer {
  const sharedStrings: string[] = [];
  function sharedStringIndex(text: string): number {
    let idx = sharedStrings.indexOf(text);
    if (idx < 0) {
      idx = sharedStrings.length;
      sharedStrings.push(text);
    }
    return idx;
  }

  const sheetXmls = sheets.map((sheet) => {
    const rowsXml = sheet.rows
      .map((row, rowIndex) => {
        const cellsXml = row
          .map((cell, colIndex) => {
            const ref = `${columnLetter(colIndex)}${rowIndex + 1}`;
            if (typeof cell === "object" && "date" in cell) {
              return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
            }
            const idx = sharedStringIndex(cell);
            return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
          })
          .join("");
        return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  });

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings
    .map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`)
    .join("")}</sst>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("")}</Relationships>`;

  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": new TextEncoder().encode(workbookXml),
    "xl/_rels/workbook.xml.rels": new TextEncoder().encode(relsXml),
    "xl/sharedStrings.xml": new TextEncoder().encode(sharedStringsXml),
    "xl/styles.xml": new TextEncoder().encode(stylesXml)
  };
  sheetXmls.forEach((xml, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = new TextEncoder().encode(xml);
  });

  return Buffer.from(zipSync(files));
}
