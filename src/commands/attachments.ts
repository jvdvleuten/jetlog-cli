/**
 * `jetlog attachments list|add|get|remove`: files on logbook entries.
 *
 * Bytes are uploaded first (they change nothing in the logbook), then one batched
 * `PUT /api/entry_attachments` writes the rows, so `jetlog batches` and the app can see what this run did.
 * Status and prompts go to stderr, data to stdout.
 */
import { randomUUID } from "node:crypto";
import {
  createImportBatch,
  FILES_SCOPE_MESSAGE,
  getEntry,
  listEntryAttachmentsPage,
  putResourceChunked,
  type ApiClient
} from "../api/client.js";
import { fetchAttachment, saveAttachment } from "../attachments/download.js";
import { inspectFile, MAX_ENTRY_FILES, uploadInspected, type LocalFile } from "../attachments/upload.js";
import { confirm } from "./confirm.js";
import { requireClient } from "./entries.js";
import { entryLabel, formatBytes, orNotFound, plural } from "./format.js";
import { printRows, sanitizeForTerminal, type OutputFormat } from "./output.js";

interface Common {
  profile: string;
  baseUrl?: string;
}

const LIST_COLUMNS = ["id", "attachment_id", "file_name", "content_type", "byte_size", "position"];

export async function attachmentsList(opts: Common & { entryId: string; format: OutputFormat }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entry = await orNotFound(`entry ${opts.entryId}`, () => getEntry(client, opts.entryId));
  // A token without the `files` scope gets no `attachments` key at all, which must not read as "no files".
  if (entry.attachments === undefined) throw new Error(FILES_SCOPE_MESSAGE);
  printRows(entry.attachments as unknown as Record<string, unknown>[], LIST_COLUMNS, opts.format);
}

export async function attachmentsAdd(
  opts: Common & { entryId: string; files: string[]; name?: string; yes?: boolean }
): Promise<void> {
  if (opts.files.length === 0) throw new Error("pass at least one file.");
  if (opts.name !== undefined && opts.files.length > 1) throw new Error("--name only works with a single file.");

  // Local checks first, so a bad file fails before anything is sent.
  const local: LocalFile[] = [];
  for (const file of opts.files) local.push(await inspectFile(file, "entry_file"));
  const names = local.map((f) => opts.name ?? f.fileName);

  const client = await requireClient(opts.profile, opts.baseUrl);
  const entry = await orNotFound(`entry ${opts.entryId}`, () => getEntry(client, opts.entryId));
  if (entry.attachments === undefined) throw new Error(FILES_SCOPE_MESSAGE);
  const existing = entry.attachments.length;
  if (existing + local.length > MAX_ENTRY_FILES) {
    throw new Error(
      `this entry has ${plural(existing, "file", "files")} and ${MAX_ENTRY_FILES} is the most it can hold, so ${plural(local.length, "more file", "more files")} do not fit.`
    );
  }

  console.error(`Entry ${entryLabel(entry)}`);
  const described = local.map((f, i) => `${sanitizeForTerminal(names[i]!)} (${f.contentType}, ${formatBytes(f.byteSize)})`);
  console.error(`Will add ${plural(local.length, "file", "files")}: ${described.join(", ")}`);
  if (!opts.yes && !(await confirm("Add these files?"))) {
    console.error("aborted: nothing was added.");
    return;
  }

  const batch = await createImportBatch(client, { kind: "edit", client: "jetlog-cli", label: `attachments add ${opts.entryId}` });
  const rows: Record<string, unknown>[] = [];
  for (const [i, file] of local.entries()) {
    const uploaded = await uploadInspected(client, "entry_file", file);
    rows.push({ id: randomUUID(), entry_id: opts.entryId, attachment_id: uploaded.attachment_id, file_name: names[i] });
  }
  const written = await putResourceChunked(client, "entry_attachments", rows, batch.id);

  for (const row of written) console.log(`${row.id}  ${sanitizeForTerminal(String(row.file_name ?? ""))}`);
  console.error(`Uploaded ${plural(rows.length, "file", "files")}. Entry now has ${plural(existing + rows.length, "attachment", "attachments")}.`);
}

export async function attachmentsGet(opts: Common & { attachmentId: string; output?: string; force?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const { meta, bytes } = await fetchAttachment(client, opts.attachmentId);
  const path = await saveAttachment(
    { attachment_id: meta.id, content_type: meta.content_type },
    bytes,
    opts.output ? { path: opts.output, force: opts.force } : { dir: process.cwd(), force: opts.force }
  );
  console.error(`Saved ${formatBytes(bytes.length)} (${meta.content_type}).`);
  console.log(path);
}

/** Finds an entry file row by its row id in the app's sync mirror, paging until it turns up. */
async function findEntryAttachmentRow(client: ApiClient, id: string): Promise<Record<string, unknown> | undefined> {
  const limit = 1000;
  let after = 0;
  for (;;) {
    const page = await listEntryAttachmentsPage(client, after, limit);
    const rows = page.entry_attachments ?? [];
    const hit = rows.find((r) => r.id === id);
    if (hit) return hit;
    if (rows.length < limit) return undefined;
    after = Math.max(...rows.map((r) => Number(r.version ?? 0)), after);
  }
}

export async function attachmentsRemove(opts: Common & { id: string; yes?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const row = await findEntryAttachmentRow(client, opts.id);
  if (!row || row.is_deleted === true) throw new Error(`file ${opts.id} not found.`);

  console.error(`Will remove ${sanitizeForTerminal(String(row.file_name ?? "this file"))} from entry ${String(row.entry_id)}.`);
  if (!opts.yes && !(await confirm("Remove this file?"))) {
    console.error("aborted: nothing was removed.");
    return;
  }

  const batch = await createImportBatch(client, { kind: "edit", client: "jetlog-cli", label: `attachments remove ${opts.id}` });
  await putResourceChunked(
    client,
    "entry_attachments",
    [{ id: row.id, entry_id: row.entry_id, attachment_id: row.attachment_id, file_name: row.file_name, is_deleted: true }],
    batch.id
  );
  console.error("Removed 1 file.");
}
