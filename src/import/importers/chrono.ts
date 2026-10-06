/**
 * Ported from the Jetlog iOS app's Chrono importer (KLM "Chronologisch overzicht
 * Vlieguren", the Dutch monthly cema-staat flight-hours statement PDF), plus the
 * simulator-session helpers (`cemaDuty`/`makeSession`) it shares with the Monthly Overview
 * importer (new-session branch only, see below).
 *
 * ## PDF text extraction: layout reconstruction, at pdfjs's granularity
 *
 * The iOS app loads the PDF via PDFKit and gets its layout-aware lines from a custom
 * per-glyph coordinate reconstructor. This port uses `../pdf-layout.ts`'s
 * `extractTextByLayout` instead, with the same line-reconstruction contract
 * (Y-band top-to-bottom, X-order left-to-right, gap-based spacing, the
 * `"K L"` -> `"KL"` kerning patch), but built on `pdfjs-dist`'s
 * `getTextContent()`, which only exposes whole text runs (words/styled
 * spans), not individual glyphs with their own bounding box, so per-glyph
 * foreground-color filtering and the allowed-character-set glyph filter
 * aren't ported (no pdfjs equivalent at that granularity); see
 * `pdf-layout.ts`'s file doc comment for the full detail. `parse()` below:
 *  - sniffs a raw PDF binary input by the `%PDF` magic bytes and runs it
 *    through `extractTextByLayout`, surfacing a clear `ImportError` (not a
 *    thrown exception) if extraction itself fails;
 *  - otherwise treats the input as plain UTF-8 text (already
 *    layout-extracted lines, e.g. from some other tool), splits it into
 *    lines, and runs the same regex-based parsing the iOS app runs over its
 *    own extracted lines.
 *
 * Unverified end-to-end against a real exported KLM Chrono statement, this
 * repo only has synthetic fixtures (see `docs/IMPORTERS.md`'s Fixtures
 * section for why).
 *
 * ## Not ported (no local store offline, see `model.ts`)
 *
 * Every existing-entry/aircraft/user-person lookup in the iOS importer
 * is skipped: there is no local database to match an existing entry,
 * FSTD session, or aircraft against, and no stored user person to fetch.
 * Concretely:
 *  - Every flight/FSTD row is produced as brand-new
 *    (`isExisting: { existing: false }`); the "matched existing entry"
 *    branch of the main loop, and the simulator helper's whole
 *    merge-onto-an-existing-session branch, are dropped. Only the
 *    new-session branch is ported, as `makeChronoSimulatorEntry` below.
 *  - The stored user person is replaced by the same `"SELF"` placeholder
 *    `ImportedPerson` every other ported importer uses offline.
 *  - IATA->ICAO airport code conversion is backed by the airport resolver
 *    (logged-in catalog only, none offline) in `../../airports/index.js`
 *    (`canonicalCode`): `from`/`to` resolve to ICAO for a known IATA
 *    code (the active regex only ever captures 3-letter IATA-shaped codes
 *    here), otherwise pass through unchanged, same as
 *    `deeplink-json.ts`/`logten.ts`/`pilotlog.ts`.
 *  - The existing-aircraft match in `addAircraftIfNeeded` is skipped;
 *    every registration not already collected in this run is produced as new.
 *
 * ## Ported
 *
 *  - The period (month/year) detection: the `T/M` period regex, with a
 *    `Datum:` fallback, `findPeriod` below.
 *  - The single active flight-row regex (the iOS source holds several older
 *    patterns that are dead code; they are not ported) and its per-line
 *    match loop, including the `CP` -> `PIC` crew-role remap.
 *  - The simulator-session scan: VK/VC/VA/VT1/VT2/VX1/VX2 duty-code + leading
 *    day-number lines, and the code -> {sessionType, role} table
 *    (`cemaDuty`). The Monthly Overview-only duty mapping is not needed here.
 */
import type { Importer, ImporterOptions } from "../importer.js";
import { canonicalCode } from "../../airports/index.js";
import { flagDuplicates } from "../duplicate-detector.js";
import {
  newImportedEntry,
  type DateOnly,
  type EntryPersonRole,
  type ImportError,
  type ImportResult,
  type ImportedAircraft,
  type ImportedEntry,
  type ImportedEntryCrewMember,
  type ImportedPerson
} from "../model.js";
import { timeOfDay } from "../time-parsing.js";
import { applyAuthoritativeFSTDSessionDuration } from "../normalization.js";
import { extractTextByLayout } from "../pdf-layout.js";

// ---------------------------------------------------------------------------
// PDF-vs-plain-text sniffing
// ---------------------------------------------------------------------------

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // "%PDF"
}

// ---------------------------------------------------------------------------
// Period (month/year) detection, mirrors `periodRegex`/`datumRegex`
// ---------------------------------------------------------------------------

const PERIOD_REGEX = /(?:Datum:\s*\d{2}[-./]\d{2}[-./]\d{2,4}\s*)?.*?(\d{2})[-./](\d{2})[-./](\d{2,4})\s+T\/M/i;
const DATUM_FALLBACK_REGEX = /Datum:\s*(\d{2})[-./](\d{2})[-./](\d{2,4})/;

interface ChronoPeriod {
  year: string;
  month: string;
}

function normalizedYear(rawYear: string): string {
  return rawYear.length === 4 ? rawYear : `20${rawYear}`;
}

/** Period detection: the `T/M` pattern
 * first, falling back to a lone `Datum:` line. Runs over the whole joined
 * text (as in the iOS app), not per line. */
function findPeriod(fullText: string): ChronoPeriod | undefined {
  const periodMatch = fullText.match(PERIOD_REGEX);
  if (periodMatch) {
    return { month: periodMatch[2]!, year: normalizedYear(periodMatch[3]!) };
  }
  const datumMatch = fullText.match(DATUM_FALLBACK_REGEX);
  if (datumMatch) {
    return { month: datumMatch[2]!, year: normalizedYear(datumMatch[3]!) };
  }
  return undefined;
}

function buildDateString(year: string, month: string, day: string): DateOnly {
  const pad = (s: string): string => (s.length === 1 ? `0${s}` : s);
  return `${year}-${pad(month)}-${pad(day)}`;
}

// ---------------------------------------------------------------------------
// Role mapping
// ---------------------------------------------------------------------------

/** Canonical `EntryPersonRole` wire codes (`model.ts`'s `EntryPersonRole`
 * union), a raw code outside this set becomes `{ unknown: raw }`, mirroring
 * `EntryPersonRole(fromRawString:)`'s forward-compat fallback. */
const KNOWN_ROLES = new Set<string>([
  "PIC",
  "CP",
  "CRCP",
  "PICUS",
  "SPIC",
  "RI",
  "RI_CP",
  "LCA",
  "LCAI",
  "LCAIFO",
  "FI",
  "FE",
  "SI_PIC",
  "SI_CP",
  "SI_OBS",
  "STU",
  "DH",
  "CA",
  "CS",
  "Purser",
  "SP",
  "FSTD_TRN",
  "FSTD_INS",
  "FSTD_EXA",
  "FSTD_OBS",
  "FSTD_SI"
]);

function roleFromRawString(raw: string): EntryPersonRole {
  return KNOWN_ROLES.has(raw) ? (raw as EntryPersonRole) : { unknown: raw };
}

// ---------------------------------------------------------------------------
// Flight-row regex, the one active row pattern in the iOS source
// ---------------------------------------------------------------------------

/** Capture groups: 1=day, 2=flightNumber, 3=aircraftReg, 4=departureTime,
 * 5=departureAirport, 6=crewRole, 7=arrivalAirport, 8=arrivalTime. */
const FLIGHT_LINE_REGEX =
  /(\d{1,2}).+?(KL\s?\d{1,4}).*?(PH[A-Z]{3})\s.*(\d{2}:\d{2}).*?([A-Z]{3}).*?([A-Z]{2}).*?([A-Z]{3}).*?(\d{2}:\d{2})/;

function ensureSelfPerson(people: Map<string, ImportedPerson>): void {
  if (people.has("SELF")) return;
  people.set("SELF", { refId: "SELF", isExisting: { existing: false }, isImportedFromOtherLogbook: false });
}

function addAircraftIfNeeded(registration: string, aircraft: Map<string, ImportedAircraft>): void {
  if (registration.length === 0 || aircraft.has(registration)) return;
  aircraft.set(registration, { registration, isImportedFromOtherLogbook: false });
}

function parseFlightLine(
  line: string,
  year: string,
  month: string,
  people: Map<string, ImportedPerson>,
  aircraft: Map<string, ImportedAircraft>
): ImportedEntry | undefined {
  const match = line.match(FLIGHT_LINE_REGEX);
  if (!match) return undefined;

  const day = match[1]!;
  const flightRaw = match[2]!;
  const registration = match[3]!;
  const offBlocksString = match[4]!;
  const from = canonicalCode(match[5]) ?? match[5]!;
  const role = match[6]!;
  const to = canonicalCode(match[7]) ?? match[7]!;
  const onBlocksString = match[8]!;

  addAircraftIfNeeded(registration, aircraft);

  // KLM-specific mapping: CP means Captain (PIC), not Co-Pilot.
  const mappedRole = role === "CP" ? "PIC" : role;
  const flightNumber = flightRaw.replace(/ /g, "");
  const date = buildDateString(year, month, day);

  const entry = newImportedEntry({
    date,
    type: "flight",
    flightNumber,
    registration,
    from,
    to,
    offBlocks: timeOfDay(offBlocksString),
    onBlocks: timeOfDay(onBlocksString),
    updateFlightData: false,
    isImportedFromOtherLogbook: false
  });

  ensureSelfPerson(people);
  const crewMember: ImportedEntryCrewMember = { refId: "SELF", role: roleFromRawString(mappedRole) };
  entry.crew.push(crewMember);

  return entry;
}

// ---------------------------------------------------------------------------
// Simulator sessions, `parseSimulatorSessions` + `MonthlyStatementSimulator
// .cemaDuty`/`.makeSession` (new-session branch only)
// ---------------------------------------------------------------------------

/** Default loggable session length when the statement gives only a duty
 * window, not a real session length, mirrors
 * `MonthlyStatementSimulator.defaultSessionMinutes` (3.5h). */
const DEFAULT_SESSION_MINUTES = 210;

interface ChronoSimulatorDuty {
  sessionType: string;
  /** `undefined` leaves the crew role open (flagged `roleMissingSimulator`
   * for the user to set in review). None of
   * Chrono's own `cemaDuty` codes actually produce this (every code below
   * has a role); the branch is kept because
   * `makeChronoSimulatorEntry` is the general session builder and a
   * sibling statement format (Monthly Overview) does hit it. */
  role?: EntryPersonRole;
}

/** KLM "Chronologisch overzicht Vlieguren" (cema staat) simulator duty
 * codes (`cemaDuty` in the iOS app). `VX1` (Instructor
 * Refresher) is flown as the instructor; the rest are the pilot's own
 * qualification/check/recurrent (trainee). Non-sim "V…" codes (VI/VN/VRT),
 * CTF/CNFE/RFCB are intentionally not matched (and don't even reach this
 * function, `SIM_CODE_REGEX` below only matches the seven codes here). */
const CEMA_DUTY_CODES: Record<string, ChronoSimulatorDuty> = {
  VK: { sessionType: "Type Qualification", role: "FSTD_TRN" },
  VC: { sessionType: "OPC / LPC", role: "FSTD_TRN" },
  VA: { sessionType: "LOE", role: "FSTD_TRN" },
  VT1: { sessionType: "Type Recurrent 1", role: "FSTD_TRN" },
  VT2: { sessionType: "Type Recurrent 2", role: "FSTD_TRN" },
  VX1: { sessionType: "Instructor Refresher", role: "FSTD_INS" },
  VX2: { sessionType: "Pilot Qualification Either Seat", role: "FSTD_TRN" }
};

function cemaDuty(code: string): ChronoSimulatorDuty | undefined {
  return CEMA_DUTY_CODES[code.toUpperCase()];
}

const SIM_CODE_REGEX = /\b(VK|VC|VA|VT1|VT2|VX1|VX2)\b/i;
const SIM_DAY_REGEX = /^\s*(\d{1,2})\b/;

/**
 * Builds a brand-new FSTD `ImportedEntry` for a simulator session found on a
 * monthly statement. Mirrors ONLY `MonthlyStatementSimulator.makeSession`'s
 * `existing == nil` ("new session") branch, the `existing != nil`
 * merge-onto-an-existing-session branch never applies offline (no local
 * store to match against, see the file doc comment) and is dropped.
 *
 * Exported for direct unit coverage of the `role === undefined` ->
 * `roleMissingSimulator` branch, which none of Chrono's own `cemaDuty` codes
 * currently trigger (see `ChronoSimulatorDuty.role`'s doc comment).
 */
export function makeChronoSimulatorEntry(
  date: DateOnly,
  sessionType: string,
  role: EntryPersonRole | undefined,
  importErrors: ImportError[]
): ImportedEntry {
  const crew: ImportedEntryCrewMember[] = role !== undefined ? [{ refId: "SELF", role }] : [];

  const entry = newImportedEntry({
    date,
    type: "fstd",
    sessionType,
    updateFlightData: false,
    isImportedFromOtherLogbook: false,
    crew
  });

  // Statements give only a duty window, not the session length: default to
  // a 3.5h session (00:00-03:30), which stays editable in import review.
  applyAuthoritativeFSTDSessionDuration(entry, DEFAULT_SESSION_MINUTES);

  importErrors.push({
    code: "fstdIdentifierMissing",
    reason: "FSTD identifier missing",
    dateString: date,
    entryId: entry.id
  });

  if (role === undefined) {
    importErrors.push({
      code: "roleMissingSimulator",
      reason: "You have no role set on this simulator session",
      dateString: date,
      entryId: entry.id
    });
  }

  return entry;
}

/** Mirrors `parseSimulatorSessions`: scans the layout lines for the
 * VK/VC/VA/VT1/VT2/VX1/VX2 duty codes plus a leading day number, and appends
 * each as an FSTD entry. The duty window itself is only read to date the
 * session; the length always defaults to `DEFAULT_SESSION_MINUTES`. */
function parseSimulatorSessions(
  lines: string[],
  year: string,
  month: string,
  people: Map<string, ImportedPerson>,
  importErrors: ImportError[]
): ImportedEntry[] {
  const sessions: ImportedEntry[] = [];

  for (const line of lines) {
    const codeMatch = line.match(SIM_CODE_REGEX);
    if (!codeMatch) continue;
    const duty = cemaDuty(codeMatch[1]!);
    if (!duty) continue;
    const dayMatch = line.match(SIM_DAY_REGEX);
    if (!dayMatch) continue;

    const date = buildDateString(year, month, dayMatch[1]!);
    const entry = makeChronoSimulatorEntry(date, duty.sessionType, duty.role, importErrors);
    if (duty.role !== undefined) ensureSelfPerson(people);
    sessions.push(entry);
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/** Parses already layout-extracted Chrono statement lines into an
 * `ImportResult`. Mirrors the iOS app's line-matching body
 * (period detection, flight rows, simulator sessions,
 * in-file duplicate flagging), minus the PDF loading itself
 * (see the file doc comment). */
export function parseChronoLines(lines: string[], filename: string | undefined): ImportResult {
  const importErrors: ImportError[] = [];
  const fullText = lines.join("\n");

  const period = findPeriod(fullText);
  if (!period) {
    importErrors.push({ reason: "No month and year found", sourceFileName: filename });
    return { entries: [], people: [], aircraft: [], importErrors, skippedUnchangedCount: 0 };
  }

  const people = new Map<string, ImportedPerson>();
  const aircraft = new Map<string, ImportedAircraft>();
  const entries: ImportedEntry[] = [];

  for (const line of lines) {
    const entry = parseFlightLine(line, period.year, period.month, people, aircraft);
    if (entry) entries.push(entry);
  }

  entries.push(...parseSimulatorSessions(lines, period.year, period.month, people, importErrors));

  flagDuplicates(entries, importErrors);

  return {
    entries,
    people: [...people.values()],
    aircraft: [...aircraft.values()],
    importErrors,
    skippedUnchangedCount: 0
  };
}

export const chronoImporter: Importer = {
  id: "chrono",
  displayName: "KLM Chronologisch overzicht Vlieguren (cema-staat, PDF)",
  extensions: ["pdf"],
  // This format is realistically only ever selected explicitly via
  // `--from chrono`, never auto-detected: a raw PDF binary is ambiguous with
  // several other PDF-based importers (Monthly Overview /
  // Monthly Statement, see docs/IMPORTERS.md), and a generic text
  // file (already layout-extracted lines) gives no reliable signal either.
  // Mirrors `pilotlog.ts`'s `detect()` returning 0 for its own
  // always-unsupported ZIP case, conservative/inert rather than guessing.
  detect(_buffer: Buffer, _filename: string | undefined): number {
    return 0;
  },
  async parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult> {
    const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    if (looksLikePdf(buffer)) {
      let lines: string[];
      try {
        lines = await extractTextByLayout(buffer);
      } catch (err) {
        return {
          entries: [],
          people: [],
          aircraft: [],
          importErrors: [{ reason: `Could not extract text from the PDF: ${(err as Error).message}`, sourceFileName: options?.filename }],
          skippedUnchangedCount: 0
        };
      }
      return parseChronoLines(lines, options?.filename);
    }
    const text = typeof input === "string" ? input : input.toString("utf8");
    const lines = text.split(/\r\n|\r|\n/);
    return parseChronoLines(lines, options?.filename);
  }
};
