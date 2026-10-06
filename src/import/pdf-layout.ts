/**
 * Layout-aware PDF text extraction for Chrono, ported as faithfully as
 * `pdfjs-dist` allows from the iOS app's layout text extractor (PDFKit,
 * per-glyph coordinates + foreground-color filtering).
 *
 * ## What's ported
 *
 * - Reconstructing lines from each text item's Y position (top-to-bottom,
 *   within a `yTolerance` band) then X position (left-to-right), mirrors
 *   the app's sort (`midY` descending, then `minX` ascending within a
 *   line).
 * - Inserting a space between two adjacent items on the same line when the
 *   horizontal gap between them exceeds a threshold, mirrors
 *   `buildLineStringSimple`'s gap-vs-`spaceThreshold` logic, just applied
 *   at pdfjs's own item granularity (see below) instead of per character.
 * - Uppercasing every line (the app uppercases each glyph before matching).
 * - The `"K L"` -> `"KL"` kerning-artifact patch the app applies to every
 *   reconstructed line.
 *
 * ## What's not ported (documented, not silently different)
 *
 * - **Per-glyph granularity.** PDFKit's `enumerateSubstrings` walks
 *   individual Unicode grapheme clusters, each with its own bounding box.
 *   pdfjs's `getTextContent()` instead returns whole runs (`TextItem.str`,
 *   typically a word, or a run of same-styled text drawn by one content-
 *   stream operator) with one position/width for the entire run, verified
 *   empirically (a "HELLO WORLD" run came back as a single item, not 11).
 *   There is no pdfjs API that exposes a per-glyph bounding box the way
 *   PDFKit's selection-based bounds do. Consequences: gap-based spacing
 *   only ever kicks in between items (pdfjs already encodes any
 *   intra-run spacing straight into `str`), and the app's
 *   kerning-width-correction heuristic (clamping an abnormally wide
 *   single-character bounding box, its own patch for a PDFKit artifact)
 *   has nothing to operate on at this granularity, dropped, not
 *   approximated.
 * - **Foreground-color filtering** (the app drops glyphs whose fill color
 *   isn't near-black/opaque, to strip watermarks). pdfjs's `TextItem`
 *   carries no color field at all (confirmed empirically); the only fields
 *   present are `str`/`dir`/`width`/`height`/`transform`/`fontName`/
 *   `hasEOL`. A full reproduction would mean walking
 *   `page.getOperatorList()` and correlating `setFillRGBColor`/
 *   `setFillGray`/`setFillColorN` ops with the interleaved text-showing
 *   ops by call order, to reconstruct a running "current fill color" at
 *   the moment each text run was drawn. That's fragile (it assumes a
 *   specific, generator-dependent interleaving of color-setting and
 *   text-showing ops that getOperatorList's flat op stream doesn't
 *   guarantee) and impossible to validate without a real exported Chrono
 *   PDF that actually has colored/watermark content; this repo only has
 *   synthetic fixtures (see `docs/IMPORTERS.md`).
 *   Deliberately not attempted: every extracted line is kept regardless of
 *   source color.
 * - **The allowed-character-set per-glyph filter**
 *   (`ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:+-.* `). Same granularity
 *   problem as color: it's a per-glyph gate in the app, and applying it to a
 *   whole `TextItem.str` run risks dropping real content (e.g. a crew name
 *   sharing a run with punctuation) rather than just noise. Not applied
 *   here.
 *
 * Bottom line: treat this as best-effort, same line-reconstruction
 * contract as iOS (Y-band + X-order + gap spacing + the "K L" patch), but
 * at word/run granularity instead of per-glyph, and with no color-based
 * noise filtering. Unverified against a real exported Chrono PDF; this
 * repo only has synthetic fixtures (see `docs/IMPORTERS.md`).
 */
import { getDocumentProxy } from "unpdf";

/** Mirrors `PDFLayoutTextExtractor.extractTextByLayout`'s default
 * `yTolerance`: two items land on the same reconstructed line when their Y
 * positions differ by at most this many PDF points. */
const Y_TOLERANCE = 4;

/**
 * Minimum horizontal gap (in PDF points) between two adjacent items on the
 * same line before a space is inserted between them. The iOS app derives its
 * threshold from a rolling average glyph width (`avgCharWidth *
 * spaceThresholdMultiplier`); at item/run granularity there's no equivalent
 * per-line average to roll, so this is a fixed, conservative points value
 * instead, small enough that two adjacent words/columns separated by a
 * real gap still get a space, without needing a character-width estimate.
 */
const SPACE_THRESHOLD_POINTS = 2;

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

function isPdfjsTextItem(item: unknown): item is { str: string; transform: number[]; width: number } {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { str?: unknown }).str === "string" &&
    Array.isArray((item as { transform?: unknown }).transform)
  );
}

function buildLine(items: PositionedTextItem[]): string {
  let line = "";
  let prevEndX: number | undefined;
  for (const item of items) {
    const text = item.str.toUpperCase();
    if (text.length === 0) continue;
    if (prevEndX !== undefined && !line.endsWith(" ") && !text.startsWith(" ")) {
      const gap = item.x - prevEndX;
      if (gap > SPACE_THRESHOLD_POINTS) line += " ";
    }
    line += text;
    prevEndX = item.x + item.width;
  }
  // Mirrors the iOS app's final `"K L"` -> `"KL"` kerning-artifact patch, applied
  // to every reconstructed line.
  return line.trim().replace(/K L/g, "KL");
}

/**
 * Extracts PDF text as layout-reconstructed lines (one element per line),
 * for formats whose regex-based row parsing depends on column spacing
 * surviving extraction (Chrono's flight/simulator-duty rows). See the file
 * doc comment for exactly what is and isn't ported from
 * the iOS app's extractor.
 */
export async function extractTextByLayout(buffer: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const lines: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();

    const items: PositionedTextItem[] = [];
    for (const raw of content.items) {
      if (!isPdfjsTextItem(raw) || raw.str.trim().length === 0) continue;
      items.push({ str: raw.str, x: raw.transform[4] ?? 0, y: raw.transform[5] ?? 0, width: raw.width });
    }

    if (items.length === 0) continue;

    // Top-most first, then left-to-right within a line, mirrors the iOS
    // app's comparator exactly (just at item, not glyph, granularity).
    const sorted = [...items].sort((a, b) => {
      if (Math.abs(a.y - b.y) > Y_TOLERANCE) return b.y - a.y;
      return a.x - b.x;
    });

    let currentLine: PositionedTextItem[] = [];
    let currentLineY: number | undefined;
    for (const item of sorted) {
      if (currentLine.length === 0 || (currentLineY !== undefined && Math.abs(item.y - currentLineY) <= Y_TOLERANCE)) {
        if (currentLine.length === 0) currentLineY = item.y;
        currentLine.push(item);
      } else {
        lines.push(buildLine(currentLine));
        currentLine = [item];
        currentLineY = item.y;
      }
    }
    if (currentLine.length > 0) lines.push(buildLine(currentLine));
  }

  return lines;
}
