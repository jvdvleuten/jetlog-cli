/**
 * Saving downloaded attachment bytes to disk.
 *
 * The file name comes from the server, so it is never trusted as a path: control and bidirectional
 * characters are removed, only the last path part is kept, the extension is forced to match the content
 * type, and the file is created with the exclusive flag and mode 0600.
 */
import { createHash } from "node:crypto";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { attachmentDownloadUrls, getPresigned, type ApiClient, type AttachmentDownloadUrl } from "../api/client.js";
import { sanitizeForTerminal } from "../commands/output.js";

const EXTENSIONS: Record<string, { canonical: string; accepted: string[] }> = {
  "image/png": { canonical: "png", accepted: ["png"] },
  "image/jpeg": { canonical: "jpg", accepted: ["jpg", "jpeg"] },
  "image/heic": { canonical: "heic", accepted: ["heic"] },
  "application/pdf": { canonical: "pdf", accepted: ["pdf"] }
};

const MAX_NAME_BYTES = 255;

function truncateBytes(text: string, maxBytes: number): string {
  let out = text;
  while (Buffer.byteLength(out, "utf-8") > maxBytes) out = out.slice(0, -1);
  return out;
}

/**
 * A safe local file name for `fileName` and `contentType`: no path parts, no control characters, at most
 * 255 bytes, never hidden, and an extension that matches the content type.
 */
export function safeFileName(fileName: string | undefined, contentType: string, fallbackStem = "attachment"): string {
  const ext = EXTENSIONS[contentType];
  const last = sanitizeForTerminal(fileName ?? "").split(/[\\/]/).pop() ?? "";
  let stem = basename(last).replace(/^[.\s]+/, "").replace(/[<>:"|?*]/g, "_").trim();
  let currentExt = "";
  const dot = stem.lastIndexOf(".");
  if (dot > 0 && stem.length - dot <= 6) {
    currentExt = stem.slice(dot + 1);
    stem = stem.slice(0, dot);
  }
  if (!stem) stem = fallbackStem;
  if (!ext) return truncateBytes(currentExt ? `${stem}.${currentExt}` : stem, MAX_NAME_BYTES);

  const keep = ext.accepted.includes(currentExt.toLowerCase()) ? currentExt : ext.canonical;
  const suffix = `.${keep}`;
  return `${truncateBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(suffix))}${suffix}`;
}

export interface AttachmentMeta {
  attachment_id: string;
  content_type: string;
  file_name?: string;
}

export type SaveTarget =
  /** A generated safe name inside `dir`. An existing file is kept unless `force` is set. */
  | { dir: string; force?: boolean }
  /** An explicit path chosen by the person at the terminal, honoured as given. */
  | { path: string; force?: boolean };

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Writes `bytes` to the target and returns the final path. Never overwrites without `force`. */
export async function saveAttachment(meta: AttachmentMeta, bytes: Uint8Array, target: SaveTarget): Promise<string> {
  const generated = () => safeFileName(meta.file_name, meta.content_type, `attachment-${meta.attachment_id.slice(0, 8)}`);
  let path: string;
  if ("path" in target) {
    path = (await isDirectory(target.path)) ? join(target.path, generated()) : target.path;
  } else {
    path = join(target.dir, generated());
  }

  await mkdir(dirname(path), { recursive: true });
  if (target.force) await unlink(path).catch(() => undefined);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${path} already exists. Pass --force to overwrite it, or -o to pick another path.`);
    }
    throw err;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return path;
}

/**
 * Mints a download URL for one attachment, fetches the bytes and checks them against the stored checksum.
 * Signature images are never served to a token, so that case gets its own message.
 */
export async function fetchAttachment(client: ApiClient, id: string): Promise<{ meta: AttachmentDownloadUrl; bytes: Buffer }> {
  const result = await attachmentDownloadUrls(client, [id]);
  if (result.forbidden?.includes(id)) throw new Error("signature images are not available to tokens.");
  const meta = result.attachments.find((a) => a.id === id);
  if (!meta) {
    if (result.gone?.includes(id)) throw new Error(`attachment ${id} not found.`);
    throw new Error(`attachment ${id} is not available yet (its upload may not be confirmed).`);
  }
  const bytes = await getPresigned(meta.url);
  if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256) {
    throw new Error("the downloaded bytes do not match the stored checksum, nothing was saved.");
  }
  return { meta, bytes };
}

/** The only folder the local MCP server writes downloads to: `JETLOG_DOWNLOAD_DIR`, else `~/Downloads/jetlog`. */
export function downloadRoot(): string {
  const configured = process.env.JETLOG_DOWNLOAD_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), "Downloads", "jetlog");
}

/** A refusal that is safe to show a model as it is. */
export class DownloadRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadRootError";
  }
}

/**
 * Saves downloaded bytes for the local MCP server, where the name comes from a model and so is never a path.
 * The root is created if needed and resolved through symlinks once; the file gets a generated safe name directly
 * inside that resolved folder, so neither `..` nor a symlink inside the root can lead out of it. The file is
 * created with the exclusive flag, which also fails on a symlink already sitting at that name, so nothing is
 * ever overwritten or followed. Returns the final path.
 */
export async function saveInsideRoot(root: string, meta: AttachmentMeta, bytes: Uint8Array, requestedName?: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const name = safeFileName(requestedName ?? meta.file_name, meta.content_type, `attachment-${meta.attachment_id.slice(0, 8)}`);
  const path = join(realRoot, name);

  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DownloadRootError(`${name} already exists in the download folder and is never overwritten. Call again with a different file_name.`);
    }
    throw err;
  }
  try {
    if (dirname(await realpath(path)) !== realRoot) {
      await unlink(path).catch(() => undefined);
      throw new DownloadRootError("refusing to write outside the download folder.");
    }
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return path;
}
