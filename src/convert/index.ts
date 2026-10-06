export * from "./csv.js";
export * from "./presets.js";
export * from "./jetlog.js";

import { convertGenericCsv, type ConvertResult, type GenericCsvOptions } from "./csv.js";
import { convertForeflight } from "./presets.js";
import { convertJetlogJson } from "./jetlog.js";
import { IMPORTERS, detectImporter, getImporter } from "../import/registry.js";
import { importResultToPayload } from "../import/to-payload.js";
import { excludingFutureEntries, type DateOnly, type ImportResult } from "../import/model.js";
import type { Importer } from "../import/importer.js";
import { importNotices, type ImportNotice } from "../import/warnings.js";

/** The real ported importers' ids, usable as `--from <id>` values. */
export const PORTED_IMPORTER_IDS = IMPORTERS.map((i) => i.id);

export type ConvertFormat = "csv" | "foreflight" | "jetlog" | "auto" | (typeof PORTED_IMPORTER_IDS)[number];

/**
 * Importer ids the iOS app applies `excludingFutureEntries` to by default
 * (every third-party logbook import, including LogTen and RBLogbook). Jetlog's
 * own re-import formats (`excel`, `jetlog-csv`, `deeplink-json`) and the PDF
 * roster/statement formats (`monthly-overview`, `chrono`) must not get this,
 * because future-dated rows are first-class there.
 */
export const EXCLUDES_FUTURE_ENTRIES_BY_DEFAULT = new Set<string>([
  "pilotlog",
  "safelog",
  "flightlogger",
  "flylog",
  "skylife",
  "logten",
  "rblogbook"
]);

export interface ConvertFileOptions extends GenericCsvOptions {
  /** Override to keep future-dated rows for an importer that normally drops
   * them (see `EXCLUDES_FUTURE_ENTRIES_BY_DEFAULT`). Mirrors `jetlog
   * convert`'s `--include-future` flag. */
  includeFuture?: boolean;
  /** Name of the person in the file who is you, for formats that list crew by name (LogTen). */
  selfName?: string;
  /** Override "today" for the future-entries cutoff, mainly for tests;
   * defaults to the real current date. */
  today?: DateOnly;
}

export interface ConvertFileResult extends ConvertResult {
  /** Present only when `format` resolved to a dedicated importer (`logten`,
   * `pilotlog`, `jetlog-csv`, `deeplink-json`, or `auto` resolving to one of
   * those), the richer `ImportResult` before it was narrowed down to the
   * public payload, plus how much was dropped in that narrowing. See
   * `src/import/to-payload.ts`'s file doc comment for why this mapping is
   * deliberately minimal. */
  importResult?: ImportResult;
  /** Row-aware warnings and skipped rows from the importer (see `import/warnings.ts`). Present together
   * with `importResult`. `skipped` keeps listing every importer message for backward compatibility. */
  notices?: ImportNotice[];
  droppedFieldCount?: number;
  droppedEntryCount?: number;
  /** How many rows were dropped for being dated after "today", see
   * `EXCLUDES_FUTURE_ENTRIES_BY_DEFAULT`/`--include-future`. `undefined` when
   * the format doesn't apply this filter at all (not just when the count is 0). */
  futureEntriesExcludedCount?: number;
}

function todayDateOnly(): DateOnly {
  return new Date().toISOString().slice(0, 10);
}

export async function convertFile(
  format: ConvertFormat,
  content: string,
  options: ConvertFileOptions = {},
  buffer?: Buffer
): Promise<ConvertFileResult> {
  switch (format) {
    case "csv":
      return convertGenericCsv(content, options);
    case "foreflight":
      return convertForeflight(content, options);
    case "jetlog":
      return { payload: convertJetlogJson(content), skipped: [] };
    case "auto": {
      const importer = detectImporter(buffer ?? Buffer.from(content, "utf8"), options.filename);
      if (!importer) {
        throw new Error("Could not auto-detect the file format. Pass --from explicitly.");
      }
      return convertViaImporter(importer, content, options, buffer);
    }
    default: {
      const importer = getImporter(format);
      if (!importer) {
        throw new Error(`Unknown format: ${format}`);
      }
      return convertViaImporter(importer, content, options, buffer);
    }
  }
}

/**
 * Multi-file variant of `convertFile`, for formats whose real export is
 * several files (RBLogbook's flights/aircraft/people CSVs, see
 * `Importer.parseMany`). Single-file input is routed straight back through
 * `convertFile` so callers don't need to special-case the common case.
 */
export async function convertFiles(
  format: ConvertFormat,
  files: { content: string; buffer: Buffer; filename?: string }[],
  options: ConvertFileOptions = {}
): Promise<ConvertFileResult> {
  if (files.length === 0) {
    throw new Error("No input files given.");
  }
  if (files.length === 1) {
    const only = files[0]!;
    return convertFile(format, only.content, { ...options, filename: options.filename ?? only.filename }, only.buffer);
  }

  let importer: Importer | undefined;
  if (format === "auto") {
    for (const f of files) {
      const candidate = detectImporter(f.buffer, f.filename);
      if (candidate) {
        importer = candidate;
        break;
      }
    }
    if (!importer) {
      throw new Error("Could not auto-detect the file format from any of the given files. Pass --from explicitly.");
    }
  } else {
    importer = getImporter(format);
    if (!importer) {
      throw new Error(`Unknown format: ${format}`);
    }
  }

  if (!importer.parseMany) {
    throw new Error(`${importer.id} does not support multiple input files.`);
  }
  const importResult = await importer.parseMany(
    files.map((f) => ({ buffer: f.buffer, filename: f.filename })),
    { selfRole: options.selfRole, selfName: options.selfName, dateFormat: options.dateFormat }
  );
  return finishConvertViaImporter(importer, importResult, options);
}

async function convertViaImporter(
  importer: Importer,
  content: string,
  options: ConvertFileOptions,
  buffer?: Buffer
): Promise<ConvertFileResult> {
  const importResult = await importer.parse(buffer ?? content, {
    selfRole: options.selfRole,
    selfName: options.selfName,
    dateFormat: options.dateFormat,
    filename: options.filename
  });
  return finishConvertViaImporter(importer, importResult, options);
}

function finishConvertViaImporter(importer: Importer, rawResult: ImportResult, options: ConvertFileOptions): ConvertFileResult {
  let importResult = rawResult;
  let futureEntriesExcludedCount: number | undefined;
  if (EXCLUDES_FUTURE_ENTRIES_BY_DEFAULT.has(importer.id) && !options.includeFuture) {
    const before = importResult.entries.length;
    importResult = excludingFutureEntries(importResult, options.today ?? todayDateOnly());
    futureEntriesExcludedCount = before - importResult.entries.length;
  }
  const { payload, droppedFieldCount, droppedEntryCount } = importResultToPayload(importResult);
  const skipped = importResult.importErrors.map((e, i) => ({ row: e.rowNumber ?? i + 1, reason: e.reason }));
  return { payload, skipped, importResult, notices: importNotices(importResult), droppedFieldCount, droppedEntryCount, futureEntriesExcludedCount };
}
