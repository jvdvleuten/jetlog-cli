/**
 * The "a newer jetlog-cli is available" notice.
 *
 * The backend sends `x-jetlog-cli-latest: <version>` on every response to a `jetlog-cli/<version>` user agent.
 * `ApiClient` hands that header to `observeLatestVersion`, which keeps the last valid version seen in this
 * process and remembers it in `<config dir>/update-notice.json`.
 *
 * - A terminal command prints the notice once on stderr after it finished (`printUpdateNoticeIfDue`), at most
 *   once a day across runs.
 * - `jetlog mcp` never writes it to a stream. The MCP server puts it into its instructions (from the stored
 *   version, known at startup) and appends it to the first tool result once it is known (`mcp.ts`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./auth/credentials.js";
import { VERSION } from "./version.js";

/** Hours between two terminal notices. */
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,32}))?(?:\+[0-9A-Za-z.-]{1,32})?$/;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = SEMVER.exec(value);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : []
  };
}

function comparePrereleaseIds(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver order: -1, 0 or 1. Undefined when either side is not a full semver version. */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return Math.sign(pa.core[i]! - pb.core[i]!);
  }
  // A prerelease sorts before its release; otherwise compare identifier by identifier.
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    return Math.sign(pb.prerelease.length - pa.prerelease.length);
  }
  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const c = comparePrereleaseIds(pa.prerelease[i]!, pb.prerelease[i]!);
    if (c !== 0) return c;
  }
  return Math.sign(pa.prerelease.length - pb.prerelease.length);
}

/** True when `latest` is a valid version above `current`. */
export function isNewer(latest: string, current: string = VERSION): boolean {
  return compareVersions(latest, current) === 1;
}

export function updateNoticeText(latest: string, current: string = VERSION): string {
  return `jetlog-cli ${latest} is available, you have ${current}. Run npm i -g jetlog-cli@latest`;
}

interface NoticeState {
  /** The last `x-jetlog-cli-latest` seen. */
  latest?: string;
  /** When the terminal notice was last printed (ISO 8601). */
  last_notice_at?: string;
}

export function updateNoticeStatePath(): string {
  return join(configDir(), "update-notice.json");
}

async function readState(): Promise<NoticeState> {
  try {
    const parsed = JSON.parse(await readFile(updateNoticeStatePath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const raw = parsed as Record<string, unknown>;
    return {
      latest: typeof raw.latest === "string" && parseVersion(raw.latest) ? raw.latest : undefined,
      last_notice_at: typeof raw.last_notice_at === "string" ? raw.last_notice_at : undefined
    };
  } catch {
    return {};
  }
}

async function writeState(state: NoticeState): Promise<void> {
  const path = updateNoticeStatePath();
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // The notice is a convenience: a read-only config folder must not fail the command.
  }
}

let latestSeen: string | undefined;
let pendingWrite: Promise<void> = Promise.resolve();
/** Set by a 426: the server already told the user to update, so the notice would only repeat it. */
let suppressed = false;

/**
 * Records an `x-jetlog-cli-latest` header value. Ignores anything that is not a full semver version (the value
 * reaches a terminal and a model). The server is the authority, so the last value wins, also when it went down
 * (a pulled release). A changed value is stored in the background; `settleUpdateNotice` waits for that write.
 */
export function observeLatestVersion(header: string | null | undefined): void {
  if (!header) return;
  const value = header.trim();
  if (!parseVersion(value) || value === latestSeen) return;
  latestSeen = value;
  pendingWrite = pendingWrite.then(async () => {
    const state = await readState();
    if (state.latest !== value) await writeState({ ...state, latest: value });
  });
}

/** The server refused this version (HTTP 426) and its own message already says how to update. */
export function suppressUpdateNotice(): void {
  suppressed = true;
}

/** The last version seen in this process, if any. */
export function latestVersionSeen(): string | undefined {
  return latestSeen;
}

/** Waits for a background state write (tests, and before the process exits). */
export function settleUpdateNotice(): Promise<void> {
  return pendingWrite;
}

/** Forgets what this process has seen. For tests. */
export function resetUpdateNotice(): void {
  latestSeen = undefined;
  suppressed = false;
  pendingWrite = Promise.resolve();
}

/**
 * The notice for this process, from a version seen in this run or (with `useStored`) the stored one.
 * Undefined when nothing newer is known or a 426 already said it.
 */
export async function currentUpdateNotice(opts: { useStored?: boolean; current?: string } = {}): Promise<string | undefined> {
  if (suppressed) return undefined;
  const current = opts.current ?? VERSION;
  const latest = latestSeen ?? (opts.useStored ? (await readState()).latest : undefined);
  return latest !== undefined && isNewer(latest, current) ? updateNoticeText(latest, current) : undefined;
}

/**
 * The terminal path: prints the notice on stderr when this run saw a newer version and no notice was printed in
 * the last 24 hours. `now` and `log` are injectable for tests.
 */
export async function printUpdateNoticeIfDue(
  opts: { now?: Date; log?: (line: string) => void; current?: string } = {}
): Promise<boolean> {
  await settleUpdateNotice();
  const notice = await currentUpdateNotice({ current: opts.current });
  if (!notice) return false;
  const now = opts.now ?? new Date();
  const state = await readState();
  const last = state.last_notice_at ? Date.parse(state.last_notice_at) : Number.NaN;
  // A timestamp in the future (clock moved back) counts as due, so the notice cannot be silenced for good.
  if (Number.isFinite(last) && last <= now.getTime() && now.getTime() - last < NOTICE_INTERVAL_MS) return false;
  (opts.log ?? ((line: string) => console.error(line)))(notice);
  await writeState({ ...state, last_notice_at: now.toISOString() });
  return true;
}
