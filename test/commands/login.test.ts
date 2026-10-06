import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, renderQr, shouldPrintQr, type LoginIo } from "../../src/commands/login.js";
import { getProfile } from "../../src/auth/credentials.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

const GRANT = {
  device_code: "dc_1",
  user_code: "WDJB-MJHT",
  verification_uri: "https://jetlog.app/device",
  verification_uri_complete: "https://jetlog.app/device?user_code=WDJB-MJHT",
  expires_in: 900,
  interval: 0.01,
  match_number: 42
};

const TOKEN = {
  access_token: "jlp_minted",
  token_type: "Bearer",
  scope: "read",
  expires_in: 7776000,
  token_id: 7
};

function makeIo(overrides: Partial<LoginIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const io: LoginIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    isTTY: true,
    columns: 120,
    openLink: async (url) => {
      opened.push(url);
    },
    ...overrides
  };
  return { io, out, err, opened };
}

describe("login command", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalExit = process.exitCode;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-login-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    process.exitCode = originalExit;
    await rm(dir, { recursive: true, force: true });
  });

  async function run(
    handlers: ReturnType<typeof jsonHandler>[],
    opts: { qr?: boolean; open?: boolean } = {},
    ioOverrides: Partial<LoginIo> = {}
  ) {
    const server = new TestServer(handlers);
    await server.start();
    const captured = makeIo(ioOverrides);
    try {
      await login({ profile: "default", scope: "read", baseUrl: server.baseUrl, ...opts }, captured.io);
    } finally {
      await server.stop();
    }
    return captured;
  }

  const success = [
    jsonHandler(200, GRANT),
    jsonHandler(400, { error: "authorization_pending" }),
    jsonHandler(400, { error: "authorization_pending", jetlog_viewed: true }),
    jsonHandler(200, TOKEN),
    jsonHandler(200, { user_id: 1, email: "pilot@example.com" })
  ];

  it("prints the QR, number, code and URL on a wide TTY, then stores the token", async () => {
    const { out, err, opened } = await run(success);
    const text = out.join("\n");
    expect(text).toContain("Scan this with your iPhone camera");
    expect(text).toContain("█");
    expect(text).toContain("42");
    expect(text).toContain("WDJB-MJHT");
    expect(text).toContain("https://jetlog.app/device?user_code=WDJB-MJHT");
    expect(text).toContain("Opened in the Jetlog app");
    expect(text).toContain("Logged in as pilot@example.com");
    expect(err).toEqual([]);
    expect(opened).toEqual([]);
    const profile = await getProfile("default");
    expect(profile?.token).toBe("jlp_minted");
  });

  it("skips the QR (but still prints number, code and URL) when stdout is not a TTY", async () => {
    const { out } = await run(success, {}, { isTTY: false });
    const text = out.join("\n");
    expect(text).not.toContain("Scan this with your iPhone camera");
    expect(text).not.toContain("█");
    expect(text).toContain("42");
    expect(text).toContain("WDJB-MJHT");
    expect(text).toContain("https://jetlog.app/device?user_code=WDJB-MJHT");
  });

  it("skips the QR on a terminal that is too narrow", async () => {
    const { out } = await run(success, {}, { columns: 30 });
    expect(out.join("\n")).not.toContain("█");
    expect(out.join("\n")).toContain("42");
  });

  it("skips the QR with --no-qr", async () => {
    const { out } = await run(success, { qr: false });
    expect(out.join("\n")).not.toContain("█");
    expect(out.join("\n")).toContain("WDJB-MJHT");
  });

  it("opens the browser only with --open", async () => {
    const withOpen = await run(success, { open: true });
    expect(withOpen.opened).toEqual([GRANT.verification_uri_complete]);
  });

  it("explains a number mismatch and does not store a token", async () => {
    const { err } = await run([
      jsonHandler(200, GRANT),
      jsonHandler(400, { error: "access_denied", error_description: "number_mismatch" })
    ]);
    expect(err.join("\n")).toContain("didn't match 42");
    expect(process.exitCode).toBe(1);
    expect(await getProfile("default")).toBeUndefined();
  });

  it("reports a plain denial and an expired code", async () => {
    const denied = await run([jsonHandler(200, GRANT), jsonHandler(400, { error: "access_denied" })]);
    expect(denied.err.join("\n")).toContain("denied in the app");
    const expired = await run([jsonHandler(200, GRANT), jsonHandler(400, { error: "expired_token" })]);
    expect(expired.err.join("\n")).toContain("expired");
  });
});

describe("QR helpers", () => {
  it("renders light-on-dark independent QR lines with explicit ANSI colours", () => {
    const { lines, width } = renderQr("https://jetlog.app/device?user_code=WDJB-MJHT");
    expect(width).toBeGreaterThan(20);
    for (const line of lines) {
      expect(line.startsWith("\u001b[40;97m")).toBe(true);
      expect(line.endsWith("\u001b[0m")).toBe(true);
    }
  });

  it("shouldPrintQr needs a TTY, known columns wide enough, and qr enabled", () => {
    expect(shouldPrintQr({ isTTY: true, columns: 100 }, 33, true)).toBe(true);
    expect(shouldPrintQr({ isTTY: true, columns: 100 }, 33, false)).toBe(false);
    expect(shouldPrintQr({ isTTY: false, columns: 100 }, 33, true)).toBe(false);
    expect(shouldPrintQr({ isTTY: true, columns: undefined }, 33, true)).toBe(false);
    expect(shouldPrintQr({ isTTY: true, columns: 38 }, 33, true)).toBe(false);
    expect(shouldPrintQr({ isTTY: true, columns: 41 }, 33, true)).toBe(true);
  });
});
