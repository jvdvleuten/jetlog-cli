/**
 * Local credential storage for `jetlog login`/`logout`/`whoami`.
 *
 * File: `<config dir>/jetlog/credentials.json`, mode 0600 (dir 0700).
 * Config dir resolution (XDG-aware, Windows-aware):
 *   - `XDG_CONFIG_HOME` if set
 *   - `%APPDATA%` on win32
 *   - `~/.config` everywhere else
 *
 * Multiple named profiles live in one file (`--profile <name>`, default
 * "default"). `JETLOG_TOKEN` always overrides whatever is on disk for the
 * active profile, it never gets written back to the file.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

export interface StoredProfile {
  token: string;
  baseUrl?: string;
  scope?: string;
  tokenId?: string | number;
  userId?: string | number;
  email?: string | null;
  createdAt?: string;
}

interface CredentialsFile {
  profiles: Record<string, StoredProfile>;
}

export const DEFAULT_PROFILE = "default";

export function configDir(): string {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "jetlog");
  if (platform() === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "jetlog");
  return join(homedir(), ".config", "jetlog");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

async function readCredentialsFile(): Promise<CredentialsFile> {
  try {
    const raw = await readFile(credentialsPath(), "utf-8");
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (!parsed.profiles || typeof parsed.profiles !== "object") return { profiles: {} };
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw err;
  }
}

async function writeCredentialsFile(data: CredentialsFile): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  // mkdir's `mode` is only honored on creation; chmod explicitly in case
  // the directory already existed with looser permissions, same for the
  // file (umask can widen the writeFile mode).
  await chmod(dirname(path), 0o700).catch(() => {});
  await chmod(path, 0o600).catch(() => {});
}

/** The stored profile, or undefined if not logged in. Ignores JETLOG_TOKEN. */
export async function getProfile(profile = DEFAULT_PROFILE): Promise<StoredProfile | undefined> {
  const data = await readCredentialsFile();
  return data.profiles[profile];
}

export async function saveProfile(profile: string, data: StoredProfile): Promise<void> {
  const file = await readCredentialsFile();
  file.profiles[profile] = data;
  await writeCredentialsFile(file);
}

export async function deleteProfile(profile: string): Promise<boolean> {
  const file = await readCredentialsFile();
  if (!(profile in file.profiles)) return false;
  delete file.profiles[profile];
  await writeCredentialsFile(file);
  return true;
}

export async function listProfiles(): Promise<string[]> {
  const file = await readCredentialsFile();
  return Object.keys(file.profiles);
}

/**
 * Resolves the bearer token to use: `JETLOG_TOKEN` env var wins over
 * whatever is stored on disk for `profile`.
 */
export async function resolveToken(profile = DEFAULT_PROFILE): Promise<string | undefined> {
  if (process.env.JETLOG_TOKEN) return process.env.JETLOG_TOKEN;
  const stored = await getProfile(profile);
  return stored?.token;
}

/** Base URL for a profile: explicit --base-url / JETLOG_BASE_URL wins, then the stored value. */
export async function resolveBaseUrl(profile = DEFAULT_PROFILE): Promise<string | undefined> {
  if (process.env.JETLOG_BASE_URL) return process.env.JETLOG_BASE_URL;
  const stored = await getProfile(profile);
  return stored?.baseUrl;
}

/**
 * The scope recorded for `profile` at `jetlog login` time (e.g. "read" or
 * "read write"), best-effort only: a `JETLOG_TOKEN` override has no
 * associated scope on disk, so this returns `undefined` in that case.
 * Callers that need to gate a write-only feature on scope should treat
 * `undefined` as "unknown", not as "read-only".
 */
export async function resolveScope(profile = DEFAULT_PROFILE): Promise<string | undefined> {
  const stored = await getProfile(profile);
  return stored?.scope;
}
