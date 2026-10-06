import { ApiClient, DEFAULT_BASE_URL, type MeResponse } from "../api/client.js";
import { startDeviceAuthorization, pollDeviceToken, DeviceFlowError } from "../auth/device-flow.js";
import { saveProfile } from "../auth/credentials.js";
import { openLink } from "../deeplink.js";
import { renderUnicodeCompact } from "uqr";

export interface LoginOptions {
  profile: string;
  scope: "read" | "write";
  baseUrl?: string;
  /** Print the terminal QR code when the terminal is wide enough (default true; `--no-qr` turns it off). */
  qr?: boolean;
  /** Open verification_uri_complete in a browser (default false; the page would only show the same QR). */
  open?: boolean;
}

/** Output and environment hooks, so tests can drive `login` without a real terminal. */
export interface LoginIo {
  out: (line: string) => void;
  err: (line: string) => void;
  isTTY: boolean;
  columns: number | undefined;
  openLink: (url: string) => Promise<void>;
}

const defaultIo: LoginIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  get isTTY() {
    return Boolean(process.stdout.isTTY);
  },
  get columns() {
    return process.stdout.columns;
  },
  openLink
};

const QR_INDENT = "      ";
/** Room left of the QR (indent) plus a little slack so a wrapped line never breaks the code. */
const QR_MARGIN = QR_INDENT.length + 2;

/**
 * Renders `url` as a QR code made of half-block characters.
 *
 * uqr draws light modules as full blocks and dark modules as spaces, which
 * only scans on a dark terminal. Each line is wrapped in explicit ANSI
 * colours (white foreground on black background) so the code is the same
 * black-on-white image on a light or a dark terminal theme.
 */
export function renderQr(url: string): { lines: string[]; width: number } {
  const raw = renderUnicodeCompact(url, { border: 2 }).split("\n");
  const width = Math.max(...raw.map((line) => line.length));
  return { lines: raw.map((line) => `\u001b[40;97m${line}\u001b[0m`), width };
}

/** True only for an interactive terminal that is wide enough for the code. */
export function shouldPrintQr(io: Pick<LoginIo, "isTTY" | "columns">, width: number, qr: boolean): boolean {
  return qr && io.isTTY && io.columns !== undefined && io.columns >= width + QR_MARGIN;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The scopes a login asks for. `files` (download, and upload with `write`) and `signatures` (with
 * `write`) are separate grants, so a login made before they existed keeps exactly its old powers.
 * A read login asks for `files` only: the signatures permission comes with the write login.
 */
export function loginScopes(scope: "read" | "write"): string {
  return scope === "write" ? "read write files signatures" : "read files";
}

export async function login(opts: LoginOptions, io: LoginIo = defaultIo): Promise<void> {
  const baseUrl = opts.baseUrl ?? process.env.JETLOG_BASE_URL ?? DEFAULT_BASE_URL;
  const client = new ApiClient({ baseUrl });
  const scope = loginScopes(opts.scope);

  const grant = await startDeviceAuthorization({ client, scope });
  const matchNumber = grant.match_number;

  io.out("");
  io.out("  Sign in to Jetlog");
  io.out("");

  const qr = renderQr(grant.verification_uri_complete);
  if (shouldPrintQr(io, qr.width, opts.qr ?? true)) {
    io.out("  Scan this with your iPhone camera:");
    io.out("");
    for (const line of qr.lines) io.out(QR_INDENT + line);
    io.out("");
  }

  io.out(`  Then pick this number in the Jetlog app:   ${matchNumber}`);
  io.out("");
  io.out(`  No camera? Open ${grant.verification_uri} and enter ${grant.user_code}`);
  io.out("  (or in the app: Settings > Connected Apps > enter code)");
  io.out(`  Link:   ${grant.verification_uri_complete}`);
  io.out("");

  if (opts.open) {
    try {
      await io.openLink(grant.verification_uri_complete);
    } catch {
      io.err(`Couldn't open a browser automatically. Open the link above instead.`);
    }
  }

  io.out(`  Waiting for approval... (expires in ${formatDuration(grant.expires_in)}, number ${matchNumber})`);

  const abortController = new AbortController();
  const onSigint = () => {
    io.err("\nlogin cancelled");
    abortController.abort();
  };
  process.once("SIGINT", onSigint);

  let token;
  try {
    token = await pollDeviceToken({
      client,
      deviceCode: grant.device_code,
      intervalSeconds: grant.interval,
      expiresInSeconds: grant.expires_in,
      matchNumber,
      signal: abortController.signal,
      onViewed: () => io.out("  Opened in the Jetlog app, waiting for you to approve...")
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    if (err instanceof DeviceFlowError) {
      io.err(`error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  const authedClient = new ApiClient({ baseUrl, token: token.access_token });
  let me: MeResponse | undefined;
  try {
    me = await authedClient.get<MeResponse>("/api/cli/v1/me");
  } catch {
    // Not fatal, the token itself is what matters. `whoami` can retry this.
  }

  await saveProfile(opts.profile, {
    token: token.access_token,
    baseUrl: opts.baseUrl ? baseUrl : undefined,
    scope: token.scope,
    tokenId: token.token_id,
    userId: me?.user_id,
    email: me?.email ?? undefined,
    createdAt: new Date().toISOString()
  });

  io.out(`Logged in${me?.email ? ` as ${me.email}` : ""} (scope: ${token.scope}, profile: ${opts.profile}).`);
}
