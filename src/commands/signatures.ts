/**
 * `jetlog signatures show|get|attach|attach-many|remove|waive|unwaive|request|revoke`.
 *
 * Every change previews first and asks for confirmation unless `--yes`. Writes of entry rows open one
 * `edit` batch per run. With the `signatures` scope a token can read, attach, replace and remove the signature
 * image of an entry, so the commands check the entry state up front to preview the change and to skip what
 * does not apply. Every change is recorded in the account's audit log. Status and prompts go to stderr,
 * data to stdout.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createImportBatch,
  createSignatureRequest,
  getEntry,
  putResourceChunked,
  revokeSignatureRequest,
  type ApiClient,
  type EntryDetail
} from "../api/client.js";
import { fetchAttachment, saveAttachment } from "../attachments/download.js";
import { inspectFile, uploadInspected, type LocalFile } from "../attachments/upload.js";
import { confirm } from "./confirm.js";
import { requireClient } from "./entries.js";
import { entryLabel, formatBytes, orNotFound, plural } from "./format.js";
import { sanitizeForTerminal } from "./output.js";

interface Common {
  profile: string;
  baseUrl?: string;
}

/** Most entries one signing link made with a token may cover (server-enforced). */
export const MAX_LINK_ENTRIES = 20;

/**
 * Most signatures one `attach-many` run attaches. It is the server's hourly budget for signature changes and
 * also the most rows one write carries, so one run is one write.
 */
export const MAX_ATTACH_PER_RUN = 200;

type SignatureState = "none" | "waived" | "signed" | "unknown";

function stateOf(entry: EntryDetail): SignatureState {
  const s = entry.signature;
  return s === "none" || s === "waived" || s === "signed" ? s : "unknown";
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

async function loadEntries(client: ApiClient, ids: string[]): Promise<EntryDetail[]> {
  const entries: EntryDetail[] = [];
  for (const id of uniqueIds(ids)) entries.push(await orNotFound(`entry ${id}`, () => getEntry(client, id)));
  return entries;
}

function describeEntry(entry: EntryDetail): string {
  return `${entryLabel(entry) || sanitizeForTerminal(String(entry.id))}, signature: ${stateOf(entry)}`;
}

export async function signaturesShow(opts: Common & { entryId: string; json?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entry = await orNotFound(`entry ${opts.entryId}`, () => getEntry(client, opts.entryId));
  const info = {
    entry_id: entry.id,
    signature: stateOf(entry),
    signature_attachment_id: entry.signature_attachment_id ?? null,
    signature_sha256: entry.signature_sha256 ?? null,
    is_bulk: entry.is_bulk ?? null
  };
  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.error(`Entry ${entryLabel(entry)}`);
  console.log(`signature: ${info.signature}`);
  if (info.signature_attachment_id) console.log(`attachment_id: ${sanitizeForTerminal(String(info.signature_attachment_id))}`);
  if (info.signature_sha256) console.log(`sha256: ${sanitizeForTerminal(String(info.signature_sha256))}`);
  if (info.is_bulk === true) console.log("bulk: yes (bulk entries cannot be signed here)");
}

export async function signaturesGet(opts: Common & { entryId: string; output?: string; force?: boolean }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entry = await orNotFound(`entry ${opts.entryId}`, () => getEntry(client, opts.entryId));
  const state = stateOf(entry);
  const attachmentId = entry.signature_attachment_id;
  if (state !== "signed" || typeof attachmentId !== "string" || attachmentId === "") {
    throw new Error(`entry ${describeEntry(entry)}: this entry is not signed, so there is no signature image to download.`);
  }

  const { meta, bytes } = await fetchAttachment(client, attachmentId);
  const path = await saveAttachment(
    { attachment_id: meta.id, content_type: meta.content_type, file_name: `signature-${String(entry.id)}` },
    bytes,
    opts.output ? { path: opts.output, force: opts.force } : { dir: process.cwd(), force: opts.force }
  );
  console.error(`Saved ${formatBytes(bytes.length)} (${meta.content_type}).`);
  console.log(path);
}

export async function signaturesAttach(opts: Common & { entryId: string; image: string; yes?: boolean }): Promise<void> {
  // Local checks first, so a bad file fails before anything is sent.
  const file = await inspectFile(opts.image, "signature");
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entry = await orNotFound(`entry ${opts.entryId}`, () => getEntry(client, opts.entryId));
  const state = stateOf(entry);

  console.error(`Entry ${describeEntry(entry)}`);
  if (entry.is_bulk === true) throw new Error("bulk entries cannot be signed.");

  const described = `${sanitizeForTerminal(file.fileName)} (${file.contentType}, ${formatBytes(file.byteSize)})`;
  const replacing = state === "signed";
  console.error(
    replacing
      ? `Will replace the existing signature with ${described}. This is recorded in your account's audit log.`
      : `Will attach ${described} as the signature. This is recorded in your account's audit log.`
  );
  if (state === "waived") console.error("The waiver on this entry is replaced by the signature.");
  if (!opts.yes && !(await confirm(replacing ? "Replace the existing signature?" : "Attach this signature?"))) {
    console.error("aborted: nothing was changed.");
    return;
  }

  const batch = await createImportBatch(client, { kind: "edit", client: "jetlog-cli", label: `signatures attach ${opts.entryId}` });
  const uploaded = await uploadInspected(client, "signature", file);
  await putResourceChunked(client, "entries", [{ id: opts.entryId, signature_attachment_id: uploaded.attachment_id }], batch.id);
  console.error(replacing ? "Signature replaced." : "Signature attached.");
}

interface AttachItem {
  entryId: string;
  file: string;
}

export interface AttachCandidate<E> {
  item: AttachItem;
  entry: E;
}

export interface AttachDecision<E> {
  /** Items to attach now, in list order. */
  todo: Array<AttachCandidate<E> & { replacing: boolean; waived: boolean }>;
  skipped: Array<AttachCandidate<E> & { reason: string }>;
  /** Items that would be attached but are over the cap, left for a later run. */
  deferred: Array<AttachCandidate<E>>;
}

/** Decides per item, in list order, what happens to it. Pure, so it needs no server. */
export function decideAttachMany<E extends Pick<EntryDetail, "signature" | "is_bulk">>(
  candidates: Array<AttachCandidate<E>>,
  replace: boolean,
  cap: number
): AttachDecision<E> {
  const decision: AttachDecision<E> = { todo: [], skipped: [], deferred: [] };
  for (const candidate of candidates) {
    const state = stateOf(candidate.entry as EntryDetail);
    if (candidate.entry.is_bulk === true) {
      decision.skipped.push({ ...candidate, reason: "bulk entries cannot be signed." });
    } else if (state === "signed" && !replace) {
      decision.skipped.push({ ...candidate, reason: "already signed. Pass --replace to replace the signature." });
    } else if (decision.todo.length >= cap) {
      decision.deferred.push(candidate);
    } else {
      decision.todo.push({ ...candidate, replacing: state === "signed", waived: state === "waived" });
    }
  }
  return decision;
}

async function readAttachList(listPath: string): Promise<AttachItem[]> {
  let raw: string;
  try {
    raw = await readFile(listPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${sanitizeForTerminal(listPath)}: ${sanitizeForTerminal((err as Error).message)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${sanitizeForTerminal(listPath)} is not valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("the list must be a JSON array with at least one {entry_id, file} item.");
  }
  const base = dirname(resolve(listPath));
  const seen = new Set<string>();
  return parsed.map((value: unknown, index) => {
    const item = value as Record<string, unknown> | null;
    const entryId = item?.entry_id;
    const file = item?.file;
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      typeof entryId !== "string" || entryId === "" || typeof file !== "string" || file === ""
    ) {
      throw new Error(`item ${index + 1} of the list needs a non-empty entry_id and file.`);
    }
    if (seen.has(entryId)) throw new Error(`entry ${sanitizeForTerminal(entryId)} is listed more than once.`);
    seen.add(entryId);
    return { entryId, file: resolve(base, file) };
  });
}

export async function signaturesAttachMany(opts: Common & { list: string; replace?: boolean; yes?: boolean }): Promise<void> {
  // Local checks first, so a bad list or file fails before anything is sent.
  const items = await readAttachList(opts.list);
  const files = new Map<string, LocalFile>();
  for (const item of items) files.set(item.entryId, await inspectFile(item.file, "signature"));
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entries = await loadEntries(client, items.map((i) => i.entryId));

  const { todo, skipped, deferred } = decideAttachMany(
    items.map((item, i) => ({ item, entry: entries[i]! })),
    opts.replace === true,
    MAX_ATTACH_PER_RUN
  );
  if (deferred.length > 0) {
    console.error(
      `Only the first ${MAX_ATTACH_PER_RUN} are attached now, because the server allows ${MAX_ATTACH_PER_RUN} signature changes per hour. ` +
        `Run the same command again in an hour for the other ${deferred.length} (entries signed by then are skipped).`
    );
  }

  for (const s of skipped) console.error(`Skipping ${describeEntry(s.entry)}: ${s.reason}`);
  for (const t of todo) {
    const file = files.get(t.item.entryId)!;
    const described = `${sanitizeForTerminal(file.fileName)} (${file.contentType}, ${formatBytes(file.byteSize)})`;
    const action = t.replacing ? `Will replace the existing signature with ${described}.` : `Will attach ${described}.`;
    console.error(`Entry ${describeEntry(t.entry)}. ${action}${t.waived ? " The waiver is replaced by the signature." : ""}`);
  }
  if (todo.length === 0) {
    console.error("nothing to do.");
    return;
  }
  console.error("This is recorded in your account's audit log.");

  const replaced = todo.filter((t) => t.replacing).length;
  const count = plural(todo.length, "signature", "signatures");
  const prompt = replaced > 0 ? `Attach ${count} (${replaced} replace an existing signature)?` : `Attach ${count}?`;
  if (!opts.yes && !(await confirm(prompt))) {
    console.error("aborted: nothing was changed.");
    return;
  }

  const batch = await createImportBatch(client, { kind: "edit", client: "jetlog-cli", label: `signatures attach-many ${todo.length}` });
  const rows: Array<{ id: string; signature_attachment_id: string }> = [];
  for (const [i, t] of todo.entries()) {
    const uploaded = await uploadInspected(client, "signature", files.get(t.item.entryId)!);
    rows.push({ id: t.item.entryId, signature_attachment_id: uploaded.attachment_id });
    if ((i + 1) % 20 === 0 && i + 1 < todo.length) console.error(`Uploaded ${i + 1} of ${todo.length}.`);
  }
  await putResourceChunked(client, "entries", rows, batch.id);
  console.error(`Attached ${count}.${replaced > 0 ? ` ${replaced} replaced an existing signature.` : ""}`);
}

interface WaiveSpec {
  /** Command name, for the batch label. */
  command: "waive" | "unwaive" | "remove";
  /** The state an entry must be in for the change to apply. */
  from: SignatureState;
  /** The fields written for each entry that applies. */
  row: (entry: EntryDetail) => Record<string, unknown>;
  /** Skip bulk entries (they cannot be signed or waived). */
  skipBulk: boolean;
  /** Plain-words reason why an entry in `state` is left alone. */
  skipReason: (state: SignatureState) => string;
  warning: string[];
  prompt: (n: number) => string;
  done: (n: number) => string;
}

async function changeWaiver(opts: Common & { entryIds: string[]; yes?: boolean }, spec: WaiveSpec): Promise<void> {
  if (opts.entryIds.length === 0) throw new Error("pass at least one entry id.");
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entries = await loadEntries(client, opts.entryIds);

  const todo: EntryDetail[] = [];
  for (const entry of entries) {
    const state = stateOf(entry);
    // An entry in an unknown state is sent anyway: the server knows the truth and answers with a clear error.
    if (state === spec.from || state === "unknown") {
      if (spec.skipBulk && entry.is_bulk === true) console.error(`Skipping ${describeEntry(entry)}: bulk entries cannot be signed.`);
      else {
        console.error(`Entry ${describeEntry(entry)}`);
        todo.push(entry);
      }
    } else {
      console.error(`Skipping ${describeEntry(entry)}: ${spec.skipReason(state)}`);
    }
  }
  if (todo.length === 0) {
    console.error("nothing to do.");
    return;
  }

  for (const line of spec.warning) console.error(line);
  if (!opts.yes && !(await confirm(spec.prompt(todo.length)))) {
    console.error("aborted: nothing was changed.");
    return;
  }

  const batch = await createImportBatch(client, { kind: "edit", client: "jetlog-cli", label: `signatures ${spec.command} ${todo.length}` });
  await putResourceChunked(
    client,
    "entries",
    todo.map(spec.row),
    batch.id
  );
  console.error(spec.done(todo.length));
}

export function signaturesWaive(opts: Common & { entryIds: string[]; yes?: boolean }): Promise<void> {
  return changeWaiver(opts, {
    command: "waive",
    from: "none",
    row: (e) => ({ id: e.id, signature_waived: true }),
    skipBulk: true,
    skipReason: (state) => (state === "waived" ? "already waived." : "already signed. Use `signatures attach` to replace the signature."),
    warning: [
      "Waiving records these hours as signed in your own totals. An authority does not accept a waived signature.",
      "A real signature can still be added later and replaces the waiver."
    ],
    prompt: (n) => `Waive the signature on ${plural(n, "entry", "entries")}?`,
    done: (n) => `Waived ${plural(n, "entry", "entries")}.`
  });
}

export function signaturesUnwaive(opts: Common & { entryIds: string[]; yes?: boolean }): Promise<void> {
  return changeWaiver(opts, {
    command: "unwaive",
    from: "waived",
    row: (e) => ({ id: e.id, signature_waived: false }),
    skipBulk: false,
    skipReason: (state) => (state === "none" ? "not waived." : "signed, not waived."),
    warning: ["The entries go back to unsigned."],
    prompt: (n) => `Undo the waiver on ${plural(n, "entry", "entries")}?`,
    done: (n) => `Undid the waiver on ${plural(n, "entry", "entries")}.`
  });
}

export function signaturesRemove(opts: Common & { entryIds: string[]; yes?: boolean }): Promise<void> {
  return changeWaiver(opts, {
    command: "remove",
    from: "signed",
    row: (e) => ({ id: e.id, signature_attachment_id: null }),
    skipBulk: false,
    skipReason: (state) => (state === "waived" ? "waived, not signed. Use `signatures unwaive` to undo a waiver." : "not signed."),
    warning: [
      "The signature image is removed from these entries and they go back to unsigned.",
      "This is recorded in your account's audit log."
    ],
    prompt: (n) => `Remove the signature from ${plural(n, "entry", "entries")}?`,
    done: (n) => `Removed the signature from ${plural(n, "entry", "entries")}.`
  });
}

export async function signaturesRequest(opts: Common & { entryIds: string[]; yes?: boolean }): Promise<void> {
  const ids = uniqueIds(opts.entryIds);
  if (ids.length === 0) throw new Error("pass at least one entry id.");
  if (ids.length > MAX_LINK_ENTRIES) {
    throw new Error(`a signing link made with a token covers at most ${MAX_LINK_ENTRIES} entries, and ${ids.length} were given.`);
  }
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entries = await loadEntries(client, ids);

  const blocked = entries.filter((e) => stateOf(e) === "signed" || e.is_bulk === true);
  if (blocked.length > 0) {
    for (const entry of blocked) {
      console.error(`${describeEntry(entry)}: ${entry.is_bulk === true ? "bulk entries cannot be signed." : "already signed."}`);
    }
    throw new Error("these entries cannot be signed through a link. Leave them out and try again.");
  }

  console.error(`${plural(entries.length, "entry", "entries")}: ${entries.map((e) => entryLabel(e) || sanitizeForTerminal(String(e.id))).join(", ")}`);
  console.error("Anyone who has the link can sign these entries for 48 hours. It shows them your email address and these flights.");
  if (!opts.yes && !(await confirm("Create the signing link?"))) {
    console.error("aborted: no link was created.");
    return;
  }

  const request = await createSignatureRequest(client, entries.map((e) => e.id));
  console.log(sanitizeForTerminal(request.url));
  console.error(
    `Request id ${sanitizeForTerminal(request.id)}, expires ${sanitizeForTerminal(request.expires_at)}. ` +
      `Revoke with: jetlog signatures revoke ${sanitizeForTerminal(request.id)}`
  );
}

export async function signaturesRevoke(opts: Common & { requestId: string }): Promise<void> {
  const client = await requireClient(opts.profile, opts.baseUrl);
  await orNotFound(`signing request ${opts.requestId} (a login can only revoke links it created itself)`, () =>
    revokeSignatureRequest(client, opts.requestId)
  );
  console.error("Signing link revoked.");
}
