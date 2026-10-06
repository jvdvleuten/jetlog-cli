import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfile } from "../../src/auth/credentials.js";
import {
  signaturesAttach,
  signaturesGet,
  signaturesRemove,
  signaturesRequest,
  signaturesRevoke,
  signaturesShow,
  signaturesUnwaive,
  signaturesWaive
} from "../../src/commands/signatures.js";
import { TestServer, jsonHandler, type Handler } from "../helpers/test-server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  date: "2026-10-01",
  flight_number: "KL1234",
  from: "AMS",
  to: "LHR",
  signature: "none",
  is_bulk: false,
  attachments: [],
  ...extra
});

describe("signatures commands", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-signatures-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
    await mkdir(join(dir, "files"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  const common = { profile: "default" };

  it("show prints the state, the attachment id and the checksum, never an image", async () => {
    await withServer([jsonHandler(200, entry("e1", { signature: "signed", signature_attachment_id: "att-9", signature_sha256: "ab".repeat(32) }))], async (server) => {
      await signaturesShow({ ...common, entryId: "e1" });
      expect(server.requests[0]!.path).toBe("/api/cli/v1/entries/e1");
      expect(out).toEqual(["signature: signed", "attachment_id: att-9", `sha256: ${"ab".repeat(32)}`]);
    });
  });

  it("show --json prints the fields as JSON", async () => {
    await withServer([jsonHandler(200, { entry: entry("e1", { signature: "waived" }) })], async () => {
      await signaturesShow({ ...common, entryId: "e1", json: true });
      expect(JSON.parse(out[0]!)).toMatchObject({ entry_id: "e1", signature: "waived", signature_attachment_id: null });
    });
  });

  it("attach uploads the PNG as a signature, then writes only the reference on the entry", async () => {
    const png = join(dir, "files", "instructor.png");
    await writeFile(png, PNG);
    let server!: TestServer;
    await withServer(
      [
        jsonHandler(200, entry("e1")),
        jsonHandler(201, { id: "batch-1" }),
        (_req, res) => {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "att-1", status: "pending", upload: { url: `${server.baseUrl}/bucket/att-1`, headers: { "content-type": "image/png", "content-length": String(PNG.length) } } }));
        },
        (_req, res) => res.writeHead(200).end(),
        jsonHandler(200, { id: "att-1", status: "stored" }),
        jsonHandler(200, { entries: [{ id: "e1" }] })
      ],
      async (s) => {
        server = s;
        await signaturesAttach({ ...common, entryId: "e1", image: png, yes: true });
        expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
          "GET /api/cli/v1/entries/e1",
          "POST /api/import_batches",
          "POST /api/attachments",
          "PUT /bucket/att-1",
          "POST /api/attachments/att-1/confirm",
          "PUT /api/entries"
        ]);
        expect(server.requests[2]!.body).toMatchObject({ kind: "signature", content_type: "image/png", byte_size: PNG.length });
        const put = server.requests[5]!;
        expect(put.headers["x-jetlog-batch-id"]).toBe("batch-1");
        expect(put.body).toEqual({ entries: [{ id: "e1", signature_attachment_id: "att-1" }] });
        expect(err.join("\n")).toContain("Will attach instructor.png (image/png,");
        expect(err.join("\n")).not.toContain("replace");
        expect(err.join("\n")).toContain("Signature attached.");
      }
    );
  });

  it("attach on a signed entry previews a replace and sends the same write", async () => {
    const png = join(dir, "files", "sig.png");
    await writeFile(png, PNG);
    let server!: TestServer;
    await withServer(
      [
        jsonHandler(200, entry("e1", { signature: "signed", signature_attachment_id: "att-old" })),
        jsonHandler(201, { id: "batch-1" }),
        (_req, res) => {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "att-2", status: "pending", upload: { url: `${server.baseUrl}/bucket/att-2`, headers: { "content-type": "image/png", "content-length": String(PNG.length) } } }));
        },
        (_req, res) => res.writeHead(200).end(),
        jsonHandler(200, { id: "att-2", status: "stored" }),
        jsonHandler(200, { entries: [{ id: "e1" }] })
      ],
      async (s) => {
        server = s;
        await signaturesAttach({ ...common, entryId: "e1", image: png, yes: true });
        expect(server.requests[5]!.method).toBe("PUT");
        expect(server.requests[5]!.path).toBe("/api/entries");
        expect(server.requests[5]!.body).toEqual({ entries: [{ id: "e1", signature_attachment_id: "att-2" }] });
        const text = err.join("\n");
        expect(text).toContain("signature: signed");
        expect(text).toContain(`Will replace the existing signature with sig.png (image/png, ${PNG.length} B). This is recorded in your account's audit log.`);
        expect(text).toContain("Signature replaced.");
      }
    );
  });

  it("attach refuses a bulk entry", async () => {
    const png = join(dir, "files", "s.png");
    await writeFile(png, PNG);
    await withServer([jsonHandler(200, entry("e1", { is_bulk: true }))], async (server) => {
      await expect(signaturesAttach({ ...common, entryId: "e1", image: png, yes: true })).rejects.toThrow(/bulk/);
      expect(server.requests).toHaveLength(1);
    });
  });

  it("attach rejects a non-PNG before any request is made", async () => {
    const txt = join(dir, "files", "s.txt");
    await writeFile(txt, "hello");
    await withServer([], async (server) => {
      await expect(signaturesAttach({ ...common, entryId: "e1", image: txt, yes: true })).rejects.toThrow(/supported file type/);
      expect(server.requests).toHaveLength(0);
    });
  });

  describe("get", () => {
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

    it("downloads the signature image of a signed entry through the download URL call", async () => {
      const target = join(dir, "files", "out.png");
      let server!: TestServer;
      await withServer(
        [
          jsonHandler(200, entry("e1", { signature: "signed", signature_attachment_id: "att-9" })),
          (req, res) =>
            jsonHandler(200, { attachments: [{ id: "att-9", sha256: sha(PNG), content_type: "image/png", url: `${server.baseUrl}/obj/att-9`, expires_at: "x" }] })(req, res),
          (_req, res) => res.writeHead(200).end(PNG)
        ],
        async (s) => {
          server = s;
          await signaturesGet({ ...common, entryId: "e1", output: target });
          expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/cli/v1/entries/e1", "POST /api/attachments/download_urls", "GET /obj/att-9"]);
          expect(server.requests[1]!.body).toEqual({ ids: ["att-9"] });
          expect((await readFile(target)).equals(PNG)).toBe(true);
          expect(out).toEqual([target]);
        }
      );
    });

    it("says an unsigned entry has no image and requests nothing more", async () => {
      await withServer([jsonHandler(200, entry("e1"))], async (server) => {
        await expect(signaturesGet({ ...common, entryId: "e1" })).rejects.toThrow(/not signed/);
        expect(server.requests).toHaveLength(1);
      });
    });

    it("explains a forbidden signature id as a login without the signatures permission", async () => {
      await withServer(
        [jsonHandler(200, entry("e1", { signature: "signed", signature_attachment_id: "att-9" })), jsonHandler(200, { attachments: [], gone: [], forbidden: ["att-9"] })],
        async () => {
          await expect(signaturesGet({ ...common, entryId: "e1", output: join(dir, "files", "x.png") })).rejects.toThrow(/without the signatures permission.*jetlog login/);
        }
      );
    });
  });

  describe("remove", () => {
    it("previews, then sends signature_attachment_id null for each signed entry in one batch", async () => {
      await withServer(
        [jsonHandler(200, entry("e1", { signature: "signed", signature_attachment_id: "a1" })), jsonHandler(200, entry("e2", { signature: "signed", signature_attachment_id: "a2" })), jsonHandler(201, { id: "batch-1" }), jsonHandler(200, { entries: [] })],
        async (server) => {
          await signaturesRemove({ ...common, entryIds: ["e1", "e2"], yes: true });
          expect(server.requests[2]!.path).toBe("/api/import_batches");
          expect(server.requests[3]!.method).toBe("PUT");
          expect(server.requests[3]!.path).toBe("/api/entries");
          expect(server.requests[3]!.headers["x-jetlog-batch-id"]).toBe("batch-1");
          expect(server.requests[3]!.body).toEqual({ entries: [{ id: "e1", signature_attachment_id: null }, { id: "e2", signature_attachment_id: null }] });
          const text = err.join("\n");
          expect(text).toContain("signature: signed");
          expect(text).toContain("The signature image is removed from these entries");
          expect(text).toContain("recorded in your account's audit log");
          expect(text).toContain("Removed the signature from 2 entries.");
        }
      );
    });

    it("skips entries that are not signed with a reason", async () => {
      await withServer(
        [jsonHandler(200, entry("e1", { signature: "signed" })), jsonHandler(200, entry("e2")), jsonHandler(200, entry("e3", { signature: "waived" })), jsonHandler(201, { id: "batch-1" }), jsonHandler(200, { entries: [] })],
        async (server) => {
          await signaturesRemove({ ...common, entryIds: ["e1", "e2", "e3"], yes: true });
          expect(server.requests[4]!.body).toEqual({ entries: [{ id: "e1", signature_attachment_id: null }] });
          const text = err.join("\n");
          expect(text).toContain("not signed.");
          expect(text).toContain("waived, not signed.");
        }
      );
    });

    it("does nothing when no entry is signed", async () => {
      await withServer([jsonHandler(200, entry("e1"))], async (server) => {
        await signaturesRemove({ ...common, entryIds: ["e1"], yes: true });
        expect(server.requests).toHaveLength(1);
        expect(err.join("\n")).toContain("nothing to do.");
      });
    });

    it("needs at least one entry id", async () => {
      await withServer([], async () => {
        await expect(signaturesRemove({ ...common, entryIds: [] })).rejects.toThrow(/at least one entry id/);
      });
    });
  });

  it("waive sends one PUT for the unsigned entries and skips waived and signed ones", async () => {
    await withServer(
      [
        jsonHandler(200, entry("e1")),
        jsonHandler(200, entry("e2", { signature: "waived" })),
        jsonHandler(200, entry("e3", { signature: "signed" })),
        jsonHandler(200, entry("e4")),
        jsonHandler(201, { id: "batch-1" }),
        jsonHandler(200, { entries: [] })
      ],
      async (server) => {
        await signaturesWaive({ ...common, entryIds: ["e1", "e2", "e3", "e4", "e1"], yes: true });
        expect(server.requests).toHaveLength(6);
        const put = server.requests[5]!;
        expect(put.headers["x-jetlog-batch-id"]).toBe("batch-1");
        expect(put.body).toEqual({ entries: [{ id: "e1", signature_waived: true }, { id: "e4", signature_waived: true }] });
        const text = err.join("\n");
        expect(text).toContain("already waived");
        expect(text).toContain("already signed. Use `signatures attach` to replace");
        expect(text).toContain("Waiving records these hours as signed in your own totals.");
        expect(text).toContain("Waived 2 entries.");
      }
    );
  });

  it("waive does nothing when every entry is already waived", async () => {
    await withServer([jsonHandler(200, entry("e1", { signature: "waived" }))], async (server) => {
      await signaturesWaive({ ...common, entryIds: ["e1"], yes: true });
      expect(server.requests).toHaveLength(1);
      expect(err.join("\n")).toContain("nothing to do.");
    });
  });

  it("waive skips a bulk entry", async () => {
    await withServer([jsonHandler(200, entry("e1", { is_bulk: true }))], async (server) => {
      await signaturesWaive({ ...common, entryIds: ["e1"], yes: true });
      expect(server.requests).toHaveLength(1);
    });
  });

  it("unwaive writes signature_waived false for waived entries only", async () => {
    await withServer(
      [jsonHandler(200, entry("e1", { signature: "waived" })), jsonHandler(200, entry("e2")), jsonHandler(201, { id: "batch-1" }), jsonHandler(200, { entries: [] })],
      async (server) => {
        await signaturesUnwaive({ ...common, entryIds: ["e1", "e2"], yes: true });
        expect(server.requests[3]!.body).toEqual({ entries: [{ id: "e1", signature_waived: false }] });
        expect(err.join("\n")).toContain("not waived");
      }
    );
  });

  it("waive reports an unknown entry plainly", async () => {
    await withServer([jsonHandler(404, { error: "not_found" })], async () => {
      await expect(signaturesWaive({ ...common, entryIds: ["nope"], yes: true })).rejects.toThrow(/entry nope not found/);
    });
  });

  it("request creates the link and prints the URL on stdout and the id on stderr", async () => {
    await withServer(
      [
        jsonHandler(200, entry("e1")),
        jsonHandler(200, entry("e2", { signature: "waived" })),
        jsonHandler(201, { signature_request: { id: "req-1", url: "https://jetlog.app/sign/abc", expires_at: "2026-10-08T10:00:00Z" } })
      ],
      async (server) => {
        await signaturesRequest({ ...common, entryIds: ["e1", "e2"], yes: true });
        expect(server.requests[2]!.method).toBe("POST");
        expect(server.requests[2]!.path).toBe("/api/signature_requests");
        expect(server.requests[2]!.body).toEqual({ entry_ids: ["e1", "e2"] });
        expect(out).toEqual(["https://jetlog.app/sign/abc"]);
        expect(err.join("\n")).toContain("Request id req-1, expires 2026-10-08T10:00:00Z. Revoke with: jetlog signatures revoke req-1");
        expect(err.join("\n")).toContain("Anyone who has the link can sign these entries for 48 hours.");
      }
    );
  });

  it("request refuses signed and bulk entries before creating anything", async () => {
    await withServer([jsonHandler(200, entry("e1", { signature: "signed" })), jsonHandler(200, entry("e2", { is_bulk: true }))], async (server) => {
      await expect(signaturesRequest({ ...common, entryIds: ["e1", "e2"], yes: true })).rejects.toThrow(/cannot be signed through a link/);
      expect(server.requests).toHaveLength(2);
      expect(out).toEqual([]);
    });
  });

  it("request refuses more than 20 entries without a request", async () => {
    await withServer([], async (server) => {
      const ids = Array.from({ length: 21 }, (_, i) => `e${i}`);
      await expect(signaturesRequest({ ...common, entryIds: ids, yes: true })).rejects.toThrow(/at most 20/);
      expect(server.requests).toHaveLength(0);
    });
  });

  it("revoke deletes the request and names a missing one", async () => {
    await withServer([(_req, res) => res.writeHead(204).end(), jsonHandler(404, { error: "not_found" })], async (server) => {
      await signaturesRevoke({ ...common, requestId: "req-1" });
      expect(server.requests[0]!.method).toBe("DELETE");
      expect(server.requests[0]!.path).toBe("/api/signature_requests/req-1");
      await expect(signaturesRevoke({ ...common, requestId: "req-2" })).rejects.toThrow(/signing request req-2.*not found/);
    });
  });

  describe("server error messages", () => {
    async function failWith(status: number, body: unknown, headers: Record<string, string> = {}): Promise<string> {
      let message = "";
      await withServer([jsonHandler(200, entry("e1")), jsonHandler(201, { id: "batch-1" }), jsonHandler(status, body, headers)], async () => {
        try {
          await signaturesWaive({ ...common, entryIds: ["e1"], yes: true });
        } catch (e) {
          message = (e as Error).message;
        }
      });
      return message;
    }

    it("explains each signature_rejected reason in plain words", async () => {
      const message = await failWith(422, { error: "signature_rejected", errors: [{ id: "e1", reason: "signature_conflict" }] });
      expect(message).toBe("a signature and a waiver cannot be set in the same change.");
    });

    it("no longer knows the removed reasons and shows them as a generic code", async () => {
      const message = await failWith(422, { error: "signature_rejected", errors: [{ id: "e1", reason: "signature_origin_not_allowed" }] });
      expect(message).toBe("the signature was rejected (signature_origin_not_allowed).");
    });

    it("explains a signature that is still in the older format", async () => {
      const message = await failWith(422, { error: "signature_rejected", errors: [{ id: "e1", reason: "legacy_signature_not_migrated" }] });
      expect(message).toContain("older format");
      expect(message).toContain("Nothing was changed");
    });

    it("explains that a signed entry cannot be waived", async () => {
      const message = await failWith(422, { error: "signature_rejected", errors: [{ id: "e1", reason: "already_signed" }] });
      expect(message).toBe("this entry is signed, so it cannot be waived. Remove the signature first.");
    });

    it("lists reasons per entry when several entries were rejected", async () => {
      const message = await failWith(422, { error: { code: "signature_rejected", message: "x", errors: [{ id: "e1", reason: "signature_conflict" }, { id: "e2", reason: "entry_not_signable" }] } });
      expect(message).toContain("entry e1: a signature and a waiver");
      expect(message).toContain("entry e2: this entry cannot be signed");
    });

    it("does not echo an unknown reason that is not a plain code", async () => {
      const message = await failWith(422, { error: "signature_rejected", errors: [{ id: "e1", reason: "<script>x</script>" }] });
      expect(message).toBe("the signature was rejected.");
    });

    it("explains signature_not_applied", async () => {
      const message = await failWith(409, { error: "signature_not_applied", entry_ids: ["e1"] });
      expect(message).toContain("Nothing was written.");
      expect(message).toContain("Entries: e1.");
    });

    it("explains entries_not_signable with the ids", async () => {
      const message = await failWith(422, { error: "entries_not_signable", ids: ["e1", "e2"] });
      expect(message).toContain("e1, e2");
    });

    it("fails at once on a signature budget 429 and says how long to wait, without retrying", async () => {
      const message = await failWith(429, { error: "signature_budget_exceeded" }, { "retry-after": "1800" });
      expect(message).toBe("the hourly limit for signature actions is used up. Try again in 30 minutes.");
    });

    it("tells the user to log in again on insufficient_scope", async () => {
      const message = await failWith(403, { error: "insufficient_scope" });
      expect(message).toContain("Run `jetlog login` again");
    });
  });
});
