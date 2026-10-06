/**
 * Uploading a local file as an attachment.
 *
 * The flow is the app's presigned one: declare (kind, sha256, type, size), PUT the bytes to the returned
 * URL, confirm. The file is checked locally first so a bad path or type fails before any network call:
 * regular files only, size under the kind cap, nothing from the CLI config directory or a known secrets
 * directory, and the content type comes from the file's magic bytes, never from its name.
 */
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { configDir } from "../auth/credentials.js";
import { confirmAttachment, createAttachment, putPresigned, type ApiClient, type AttachmentKind } from "../api/client.js";

const MIB = 1024 * 1024;

/** Per-kind size cap and accepted types, the same limits the server enforces. */
export const KIND_LIMITS: Record<AttachmentKind, { maxBytes: number; types: string[] }> = {
  entry_file: { maxBytes: 25 * MIB, types: ["image/png", "image/jpeg", "image/heic", "application/pdf"] },
  person_photo: { maxBytes: 2 * MIB, types: ["image/png", "image/jpeg"] },
  signature: { maxBytes: 5 * MIB, types: ["image/png"] }
};

/** Longest side in pixels the server accepts for a token's signature and photo images (checked at confirm). */
export const MAX_PIXELS: Partial<Record<AttachmentKind, number>> = { signature: 4096, person_photo: 8192 };

/** How much of a JPEG is searched for its size, the same window the server reads. */
const JPEG_SCAN_BYTES = 256 * 1024;

/** Max live files on one entry (server-enforced, checked here for a clearer message). */
export const MAX_ENTRY_FILES = 20;

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

/** The content type for `head` (the first bytes of a file), or undefined when it is none we accept. */
export function sniffContentType(head: Uint8Array): string | undefined {
  const b = Buffer.from(head);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.has(b.subarray(8, 12).toString("latin1"))) {
    return "image/heic";
  }
  return undefined;
}

// SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC), which share the range.
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Width and height of a PNG (IHDR) or JPEG (first SOF segment) from the head of the file, or undefined when unreadable. */
export function imageDimensions(head: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(head);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(12, 16).toString("latin1") === "IHDR") {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
    } else {
      const length = b.readUInt16BE(i + 2);
      if (SOF_MARKERS.has(marker)) {
        if (i + 9 > b.length) return undefined;
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      if (length < 2) return undefined;
      i += 2 + length;
    }
  }
  return undefined;
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Directories no upload may read from: this tool's own credentials and the usual secret stores. */
function forbiddenDirs(): string[] {
  const home = homedir();
  return [configDir(), join(home, ".ssh"), join(home, ".aws"), join(home, ".gnupg"), join(home, ".config")];
}

async function resolveDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

export interface LocalFile {
  /** The resolved path that was checked (symlinks followed). */
  path: string;
  /** Base name of the path the caller gave, used as the default file name. */
  fileName: string;
  byteSize: number;
  contentType: string;
}

/**
 * Checks a local file for upload without reading it whole: resolves the path, refuses forbidden
 * directories, accepts only a regular file (no FIFO, device, socket or directory), enforces the kind's
 * size cap and sniffs the type from the first bytes.
 */
export async function inspectFile(path: string, kind: AttachmentKind): Promise<LocalFile> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new UploadError(`cannot read ${path}: no such file.`);
  }
  for (const dir of forbiddenDirs()) {
    if (isInside(await resolveDir(dir), real)) {
      throw new UploadError(`refusing to upload ${path}: files under ${dir} are never uploaded.`);
    }
  }

  const stats = await lstat(real);
  if (!stats.isFile()) throw new UploadError(`${path} is not a regular file.`);
  const limits = KIND_LIMITS[kind];
  if (stats.size === 0) throw new UploadError(`${path} is empty.`);
  if (stats.size > limits.maxBytes) {
    throw new UploadError(`${path} is too large (${stats.size} bytes, the limit is ${limits.maxBytes / MIB} MiB for this kind of file).`);
  }

  const handle = await open(real, "r");
  let head: Buffer;
  try {
    // Signature and photo images also need their size, which a JPEG states somewhere in its first segments.
    const headBytes = MAX_PIXELS[kind] ? Math.min(stats.size, JPEG_SCAN_BYTES) : 16;
    head = Buffer.alloc(headBytes);
    const { bytesRead } = await handle.read(head, 0, headBytes, 0);
    head = head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const contentType = sniffContentType(head);
  if (!contentType || !limits.types.includes(contentType)) {
    throw new UploadError(`${path} is not a supported file type here (accepted: ${limits.types.join(", ")}).`);
  }
  const maxPixels = MAX_PIXELS[kind];
  const size = maxPixels ? imageDimensions(head) : undefined;
  if (maxPixels && size && (size.width > maxPixels || size.height > maxPixels)) {
    throw new UploadError(`${path} is ${size.width} by ${size.height} pixels, and the limit is ${maxPixels} pixels on each side. Resize the image and try again.`);
  }
  return { path: real, fileName: basename(path), byteSize: stats.size, contentType };
}

export interface UploadResult {
  /** The resolved local path that was read (symlinks followed). */
  path: string;
  attachment_id: string;
  sha256: string;
  content_type: string;
  byte_size: number;
  file_name: string;
  /** True when the server already held this exact content, so no bytes were sent. */
  deduped: boolean;
}

/** Uploads a file already accepted by `inspectFile`. */
export async function uploadInspected(client: ApiClient, kind: AttachmentKind, file: LocalFile): Promise<UploadResult> {
  const bytes = await readFile(file.path);
  if (bytes.length !== file.byteSize) throw new UploadError(`${file.fileName} changed while it was being read, try again.`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const created = await createAttachment(client, { kind, sha256, content_type: file.contentType, byte_size: bytes.length });
  const result: UploadResult = {
    path: file.path,
    attachment_id: created.id,
    sha256,
    content_type: file.contentType,
    byte_size: bytes.length,
    file_name: file.fileName,
    deduped: created.upload === null
  };
  if (created.upload === null) return result;

  await putPresigned(created.upload, bytes);
  await confirmAttachment(client, created.id);
  return result;
}

export async function uploadFile(client: ApiClient, kind: AttachmentKind, path: string): Promise<UploadResult> {
  return uploadInspected(client, kind, await inspectFile(path, kind));
}
