import type { Entry, Payload, Person } from "./schema.js";

export type DeeplinkScheme = "https" | "jetlog";

export interface BuildDeeplinksOptions {
  scheme?: DeeplinkScheme;
  maxLength?: number;
}

function baseUrl(scheme: DeeplinkScheme): string {
  return scheme === "jetlog" ? "jetlog://import?data=" : "https://jetlog.app/import?data=";
}

function encode(payload: Payload): string {
  return JSON.stringify(payload);
}

function buildUrl(scheme: DeeplinkScheme, payload: Payload): string {
  return baseUrl(scheme) + encodeURIComponent(encode(payload));
}

/**
 * Every person ref_id an entry touches, so a chunk that includes the
 * entry also includes the people it needs (SELF never needs a people
 * entry and is skipped).
 */
function refIdsForEntry(entry: Entry): string[] {
  return (entry.people ?? [])
    .map((p) => p.ref_id)
    .filter((refId) => refId.toUpperCase() !== "SELF");
}

/**
 * Splits a payload into one or more deeplinks, each under maxLength
 * characters, while keeping every entry's referenced people in the same
 * chunk as that entry. Chunking is greedy: entries are added to the
 * current chunk until adding the next one (plus its people) would
 * overflow, at which point a new chunk starts. A single entry whose own
 * encoded size (with its people) exceeds maxLength is still emitted
 * alone, since it cannot be split further.
 */
export function buildImportLinks(
  payload: Payload,
  options: BuildDeeplinksOptions = {}
): string[] {
  const scheme = options.scheme ?? "https";
  const maxLength = options.maxLength ?? 6000;
  const entries = payload.entries ?? [];
  const peopleById = new Map<string, Person>();
  for (const person of payload.people ?? []) {
    peopleById.set(person.ref_id, person);
  }

  if (entries.length === 0) {
    return [buildUrl(scheme, { entries: [], people: payload.people ?? [] })];
  }

  const chunks: { entries: Entry[]; refIds: Set<string> }[] = [];
  let current: { entries: Entry[]; refIds: Set<string> } = { entries: [], refIds: new Set() };

  function chunkPayload(chunk: { entries: Entry[]; refIds: Set<string> }): Payload {
    const people = [...chunk.refIds]
      .map((refId) => peopleById.get(refId))
      .filter((p): p is Person => Boolean(p));
    return { entries: chunk.entries, people };
  }

  function chunkLength(chunk: { entries: Entry[]; refIds: Set<string> }): number {
    return buildUrl(scheme, chunkPayload(chunk)).length;
  }

  for (const entry of entries) {
    const entryRefIds = refIdsForEntry(entry);
    const candidate = {
      entries: [...current.entries, entry],
      refIds: new Set([...current.refIds, ...entryRefIds])
    };

    if (current.entries.length > 0 && chunkLength(candidate) > maxLength) {
      chunks.push(current);
      current = {
        entries: [entry],
        refIds: new Set(entryRefIds)
      };
    } else {
      current = candidate;
    }
  }
  if (current.entries.length > 0) {
    chunks.push(current);
  }

  return chunks.map((chunk) => buildUrl(scheme, chunkPayload(chunk)));
}

export async function openLink(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
