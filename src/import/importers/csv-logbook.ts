/**
 * Ported from the Jetlog iOS app's CSV logbook importer: Jetlog's own CSV export format
 * (Flights / Simulator / People / Aircraft sheets), re-imported.
 *
 * Scope cut vs. the iOS app: the app's CSV importer is a thin wrapper that rebuilds the CSVs
 * into a workbook and hands them to its Excel importer, which does UUID-based matching against
 * the user's existing entries/people/aircraft, change detection ("only changed rows"), and the
 * full merge semantics. None of that is portable offline (no local store, see `model.ts`'s
 * file doc comment), and the Excel format's full column-level behaviour (manual-time columns,
 * planned-vs-actual route, IFR flag, crew slot resolution) lives in `excel.ts`. What's ported
 * here is the column schema itself (header names and role-code mapping) and a
 * straightforward column->`ImportedEntry`/`ImportedPerson`/`ImportedAircraft`
 * mapping with every row treated as new (parse-only, no UUID matching) plus
 * this CLI's own in-file duplicate detection pass. `excel.ts` lifts this schema module
 * (`JETLOG_CSV_HEADERS` below) directly.
 *
 * ZIP archive support is implemented via `../zip.ts` (`fflate`), see that file's doc comment.
 * It recursively finds every `.csv` entry, skips anything under a `__MACOSX` path (Finder's
 * resource-fork copies), and matches each file's name stem (case-
 * insensitive) against the 4 known sheet names, unmatched files are
 * ignored, same as the iOS app. Unlike the iOS app (which re-derives the
 * sheet purely from the matched filename), this port still runs the result
 * through the same content-based `detectSheet()` used for loose files, so a
 * renamed-but-still-recognizable CSV inside the zip still imports.
 */
import { parse as parseCsvRows } from "csv-parse/sync";
import type { Importer, ImporterOptions } from "../importer.js";
import { canonicalCode } from "../../airports/index.js";
import { flagDuplicates } from "../duplicate-detector.js";
import { looksLikeZip, unzipEntries, decodeZipText } from "../zip.js";
import {
  emptyImportResult,
  newImportedEntry,
  time,
  truncatedRemarks,
  type EntryPersonRole,
  type ImportError,
  type ImportResult,
  type ImportedAircraft,
  type ImportedEntryCrewMember,
  type ImportedPerson,
  type TakeoffsAndLandings,
  type Time
} from "../model.js";
import { InFileNameMatcher } from "../person-matcher.js";

export const JETLOG_CSV_HEADERS = {
  flights: [
    "Jetlog ID",
    "Date",
    "Flight Number",
    "Registration",
    "From",
    "To",
    "Planned From",
    "Planned To",
    "Scheduled Off Blocks",
    "Off Blocks",
    "Airborne",
    "Touchdown",
    "On Blocks",
    "Scheduled On Blocks",
    "Takeoffs Day",
    "Takeoffs Night",
    "Landings Day",
    "Landings Night",
    "IFR (Y/N)",
    "Remarks",
    "Crew 1 Name",
    "Crew 1 Role",
    "Crew 2 Name",
    "Crew 2 Role",
    "Crew 3 Name",
    "Crew 3 Role",
    "Crew 4 Name",
    "Crew 4 Role",
    "Crew 5 Name",
    "Crew 5 Role",
    "Manual Total Time",
    "Manual PIC",
    "Manual Co-Pilot",
    "Manual Dual",
    "Manual SPIC",
    "Manual PICUS",
    "Manual Instructor",
    "Manual Examiner",
    "Manual Multi-Pilot",
    "Manual Single-Engine",
    "Manual Multi-Engine",
    "Manual Night",
    "Manual IFR",
    "Manual Cross-Country"
  ],
  simulator: [
    "Jetlog ID",
    "Date",
    "FSTD ID",
    "Session Type",
    "Start Time",
    "End Time",
    "Takeoffs",
    "Landings",
    "Remarks",
    "Crew 1 Name",
    "Crew 1 Role",
    "Crew 2 Name",
    "Crew 2 Role",
    "Crew 3 Name",
    "Crew 3 Role",
    "Crew 4 Name",
    "Crew 4 Role",
    "Crew 5 Name",
    "Crew 5 Role",
    "Manual Session Time"
  ],
  people: ["Jetlog ID", "Code", "First Name", "Last Name", "Employee Number", "Default Role"],
  aircraft: ["Registration", "ICAO Type", "IATA Type"]
} as const;

const CREW_SLOT_COUNT = 5;

/** Mirrors `ExcelLogbookFormat.role(fromCode:)`'s canonical-code half (the
 * lenient-alias fallback needs the full iOS alias table, out of scope). */
export function roleFromCode(code: string | undefined): EntryPersonRole | undefined {
  const trimmed = code?.trim();
  if (!trimmed) return undefined;
  const CANON = [
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
  ] as const;
  const match = CANON.find((c) => c === trimmed);
  return match ?? { unknown: trimmed };
}

export type Sheet = "flights" | "simulator" | "people" | "aircraft";

export function detectSheet(headers: string[]): Sheet | undefined {
  const set = new Set(headers.map((h) => h.trim()));
  if (set.has("Flight Number") && set.has("Off Blocks")) return "flights";
  if (set.has("FSTD ID") && set.has("Start Time")) return "simulator";
  if (set.has("Code") && set.has("Employee Number")) return "people";
  if (set.has("Registration") && set.has("ICAO Type")) return "aircraft";
  return undefined;
}

function parseRecords(content: string): Record<string, string>[] {
  return parseCsvRows(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<
    string,
    string
  >[];
}

function toInt(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Duration cell parsing, now matching the leniency the iOS Excel importer
 * documents for hand-edited sheets, on top of
 * this format's own existing "H:MM" / bare-integer-minutes forms (see
 * `docs/IMPORTERS.md`'s Excel section): `"1:30"` -> 90, a bare integer like
 * `"90"` -> 90 (this format's own export convention, raw minutes, not
 * the iOS app's decimal-hours reading of a plain Excel numeric cell, which this
 * CSV-shaped mapping never receives), and now also a decimal-hours value
 * like `"1.5"` -> 90 (1h30m) for a hand-typed cell that isn't a bare integer.
 */
function parseManualTime(v: string | undefined): Time | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const trimmed = v.trim();
  if (trimmed.includes(":")) {
    const [h, m] = trimmed.split(":");
    const hh = Number.parseInt(h ?? "0", 10);
    const mm = Number.parseInt(m ?? "0", 10);
    return Number.isFinite(hh) && Number.isFinite(mm) ? time(hh * 60 + mm) : undefined;
  }
  // Only a string that's ENTIRELY digits counts as the bare-integer-minutes
  // form, `Number.parseInt`/`toInt` would otherwise silently truncate a
  // decimal-hours cell like "1.5" to 1.
  if (/^-?\d+$/.test(trimmed)) {
    const bareMinutes = toInt(trimmed);
    if (bareMinutes !== undefined) return time(bareMinutes);
  }
  // Decimal-hours leniency: only reached when the cell isn't a plain integer
  // (e.g. "1.5"), so it never changes the existing bare-integer-minutes case.
  const decimalHours = Number.parseFloat(trimmed);
  if (Number.isFinite(decimalHours) && /^-?\d*\.\d+$/.test(trimmed)) {
    return time(Math.round(decimalHours * 60));
  }
  return undefined;
}

/**
 * Clock-time cell parsing with the same `"1435"` (4-digit, no colon)
 * leniency the iOS Excel importer documents, on top of the
 * usual "H:MM"/"HH:MM" form. Unlike the shared `timeOfDay()` helper used by
 * the other (non-Jetlog-own) CSV-ish importers, a malformed-but-non-blank
 * cell is left `undefined` rather than collapsing to midnight, this
 * format's own export never writes a malformed clock cell, so there's
 * nothing to be lenient about there, only about the two accepted shapes.
 */
function parseLenientClockTime(v: string | undefined): Time | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const trimmed = v.trim();
  if (trimmed.includes(":")) {
    const [h, m] = trimmed.split(":");
    const hh = Number.parseInt(h ?? "", 10);
    const mm = Number.parseInt(m ?? "", 10);
    if (Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && mm >= 0 && mm < 60) {
      return time(hh * 60 + mm);
    }
    return undefined;
  }
  if (/^\d{4}$/.test(trimmed)) {
    const hh = Number.parseInt(trimmed.slice(0, 2), 10);
    const mm = Number.parseInt(trimmed.slice(2), 10);
    if (mm < 60) return time(hh * 60 + mm);
  }
  return undefined;
}

export interface ParsedFiles {
  flights: Record<string, string>[];
  simulator: Record<string, string>[];
  people: Record<string, string>[];
  aircraft: Record<string, string>[];
}

export function parseFiles(contents: string[]): ParsedFiles {
  const result: ParsedFiles = { flights: [], simulator: [], people: [], aircraft: [] };
  for (const content of contents) {
    const records = parseRecords(content);
    if (records.length === 0) continue;
    const sheet = detectSheet(Object.keys(records[0]!));
    if (sheet) result[sheet].push(...records);
  }
  return result;
}

const DATA_SHEET_STEMS: Record<string, Sheet> = { flights: "flights", simulator: "simulator", people: "people", aircraft: "aircraft" };

/** Mirrors `CSVLogbookArchive.collectCSVURLs(under:)` + `workbook(fromCSVFiles:)`:
 * recursively collects every non-`__MACOSX` `.csv` entry, keeping only those
 * whose filename stem (case-insensitive, extension stripped) matches one of
 * the 4 known sheet names. Returns the decoded text of each match, in zip
 * order. */
function collectArchiveCsvTexts(entries: Record<string, Uint8Array>): string[] {
  const texts: string[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.includes("__MACOSX")) continue;
    if (!path.toLowerCase().endsWith(".csv")) continue;
    const filename = path.split("/").pop() ?? path;
    const stem = filename.slice(0, -".csv".length).toLowerCase();
    if (!(stem in DATA_SHEET_STEMS)) continue;
    texts.push(decodeZipText(bytes));
  }
  return texts;
}

/** Unwraps a Jetlog CSV-logbook ZIP archive (`CSVLogbookArchive`'s export
 * format) into its member CSV texts. Throws (surfaced as an `ImportError`
 * by callers) when nothing recognizable is found, mirroring
 * `CSVArchiveError.noSheetsFound`. */
export function unwrapJetlogCsvZip(buffer: Buffer): string[] {
  const texts = collectArchiveCsvTexts(unzipEntries(buffer));
  if (texts.length === 0) {
    throw new Error("The CSV archive contained no recognizable logbook files (Flights.csv, Simulator.csv, People.csv, Aircraft.csv).");
  }
  return texts;
}

export function parseSheets(parsed: ParsedFiles, importErrors: ImportError[]): ImportResult {
  if (parsed.flights.length === 0 && parsed.simulator.length === 0 && parsed.people.length === 0 && parsed.aircraft.length === 0) {
    importErrors.push({ reason: "No recognizable Jetlog logbook CSV sheets found (Flights/Simulator/People/Aircraft)" });
    return { ...emptyImportResult(), importErrors };
  }

  const nameMatcher = new InFileNameMatcher();
  const peopleByRef = new Map<string, ImportedPerson>();

  for (const row of parsed.people) {
    const refId = row["Jetlog ID"]?.trim() || row["Code"]?.trim() || `${row["First Name"] ?? ""} ${row["Last Name"] ?? ""}`.trim();
    if (!refId) continue;
    peopleByRef.set(refId, {
      refId,
      firstName: row["First Name"] || undefined,
      lastName: row["Last Name"] || undefined,
      employeeNumber: row["Employee Number"] || undefined,
      defaultRole: roleFromCode(row["Default Role"]),
      isExisting: { existing: false },
      isImportedFromOtherLogbook: true
    });
  }

  /** Resolves a crew-slot name cell to a `refId`, creating a placeholder
   * `ImportedPerson` (de-duplicated by name within this file) when the name
   * doesn't match a People-sheet row by Jetlog ID/Code. */
  function resolveCrewRef(name: string): string {
    const trimmed = name.trim();
    for (const person of peopleByRef.values()) {
      if (`${person.firstName ?? ""} ${person.lastName ?? ""}`.trim().toLowerCase() === trimmed.toLowerCase()) {
        return person.refId;
      }
    }
    const key = nameMatcher.resolve(trimmed);
    if (!peopleByRef.has(key)) {
      const [firstName, ...rest] = trimmed.split(" ");
      peopleByRef.set(key, {
        refId: key,
        firstName,
        lastName: rest.join(" ") || undefined,
        isExisting: { existing: false },
        isImportedFromOtherLogbook: true
      });
    }
    return key;
  }

  function readCrew(row: Record<string, string>): ImportedEntryCrewMember[] {
    const crew: ImportedEntryCrewMember[] = [];
    for (let i = 0; i < CREW_SLOT_COUNT; i++) {
      const slot = i + 1;
      const name = row[`Crew ${slot} Name`]?.trim();
      const roleCode = row[`Crew ${slot} Role`];
      if (!name) continue;
      const role = roleFromCode(roleCode);
      if (!role) continue;
      crew.push({ refId: resolveCrewRef(name), role });
    }
    return crew;
  }

  const aircraftByRegistration = new Map<string, ImportedAircraft>();
  for (const row of parsed.aircraft) {
    const registration = row["Registration"]?.trim().toUpperCase();
    if (!registration) continue;
    aircraftByRegistration.set(registration, {
      registration,
      icaoCode: row["ICAO Type"] || undefined,
      iataCode: row["IATA Type"] || undefined,
      useSystem: false,
      isImportedFromOtherLogbook: true
    });
  }

  const entries: ReturnType<typeof newImportedEntry>[] = [];

  for (const row of parsed.flights) {
    const date = row["Date"]?.trim();
    if (!date) {
      importErrors.push({ reason: "Missing date", flightNumber: row["Flight Number"] });
      continue;
    }
    const registration = row["Registration"]?.trim().toUpperCase() || undefined;
    if (registration) {
      aircraftByRegistration.set(registration, aircraftByRegistration.get(registration) ?? { registration, isImportedFromOtherLogbook: true });
    }

    const manualTimes = {
      totalTimeOfFlight: parseManualTime(row["Manual Total Time"]),
      pilotInCommand: parseManualTime(row["Manual PIC"]),
      coPilot: parseManualTime(row["Manual Co-Pilot"]),
      dual: parseManualTime(row["Manual Dual"]),
      spic: parseManualTime(row["Manual SPIC"]),
      picus: parseManualTime(row["Manual PICUS"]),
      instructor: parseManualTime(row["Manual Instructor"]),
      examiner: parseManualTime(row["Manual Examiner"]),
      multiPilot: parseManualTime(row["Manual Multi-Pilot"]),
      singlePilotSingleEngine: parseManualTime(row["Manual Single-Engine"]),
      singlePilotMultiEngine: parseManualTime(row["Manual Multi-Engine"]),
      night: parseManualTime(row["Manual Night"]),
      ifr: parseManualTime(row["Manual IFR"]),
      crossCountry: parseManualTime(row["Manual Cross-Country"])
    };
    const hasManualTimes = Object.values(manualTimes).some((t) => t !== undefined);

    const takeoffsDay = toInt(row["Takeoffs Day"]);
    const takeoffsNight = toInt(row["Takeoffs Night"]);
    const landingsDay = toInt(row["Landings Day"]);
    const landingsNight = toInt(row["Landings Night"]);
    const takeoffsAndLandings: TakeoffsAndLandings | undefined =
      takeoffsDay !== undefined || takeoffsNight !== undefined || landingsDay !== undefined || landingsNight !== undefined
        ? {
            type: "manual",
            takeoffsDay: takeoffsDay ?? 0,
            takeoffsNight: takeoffsNight ?? 0,
            landingsDay: landingsDay ?? 0,
            landingsNight: landingsNight ?? 0
          }
        : undefined;

    // Same `canonicalCode(x) ?? x` write-time normalization as the iOS ExcelImporter: IATA, lowercase
    // and padded codes land as the canonical identity (ICAO) the calculator resolves.
    const from = row["From"] ? canonicalCode(row["From"]) ?? row["From"].toUpperCase() : undefined;
    const to = row["To"] ? canonicalCode(row["To"]) ?? row["To"].toUpperCase() : undefined;

    const entry = newImportedEntry({
      date,
      type: "flight",
      flightNumber: row["Flight Number"] || undefined,
      registration,
      from: from || undefined,
      to: to || undefined,
      actualFrom: row["Planned From"] ? from || undefined : undefined,
      actualTo: row["Planned To"] ? to || undefined : undefined,
      scheduledOffBlocks: parseLenientClockTime(row["Scheduled Off Blocks"]),
      scheduledOnBlocks: parseLenientClockTime(row["Scheduled On Blocks"]),
      offBlocks: parseLenientClockTime(row["Off Blocks"]),
      airborne: parseLenientClockTime(row["Airborne"]),
      touchdown: parseLenientClockTime(row["Touchdown"]),
      onBlocks: parseLenientClockTime(row["On Blocks"]),
      ifr: row["IFR (Y/N)"] ? row["IFR (Y/N)"].trim().toUpperCase() === "Y" : undefined,
      takeoffsAndLandings,
      crew: readCrew(row),
      manualTimes: hasManualTimes ? manualTimes : undefined,
      manualTimesAreAuthoritative: hasManualTimes,
      isImportedFromOtherLogbook: true,
      updateFlightData: false,
      updateFlightDataIsNonIntentDefault: true
    });
    entry.remarks = truncatedRemarks(row["Remarks"] || undefined, importErrors, {
      dateString: date,
      flightNumber: entry.flightNumber,
      registration
    });
    entries.push(entry);
  }

  for (const row of parsed.simulator) {
    const date = row["Date"]?.trim();
    if (!date) {
      importErrors.push({ reason: "Missing date" });
      continue;
    }
    const sessionTime = parseManualTime(row["Manual Session Time"]);
    const entry = newImportedEntry({
      date,
      type: "fstd",
      fstdId: row["FSTD ID"] || undefined,
      sessionType: row["Session Type"] || undefined,
      startTime: parseLenientClockTime(row["Start Time"]),
      endTime: parseLenientClockTime(row["End Time"]),
      fstdTakeoffs: toInt(row["Takeoffs"]),
      fstdLandings: toInt(row["Landings"]),
      crew: readCrew(row),
      manualTimes: sessionTime ? { fstdSession: sessionTime } : undefined,
      manualTimesAreAuthoritative: sessionTime !== undefined,
      isImportedFromOtherLogbook: true
    });
    entry.remarks = truncatedRemarks(row["Remarks"] || undefined, importErrors, { dateString: date });
    entries.push(entry);
  }

  const result: ImportResult = {
    entries,
    people: [...peopleByRef.values()],
    aircraft: [...aircraftByRegistration.values()],
    importErrors,
    skippedUnchangedCount: 0
  };
  flagDuplicates(result.entries, result.importErrors);
  return result;
}

function parse(contents: string[], importErrors: ImportError[]): ImportResult {
  return parseSheets(parseFiles(contents), importErrors);
}

export const csvLogbookImporter: Importer = {
  id: "jetlog-csv",
  displayName: "Jetlog CSV export (Flights/Simulator/People/Aircraft, incl. ZIP archive)",
  extensions: ["csv", "zip"],
  detect(buffer: Buffer, filename?: string): number {
    if (looksLikeZip(buffer) || filename?.toLowerCase().endsWith(".zip")) {
      try {
        return collectArchiveCsvTexts(unzipEntries(buffer)).length > 0 ? 0.75 : 0;
      } catch {
        return 0;
      }
    }
    const text = buffer.toString("utf8");
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const headers = firstLine.split(",").map((h) => h.replace(/^"|"$/g, ""));
    return detectSheet(headers) ? 0.7 : 0;
  },
  async parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult> {
    const importErrors: ImportError[] = [];
    const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    if (looksLikeZip(buffer) || options?.filename?.toLowerCase().endsWith(".zip")) {
      let texts: string[];
      try {
        texts = unwrapJetlogCsvZip(buffer);
      } catch (err) {
        importErrors.push({ reason: err instanceof Error ? err.message : String(err), sourceFileName: options?.filename });
        return { ...emptyImportResult(), importErrors };
      }
      return parse(texts, importErrors);
    }
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parse([text], importErrors);
  }
};

/** Parses several loose CSV files (e.g. Flights.csv + People.csv +
 * Aircraft.csv picked separately) as one Jetlog CSV export, mirroring
 * `CSVLogbookImporter.importLogbook(fromCSVFiles:...)`. */
export function parseJetlogCsvFiles(contents: string[]): ImportResult {
  const importErrors: ImportError[] = [];
  return parse(contents, importErrors);
}
