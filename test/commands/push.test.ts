import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  PARTNER_MIGRATION_URL,
  PUSH_DEPRECATION_NOTICE,
  PUSH_DESCRIPTION,
  runPush
} from "../../src/commands/push.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

const execFileAsync = promisify(execFile);

function flight(n: number) {
  return { date: "2026-08-14", flight_number: `KL${1000 + n}`, from: "EHAM", to: "EGLL" };
}

describe("push command (deprecated)", () => {
  const originalUserKey = process.env.JETLOG_USER_KEY;
  const originalPartnerKey = process.env.JETLOG_PARTNER_KEY;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.JETLOG_USER_KEY = "user-key";
    process.env.JETLOG_PARTNER_KEY = "partner-key";
    process.exitCode = undefined;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = undefined;
    if (originalUserKey === undefined) delete process.env.JETLOG_USER_KEY;
    else process.env.JETLOG_USER_KEY = originalUserKey;
    if (originalPartnerKey === undefined) delete process.env.JETLOG_PARTNER_KEY;
    else process.env.JETLOG_PARTNER_KEY = originalPartnerKey;
  });

  it("states the deprecation in one plain line that points at the migration guide", () => {
    expect(PUSH_DEPRECATION_NOTICE).toContain(PARTNER_MIGRATION_URL);
    expect(PUSH_DEPRECATION_NOTICE.toLowerCase()).toContain("deprecated");
    expect(PUSH_DEPRECATION_NOTICE).not.toContain("\n");
    expect(PUSH_DEPRECATION_NOTICE).not.toMatch(/[–—]/);
    expect(PUSH_DESCRIPTION).toMatch(/^Deprecated/);
    expect(PUSH_DESCRIPTION).toContain(PARTNER_MIGRATION_URL);
  });

  it("prints the notice on stderr only, once, and keeps stdout to the command's own output", async () => {
    await runPush(JSON.stringify({ entries: [flight(1)], people: [] }), { baseUrl: "http://unused.invalid", dryRun: true });

    expect(errorSpy.mock.calls.map((c) => c[0])).toEqual([PUSH_DEPRECATION_NOTICE]);
    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(["valid: 1 entries, dry run, nothing sent"]);
  });

  it("still sends the payload to the key route with the key pair, one notice for several batches", async () => {
    const server = new TestServer([
      jsonHandler(200, { data: "OK", skipped: [] }),
      jsonHandler(200, { data: "OK", skipped: [] })
    ]);
    await server.start();
    try {
      const entries = Array.from({ length: 501 }, (_, i) => flight(i));
      await runPush(JSON.stringify({ entries, people: [] }), { baseUrl: server.baseUrl });

      expect(server.requests).toHaveLength(2);
      for (const request of server.requests) {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/external/v1/import");
        expect(request.headers.authorization).toBe("Bearer user-key:partner-key");
      }
      expect(errorSpy.mock.calls.map((c) => c[0])).toEqual([PUSH_DEPRECATION_NOTICE]);
      expect(logSpy.mock.calls.map((c) => c[0])).toEqual(["batch 1: OK", "batch 2: OK"]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("warns before it complains about missing keys", async () => {
    delete process.env.JETLOG_PARTNER_KEY;
    await runPush(JSON.stringify({ entries: [flight(1)], people: [] }), { baseUrl: "http://unused.invalid" });

    expect(errorSpy.mock.calls.map((c) => c[0])).toEqual([
      PUSH_DEPRECATION_NOTICE,
      "error: JETLOG_USER_KEY and JETLOG_PARTNER_KEY must be set"
    ]);
    expect(process.exitCode).toBe(1);
  });

  // The wiring in src/cli.ts, through the real program: the notice must reach stderr
  // and never stdout, and --help must say the command is deprecated.
  describe("the jetlog program", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "jetlog-cli-push-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const run = (args: string[]) =>
      execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env: { ...process.env, NO_COLOR: "1" } });

    it("push --dry-run writes the notice to stderr and nothing like it to stdout", async () => {
      const file = join(dir, "payload.json");
      await writeFile(file, JSON.stringify({ entries: [flight(1)], people: [] }));

      const { stdout, stderr } = await run(["push", file, "--dry-run"]);

      expect(stderr.trim()).toBe(PUSH_DEPRECATION_NOTICE);
      expect(stdout.trim()).toBe("valid: 1 entries, dry run, nothing sent");
    }, 30_000);

    it("push --help and the command list say it is deprecated", async () => {
      const help = await run(["push", "--help"]);
      expect(help.stdout).toContain("Deprecated");
      expect(help.stdout).toContain(PARTNER_MIGRATION_URL);

      const list = await run(["--help"]);
      expect(list.stdout).toMatch(/push .*Deprecated/);
    }, 30_000);
  });
});
