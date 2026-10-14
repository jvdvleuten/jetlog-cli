/**
 * `jetlog changes propose|show|apply`: the CLI side of the propose/confirm/apply flow, the same one the MCP
 * tools `propose_changes`/`apply_changes`/`get_change_status` use. Propose validates the payload with the schema
 * the MCP tool uses, stores a preview on the server and writes nothing. Apply is the only call that writes.
 */
import { readFile } from "node:fs/promises";
import {
  applyChanges,
  getPendingChange,
  proposeChanges,
  type PendingChange,
  type PendingChangeOperationInput,
  type PendingChangePreviewEntry
} from "../api/client.js";
import { parseProposeChanges } from "../changes-schema.js";
import { confirm } from "./confirm.js";
import { requireClient } from "./entries.js";
import { sanitizeForTerminal } from "./output.js";

type Log = (line: string) => void;
const toStderr: Log = (line) => console.error(line);

function formatValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  return sanitizeForTerminal(JSON.stringify(value) ?? "null");
}

function printPreviewEntry(entry: PendingChangePreviewEntry, log: Log): void {
  const label = entry.op === "delete" ? "DELETE" : entry.op === "create" ? "create" : "update";
  log(`  [${entry.index}] ${label} ${sanitizeForTerminal(entry.resource)} ${sanitizeForTerminal(entry.id)}`);
  const fields = entry.changed_fields.length > 0 ? entry.changed_fields : [];
  if (fields.length === 0) return;
  if (entry.op === "update" && entry.before && entry.after) {
    for (const field of fields) {
      log(`        ${sanitizeForTerminal(field)}: ${formatValue(entry.before[field])} -> ${formatValue(entry.after[field])}`);
    }
  } else {
    log(`        changed: ${fields.map((f) => sanitizeForTerminal(f)).join(", ")}`);
  }
}

function printPendingChange(pc: PendingChange, log: Log = toStderr): void {
  log(`id:      ${pc.id}`);
  log(`status:  ${pc.status}`);
  log(`summary: ${sanitizeForTerminal(pc.summary)}`);
  log(
    `counts:  ${pc.counts.creates} create(s), ${pc.counts.updates} update(s), ${pc.counts.deletes} delete(s)` +
      (pc.counts.deletes > 0 ? "  <-- includes deletion(s)" : "")
  );
  log(`expires: ${pc.expires_at}`);
  log("operations:");
  for (const entry of pc.preview) printPreviewEntry(entry, log);
}

async function readPayloadText(source: string | undefined): Promise<string> {
  if (source !== undefined && source !== "-") return readFile(source, "utf8");
  if (source === undefined && process.stdin.isTTY) {
    throw new Error("no payload given. Pass a file, or pipe JSON on stdin (`jetlog changes propose -`). See `jetlog changes propose --help`.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function changesPropose(opts: {
  profile: string;
  baseUrl?: string;
  file?: string;
  json?: boolean;
}): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readPayloadText(opts.file));
  } catch (err) {
    throw new Error(`could not read the payload as JSON: ${(err as Error).message}`);
  }
  const parsed = parseProposeChanges(raw);
  if (!parsed.ok) {
    const lines = ["the payload is not valid, nothing was sent:", ...parsed.errors.map((e) => `  ${e}`), "Run `jetlog changes schema` for the expected shape."];
    throw new Error(lines.join("\n"));
  }

  const client = await requireClient(opts.profile, opts.baseUrl);
  const result = await proposeChanges(client, parsed.value.summary, parsed.value.operations as PendingChangeOperationInput[]);

  if (!result.ok) {
    if (result.code === "scope_missing" || result.code === "insufficient_scope") {
      const profileFlag = opts.profile === "default" ? "" : ` --profile ${opts.profile}`;
      throw new Error(
        `this login cannot propose changes (it needs write access${result.missingScopes?.length ? ` and the ${result.missingScopes.join(", ")} scope` : ""}). ` +
          `Ask the pilot to run \`jetlog login --scope write${profileFlag}\` and to switch on "Make changes to your logbook" in the Jetlog app first. Nothing was changed.`
      );
    }
    const details = (result.errors ?? []).map(
      (e) => `\n  operation ${e.index ?? "?"}${e.field ? `, ${sanitizeForTerminal(e.field)}` : ""}: ${sanitizeForTerminal(e.message)}`
    );
    const code = result.code && !result.message.includes(result.code) ? ` (${result.code})` : "";
    throw new Error(`${result.message}${code}${details.join("")}\nNothing was changed.`);
  }

  const pc = result.pendingChange;
  const profileFlag = opts.profile === "default" ? "" : ` --profile ${opts.profile}`;
  const next = `jetlog changes apply ${pc.id}${profileFlag}`;
  if (opts.json) {
    console.log(JSON.stringify({ id: pc.id, status: pc.status, summary: pc.summary, counts: pc.counts, expires_at: pc.expires_at, preview: pc.preview, next }, null, 2));
    return;
  }
  printPendingChange(pc, (line) => console.log(line));
  console.log("");
  console.log("Nothing has been written yet. Show this preview to the pilot. After an explicit yes, run:");
  console.log(`  ${next}`);
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

  // The server shows a signing link URL in this one response only, so it is printed here or lost.
  for (const link of result.links) {
    console.log(sanitizeForTerminal(link.url));
    const id = sanitizeForTerminal(link.signature_request_id);
    console.error(
      `Signing link ${id}, expires ${sanitizeForTerminal(link.expires_at)}` +
        `${link.entry_count !== undefined ? `, ${link.entry_count} ${link.entry_count === 1 ? "entry" : "entries"}` : ""}. ` +
        `Anyone who has it can sign those entries until then. Revoke with: jetlog signatures revoke ${id}`
    );
  }
}
