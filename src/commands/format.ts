/** Small formatting helpers shared by the attachment commands. */
import { ApiError, type EntryDetail } from "../api/client.js";
import { sanitizeForTerminal } from "./output.js";

/** "212 kB", "1.8 MB": decimal units, one decimal from MB up. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** "2026-10-01 KL1234 AMS to LHR", from whatever of those the entry carries. */
export function entryLabel(entry: EntryDetail): string {
  const route = entry.from && entry.to ? `${entry.from} to ${entry.to}` : "";
  return sanitizeForTerminal([entry.date, entry.flight_number, route].filter((p) => typeof p === "string" && p !== "").join(" "));
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Turns a 404 from a lookup into a message naming what was not found. */
export async function orNotFound<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw new Error(`${what} not found.`);
    throw err;
  }
}
