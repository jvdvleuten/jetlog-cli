import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProfile } from "../../src/auth/credentials.js";
import { runExport } from "../../src/commands/export.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

function entry(id: number, date: string) {
  return { id, date, flight_number: `KL${1000 + id}`, is_deleted: false };
}

describe("runExport", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-export-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  it("pages across cursors and writes every entry to a JSON file", async () => {
    const server = new TestServer([
      jsonHandler(200, {
        entries: [entry(1, "2026-01-01"), entry(2, "2026-01-02")],
        pagination: { limit: 200, has_more: true, next_cursor: { date: "2026-01-02", id: 2 } }
      }),
      jsonHandler(200, {
        entries: [entry(3, "2026-01-03")],
        pagination: { limit: 200, has_more: false, next_cursor: null }
      })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });

    try {
      const output = join(dir, "export.json");
      await runExport({ profile: "default", output, format: "json" });

      expect(server.requests.length).toBe(2);
      expect(new URL(server.requests[1]!.path, "http://x").searchParams.get("after_id")).toBe("2");

      const written = JSON.parse(await readFile(output, "utf-8"));
      expect(written.map((e: { id: number }) => e.id)).toEqual([1, 2, 3]);

      // Resume file is cleaned up on a clean finish.
      await expect(readFile(`${output}.resume.json`, "utf-8")).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });

  it("resumes from a saved cursor when the resume file already exists", async () => {
    const server = new TestServer([
      jsonHandler(200, {
        entries: [entry(3, "2026-01-03")],
        pagination: { limit: 200, has_more: false, next_cursor: null }
      })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });

    try {
      const output = join(dir, "export.json");
      // Simulate a previous interrupted run: partial file + resume cursor.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, "[\n" + JSON.stringify(entry(1, "2026-01-01")) + ",\n");
      await writeFile(`${output}.resume.json`, JSON.stringify({ afterDate: "2026-01-01", afterId: "1" }));

      await runExport({ profile: "default", output, format: "json" });

      expect(server.requests.length).toBe(1);
      expect(new URL(server.requests[0]!.path, "http://x").searchParams.get("after_date")).toBe("2026-01-01");

      const written = JSON.parse(await readFile(output, "utf-8"));
      expect(written.map((e: { id: number }) => e.id)).toEqual([1, 3]);
    } finally {
      await server.stop();
    }
  });

  it("writes CSV output when --format csv is used", async () => {
    const server = new TestServer([
      jsonHandler(200, {
        entries: [entry(1, "2026-01-01")],
        pagination: { limit: 200, has_more: false, next_cursor: null }
      })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });

    try {
      const output = join(dir, "export.csv");
      await runExport({ profile: "default", output, format: "csv" });
      const csv = await readFile(output, "utf-8");
      expect(csv.split("\r\n")[0]).toContain("flight_number");
      expect(csv).toContain("KL1001");
    } finally {
      await server.stop();
    }
  });
});
