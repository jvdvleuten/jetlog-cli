import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveProfile } from "../../src/auth/credentials.js";
import { attachmentsAdd, attachmentsGet, attachmentsList, attachmentsRemove } from "../../src/commands/attachments.js";
import { TestServer, jsonHandler, type Handler } from "../helpers/test-server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const PDF = Buffer.from("%PDF-1.7\nbody");

const ENTRY = { id: "e1", date: "2026-10-01", flight_number: "KL1234", from: "AMS", to: "LHR", signature: "none", attachments: [] as unknown[] };

describe("attachments commands", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-attachments-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
    await mkdir(join(dir, "files"));
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  async function withServer(handlers: Handler[], fn: (server: TestServer) => Promise<void>): Promise<void> {
    const server = new TestServer(handlers);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  }

  const createResponse =
    (server: () => TestServer, id: string, length: number): Handler =>
    (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status: "pending", upload: { url: `${server().baseUrl}/bucket/${id}`, headers: { "content-type": "image/png", "content-length": String(length) } } }));
    };

  it("add uploads each file, then writes the rows in one batched PUT", async () => {
    const png = join(dir, "files", "ramp.png");
    const pdf = join(dir, "files", "loadsheet.pdf");
    await writeFile(png, PNG);
    await writeFile(pdf, PDF);
    let server!: TestServer;
    const created = (id: string, type: string, length: number): Handler => (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status: "pending", upload: { url: `${server.baseUrl}/bucket/${id}`, headers: { "content-type": type, "content-length": String(length) } } }));
    };
    await withServer(
      [
        jsonHandler(200, ENTRY),
        jsonHandler(201, { id: "batch-1" }),
        created("att-1", "image/png", PNG.length),
        (_req, res) => res.writeHead(200).end(),
        jsonHandler(200, { id: "att-1", status: "stored" }),
        created("att-2", "application/pdf", PDF.length),
        (_req, res) => res.writeHead(200).end(),
        jsonHandler(200, { id: "att-2", status: "stored" }),
        (req, res) => {
          const rows = (req.body as { entry_attachments: { id: string; file_name: string }[] }).entry_attachments;
          jsonHandler(200, { entry_attachments: rows.map((r) => ({ id: r.id, file_name: r.file_name })) })(req, res);
        }
      ],
      async (s) => {
        server = s;
        await attachmentsAdd({ profile: "default", entryId: "e1", files: [png, pdf], yes: true });
        const paths = server.requests.map((r) => `${r.method} ${r.path}`);
        expect(paths[0]).toBe("GET /api/cli/v1/entries/e1");
        expect(paths[1]).toBe("POST /api/import_batches");
        expect(server.requests[1]!.body).toMatchObject({ kind: "edit", client: "jetlog-cli" });
        expect(paths.slice(2)).toEqual([
          "POST /api/attachments",
          "PUT /bucket/att-1",
          "POST /api/attachments/att-1/confirm",
          "POST /api/attachments",
          "PUT /bucket/att-2",
          "POST /api/attachments/att-2/confirm",
          "PUT /api/entry_attachments"
        ]);
        const put = server.requests[8]!;
        expect(put.headers["x-jetlog-batch-id"]).toBe("batch-1");
        const rows = (put.body as { entry_attachments: Record<string, unknown>[] }).entry_attachments;
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ entry_id: "e1", attachment_id: "att-1", file_name: "ramp.png" });
        expect(rows[1]).toMatchObject({ entry_id: "e1", attachment_id: "att-2", file_name: "loadsheet.pdf" });
        expect(rows[0]!.id).not.toBe(rows[1]!.id);
      }
    );
  });

  it("add refuses a bad file before any request is made", async () => {
    const txt = join(dir, "files", "notes.txt");
    await writeFile(txt, "hello");
    await withServer([], async (server) => {
      await expect(attachmentsAdd({ profile: "default", entryId: "e1", files: [txt], yes: true })).rejects.toThrow(/supported file type/);
      expect(server.requests).toHaveLength(0);
    });
  });

  it("add refuses --name with more than one file", async () => {
    await expect(attachmentsAdd({ profile: "default", entryId: "e1", files: ["a.png", "b.png"], name: "x.png", yes: true })).rejects.toThrow(/--name/);
  });

  it("add stops when the entry would pass 20 files, and sends no write", async () => {
    const png = join(dir, "files", "one.png");
    await writeFile(png, PNG);
    const full = { ...ENTRY, attachments: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, attachment_id: `a${i}`, file_name: `f${i}.png` })) };
    await withServer([jsonHandler(200, full)], async (server) => {
      await expect(attachmentsAdd({ profile: "default", entryId: "e1", files: [png], yes: true })).rejects.toThrow(/20 is the most/);
      expect(server.requests).toHaveLength(1);
    });
  });

  it("add reports an unknown entry plainly", async () => {
    const png = join(dir, "files", "one.png");
    await writeFile(png, PNG);
    await withServer([jsonHandler(404, { error: "not_found" })], async () => {
      await expect(attachmentsAdd({ profile: "default", entryId: "nope", files: [png], yes: true })).rejects.toThrow(/entry nope not found/);
    });
  });

  it("list reads the entry's attachments", async () => {
    const entry = { ...ENTRY, attachments: [{ id: "r1", attachment_id: "a1", file_name: "ramp.png", content_type: "image/png", byte_size: 9, position: 1 }] };
    await withServer([jsonHandler(200, entry)], async (server) => {
      await attachmentsList({ profile: "default", entryId: "e1", format: "json" });
      expect(server.requests[0]!.path).toBe("/api/cli/v1/entries/e1");
    });
  });

  it("list and add tell a token without the files scope to log in again, not that there are no files", async () => {
    // What a token without `files` really gets: the count, but no `attachments` key.
    const noFiles = { id: "e1", date: "2026-10-01", signature: "none", attachment_count: 3 };
    const png = join(dir, "files", "one.png");
    await writeFile(png, PNG);
    await withServer([jsonHandler(200, noFiles)], async () => {
      await expect(attachmentsList({ profile: "default", entryId: "e1", format: "json" })).rejects.toThrow(/files scope.*jetlog login/);
    });
    await withServer([jsonHandler(200, noFiles)], async (server) => {
      await expect(attachmentsAdd({ profile: "default", entryId: "e1", files: [png], yes: true })).rejects.toThrow(/files scope.*jetlog login/);
      expect(server.requests).toHaveLength(1);
    });
  });

  it("get downloads, verifies the checksum and refuses to overwrite without --force", async () => {
    const sha = createHash("sha256").update(PDF).digest("hex");
    const target = join(dir, "out.pdf");
    let server!: TestServer;
    const urls: Handler = (req, res) =>
      jsonHandler(200, { attachments: [{ id: "a1", sha256: sha, content_type: "application/pdf", url: `${server.baseUrl}/dl/a1`, expires_at: "2026-10-06T10:00:00Z" }], gone: [] })(req, res);
    await withServer([urls, (_req, res) => res.writeHead(200).end(PDF), urls, (_req, res) => res.writeHead(200).end(PDF)], async (s) => {
      server = s;
      await attachmentsGet({ profile: "default", attachmentId: "a1", output: target });
      expect((await readFile(target)).equals(PDF)).toBe(true);
      expect(server.requests[1]!.headers["authorization"]).toBeUndefined();
      await expect(attachmentsGet({ profile: "default", attachmentId: "a1", output: target })).rejects.toThrow(/already exists/);
    });
  });

  it("get rejects bytes that do not match the checksum, and saves nothing", async () => {
    const target = join(dir, "out.pdf");
    let server!: TestServer;
    await withServer(
      [
        (req, res) => jsonHandler(200, { attachments: [{ id: "a1", sha256: "0".repeat(64), content_type: "application/pdf", url: `${server.baseUrl}/dl/a1`, expires_at: "x" }] })(req, res),
        (_req, res) => res.writeHead(200).end(PDF)
      ],
      async (s) => {
        server = s;
        await expect(attachmentsGet({ profile: "default", attachmentId: "a1", output: target })).rejects.toThrow(/checksum/);
        await expect(readFile(target)).rejects.toThrow();
      }
    );
  });

  it("get says when the login lacks the signatures permission for a forbidden id", async () => {
    await withServer([jsonHandler(200, { attachments: [], gone: [], forbidden: ["sig1"] })], async () => {
      await expect(attachmentsGet({ profile: "default", attachmentId: "sig1" })).rejects.toThrow(/without the signatures permission/);
    });
  });

  it("remove looks the row up, then tombstones it in a batched PUT", async () => {
    const row = { id: "r1", version: 4, entry_id: "e1", attachment_id: "a1", file_name: "ramp.png", is_deleted: false };
    await withServer(
      [jsonHandler(200, { entry_attachments: [row], sync_cursor: 4 }), jsonHandler(201, { id: "batch-2" }), jsonHandler(200, { entry_attachments: [{ ...row, is_deleted: true }] })],
      async (server) => {
        await attachmentsRemove({ profile: "default", id: "r1", yes: true });
        expect(server.requests[0]!.path).toMatch(/^\/api\/entry_attachments\?/);
        const put = server.requests[2]!;
        expect(put.method).toBe("PUT");
        expect(put.headers["x-jetlog-batch-id"]).toBe("batch-2");
        expect((put.body as { entry_attachments: unknown[] }).entry_attachments).toEqual([
          { id: "r1", entry_id: "e1", attachment_id: "a1", file_name: "ramp.png", is_deleted: true }
        ]);
      }
    );
  });

  it("remove reports an unknown row", async () => {
    await withServer([jsonHandler(200, { entry_attachments: [], sync_cursor: 0 })], async () => {
      await expect(attachmentsRemove({ profile: "default", id: "nope", yes: true })).rejects.toThrow(/not found/);
    });
  });
});
