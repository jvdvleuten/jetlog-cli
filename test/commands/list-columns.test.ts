import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfile } from "../../src/auth/credentials.js";
import { entriesList } from "../../src/commands/entries.js";
import { peopleList } from "../../src/commands/people.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

// The shapes the token facade really sends from the attachments release on (see TokenReadFields on the backend).
const ENTRY_ROWS = {
  entries: [
    { id: "e1", date: "2026-10-01", type: "flight", flight_number: "KL1234", signature: "signed", signature_attachment_id: "att-1", attachment_count: 3 },
    { id: "e2", date: "2026-10-02", type: "flight", flight_number: "KL1235", signature: "none", attachment_count: 0 }
  ],
  pagination: { has_more: false }
};
const PEOPLE_ROWS = {
  people: [
    { id: "p1", first_name: "Jan", last_name: "Jansen", has_photo: true, photo_attachment_id: "ph-1" },
    { id: "p2", first_name: "Els", last_name: "Bakker", has_photo: false, photo_attachment_id: null }
  ]
};

describe("list columns from the attachments release", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let out: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-list-columns-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (out.push(String(chunk)), true));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  async function withServer(handler: ReturnType<typeof jsonHandler>, fn: () => Promise<void>): Promise<void> {
    const server = new TestServer([handler]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await fn();
    } finally {
      await server.stop();
    }
  }

  it("entries shows signature and files (from attachment_count)", async () => {
    await withServer(jsonHandler(200, ENTRY_ROWS), async () => {
      await entriesList({ profile: "default", format: "table" });
    });
    const lines = out.join("\n").split("\n").map((l) => l.trimEnd());
    expect(lines[0]).toMatch(/signature\s+files$/);
    expect(lines[2]).toMatch(/signed\s+3$/);
    expect(lines[3]).toMatch(/none\s+0$/);
  });

  it("entries --csv carries the same two columns", async () => {
    await withServer(jsonHandler(200, ENTRY_ROWS), async () => {
      await entriesList({ profile: "default", format: "csv" });
    });
    const lines = out.join("").split("\r\n");
    expect(lines[0]).toMatch(/,signature,files$/);
    expect(lines[1]).toMatch(/,signed,3$/);
  });

  it("people shows a photo column from has_photo", async () => {
    await withServer(jsonHandler(200, PEOPLE_ROWS), async () => {
      await peopleList({ profile: "default", format: "table" });
    });
    const lines = out.join("\n").split("\n").map((l) => l.trimEnd());
    expect(lines[0]).toMatch(/employee_number\s+photo$/);
    expect(lines[2]).toMatch(/Jan\s+Jansen.*\s+yes$/);
    expect(lines[3]).toMatch(/Els\s+Bakker.*\s+no$/);
  });

  it("people --json passes the rows through unchanged", async () => {
    await withServer(jsonHandler(200, PEOPLE_ROWS), async () => {
      await peopleList({ profile: "default", format: "json" });
    });
    expect(JSON.parse(out.join(""))).toEqual(PEOPLE_ROWS.people);
  });

  it("people keeps its five columns against a backend that sends no photo state", async () => {
    await withServer(jsonHandler(200, { people: [{ id: "p1", first_name: "Jan", last_name: "Jansen" }] }), async () => {
      await peopleList({ profile: "default", format: "table" });
    });
    expect(out.join("\n").split("\n")[0]).not.toContain("photo");
  });
});
