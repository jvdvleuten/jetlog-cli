/**
 * `jetlog export`: pages through `/api/cli/v1/entries` (the filterable
 * read facade, not the version-cursor sync mirror: it has `include_deleted`
 * built in and a nicer `derived` shape) and writes every entry to disk.
 *
 * Resumability: before each page request, the keyset cursor (`after_date`/
 * `after_id`) is written to `<output>.resume.json`. If that file exists on
 * a fresh run, it's picked up automatically so a killed/interrupted export
 * can continue instead of starting over. On a clean finish the resume file
 * is removed. This only resumes a single JSON array file; CSV export does
 * not keep a resume file since appending a partial row set and tracking
 * array commas is one more fragile thing to make correct, and CSV export
 * is comparatively quick for how most logbooks are sized.
 */

import { open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { ApiClient, type EntriesPage } from "../api/client.js";
import { requireClient } from "./entries.js";
import { toCsv } from "./output.js";

export interface ExportOptions {
  profile: string;
  baseUrl?: string;
  output?: string;
  format: "json" | "csv";
  includeDeleted?: boolean;
}

interface ResumeState {
  afterDate?: string;
  afterId?: string;
}

function resumePath(output: string): string {
  return `${output}.resume.json`;
}

async function loadResumeState(output: string): Promise<ResumeState | undefined> {
  try {
    const raw = await readFile(resumePath(output), "utf-8");
    return JSON.parse(raw) as ResumeState;
  } catch {
    return undefined;
  }
}

async function saveResumeState(output: string, state: ResumeState): Promise<void> {
  await writeFile(resumePath(output), JSON.stringify(state), "utf-8");
}

const CSV_COLUMNS = [
  "id",
  "version",
  "type",
  "date",
  "flight_number",
  "registration",
  "from",
  "to",
  "off_blocks",
  "airborne",
  "touchdown",
  "on_blocks",
  "is_deleted",
  "remarks"
];

export async function runExport(opts: ExportOptions): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const output = opts.output;

  let afterDate: string | undefined;
  let afterId: string | undefined;
  let resuming = false;

  if (output) {
    const resume = await loadResumeState(output);
    if (resume) {
      afterDate = resume.afterDate;
      afterId = resume.afterId;
      resuming = true;
      process.stderr.write(`resuming export after date=${afterDate} id=${afterId}\n`);
    }
  }

  const entries: Record<string, unknown>[] = [];
  let total = 0;
  let page = 0;

  // JSON streaming to disk: write the opening bracket once (skipped when
  // resuming into an existing partial file), then append each page's rows
  // as additional array elements followed by a comma, and close the array
  // only once the whole export finishes successfully.
  let handle: FileHandle | undefined;
  if (output && opts.format === "json") {
    // "a" (append) always writes at end-of-file regardless of the file
    // descriptor's current position, unlike "r+", where appendFile()
    // writes from the current position (0 right after open) and would
    // clobber the existing partial file instead of extending it.
    handle = await open(output, "a");
    if (!resuming) await handle.appendFile("[\n");
  }

  try {
    for (;;) {
      page++;
      const result: EntriesPage = await client.get<EntriesPage>("/api/cli/v1/entries", {
        limit: 200,
        include_deleted: opts.includeDeleted,
        after_date: afterDate,
        after_id: afterId
      });

      total += result.entries.length;
      process.stderr.write(`page ${page}: ${result.entries.length} entries (total ${total})\n`);

      if (handle) {
        for (const entry of result.entries) {
          await handle.appendFile(JSON.stringify(entry) + ",\n");
        }
      } else {
        entries.push(...result.entries);
      }

      if (!result.pagination.has_more || !result.pagination.next_cursor) break;

      afterDate = String(result.pagination.next_cursor.date);
      afterId = String(result.pagination.next_cursor.id);

      if (output) await saveResumeState(output, { afterDate, afterId });
    }
  } finally {
    await handle?.close();
  }

  if (output) {
    if (opts.format === "json") {
      // Close the array: strip the trailing ",\n" left by the last
      // appendFile write (or replace the lone "[\n" when the export has no
      // entries at all) with a clean "]\n".
      const raw = await readFile(output, "utf-8");
      const closed = raw.endsWith(",\n") ? raw.slice(0, -2) + "\n]\n" : raw.trimEnd() + "\n]\n";
      await writeFile(output, closed, "utf-8");
    } else {
      await writeFile(output, toCsv(entries, CSV_COLUMNS), "utf-8");
    }
    await rm(resumePath(output), { force: true });
    process.stderr.write(`done: ${total} entries written to ${output}\n`);
  } else {
    if (opts.format === "csv") {
      process.stdout.write(toCsv(entries, CSV_COLUMNS));
    } else {
      console.log(JSON.stringify(entries, null, 2));
    }
    process.stderr.write(`done: ${total} entries\n`);
  }
}
