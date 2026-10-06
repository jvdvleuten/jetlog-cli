/**
 * `jetlog changes show|apply`: human-facing CLI parity for the
 * AI-proposes/user-confirms pending-change flow (`src/mcp.ts`'s
 * `propose_changes`/`apply_changes`/`get_change_status` tools). Mostly
 * useful for testing that flow by hand: proposing is done by an AI client
 * (or `jetlog mcp` itself) via `POST /api/pending_changes`, not from here;
 * there's no `jetlog changes propose` command.
 */
import { createInterface } from "node:readline/promises";
import { applyChanges, getPendingChange, type PendingChange, type PendingChangePreviewEntry } from "../api/client.js";
import { requireClient } from "./entries.js";

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printPreviewEntry(entry: PendingChangePreviewEntry): void {
  const label = entry.op === "delete" ? "DELETE" : entry.op === "create" ? "create" : "update";
  console.error(`  [${entry.index}] ${label} ${entry.resource} ${entry.id}`);
  if (entry.changed_fields.length > 0) {
    console.error(`        changed: ${entry.changed_fields.join(", ")}`);
  }
}

function printPendingChange(pc: PendingChange): void {
  console.error(`id:      ${pc.id}`);
  console.error(`status:  ${pc.status}`);
  console.error(`summary: ${pc.summary}`);
  console.error(
    `counts:  ${pc.counts.creates} create(s), ${pc.counts.updates} update(s), ${pc.counts.deletes} delete(s)` +
      (pc.counts.deletes > 0 ? "  <-- includes deletion(s)" : "")
  );
  console.error(`expires: ${pc.expires_at}`);
  console.error("operations:");
  for (const entry of pc.preview) printPreviewEntry(entry);
}

export async function changesShow(opts: { profile: string; baseUrl?: string; id: string; json?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const pendingChange = await getPendingChange(client, opts.id);
  if (opts.json) {
    console.log(JSON.stringify(pendingChange, null, 2));
  } else {
    printPendingChange(pendingChange);
  }
}

export async function changesApply(opts: {
  profile: string;
  baseUrl?: string;
  id: string;
  yes?: boolean;
  operationIndices?: number[];
}): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const pendingChange = await getPendingChange(client, opts.id);

  if (pendingChange.status !== "pending" && pendingChange.status !== "stale") {
    console.error(`this change is already "${pendingChange.status}", nothing to apply.`);
    return;
  }

  printPendingChange(pendingChange);

  if (!opts.yes) {
    const proceed = await confirm(`Apply pending change ${opts.id}?`);
    if (!proceed) {
      console.error("aborted: nothing was applied.");
      return;
    }
  }

  const result = await applyChanges(client, opts.id, opts.operationIndices);

  if (result.ok === "stale") {
    console.error("the underlying data changed since this was proposed. Here is the fresh preview:");
    printPendingChange(result.pendingChange);
    console.error("nothing was applied. Re-run `jetlog changes apply` to apply the fresh preview, or propose again.");
    return;
  }

  if (!result.ok) {
    console.error(`error: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.error(
    `applied: ${result.pendingChange.counts.creates} create(s), ${result.pendingChange.counts.updates} update(s), ` +
      `${result.pendingChange.counts.deletes} delete(s). batch: ${result.pendingChange.applied_batch_id}`
  );
}
