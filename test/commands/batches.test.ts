import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProfile } from "../../src/auth/credentials.js";
import { batchesList, batchesRemove, batchesRemoveAllCli } from "../../src/commands/batches.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

describe("batches commands", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-batches-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  it("list prints the batches from GET /api/import_batches", async () => {
    const server = new TestServer([jsonHandler(200, { import_batches: [{ id: "batch-1", status: "active", created_count: 5 }] })]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await batchesList({ profile: "default", format: "json" });
      expect(server.requests[0]!.path).toBe("/api/import_batches");
    } finally {
      await server.stop();
    }
  });

  it("remove previews with dry_run=true first, then only deletes after confirmation (--yes)", async () => {
    const server = new TestServer([
      jsonHandler(200, { would_delete: 3, changed_since_import: 1, edited_entries_untouched: 2, people_would_delete: 1, signed_kept: 0 }),
      jsonHandler(200, { deleted: 3, people_deleted: 1 })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await batchesRemove({ profile: "default", id: "batch-1", yes: true });
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]!.method).toBe("DELETE");
      expect(server.requests[0]!.path).toBe("/api/import_batches/batch-1?dry_run=true");
      expect(server.requests[1]!.method).toBe("DELETE");
      expect(server.requests[1]!.path).toBe("/api/import_batches/batch-1");
    } finally {
      await server.stop();
    }
  });

  it("remove does nothing further when the preview shows would_delete=0", async () => {
    const server = new TestServer([
      jsonHandler(200, { would_delete: 0, changed_since_import: 0, edited_entries_untouched: 0, people_would_delete: 0, signed_kept: 0 })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await batchesRemove({ profile: "default", id: "batch-1", yes: true });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("remove-all-cli previews cleanup with sources=['cli'] then executes", async () => {
    const server = new TestServer([
      jsonHandler(200, { would_delete: 10, changed_since_import: 0, edited_entries_untouched: 0, people_would_delete: 2, signed_kept: 1 }),
      jsonHandler(202, { status: "removing" })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await batchesRemoveAllCli({ profile: "default", yes: true });
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]!.body).toEqual({ sources: ["cli"], dry_run: true });
      expect(server.requests[1]!.body).toEqual({ sources: ["cli"], dry_run: false });
    } finally {
      await server.stop();
    }
  });
});
