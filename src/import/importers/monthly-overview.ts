/**
 * Ported from the Jetlog iOS app's Monthly Overview importer and the simulator-session helpers
 * it shares with the Chrono importer: the KLM Cityhopper "MONTHLY OVERVIEW" crew duty-roster PDF
 * statement (flight legs + line-check/simulator duty codes for one calendar month).
 *
 * ## PDF text extraction, a real, documented parity gap
 *
 * The iOS app reads the whole document via PDFKit's
 * `PDFDocument.string` (its own opaque reading-order text extraction across
 * every page, concatenated, then split on newlines), not the custom
 * glyph-coordinate layout reconstructor it uses for Chrono statements
 * (replicating that would mean PDFKit-specific
 * per-glyph foreground-color filtering and bounding-box spacing heuristics
 * that have no straightforward PDF.js equivalent).
 *
 * This port extracts text with `unpdf` (`extractText(pdf, { mergePages:
 * true })`, a thin wrapper over `pdfjs-dist`) instead of PDFKit. PDFKit's
 * own line/column joining behavior is an undocumented black box, and so is
 * pdfjs's, they are not guaranteed to produce identical line breaks or
 * whitespace for the same PDF. The iOS source itself documents a known
 * PDFKit artifact its regexes were written to tolerate: two
 * duty rows sometimes land on one physical text line (`"10 TCRMI 10 TLCI
 * Line Check Instructor"`), which is why `dutyCodesByDay`/the simulator
 * scan use global/every-match-in-line regexes rather than anchoring a
 * whole line to one duty. A pdfjs-based extraction may merge or split
 * differently; this port keeps the same tolerant regex shapes, but has not
 * been validated against a real exported KLC monthly-overview PDF (see
 * `docs/IMPORTERS.md`'s Monthly Overview section), so this port is
 * tested against hand-built text fixtures shaped like plausible extracted
 * output, not a real PDF run through both extractors side by side. Treat
 * PDF support here as "best-effort, same regex contract as iOS, unverified
 * end-to-end" until checked against a real export.
 *
 * `parseMonthlyOverviewText` below is the fully synchronous, real port of
 * the parsing logic (works on already-extracted text, this is what's unit
 * tested). `extractMonthlyOverviewPdfText` is the async PDF->text step
 * (unpdf/pdfjs is promise-based). Since `Importer.parse()` is now `async`
 * (every importer body stays synchronous internally except this one and
 * `chrono`), the registered `monthlyOverviewImporter` accepts a raw PDF
 * `Buffer` directly, it's sniffed via the `%PDF` magic header, run through
 * `extractMonthlyOverviewPdfText`, then handed to `parseMonthlyOverviewText`
 * like any already-extracted text input. A caller that already has
 * extracted text (e.g. from some other tool) can still pass a plain
 * `string` through `parse()`, or call `parseMonthlyOverviewText` directly.
 *
 * ## Scope cut vs. the iOS app
 *
 * No local store offline (see `model.ts`'s file doc comment), every
 * existing-entry/FSTD lookup always
 * takes the iOS app's "no match" branch here:
 *  - Flights are always newly created (never the "update specific fields on
 *    a matched existing entry" branch).
 *  - Line-check role resolution's "already resolved initial" preservation
 *    exception can never apply (nothing to preserve), every initial
 *    line-check day always gets an open crew + `roleMissingFlight` error.
 *  - The simulator helper's "matched existing session"
 *    branch (merge-safe, never overwrites stored times) never applies,
 *    every simulator day is the iOS app's "new session" branch:
 *    00:00-03:30, `fstdIdentifierMissing` always, `roleMissingSimulator`
 *    when the day's code implies no role.
 *  - The "no line-check duty that day" role-add also always takes the
 *    "add the user" branch (never "already crewed, leave untouched") with
 *    `userPerson.defaultRole` unknown offline, so it adds an
 *    `{ unknown: "Unknown" }` role rather than the signed-in user's real
 *    default role.
 * `from`/`to` go through `canonicalCode` (src/airports) like the iOS
 * importer.
 */
import { getDocumentProxy, extractText } from "unpdf";
import type { Importer, ImporterOptions } from "../importer.js";
import { canonicalCode } from "../../airports/index.js";
import { flagDuplicates } from "../duplicate-detector.js";
import { emptyImportResult, newImportedEntry, time, type EntryPersonRole, type ImportError, type ImportResult, type ImportedEntry } from "../model.js";

// ---------------------------------------------------------------------------
// Async PDF -> text extraction (unpdf/pdfjs)
// ---------------------------------------------------------------------------

export async function extractMonthlyOverviewPdfText(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

// ---------------------------------------------------------------------------
// Period (month/year) extraction
// ---------------------------------------------------------------------------

const PERIOD_REGEX = /Period:\s+From\s+(\d{1,2})-(\d{1,2})-(\d{4})/;

function extractPeriod(text: string): { year: string; month: string } | undefined {
  const match = PERIOD_REGEX.exec(text);
  if (!match) return undefined;
  const month = match[2]!.padStart(2, "0");
  const year = match[3]!;
  return { year, month };
}

// ---------------------------------------------------------------------------
// Flight-leg regex
// ---------------------------------------------------------------------------

// Mirrors the iOS regex's literal (likely unintended, preserved for
// fidelity) character class `[E|N]` -- a set containing 'E', '|', or 'N'.
const FLIGHT_LEG_REGEX = /(\d{1,2}).+?(KL\s?\d{1,4})\s(\d{2}:\d{2})\s([A-Z]{3}).*?([A-Z]{3}).*?([EN|][A-Z]{2})\s(\d{2}:\d{2})/;

interface MonthlyOverviewFlightLeg {
  day: string;
  flightNumber: string;
  offBlocksText: string;
  from: string;
  to: string;
  registration: string;
  onBlocksText: string;
}

function parseFlightLegLine(line: string): MonthlyOverviewFlightLeg | undefined {
  const match = FLIGHT_LEG_REGEX.exec(line);
  if (!match) return undefined;
  return {
    day: match[1]!,
    flightNumber: match[2]!.replace(/\s+/g, ""),
    offBlocksText: match[3]!,
    from: match[4]!,
    to: match[5]!,
    registration: `PH${match[6]}`,
    onBlocksText: match[7]!
  };
}

// ---------------------------------------------------------------------------
// Duty-code scanning (line-check classification)
// ---------------------------------------------------------------------------

const DUTY_CODE_REGEX = /(\d{1,2})\s+([A-Z][A-Z0-9]{2,7})\b/g;

type LineCheckClassification = "recurrent" | "initial" | undefined;

function dutyCodesByDay(lines: string[]): Map<string, Set<string>> {
  const byDay = new Map<string, Set<string>>();
  for (const line of lines) {
    for (const match of line.matchAll(DUTY_CODE_REGEX)) {
      const day = match[1]!;
      const code = match[2]!.toUpperCase();
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day)!.add(code);
    }
  }
  return byDay;
}

function classifyLineCheckDay(codes: Set<string> | undefined): LineCheckClassification {
  if (!codes) return undefined;
  const hasLineCheck = codes.has("TLCI") || codes.has("TLCYI");
  if (!hasLineCheck) return undefined;
  return codes.has("TCRMI") ? "recurrent" : "initial";
}

// ---------------------------------------------------------------------------
// Simulator duty-code table (the iOS app's Monthly Overview duty mapping)
// ---------------------------------------------------------------------------

interface SimDuty {
  sessionType: string;
  role?: EntryPersonRole;
}

const MONTHLY_OVERVIEW_DUTY: Record<string, SimDuty> = {
  TSLPCI: { sessionType: "LPC", role: "FSTD_INS" },
  TSLOEI: { sessionType: "LOE", role: "FSTD_INS" },
  TSTR1: { sessionType: "Type Recurrent 1", role: "FSTD_TRN" },
  TSTR1I: { sessionType: "Type Recurrent 1", role: "FSTD_INS" },
  TSTR2: { sessionType: "Type Recurrent 2", role: "FSTD_TRN" },
  TSTR2I: { sessionType: "Type Recurrent 2", role: "FSTD_INS" },
  TSPQSI: { sessionType: "Pilot Qual Either Seat", role: "FSTD_INS" },
  TSODI: { sessionType: "Train SIM Other Duty" },
  TSTQ: { sessionType: "Type Rating Course" },
  TSTQI: { sessionType: "Type Rating Course", role: "FSTD_INS" }
};

const SIM_LINE_REGEX = /^\s*(\d{1,2})\s+([A-Z][A-Z0-9]{2,7})\b/;

const DEFAULT_SESSION_MINUTES = 210; // 3.5h

/** Mirrors the iOS app's "new session" branch
 * (the only branch offline, see the file doc comment). */
function makeSimulatorSession(date: string, sessionType: string, role: EntryPersonRole | undefined, importErrors: ImportError[]): ImportedEntry {
  const entry = newImportedEntry({
    date,
    type: "fstd",
    sessionType,
    startTime: time(0),
    endTime: time(DEFAULT_SESSION_MINUTES),
    isImportedFromOtherLogbook: true
  });
  if (role !== undefined) entry.crew.push({ refId: "SELF", role });
  importErrors.push({ code: "fstdIdentifierMissing", reason: "FSTD identifier missing", dateString: date, entryId: entry.id });
  if (role === undefined) {
    importErrors.push({ code: "roleMissingSimulator", reason: "You have no role set on this simulator session", dateString: date, entryId: entry.id });
  }
  return entry;
}

function parseSimulatorSessions(lines: string[], year: string, month: string, importErrors: ImportError[]): ImportedEntry[] {
  // Group codes by day, preserving order of first appearance, merging all
  // codes seen for the same day into one session (mirrors `parseSimulatorSessions`).
  const codesByDay = new Map<string, string[]>();
  const dayOrder: string[] = [];
  for (const line of lines) {
    const match = SIM_LINE_REGEX.exec(line);
    if (!match) continue;
    const day = match[1]!;
    const code = match[2]!.toUpperCase();
    const duty = MONTHLY_OVERVIEW_DUTY[code];
    if (!duty) continue;
    if (!codesByDay.has(day)) {
      dayOrder.push(day);
      codesByDay.set(day, []);
    }
    const codes = codesByDay.get(day)!;
    if (!codes.includes(code)) codes.push(code);
  }

  const sessions: ImportedEntry[] = [];
  for (const day of dayOrder) {
    const codes = codesByDay.get(day)!;
    const duties = codes.map((c) => MONTHLY_OVERVIEW_DUTY[c]!);
    const sessionType = [...new Set(duties.map((d) => d.sessionType))].join(" / ");
    const role = duties.some((d) => d.role === "FSTD_INS") ? "FSTD_INS" : duties.some((d) => d.role === "FSTD_TRN") ? "FSTD_TRN" : undefined;
    const date = `${year}-${month}-${day.padStart(2, "0")}`;
    sessions.push(makeSimulatorSession(date, sessionType, role, importErrors));
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Top-level parse (synchronous, operates on already-extracted text)
// ---------------------------------------------------------------------------

export function parseMonthlyOverviewText(pdfText: string): ImportResult {
  const importErrors: ImportError[] = [];
  const period = extractPeriod(pdfText);
  if (!period) {
    importErrors.push({ reason: "No month and year found" });
    return { ...emptyImportResult(), importErrors };
  }
  const { year, month } = period;

  const lines = pdfText.split(/\r?\n/).filter((l) => l.length > 0);
  const dutiesByDay = dutyCodesByDay(lines);

  const entries: ImportedEntry[] = [];
  for (const line of lines) {
    const leg = parseFlightLegLine(line);
    if (!leg) continue;

    const date = `${year}-${month}-${leg.day.padStart(2, "0")}`;
    const entry = newImportedEntry({
      date,
      type: "flight",
      flightNumber: leg.flightNumber,
      registration: leg.registration,
      from: canonicalCode(leg.from) ?? leg.from,
      to: canonicalCode(leg.to) ?? leg.to,
      offBlocks: time(Number.parseInt(leg.offBlocksText.slice(0, 2), 10) * 60 + Number.parseInt(leg.offBlocksText.slice(3, 5), 10)),
      onBlocks: time(Number.parseInt(leg.onBlocksText.slice(0, 2), 10) * 60 + Number.parseInt(leg.onBlocksText.slice(3, 5), 10)),
      isImportedFromOtherLogbook: true,
      updateFlightData: false
    });

    const classification = classifyLineCheckDay(dutiesByDay.get(leg.day));
    if (classification === "recurrent") {
      entry.crew.push({ refId: "SELF", role: "LCA" });
    } else if (classification === "initial") {
      importErrors.push({
        code: "roleMissingFlight",
        reason: "You have no role set on this flight",
        dateString: date,
        flightNumber: entry.flightNumber,
        registration: entry.registration,
        entryId: entry.id
      });
    } else {
      entry.crew.push({ refId: "SELF", role: { unknown: "Unknown" } });
    }

    entries.push(entry);
  }

  entries.push(...parseSimulatorSessions(lines, year, month, importErrors));

  flagDuplicates(entries, importErrors);

  const people =
    entries.length > 0
      ? [{ refId: "SELF", isExisting: { existing: false as const }, isImportedFromOtherLogbook: true }]
      : [];
  const aircraft = [...new Set(entries.map((e) => e.registration).filter((r): r is string => !!r))].map((registration) => ({
    registration,
    isImportedFromOtherLogbook: true
  }));

  return { entries, people, aircraft, importErrors, skippedUnchangedCount: 0 };
}

export const monthlyOverviewImporter: Importer = {
  id: "monthly-overview",
  displayName: "KLC Monthly Overview crew statement (PDF text)",
  extensions: ["pdf", "txt"],
  /** This CLI's own sniffing, not a port, `detect()` only recognizes
   * ALREADY-EXTRACTED TEXT (see the file doc comment on why `parse()` can't
   * handle a raw PDF `Buffer` synchronously); a raw `.pdf` buffer can't be
   * sniffed here at all. */
  detect(buffer: Buffer): number {
    const text = buffer.toString("utf8");
    return PERIOD_REGEX.test(text) ? 0.6 : 0;
  },
  async parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult> {
    if (Buffer.isBuffer(input) && input.subarray(0, 4).toString("latin1") === "%PDF") {
      let text: string;
      try {
        text = await extractMonthlyOverviewPdfText(input);
      } catch (err) {
        return {
          ...emptyImportResult(),
          importErrors: [
            {
              reason: `Could not extract text from the PDF: ${(err as Error).message}`,
              sourceFileName: options?.filename
            }
          ]
        };
      }
      return parseMonthlyOverviewText(text);
    }
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseMonthlyOverviewText(text);
  }
};
