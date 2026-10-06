/**
 * `jetlog import`, the CLI write path:
 * parse -> match against the user's own existing logbook -> merge -> preview
 * -> confirm -> open/reuse an import batch -> write people/aircraft/fstd/
 * entries in <=200-row chunks under `x-jetlog-batch-id` -> report the batch
 * id and how to undo it.
 */
import { createInterface } from "node:readline/promises";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { ApiClient, createImportBatch, listImportBatches, putResourceChunked, type ImportBatch } from "../api/client.js";
import { resolveToken, resolveBaseUrl, DEFAULT_PROFILE } from "../auth/credentials.js";
import { DEFAULT_BASE_URL } from "../api/client.js";
import { getImporter, detectImporter } from "../import/registry.js";
import { excludingFutureEntries, type ImportResult } from "../import/model.js";
import { EXCLUDES_FUTURE_ENTRIES_BY_DEFAULT } from "../convert/index.js";
import { fetchRemoteMirror } from "../import/remote-mirror.js";
import { fetchAirlineCatalog } from "../import/airlines.js";
import { buildWritePlan, type WritePlan } from "../import/resolve.js";
import { useLoggedInAirports } from "../airports/index.js";
import { importNotices, terminalNoticeLines } from "../import/warnings.js";

export interface ImportOptions {
  files: string[];
  from: string;
  dryRun?: boolean;
  yes?: boolean;
  label?: string;
  /** Which crew name in the file is the user (LogTen); see `jetlog import --self`. */
  self?: string;
  includeFuture?: boolean;
  /** Materializes every row that would otherwise match an existing entry as
   * an independent new entry instead (`materializeAsNewEntry`), see
   * `src/import/resolve.ts`'s doc comment for why this is all-or-nothing. */
  asNew?: boolean;
  profile: string;
  baseUrl?: string;
}

async function requireWriteClient(profile: string, baseUrlOverride?: string): Promise<ApiClient> {
  const token = await resolveToken(profile);
  if (!token) {
    throw new Error(`not logged in (profile: ${profile}). Run \`jetlog login --scope write\`.`);
  }
  const baseUrl = baseUrlOverride ?? (await resolveBaseUrl(profile)) ?? DEFAULT_BASE_URL;
  return new ApiClient({ baseUrl, token });
}

async function resolveImporterAndParse(
  opts: ImportOptions
): Promise<{ importResult: ImportResult; importerId: string; extraNotes: string[] }> {
  const loaded = await Promise.all(
    opts.files.map(async (file) => {
      const buffer = await readFile(file);
      return { buffer, filename: basename(file) };
    })
  );

  const importer =
    opts.from === "auto"
      ? detectImporter(loaded[0]!.buffer, loaded[0]!.filename)
      : getImporter(opts.from);

  if (!importer) {
    throw new Error(
      `jetlog import needs a ported importer format (logten, pilotlog, flylog, safelog, skylife, chrono, rblogbook, ` +
        `flightlogger, excel, monthly-overview, jetlog-csv, deeplink-json, or auto resolving to one of those). ` +
        `"${opts.from}" doesn't carry the richer ImportedEntry model (crew, times, FSTD) this write path merges on.`
    );
  }

  let importResult: ImportResult;
  if (loaded.length > 1) {
    if (!importer.parseMany) throw new Error(`${importer.id} does not support multiple input files.`);
    importResult = await importer.parseMany(loaded, { selfName: opts.self });
  } else {
    importResult = await importer.parse(loaded[0]!.buffer, { filename: loaded[0]!.filename, selfName: opts.self });
  }

  let futureExcluded = 0;
  if (EXCLUDES_FUTURE_ENTRIES_BY_DEFAULT.has(importer.id) && !opts.includeFuture) {
    const before = importResult.entries.length;
    importResult = excludingFutureEntries(importResult, new Date().toISOString().slice(0, 10));
    futureExcluded = before - importResult.entries.length;
  }

  const extraNotes: string[] = [];
  if (futureExcluded > 0) {
    extraNotes.push(`${futureExcluded} planned/future row(s) excluded (pass --include-future to keep them)`);
  }

  return { importResult, importerId: importer.id, extraNotes };
}

function printPreview(plan: WritePlan, importerId: string, importResult: ImportResult, extraNotes: string[]): void {
  const dates = plan.entries.map((e) => e.date).sort();
  const dateRange = dates.length > 0 ? `${dates[0]} to ${dates[dates.length - 1]}` : "n/a";
  const newEntries = plan.entries.filter((e) => e.isNew).length;
  const unchangedEntries = plan.entries.filter((e) => e.unchanged).length;
  const updatedEntries = plan.entries.length - newEntries - unchangedEntries;
  const newPeople = plan.people.filter((p) => p.isNew).length;
  const updatedPeople = plan.people.length - newPeople;
  const newAircraft = plan.aircraft.filter((a) => a.isNew).length;

  console.error(`import preview (${importerId}):`);
  console.error(
    `  entries:  ${newEntries} new, ${updatedEntries} updated, ${unchangedEntries} unchanged (not re-sent), ${dateRange}`
  );
  console.error(`  people:   ${newPeople} new, ${updatedPeople} matched, ${plan.people.map((p) => p.displayName).join(", ") || "(none)"}`);
  console.error(`  aircraft: ${newAircraft} new, ${plan.aircraft.length - newAircraft} matched`);
  if (plan.fstd.length > 0) console.error(`  fstd:     ${plan.fstd.length} referenced (new/updated catalog rows)`);
  if (plan.skippedDuplicateInFile > 0) console.error(`  skipped:  ${plan.skippedDuplicateInFile} duplicate row(s) within this file`);
  if (plan.skippedAlreadyDeletedUnmatched > 0) {
    console.error(`  skipped:  ${plan.skippedAlreadyDeletedUnmatched} unmatched row(s) already marked deleted`);
  }
  // Each warning once, row-aware and grouped per row (`plan.warnings` is a subset of these).
  for (const note of extraNotes) console.error(`  warning: ${note}`);
  for (const line of terminalNoticeLines(importNotices(importResult), "  ")) console.error(line);
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function lastBatchPath(profile: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "jetlog", `last-import-batch-${profile}.json`);
}

interface LastBatchMarker {
  batchId: string;
  importerId: string;
  label?: string;
}

async function reuseOrCreateBatch(
  client: ApiClient,
  profile: string,
  importerId: string,
  label: string | undefined
): Promise<{ batch: ImportBatch; reused: boolean }> {
  try {
    const raw = await readFile(lastBatchPath(profile), "utf-8");
    const marker = JSON.parse(raw) as LastBatchMarker;
    if (marker.importerId === importerId && marker.label === label) {
      const { import_batches } = await listImportBatches(client);
      const stillActive = import_batches.find((b) => b.id === marker.batchId && b.status === "active");
      if (stillActive) return { batch: stillActive, reused: true };
    }
  } catch {
    // No marker, or it's stale/unreadable, fall through to creating a new batch.
  }

  const batch = await createImportBatch(client, {
    kind: "import",
    source_format: importerId,
    label,
    client: "jetlog-cli"
  });
  await mkdir(join(lastBatchPath(profile), ".."), { recursive: true }).catch(() => undefined);
  await writeFile(lastBatchPath(profile), JSON.stringify({ batchId: batch.id, importerId, label } satisfies LastBatchMarker), "utf-8").catch(
    () => undefined
  );
  return { batch, reused: false };
}

export async function runImport(opts: ImportOptions): Promise<void> {
  const client = await requireWriteClient(opts.profile, opts.baseUrl);
  // Importers and the route-divergence check canonicalize codes through the ONE airport resolver;
  // install the server catalog plus the user's places first so IATA and custom-place codes
  // resolve like in the app (a failed fetch warns and keeps no airports).
  await useLoggedInAirports(client, opts.profile);

  const { importResult, importerId, extraNotes } = await resolveImporterAndParse(opts);

  const [mirror, airlineCatalog] = await Promise.all([fetchRemoteMirror(client), fetchAirlineCatalog(client)]);
  const plan = buildWritePlan(importResult, mirror, { asNew: opts.asNew, airlineCatalog });

  printPreview(plan, importerId, importResult, extraNotes);

  if (plan.entries.length === 0) {
    console.error("nothing to import.");
    return;
  }

  if (opts.dryRun) {
    console.error("dry run: nothing was written.");
    return;
  }

  if (!opts.yes) {
    const proceed = await confirm(`Write ${plan.entries.length} entr${plan.entries.length === 1 ? "y" : "ies"} to Jetlog?`);
    if (!proceed) {
      console.error("aborted: nothing was written.");
      return;
    }
  }

  const { batch, reused } = await reuseOrCreateBatch(client, opts.profile, importerId, opts.label);
  if (reused) console.error(`reusing active batch ${batch.id} (previous run didn't finish or re-ran the same import)`);

  if (plan.people.length > 0) {
    await putResourceChunked(client, "people", plan.people.map((p) => p.fields), batch.id);
  }
  if (plan.aircraft.length > 0) {
    await putResourceChunked(client, "aircraft", plan.aircraft.map((a) => a.fields), batch.id);
  }
  if (plan.fstd.length > 0) {
    await putResourceChunked(client, "fstd", plan.fstd.map((f) => f.fields), batch.id);
  }
  const writtenEntries = plan.entries.filter((e) => !e.unchanged);
  await putResourceChunked(client, "entries", writtenEntries.map((e) => e.fields), batch.id);

  console.error(`done: batch ${batch.id} (${importerId}): ${writtenEntries.length} entr${writtenEntries.length === 1 ? "y" : "ies"} written.`);
  console.error(`undo with \`jetlog batches remove ${batch.id}\`, or from the Jetlog app's Settings > Imports screen.`);
}
