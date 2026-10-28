import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiClient, ApiError, UPGRADE_REQUIRED_MESSAGE, proposeChanges } from "../src/api/client.js";
import {
  compareVersions,
  currentUpdateNotice,
  latestVersionSeen,
  observeLatestVersion,
  printUpdateNoticeIfDue,
  resetUpdateNotice,
  settleUpdateNotice,
  updateNoticeStatePath,
  updateNoticeText
} from "../src/update-notice.js";
import { createMcpServer } from "../src/mcp.js";
import { VERSION } from "../src/version.js";
import { TestServer, jsonHandler } from "./helpers/test-server.js";

const NEWER = "99.0.0";
const LATEST_HEADER = { "x-jetlog-cli-latest": NEWER };
const UPGRADE_BODY = {
  error: "jetlog-cli 0.1.9 is no longer supported. Run npm i -g jetlog-cli@latest to update.",
  minimum_cli_version: "0.2.0",
  latest_cli_version: "0.2.1"
};

let dir: string;
const originalXdg = process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jetlog-cli-update-notice-"));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.JETLOG_TOKEN;
  delete process.env.JETLOG_BASE_URL;
  resetUpdateNotice();
});

afterEach(async () => {
  await settleUpdateNotice();
  resetUpdateNotice();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  delete process.env.JETLOG_TOKEN;
  delete process.env.JETLOG_BASE_URL;
  await rm(dir, { recursive: true, force: true });
});

/** A test server answering with `responses` in order, each `[status, body, headers?]`. */
async function withServer<T>(responses: Parameters<typeof jsonHandler>[], fn: (s: TestServer) => Promise<T>): Promise<T> {
  const server = new TestServer(responses.map((r) => jsonHandler(...r)));
  await server.start();
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

async function storedState(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(updateNoticeStatePath(), "utf8")) as Record<string, unknown>;
}

describe("compareVersions", () => {
  it("orders by semver, prereleases before their release", () => {
    expect(compareVersions("0.2.1", "0.2.0")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.1")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0-beta.2", "0.2.0-beta.10")).toBe(-1);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBe(-1);
    expect(compareVersions("0.2.0+build.5", "0.2.0")).toBe(0);
  });

  it("is undefined for anything that is not a full version", () => {
    expect(compareVersions("0.2", "0.2.0")).toBeUndefined();
    expect(compareVersions("dev", "0.2.0")).toBeUndefined();
    expect(compareVersions("0.2.1\u001b[31m", "0.2.0")).toBeUndefined();
  });
});

describe("x-jetlog-cli-latest", () => {
  it("is read from every response and stored in the config folder", async () => {
    await withServer([[200, { ok: true }, LATEST_HEADER]], async (server) => {
      await new ApiClient({ baseUrl: server.baseUrl, token: "t" }).get("/api/cli/v1/me");
    });
    expect(latestVersionSeen()).toBe(NEWER);
    await settleUpdateNotice();
    expect(await storedState()).toEqual({ latest: NEWER });
  });

  it("is read from error responses and from getWithETag too", async () => {
    await withServer([[401, { error: "unauthorized" }, { "x-jetlog-cli-latest": "50.0.0" }]], async (server) => {
      await expect(new ApiClient({ baseUrl: server.baseUrl, token: "t" }).get("/api/cli/v1/me")).rejects.toBeInstanceOf(ApiError);
    });
    expect(latestVersionSeen()).toBe("50.0.0");
    await withServer([[200, { airlines: [] }, LATEST_HEADER]], async (server) => {
      await new ApiClient({ baseUrl: server.baseUrl, token: "t" }).getWithETag("/api/cli/v1/airlines");
    });
    expect(latestVersionSeen()).toBe(NEWER);
  });

  it("ignores a value that is not a version", async () => {
    observeLatestVersion("not a version");
    observeLatestVersion("1.2");
    observeLatestVersion("");
    observeLatestVersion(null);
    expect(latestVersionSeen()).toBeUndefined();
    expect(await currentUpdateNotice({ useStored: true })).toBeUndefined();
  });

  it("gives no notice when the latest version is not newer than this one", async () => {
    observeLatestVersion(VERSION);
    expect(await currentUpdateNotice()).toBeUndefined();
    observeLatestVersion("0.0.1");
    expect(await currentUpdateNotice()).toBeUndefined();
  });
});

describe("terminal notice", () => {
  const day = 24 * 60 * 60 * 1000;
  const t0 = new Date("2026-10-28T09:00:00Z");

  it("prints the line once on stderr, then not again within a day", async () => {
    observeLatestVersion(NEWER);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    expect(await printUpdateNoticeIfDue({ now: t0, log })).toBe(true);
    expect(lines).toEqual([`jetlog-cli ${NEWER} is available, you have ${VERSION}. Run npm i -g jetlog-cli@latest`]);
    expect(await storedState()).toEqual({ latest: NEWER, last_notice_at: t0.toISOString() });

    expect(await printUpdateNoticeIfDue({ now: new Date(t0.getTime() + day - 1000), log })).toBe(false);
    expect(lines).toHaveLength(1);

    expect(await printUpdateNoticeIfDue({ now: new Date(t0.getTime() + day), log })).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("keeps the once-a-day limit across runs through the state file", async () => {
    observeLatestVersion(NEWER);
    await printUpdateNoticeIfDue({ now: t0, log: () => {} });

    // A new process: nothing in memory, the state file remains.
    resetUpdateNotice();
    observeLatestVersion(NEWER);
    const lines: string[] = [];
    expect(await printUpdateNoticeIfDue({ now: new Date(t0.getTime() + 60_000), log: (l) => lines.push(l) })).toBe(false);
    expect(lines).toEqual([]);
  });

  it("counts a notice time in the future as due, so a clock change cannot silence it for good", async () => {
    await mkdir(join(dir, "jetlog"), { recursive: true });
    await writeFile(updateNoticeStatePath(), JSON.stringify({ latest: NEWER, last_notice_at: "2030-01-01T00:00:00Z" }));
    observeLatestVersion(NEWER);
    expect(await printUpdateNoticeIfDue({ now: t0, log: () => {} })).toBe(true);
  });

  it("stays silent when this run saw no header, even with a stored newer version", async () => {
    await mkdir(join(dir, "jetlog"), { recursive: true });
    await writeFile(updateNoticeStatePath(), JSON.stringify({ latest: NEWER }));
    const lines: string[] = [];
    expect(await printUpdateNoticeIfDue({ now: t0, log: (l) => lines.push(l) })).toBe(false);
    expect(lines).toEqual([]);
  });

  it("works with an unreadable state file", async () => {
    await mkdir(join(dir, "jetlog"), { recursive: true });
    await writeFile(updateNoticeStatePath(), "{not json");
    observeLatestVersion(NEWER);
    expect(await printUpdateNoticeIfDue({ now: t0, log: () => {} })).toBe(true);
  });
});

describe("HTTP 426", () => {
  it("shows the server's text instead of a generic error", async () => {
    await withServer([[426, UPGRADE_BODY, { "x-jetlog-cli-latest": "0.2.1" }]], async (server) => {
      const err = await new ApiClient({ baseUrl: server.baseUrl, token: "t" }).get("/api/cli/v1/me").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe(UPGRADE_BODY.error);
      expect((err as ApiError).status).toBe(426);
      expect((err as ApiError).code).toBe("upgrade_required");
      expect(server.requests).toHaveLength(1);
    });
  });

  it("is not followed by the update notice, which would repeat it", async () => {
    await withServer([[426, UPGRADE_BODY, LATEST_HEADER]], async (server) => {
      await new ApiClient({ baseUrl: server.baseUrl, token: "t" }).get("/api/cli/v1/me").catch(() => {});
    });
    expect(await currentUpdateNotice()).toBeUndefined();
    expect(await printUpdateNoticeIfDue({ now: new Date(), log: () => {} })).toBe(false);
  });

  it("throws from requestRaw callers too (propose) and from getWithETag", async () => {
    await withServer([[426, UPGRADE_BODY], [426, UPGRADE_BODY]], async (server) => {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "t" });
      await expect(proposeChanges(client, "x", [])).rejects.toMatchObject({ status: 426, message: UPGRADE_BODY.error });
      await expect(client.getWithETag("/api/cli/v1/airlines")).rejects.toMatchObject({ status: 426, message: UPGRADE_BODY.error });
    });
  });

  it("falls back to a fixed text, and strips control characters from the server's", async () => {
    await withServer([[426, {}], [426, { error: "too old\u001b[2J\nupdate" }]], async (server) => {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "t" });
      await expect(client.get("/x")).rejects.toMatchObject({ message: UPGRADE_REQUIRED_MESSAGE });
      await expect(client.get("/x")).rejects.toMatchObject({ message: "too old[2J update" });
    });
  });

  it("reaches the user from a device login start", async () => {
    const { startDeviceAuthorization } = await import("../src/auth/device-flow.js");
    await withServer([[426, UPGRADE_BODY]], async (server) => {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      await expect(startDeviceAuthorization({ client, scope: "read" })).rejects.toMatchObject({ message: UPGRADE_BODY.error });
    });
  });
});

describe("MCP mode", () => {
  async function connectedClient() {
    const server = await createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }
  const texts = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text);
  const expected = updateNoticeText(NEWER);

  it("puts a stored newer version into the instructions and the first tool result, and writes nothing to stdout or stderr", async () => {
    await mkdir(join(dir, "jetlog"), { recursive: true });
    await writeFile(updateNoticeStatePath(), JSON.stringify({ latest: NEWER }));
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      const client = await connectedClient();
      expect(client.getInstructions()).toContain(expected);
      expect(client.getInstructions()).toContain("npx -y jetlog-cli@latest mcp");

      const first = texts(await client.callTool({ name: "get_import_schema", arguments: {} }));
      expect(first).toHaveLength(2);
      expect(first[1]).toContain(expected);

      const second = texts(await client.callTool({ name: "get_import_schema", arguments: {} }));
      expect(second).toHaveLength(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("appends a version first seen during the session to that tool's result, once", async () => {
    await withServer(
      [
        [200, { people: [] }, LATEST_HEADER],
        [200, { aircraft: [] }, LATEST_HEADER]
      ],
      async (server) => {
        process.env.JETLOG_TOKEN = "jlp_abc";
        process.env.JETLOG_BASE_URL = server.baseUrl;
        const client = await connectedClient();
        expect(client.getInstructions()).not.toContain("is available");

        const first = texts(await client.callTool({ name: "list_people", arguments: {} }));
        expect(first[first.length - 1]).toContain(expected);
        const second = texts(await client.callTool({ name: "list_aircraft", arguments: {} }));
        expect(second.join("\n")).not.toContain("is available");
      }
    );
  });

  it("leaves results alone when nothing newer is known", async () => {
    const client = await connectedClient();
    expect(client.getInstructions()).not.toContain("is available");
    expect(texts(await client.callTool({ name: "get_import_schema", arguments: {} }))).toHaveLength(1);
  });
});
