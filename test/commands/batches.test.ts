import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("remove shows the token-signed and link-signed counts and passes --include-link-signed", async () => {
    const server = new TestServer([
      jsonHandler(200, { would_delete: 3, changed_since_import: 0, edited_entries_untouched: 0, people_would_delete: 0, signed_kept: 1, token_signed_would_delete: 2, link_signed_kept: 1 }),
      jsonHandler(200, { deleted: 3 })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      await batchesRemove({ profile: "default", id: "batch-1", yes: true, includeLinkSigned: true });
      expect(server.requests[0]!.path).toBe("/api/import_batches/batch-1?dry_run=true&include_link_signed=true");
      expect(server.requests[1]!.path).toBe("/api/import_batches/batch-1?include_link_signed=true");
      const text = lines.join("\n");
      expect(text).toContain("signed by a token:    2 entries carry signatures");
      expect(text).toContain("kept (an entry signed in the app is never deleted)");
      expect(text).toContain("kept (link-signed):   1 entry signed through a signing link a token created (add --include-link-signed to delete it too)");
    } finally {
      spy.mockRestore();
      await server.stop();
    }
  });

  it("remove without the flag sends no include_link_signed and says how to include them", async () => {
    const preview = { would_delete: 1, changed_since_import: 0, edited_entries_untouched: 0, people_would_delete: 0, signed_kept: 0, link_signed_kept: 2 };
    const server = new TestServer([jsonHandler(200, preview), jsonHandler(200, { deleted: 1 })]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      await batchesRemove({ profile: "default", id: "batch-1", yes: true });
      expect(server.requests[0]!.path).toBe("/api/import_batches/batch-1?dry_run=true");
      expect(server.requests[1]!.path).toBe("/api/import_batches/batch-1");
      expect(lines.join("\n")).toContain("kept (link-signed):   2 entries signed through a signing link a token created (add --include-link-signed to delete them too)");
    } finally {
      spy.mockRestore();
      await server.stop();
    }
  });

  it("remove-all-cli sends include_link_signed in the body only when asked", async () => {
    const preview = { would_delete: 1, changed_since_import: 0, edited_entries_untouched: 0, people_would_delete: 0, signed_kept: 0 };
    const server = new TestServer([jsonHandler(200, preview), jsonHandler(200, { deleted: 1 }), jsonHandler(200, preview), jsonHandler(200, { deleted: 1 })]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await batchesRemoveAllCli({ profile: "default", yes: true });
      expect(server.requests[0]!.body).toEqual({ sources: ["cli"], dry_run: true });
      expect(server.requests[1]!.body).toEqual({ sources: ["cli"], dry_run: false });
      await batchesRemoveAllCli({ profile: "default", yes: true, includeLinkSigned: true });
      expect(server.requests[2]!.body).toEqual({ sources: ["cli"], dry_run: true, include_link_signed: true });
      expect(server.requests[3]!.body).toEqual({ sources: ["cli"], dry_run: false, include_link_signed: true });
    } finally {
      await server.stop();
    }
  });
});
