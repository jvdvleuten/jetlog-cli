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
    console.error(`kept (signed):        ${preview.signed_kept} entr${preview.signed_kept === 1 ? "y" : "ies"} kept (an entry signed in the app is never deleted)`);
  }
  const tokenSigned = preview.token_signed_would_delete ?? 0;
  if (tokenSigned > 0) {
    console.error(`signed by a token:    ${tokenSigned} entr${tokenSigned === 1 ? "y carries a signature" : "ies carry signatures"} a token attached and are deleted with the batch`);
  }
  const linkSigned = preview.link_signed_kept ?? 0;
  if (linkSigned > 0) {
    console.error(
      `kept (link-signed):   ${linkSigned} entr${linkSigned === 1 ? "y" : "ies"} signed through a signing link a token created (add --include-link-signed to delete ${linkSigned === 1 ? "it" : "them"} too)`
    );
  }
}

function printResult(result: CleanupResult): void {
  if ("status" in result) {
    console.error(`large cleanup scheduled in the background (status: ${result.status}).`);
  } else {
    console.error(`deleted ${result.deleted} entr${result.deleted === 1 ? "y" : "ies"}${result.people_deleted ? `, ${result.people_deleted} orphaned person(s)` : ""}.`);
  }
}

export async function batchesRemove(opts: {
  profile: string;
  baseUrl?: string;
  id: string;
  yes?: boolean;
  includeLinkSigned?: boolean;
}): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const preview = (await deleteImportBatch(client, opts.id, true, opts.includeLinkSigned)) as CleanupPreview;
  printPreview(preview);

  if (preview.would_delete === 0 && (preview.token_signed_would_delete ?? 0) === 0) {
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

  const result = (await deleteImportBatch(client, opts.id, false, opts.includeLinkSigned)) as CleanupResult;
  printResult(result);
}

export async function batchesRemoveAllCli(opts: {
  profile: string;
  baseUrl?: string;
  yes?: boolean;
  includeLinkSigned?: boolean;
}): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const preview = (await cleanupImportBatches(client, ["cli"], true, opts.includeLinkSigned)) as CleanupPreview;
  printPreview(preview);

  if (preview.would_delete === 0 && (preview.token_signed_would_delete ?? 0) === 0) {
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

  const result = (await cleanupImportBatches(client, ["cli"], false, opts.includeLinkSigned)) as CleanupResult;
  printResult(result);
}
