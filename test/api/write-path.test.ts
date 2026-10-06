import { describe, expect, it } from "vitest";
import {
  ApiClient,
  ApiError,
  cleanupImportBatches,
  createImportBatch,
  deleteImportBatch,
  listImportBatches,
  putResourceChunked
} from "../../src/api/client.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

describe("putResourceChunked", () => {
  it("chunks at 200 rows per request and carries x-jetlog-batch-id on every chunk", async () => {
    const server = new TestServer([
      jsonHandler(200, { entries: Array.from({ length: 200 }, (_, i) => ({ id: `e${i}` })) }),
      jsonHandler(200, { entries: [{ id: "e200" }] })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const rows = Array.from({ length: 201 }, (_, i) => ({ id: `e${i}` }));
      const results = await putResourceChunked(client, "entries", rows, "batch-1");

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]!.method).toBe("PUT");
      expect((server.requests[0]!.body as { entries: unknown[] }).entries).toHaveLength(200);
      expect((server.requests[1]!.body as { entries: unknown[] }).entries).toHaveLength(1);
      for (const req of server.requests) {
        expect(req.headers["x-jetlog-batch-id"]).toBe("batch-1");
      }
      expect(results).toHaveLength(201);
    } finally {
      await server.stop();
    }
  });

  it("sends nothing for an empty row list", async () => {
    const server = new TestServer([]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const results = await putResourceChunked(client, "people", [], "batch-1");
      expect(results).toEqual([]);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it("surfaces a 413 too_many_entries error with its code intact", async () => {
    const server = new TestServer([
      jsonHandler(413, { error: { message: "Too many entries in one request (max 200)", code: "too_many_entries", count: 250, max: 200 } })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 0 });
      await expect(client.put("/api/entries", { entries: [] }, { headers: { "x-jetlog-batch-id": "b1" } })).rejects.toMatchObject({
        status: 413,
        code: "too_many_entries"
      });
    } finally {
      await server.stop();
    }
  });

  it("surfaces a 422 unknown_person_ids error with its code intact", async () => {
    const server = new TestServer([
      jsonHandler(422, { error: { message: "Unknown person_id reference(s)", code: "unknown_person_ids", person_ids: ["ghost"] } })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 0 });
      let caught: ApiError | undefined;
      try {
        await client.put("/api/entries", { entries: [] }, { headers: { "x-jetlog-batch-id": "b1" } });
      } catch (err) {
        caught = err as ApiError;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught?.status).toBe(422);
      expect(caught?.code).toBe("unknown_person_ids");
    } finally {
      await server.stop();
    }
  });

  it("retries a 429 with retry-after before succeeding", async () => {
    const server = new TestServer([
      jsonHandler(429, { error: { message: "rate limited", code: "rate_limited" } }, { "retry-after": "0" }),
      jsonHandler(200, { entries: [{ id: "e1" }] })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 2 });
      const results = await putResourceChunked(client, "entries", [{ id: "e1" }], "b1");
      expect(server.requests).toHaveLength(2);
      expect(results).toEqual([{ id: "e1" }]);
    } finally {
      await server.stop();
    }
  });
});

describe("import batch endpoints", () => {
  it("createImportBatch POSTs to /api/import_batches", async () => {
    const server = new TestServer([jsonHandler(201, { id: "batch-1", created_at: "2026-01-01T00:00:00Z" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const batch = await createImportBatch(client, { kind: "import", source_format: "pilotlog", label: "test" });
      expect(batch.id).toBe("batch-1");
      expect(server.requests[0]!.path).toBe("/api/import_batches");
      expect((server.requests[0]!.body as { source_format: string }).source_format).toBe("pilotlog");
    } finally {
      await server.stop();
    }
  });

  it("listImportBatches GETs /api/import_batches", async () => {
    const server = new TestServer([jsonHandler(200, { import_batches: [{ id: "batch-1", status: "active" }] })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const { import_batches } = await listImportBatches(client);
      expect(import_batches[0]!.id).toBe("batch-1");
    } finally {
      await server.stop();
    }
  });

  it("deleteImportBatch with dryRun sends dry_run=true and never mutates", async () => {
    const server = new TestServer([
      jsonHandler(200, { would_delete: 3, changed_since_import: 0, edited_entries_untouched: 1, people_would_delete: 0, signed_kept: 0 })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const preview = (await deleteImportBatch(client, "batch-1", true)) as { would_delete: number };
      expect(server.requests[0]!.method).toBe("DELETE");
      expect(server.requests[0]!.path).toBe("/api/import_batches/batch-1?dry_run=true");
      expect(preview.would_delete).toBe(3);
    } finally {
      await server.stop();
    }
  });

  it("cleanupImportBatches POSTs sources + dry_run", async () => {
    const server = new TestServer([jsonHandler(200, { would_delete: 5, changed_since_import: 0, edited_entries_untouched: 0, people_would_delete: 2, signed_kept: 0 })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      await cleanupImportBatches(client, ["cli"], true);
      expect(server.requests[0]!.path).toBe("/api/import_batches/cleanup");
      expect(server.requests[0]!.body).toEqual({ sources: ["cli"], dry_run: true });
    } finally {
      await server.stop();
    }
  });
});
