/**
 * Tiny shared ZIP-reading helper for the two importers that need it
 * (`jetlog-csv`'s archive support and `pilotlog`'s zipped
 * mccPILOTLOG backup support).
 *
 * The iOS app reads both ZIP shapes via a third-party zip library:
 * unzip-to-temp-dir, then scan the resulting
 * file tree. There's no bespoke parsing logic beyond that directory scan
 * (see each importer's own file doc comment for its scan strategy); the
 * actual inflate/ZIP-container work is delegated here to `fflate`
 * (`unzipSync`), a small, zero-dependency, MIT-licensed library, chosen over heavier
 * alternatives (adm-zip/jszip/yauzl).
 */
import { unzipSync } from "fflate";

/** True for a PK\x03\x04 local-file-header signature, the standard ZIP
 * magic bytes, same check used by `pilotlog.ts`'s existing `looksLikeZip`. */
export function looksLikeZip(buffer: Buffer | Uint8Array): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** Unzips into a `{ path: bytes }` map, in the ZIP's own central-directory
 * order (insertion order of the returned object), directories themselves
 * are omitted (zero-length entries whose path ends in `/`). Throws on a
 * corrupt/non-ZIP buffer; callers should check `looksLikeZip` first when
 * they need a non-throwing "is this even a zip" check. */
export function unzipEntries(buffer: Buffer | Uint8Array): Record<string, Uint8Array> {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = unzipSync(data);
  const result: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith("/")) continue;
    result[path] = bytes;
  }
  return result;
}

/** Decodes a ZIP entry's bytes as UTF-8 text, stripping a leading BOM,
 * mirrors `CSVLogbookArchive`'s lenient text-reading fallback chain
 * (UTF-8 first, then auto-detected encoding, then raw bytes; BOM always
 * stripped so the header row's first cell still matches by name). This port
 * only implements the UTF-8 path: every fixture/export seen is UTF-8, and a
 * non-UTF-8 CSV export is rare enough that a clearer future fix is "decode
 * failed, pick an explicit encoding" rather than guessing one here. */
export function decodeZipText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").replace(/^﻿/, "");
}
