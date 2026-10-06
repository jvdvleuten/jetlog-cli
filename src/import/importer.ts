/**
 * The importer interface every format implements.
 *
 * The iOS app doesn't auto-detect a format from file content in the way
 * this CLI's `--from auto` needs to: `ImportViewModel`/
 * `ImportProcessingService` let the user explicitly pick a format in a
 * picker (the one piece of real content-based branching is LogTen's own
 * export picking between its "Flights" and "Address Book" exports). So `detect()` here is this
 * CLI's own best-effort content/extension sniffing, not a port of existing
 * iOS logic, each importer's `detect()` doc comment says so.
 */
import type { ImportResult } from "./model.js";

export interface ImporterOptions {
  /** The pilot's own role on a format whose rows don't otherwise say (e.g. a
   * plain CSV with no per-seat columns). Mirrors `--self-role` on the
   * existing CSV presets. */
  selfRole?: string;
  /** Override for ambiguous day-first/month-first dates. */
  dateFormat?: "YMD" | "DMY" | "MDY";
  /** Name of the person in the file who is the user, for formats that list crew by name (LogTen) and do not
   * mark the owner. Mirrors `--self <name>`. */
  selfName?: string;
  /** Original filename, when known, used by multi-format importers (e.g.
   * LogTen) that branch on it, and included in `ImportError.sourceFileName`. */
  filename?: string;
}

/** 0 = definitely not this format, 1 = definitely this format. Ties are
 * broken by registration order in `registry.ts` (most specific first). */
export type DetectionConfidence = number;

export interface Importer {
  /** Stable identifier, used as the `--from` CLI value. */
  readonly id: string;
  readonly displayName: string;
  /** Lowercased extensions (without the dot) this importer's files typically use. */
  readonly extensions: string[];
  /** Best-effort format sniffing for `--from auto`. */
  detect(buffer: Buffer, filename: string | undefined): DetectionConfidence;
  /** Async because PDF-backed importers (`monthly-overview`, `chrono`) need
   * to run `pdfjs-dist` text extraction before parsing; every other
   * importer's body stays synchronous internally, just wrapped in `async`. */
  parse(input: Buffer | string, options?: ImporterOptions): Promise<ImportResult>;
  /** Optional: an importer whose real source is several files (RBLogbook's
   * flights/aircraft/people CSVs) can declare this instead of relying only on
   * `parse()` seeing a single file. `jetlog convert` calls this when more
   * than one input file is given and the importer declares it; the files are
   * content-sniffed the same way a single file is passed to `detect()`. */
  parseMany?(files: { buffer: Buffer; filename: string | undefined }[], options?: ImporterOptions): Promise<ImportResult>;
}
