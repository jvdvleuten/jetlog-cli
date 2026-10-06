/**
 * The importer registry, every format importer, plus `--from auto`
 * detection.
 *
 * Registration order matters for `detectImporter`: when two importers both
 * return a positive confidence for the same file, the one registered first
 * wins a tie. List more specific formats before more generic ones.
 */
import type { Importer } from "./importer.js";
import { chronoImporter } from "./importers/chrono.js";
import { csvLogbookImporter } from "./importers/csv-logbook.js";
import { deepLinkJSONImporter } from "./importers/deeplink-json.js";
import { excelImporter } from "./importers/excel.js";
import { flightLoggerImporter } from "./importers/flightlogger.js";
import { flylogImporter } from "./importers/flylog.js";
import { logTenImporter } from "./importers/logten/logten.js";
import { monthlyOverviewImporter } from "./importers/monthly-overview.js";
import { pilotLogImporter } from "./importers/pilotlog.js";
import { rbLogbookImporter } from "./importers/rblogbook.js";
import { safeLogImporter } from "./importers/safelog.js";
import { skylifeImporter } from "./importers/skylife.js";

export const IMPORTERS: Importer[] = [
  deepLinkJSONImporter,
  csvLogbookImporter,
  excelImporter,
  logTenImporter,
  pilotLogImporter,
  flylogImporter,
  safeLogImporter,
  skylifeImporter,
  flightLoggerImporter,
  rbLogbookImporter,
  monthlyOverviewImporter,
  chronoImporter
];

export function getImporter(id: string): Importer | undefined {
  return IMPORTERS.find((importer) => importer.id === id);
}

/**
 * Best-effort format detection for `--from auto`, mirroring each importer's
 * own `detect()` (see `importer.ts`'s file doc comment: the iOS app mostly
 * relies on an explicit user picker rather than content sniffing, so this is
 * this CLI's own logic, not a straight port).
 */
export function detectImporter(buffer: Buffer, filename: string | undefined): Importer | undefined {
  let best: { importer: Importer; confidence: number } | undefined;
  for (const importer of IMPORTERS) {
    const confidence = importer.detect(buffer, filename);
    if (confidence > 0 && (!best || confidence > best.confidence)) {
      best = { importer, confidence };
    }
  }
  return best?.importer;
}
