/** `jetlog batches list|remove`, manage CLI import batches. */
import { createInterface } from "node:readline/promises";
import { cleanupImportBatches, deleteImportBatch, listImportBatches, type CleanupPreview, type CleanupResult } from "../api/client.js";
import { requireClient } from "./entries.js";
import { printRows, type OutputFormat } from "./output.js";

const COLUMNS = ["id", "kind", "source_format", "label", "status", "created_count", "edited_count", "created_at"];

export async function batchesList(opts: { profile: string; baseUrl?: string; format: OutputFormat }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const { import_batches } = await listImportBatches(client);
  printRows(import_batches as unknown as Record<string, unknown>[], COLUMNS, opts.format);
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

function printPreview(preview: CleanupPreview): void {
  console.error(`would delete:        ${preview.would_delete} entr${preview.would_delete === 1 ? "y" : "ies"} this import created`);
  console.error(`changed since import: ${preview.changed_since_import} of those have since been edited`);
  console.error(`edited, untouched:    ${preview.edited_entries_untouched} entries this import only EDITED (never deleted)`);
  console.error(`people:               ${preview.people_would_delete} orphaned person(s) would also be removed`);
  if (preview.signed_kept > 0) {
    console.error(`kept (signed):        ${preview.signed_kept} entr${preview.signed_kept === 1 ? "y" : "ies"} kept (a signed entry is never deleted)`);
  }
}

function printResult(result: CleanupResult): void {
  if ("status" in result) {
    console.error(`large cleanup scheduled in the background (status: ${result.status}).`);
  } else {
    console.error(`deleted ${result.deleted} entr${result.deleted === 1 ? "y" : "ies"}${result.people_deleted ? `, ${result.people_deleted} orphaned person(s)` : ""}.`);
  }
}

export async function batchesRemove(opts: { profile: string; baseUrl?: string; id: string; yes?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const preview = (await deleteImportBatch(client, opts.id, true)) as CleanupPreview;
  printPreview(preview);

  if (preview.would_delete === 0) {
    console.error("nothing to remove.");
    return;
  }

  if (!opts.yes) {
    const proceed = await confirm(`Remove batch ${opts.id}?`);
    if (!proceed) {
      console.error("aborted: nothing was removed.");
      return;
    }
  }

  const result = (await deleteImportBatch(client, opts.id, false)) as CleanupResult;
  printResult(result);
}

export async function batchesRemoveAllCli(opts: { profile: string; baseUrl?: string; yes?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const preview = (await cleanupImportBatches(client, ["cli"], true)) as CleanupPreview;
  printPreview(preview);

  if (preview.would_delete === 0) {
    console.error("nothing to remove.");
    return;
  }

  if (!opts.yes) {
    const proceed = await confirm("Remove every CLI-created entry across all import batches?");
    if (!proceed) {
      console.error("aborted: nothing was removed.");
      return;
    }
  }

  const result = (await cleanupImportBatches(client, ["cli"], false)) as CleanupResult;
  printResult(result);
}
