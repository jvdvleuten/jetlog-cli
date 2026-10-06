import { convertGenericCsv, parseCsv, type ConvertResult, type GenericCsvOptions } from "./csv.js";

/**
 * ForeFlight's logbook CSV export is one file with multiple sections
 * (Aircraft Table, Flights Table, possibly more), each starting with a
 * line naming the section followed by its own header row. We only care
 * about the Flights Table section. This is best-effort: it's built from
 * publicly documented ForeFlight export samples, not a live export, so
 * header names may drift between ForeFlight versions.
 */
function extractForeflightFlightsSection(content: string): string {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().replace(/"/g, "") === "Flights Table");
  if (startIndex === -1) {
    // Not a multi-section export; assume the whole file is the flights table.
    return content;
  }
  const headerIndex = startIndex + 1;
  // Section ends at the next blank line or the next "Table" section header.
  let endIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || /Table\s*$/.test(trimmed.replace(/"/g, ""))) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(headerIndex, endIndex).join("\n");
}

const FOREFLIGHT_ALIASES = {
  date: ["date"],
  flight_number: ["flightnumber", "flight number"],
  registration: ["aircraftid"],
  from: ["from"],
  to: ["to"],
  off_blocks: ["timeout"],
  airborne: ["timeoff"],
  touchdown: ["timeon"],
  on_blocks: ["timein"],
  remarks: ["pilotcomments", "comments"],
  landings_day: ["daylandingsfullstop"],
  landings_night: ["nightlandingsfullstop"]
};

export function convertForeflight(content: string, options: GenericCsvOptions = {}): ConvertResult {
  const section = extractForeflightFlightsSection(content);
  return convertGenericCsv(section, { ...options, aliases: { ...FOREFLIGHT_ALIASES, ...options.aliases } });
}

// There are no generic-CSV presets for `logten`/`mccpilotlog`: the dedicated
// importers (`src/import/importers/logten/logten.ts`, `src/import/importers/pilotlog.ts`)
// read the real LogTen/PilotLog export shapes (tab-separated
// `flight_*` columns; PilotLog's classic/raw variants) directly, with real
// role/time-policy logic ported from the iOS app, rather than guessing at
// header aliases on top of the generic CSV converter. Use `--from logten` /
// `--from pilotlog` instead.

export { parseCsv };
