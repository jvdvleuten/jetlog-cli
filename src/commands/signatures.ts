/**
 * `jetlog signatures show|attach|waive|unwaive|request|revoke`.
 *
 * Every change previews first and asks for confirmation unless `--yes`. Writes of entry rows open one
 * `edit` batch per run. A token can attach a signature image only to an unsigned or waived entry, and can
 * never replace or remove one, so the commands check the entry state up front and skip or refuse what the
 * server would reject anyway. Status and prompts go to stderr, data to stdout.
 */
import {
  createImportBatch,
  createSignatureRequest,
  getEntry,
  putResourceChunked,
  revokeSignatureRequest,
  type ApiClient,
  type EntryDetail
} from "../api/client.js";
import { inspectFile, uploadInspected } from "../attachments/upload.js";
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

export async function signaturesAttach(opts: Common & { entryId: string; image: string; yes?: boolean }): Promise<void> {
  // Local checks first, so a bad file fails before anything is sent.
  const file = await inspectFile(opts.image, "signature");
  const client = await requireClient(opts.profile, opts.baseUrl);
  const entry = await orNotFound(`entry ${opts.entryId}`, () => getEntry(client, opts.entryId));
  const state = stateOf(entry);

  console.error(`Entry ${describeEntry(entry)}`);
  if (state === "signed") {
    throw new Error("this entry is already signed. A token cannot replace or remove a signature, only the app can.");
  }
  if (entry.is_bulk === true) throw new Error("bulk entries cannot be signed.");

  console.error(
    `Will attach ${sanitizeForTerminal(file.fileName)} (${file.contentType}, ${formatBytes(file.byteSize)}) as the signature. ` +
      "This is recorded in your account's audit log."
  );
  if (state === "waived") console.error("The waiver on this entry is replaced by the signature.");
  console.error("A token cannot replace or remove a signature once it is set.");
  if (!opts.yes && !(await confirm("Attach this signature?"))) {
    console.error("aborted: nothing was changed.");
    return;
  }

  const batch = await createImportBatch(client, { kind: "edit", client: "jetlog-cli", label: `signatures attach ${opts.entryId}` });
  const uploaded = await uploadInspected(client, "signature", file);
  await putResourceChunked(client, "entries", [{ id: opts.entryId, signature_attachment_id: uploaded.attachment_id }], batch.id);
  console.error("Signature attached.");
}

interface WaiveSpec {
  /** Command name, for the batch label. */
  command: "waive" | "unwaive";
  /** The state an entry must be in for the change to apply. */
  from: SignatureState;
  value: boolean;
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
      if (spec.value && entry.is_bulk === true) console.error(`Skipping ${describeEntry(entry)}: bulk entries cannot be signed.`);
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
    todo.map((e) => ({ id: e.id, signature_waived: spec.value })),
    batch.id
  );
  console.error(spec.done(todo.length));
}

export function signaturesWaive(opts: Common & { entryIds: string[]; yes?: boolean }): Promise<void> {
  return changeWaiver(opts, {
    command: "waive",
    from: "none",
    value: true,
    skipReason: (state) => (state === "waived" ? "already waived." : "already signed, and a token cannot replace a signature."),
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
    value: false,
    skipReason: (state) => (state === "none" ? "not waived." : "signed, not waived."),
    warning: ["The entries go back to unsigned."],
    prompt: (n) => `Undo the waiver on ${plural(n, "entry", "entries")}?`,
    done: (n) => `Undid the waiver on ${plural(n, "entry", "entries")}.`
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
