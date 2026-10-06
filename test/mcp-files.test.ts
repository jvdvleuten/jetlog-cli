import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { saveProfile } from "../src/auth/credentials.js";
import { TestServer, jsonHandler, type Handler } from "./helpers/test-server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const PDF = Buffer.from("%PDF-1.7\nbody");

async function connectedClient() {
  const server = await createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

function bytesHandler(bytes: Buffer): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(bytes);
  };
}

describe("local MCP file tools", () => {
  let dir: string;
  let downloads: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let server: TestServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-mcpfiles-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    downloads = join(dir, "downloads");
    process.env.JETLOG_DOWNLOAD_DIR = downloads;
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_PROFILE;
    delete process.env.JETLOG_USER_KEY;
    delete process.env.JETLOG_PARTNER_KEY;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    delete process.env.JETLOG_DOWNLOAD_DIR;
    delete process.env.JETLOG_BASE_URL;
    delete process.env.JETLOG_TOKEN;
    await server?.stop();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** A server with queued handlers and a stored login with `scope`. */
  async function start(handlers: Handler[], scope = "read write files signatures") {
    server = new TestServer(handlers);
    await server.start();
    process.env.JETLOG_BASE_URL = server.baseUrl;
    await saveProfile("default", { token: "jlp_abc", scope });
    return server;
  }

  it("registers the file tools", async () => {
    const { client } = await connectedClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["upload_file", "download_attachment", "list_entry_attachments", "create_upload_link", "get_upload_link_status"])
    );
  });

  it("returns the fix-it error when not logged in, read-only for a read login, a files message without the files scope", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["upload_file", { path: join(dir, "x.png"), kind: "entry_file" }],
      ["create_upload_link", { purpose: "entry_files", entry_id: "e-1" }],
      ["list_entry_attachments", { entry_id: "e-1" }],
      ["download_attachment", { attachment_id: "a-1" }],
      ["get_upload_link_status", { upload_link_id: "u-1" }]
    ];
    const none = (await connectedClient()).client;
    for (const [name, args] of calls) {
      const r = await none.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toContain("not logged in");
    }

    await saveProfile("default", { token: "jlp_abc", scope: "read files" });
    const ro = (await connectedClient()).client;
    for (const [name, args] of calls.slice(0, 2)) {
      const r = await ro.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toContain("read-only");
    }

    // A login made before file access existed keeps its old powers and is told to sign in again.
    await saveProfile("default", { token: "jlp_abc", scope: "read write" });
    const old = (await connectedClient()).client;
    for (const [name, args] of calls) {
      const r = await old.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toContain("files scope");
      expect(text(r), name).toContain("jetlog login");
    }
  });

  it("maps a server-side insufficient_scope on a file tool to the files message (token override, scope unknown)", async () => {
    server = new TestServer([jsonHandler(403, { error: "insufficient_scope" })]);
    await server.start();
    process.env.JETLOG_TOKEN = "jlp_abc";
    process.env.JETLOG_BASE_URL = server.baseUrl;
    const { client } = await connectedClient();
    const r = await client.callTool({ name: "list_entry_attachments", arguments: { entry_id: "e-1" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("files scope");
  });

  describe("upload_file", () => {
    it("uploads, then the reference goes through propose_changes as an entry_attachment", async () => {
      const file = join(dir, "ramp.png");
      await writeFile(file, PNG);
      const pending = {
        id: "pc-1",
        status: "pending",
        summary: "add file",
        operations: [],
        preview: [],
        counts: { creates: 1, updates: 0, deletes: 0 },
        expires_at: "2026-10-07T00:00:00Z"
      };
      const srv = await start([
        (req, res) =>
          jsonHandler(200, { id: "att-1", status: "pending", upload: { url: `${server!.baseUrl}/put/att-1`, headers: { "content-type": "image/png" }, expires_at: "x" } })(req, res),
        (_req, res) => res.writeHead(200).end(),
        jsonHandler(200, { id: "att-1", status: "stored" }),
        jsonHandler(201, { pending_change: pending })
      ]);
      const { client } = await connectedClient();

      const up = await client.callTool({ name: "upload_file", arguments: { path: file, kind: "entry_file" } });
      expect(up.isError).toBeFalsy();
      expect(up.structuredContent).toEqual({
        path: await realpath(file),
        attachment_id: "att-1",
        sha256: createHash("sha256").update(PNG).digest("hex"),
        content_type: "image/png",
        byte_size: PNG.length,
        file_name: "ramp.png"
      });
      expect(text(up)).toContain("Nothing in the logbook has changed yet");
      expect(text(up)).toContain(`Uploaded ${await realpath(file)} (image/png,`);
      expect(text(up)).toContain("Tell the user this exact path.");
      expect(srv.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /api/attachments",
        "PUT /put/att-1",
        "POST /api/attachments/att-1/confirm"
      ]);
      expect(srv.requests[1]!.headers.authorization).toBeUndefined();

      const proposed = await client.callTool({
        name: "propose_changes",
        arguments: {
          summary: "add file",
          operations: [{ op: "create", resource: "entry_attachment", data: { entry_id: "e-1", attachment_id: "att-1" } }]
        }
      });
      expect(proposed.isError).toBeFalsy();
      expect(srv.requests[3]!.path).toBe("/api/pending_changes");
      expect((srv.requests[3]!.body as { operations: unknown[] }).operations).toEqual([
        { op: "create", resource: "entry_attachment", data: { entry_id: "e-1", attachment_id: "att-1" } }
      ]);
    });

    it("refuses a relative path, a directory and an unsupported type before any request", async () => {
      const srv = await start([]);
      const { client } = await connectedClient();
      const notAbsolute = await client.callTool({ name: "upload_file", arguments: { path: "ramp.png", kind: "entry_file" } });
      expect(notAbsolute.isError).toBe(true);
      expect(text(notAbsolute)).toContain("absolute");

      const isDir = await client.callTool({ name: "upload_file", arguments: { path: dir, kind: "entry_file" } });
      expect(isDir.isError).toBe(true);

      const exe = join(dir, "run.png");
      await writeFile(exe, "#!/bin/sh\n");
      const bad = await client.callTool({ name: "upload_file", arguments: { path: exe, kind: "entry_file" } });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toContain("not a supported file type");
      expect(srv.requests).toHaveLength(0);
    });

    it("refuses a symbolic link before any request, and never reports the link as the file", async () => {
      const target = join(dir, "passport.png");
      await writeFile(target, PNG);
      const link = join(dir, "roster.png");
      await symlink(target, link);
      const srv = await start([]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "upload_file", arguments: { path: link, kind: "entry_file" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("symbolic link");
      expect(srv.requests).toHaveLength(0);
    });

    it("gates signature uploads on the signatures scope and the other kinds on the files scope", async () => {
      const file = join(dir, "sig.png");
      await writeFile(file, PNG);
      await saveProfile("default", { token: "jlp_abc", scope: "read write files" });
      const noSig = (await connectedClient()).client;
      const sig = await noSig.callTool({ name: "upload_file", arguments: { path: file, kind: "signature" } });
      expect(sig.isError).toBe(true);
      expect(text(sig)).toContain("signatures scope");
      expect(text(sig)).not.toContain("files scope");

      await saveProfile("default", { token: "jlp_abc", scope: "read write signatures" });
      const noFiles = (await connectedClient()).client;
      const photo = await noFiles.callTool({ name: "upload_file", arguments: { path: file, kind: "person_photo" } });
      expect(photo.isError).toBe(true);
      expect(text(photo)).toContain("files scope");
    });

    it("lets a signatures-only write login upload a signature image", async () => {
      const file = join(dir, "sig.png");
      await writeFile(file, PNG);
      const srv = await start(
        [
          (req, res) =>
            jsonHandler(200, { id: "att-s", status: "pending", upload: { url: `${server!.baseUrl}/put/att-s`, headers: { "content-type": "image/png" }, expires_at: "x" } })(req, res),
          (_req, res) => res.writeHead(200).end(),
          jsonHandler(200, { id: "att-s", status: "stored" })
        ],
        "read write signatures"
      );
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "upload_file", arguments: { path: file, kind: "signature" } });
      expect(r.isError).toBeFalsy();
      expect(srv.requests).toHaveLength(3);
    });

    it("names the scope the server lists in a 403 on upload_file", async () => {
      const file = join(dir, "sig.png");
      await writeFile(file, PNG);
      server = new TestServer([jsonHandler(403, { error: "insufficient_scope", missing_scopes: ["signatures"] })]);
      await server.start();
      process.env.JETLOG_TOKEN = "jlp_abc";
      process.env.JETLOG_BASE_URL = server.baseUrl;
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "upload_file", arguments: { path: file, kind: "signature" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("signatures scope");
    });

    it("refuses a file under the CLI config directory", async () => {
      const srv = await start([]);
      const secret = join(dir, "config", "jetlog", "credentials.json");
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "upload_file", arguments: { path: secret, kind: "entry_file" } });
      expect(r.isError).toBe(true);
      expect(srv.requests).toHaveLength(0);
    });
  });

  describe("list_entry_attachments", () => {
    it("returns the signature state and files, with file names cleaned", async () => {
      await start([
        jsonHandler(200, {
          entry: {
            id: "e-1",
            signature: "waived",
            signature_attachment_id: null,
            attachments: [
              { id: "r-1", attachment_id: "a-1", file_name: "load\u001b[31msheet‮.pdf", content_type: "application/pdf", byte_size: 10, position: 1 }
            ]
          }
        })
      ]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "list_entry_attachments", arguments: { entry_id: "e-1" } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toEqual({
        entry_id: "e-1",
        signature: "waived",
        signature_attachment_id: null,
        attachments: [{ id: "r-1", attachment_id: "a-1", file_name: "load[31msheet.pdf", content_type: "application/pdf", byte_size: 10, position: 1 }]
      });
      expect(server!.requests[0]!.path).toBe("/api/cli/v1/entries/e-1");
    });

    it("says not found for an unknown entry, and does not read a missing attachments key as no files", async () => {
      await start([jsonHandler(404, { error: "not_found" }), jsonHandler(200, { id: "e-2" })]);
      const { client } = await connectedClient();
      const missing = await client.callTool({ name: "list_entry_attachments", arguments: { entry_id: "nope" } });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain("entry nope not found");
      const noKey = await client.callTool({ name: "list_entry_attachments", arguments: { entry_id: "e-2" } });
      expect(noKey.isError).toBe(true);
      expect(text(noKey)).toContain("files scope");
    });
  });

  describe("download_attachment", () => {
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const meta = (id: string, bytes: Buffer, type: string) => (baseUrl: string) =>
      jsonHandler(200, { attachments: [{ id, sha256: sha(bytes), content_type: type, url: `${baseUrl}/obj/${id}`, expires_at: "x" }] });

    it("saves inside the download root with a safe name and mode 0600, and returns the path", async () => {
      const srv = await start([(req, res) => meta("a-1", PDF, "application/pdf")(server!.baseUrl)(req, res), bytesHandler(PDF)]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "download_attachment", arguments: { attachment_id: "a-1", file_name: "../../evil.sh" } });
      expect(r.isError).toBeFalsy();
      const result = r.structuredContent as { path: string; file_name: string; byte_size: number };
      expect(result.file_name).toBe("evil.pdf");
      expect(result.byte_size).toBe(PDF.length);
      expect(result.path.endsWith(join("downloads", "evil.pdf"))).toBe(true);
      expect((await readFile(result.path)).equals(PDF)).toBe(true);
      expect(await readdir(dir)).not.toContain("evil.sh");
      expect(srv.requests[1]!.headers.authorization).toBeUndefined();
    });

    it("never overwrites an existing file", async () => {
      await mkdir(downloads, { recursive: true });
      await writeFile(join(downloads, "keep.pdf"), "mine");
      await start([(req, res) => meta("a-1", PDF, "application/pdf")(server!.baseUrl)(req, res), bytesHandler(PDF)]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "download_attachment", arguments: { attachment_id: "a-1", file_name: "keep.pdf" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("never overwritten");
      expect((await readFile(join(downloads, "keep.pdf"))).toString()).toBe("mine");
    });

    it("does not follow a symlink inside the root to a file outside it", async () => {
      const outside = join(dir, "outside.txt");
      await writeFile(outside, "precious");
      await mkdir(downloads, { recursive: true });
      await symlink(outside, join(downloads, "link.pdf"));
      await symlink(join(dir, "does-not-exist"), join(downloads, "dangling.pdf"));
      await start([
        (req, res) => meta("a-1", PDF, "application/pdf")(server!.baseUrl)(req, res),
        bytesHandler(PDF),
        (req, res) => meta("a-2", PDF, "application/pdf")(server!.baseUrl)(req, res),
        bytesHandler(PDF)
      ]);
      const { client } = await connectedClient();
      for (const [id, name] of [["a-1", "link.pdf"], ["a-2", "dangling.pdf"]] as const) {
        const r = await client.callTool({ name: "download_attachment", arguments: { attachment_id: id, file_name: name } });
        expect(r.isError, name).toBe(true);
      }
      expect((await readFile(outside)).toString()).toBe("precious");
      expect(await readdir(dir)).not.toContain("does-not-exist");
    });

    it("saves a signature image when the login has the signatures scope, without the files scope", async () => {
      await start([(req, res) => meta("sig-1", PNG, "image/png")(server!.baseUrl)(req, res), bytesHandler(PNG)], "read write signatures");
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "download_attachment", arguments: { attachment_id: "sig-1", file_name: "signature" } });
      expect(r.isError).toBeFalsy();
      const result = r.structuredContent as { path: string; content_type: string };
      expect(result.content_type).toBe("image/png");
      expect((await readFile(result.path)).equals(PNG)).toBe(true);
    });

    it("explains a signature image the server holds back from a login without the signatures scope, and writes nothing", async () => {
      await start([jsonHandler(200, { attachments: [], gone: [], forbidden: ["sig-1"] })], "read files");
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "download_attachment", arguments: { attachment_id: "sig-1" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("without the signatures permission");
      expect(text(r)).toContain("jetlog login");
      await expect(readdir(downloads)).rejects.toThrow();
    });

    it("refuses before any request when the login has neither the files nor the signatures scope", async () => {
      const srv = await start([], "read write");
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "download_attachment", arguments: { attachment_id: "sig-1" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("files scope");
      expect(srv.requests).toHaveLength(0);
    });

    it("rejects bytes that do not match the stored checksum", async () => {
      await start([(req, res) => meta("a-1", PDF, "application/pdf")(server!.baseUrl)(req, res), bytesHandler(Buffer.from("%PDF-tampered"))]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "download_attachment", arguments: { attachment_id: "a-1" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("checksum");
    });
  });

  describe("create_upload_link", () => {
    const link = (extra: Record<string, unknown> = {}) => ({
      upload_link: {
        id: "ul-1",
        url: "https://jetlog.app/upload/tok",
        purpose: "entry_files",
        entry_id: "e-1",
        person_id: null,
        target_label: "2026-10-01 KL1234 AMS to LHR",
        max_files: 10,
        max_bytes_per_file: 26214400,
        accepted_types: ["image/png"],
        requires_owner_verification: false,
        expires_at: "2026-10-06T12:30:00Z",
        ...extra
      }
    });

    it("creates an entry_files link and shows the URL", async () => {
      const srv = await start([jsonHandler(201, link())]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "create_upload_link", arguments: { purpose: "entry_files", entry_id: "e-1" } });
      expect(r.isError).toBeFalsy();
      expect(srv.requests[0]!.path).toBe("/api/upload_links");
      expect(srv.requests[0]!.body).toEqual({ purpose: "entry_files", entry_id: "e-1" });
      expect(r.structuredContent).toMatchObject({ upload_link_id: "ul-1", url: "https://jetlog.app/upload/tok", max_files: 10, requires_owner_verification: false });
      expect(text(r)).toContain("https://jetlog.app/upload/tok");
      expect(text(r)).toContain("get_upload_link_status");
    });

    it("creates a person_photo link", async () => {
      const srv = await start([jsonHandler(201, link({ purpose: "person_photo", entry_id: null, person_id: "p-1" }))]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "create_upload_link", arguments: { purpose: "person_photo", person_id: "p-1" } });
      expect(r.isError).toBeFalsy();
      expect(srv.requests[0]!.body).toEqual({ purpose: "person_photo", person_id: "p-1" });
    });

    it("rejects the signature purpose without calling the server", async () => {
      const srv = await start([]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "create_upload_link", arguments: { purpose: "entry_signature", entry_id: "e-1" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("signature purpose is not available");
      expect(srv.requests).toHaveLength(0);
    });

    it("rejects an unknown purpose and a purpose without its target", async () => {
      const srv = await start([]);
      const { client } = await connectedClient();
      for (const args of [
        { purpose: "documents", entry_id: "e-1" },
        { purpose: "entry_files" },
        { purpose: "entry_files", entry_id: "e-1", person_id: "p-1" },
        { purpose: "person_photo", entry_id: "e-1" }
      ]) {
        const r = await client.callTool({ name: "create_upload_link", arguments: args });
        expect(r.isError, JSON.stringify(args)).toBe(true);
      }
      expect(srv.requests).toHaveLength(0);
    });

    it("never retries a 5xx, because the link may exist already", async () => {
      const srv = await start([jsonHandler(503, { error: "x" }), jsonHandler(201, link())]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "create_upload_link", arguments: { purpose: "entry_files", entry_id: "e-1" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("upload link may have been created anyway");
      expect(srv.requests).toHaveLength(1);
    });
  });

  describe("get_upload_link_status", () => {
    it("reports status and landed files with names cleaned", async () => {
      const srv = await start([
        jsonHandler(200, {
          status: "open",
          files_landed: 1,
          files: [{ file_name: "a\u0007.pdf", content_type: "application/pdf", byte_size: 3, attachment_id: "a-1" }],
          expires_at: "2026-10-06T12:30:00Z"
        })
      ]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "get_upload_link_status", arguments: { upload_link_id: "ul-1" } });
      expect(r.isError).toBeFalsy();
      expect(srv.requests[0]!.path).toBe("/api/upload_links/ul-1");
      expect(r.structuredContent).toMatchObject({ status: "open", files_landed: 1, files: [{ file_name: "a.pdf", attachment_id: "a-1" }] });
    });

    it("says not found for a link of another connection", async () => {
      await start([jsonHandler(404, { error: "not_found" })]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "get_upload_link_status", arguments: { upload_link_id: "ul-9" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("not found");
    });
  });

  describe("propose_changes and apply_changes additions", () => {
    it("lists the new resources and the signature and photo fields in the propose_changes description", async () => {
      const { client } = await connectedClient();
      const tool = (await client.listTools()).tools.find((t) => t.name === "propose_changes")!;
      const resource = (tool.inputSchema as { properties: { operations: { items: { properties: { resource: { enum: string[] } } } } } }).properties.operations.items
        .properties.resource.enum;
      expect(resource).toEqual(["entry", "person", "aircraft", "fstd", "entry_attachment", "signature_link"]);
      for (const term of ["signature_attachment_id", "signature_waived", "photo_attachment_id", "NOT accepted by an authority", "entry_ids"]) {
        expect(tool.description, term).toContain(term);
      }
    });

    it("tells a write login that lacks files or signatures which scope is missing, not that it is read-only", async () => {
      const body = { error: "insufficient_scope", message: "sign in again", missing_scopes: ["files"] };
      await start([jsonHandler(403, body), jsonHandler(403, body)], "read write");
      const { client } = await connectedClient();
      const propose = await client.callTool({
        name: "propose_changes",
        arguments: { summary: "photo", operations: [{ op: "update", resource: "person", id: "p-1", data: { photo_attachment_id: "a-1" } }] }
      });
      expect(propose.isError).toBe(true);
      expect(text(propose)).toContain("files scope");
      expect(text(propose)).not.toContain("read-only");

      const apply = await client.callTool({ name: "apply_changes", arguments: { pending_id: "pc-9" } });
      expect(apply.isError).toBe(true);
      expect(text(apply)).toContain("files scope");
      expect(text(apply)).not.toContain("read-only");
    });

    it("keeps the read-only message for an insufficient_scope without named scopes on an unknown scope", async () => {
      server = new TestServer([jsonHandler(403, { error: "insufficient_scope" })]);
      await server.start();
      process.env.JETLOG_TOKEN = "jlp_abc";
      process.env.JETLOG_BASE_URL = server.baseUrl;
      const { client } = await connectedClient();
      const r = await client.callTool({
        name: "propose_changes",
        arguments: { summary: "x", operations: [{ op: "delete", resource: "entry", id: "e-1" }] }
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("read-only");
    });

    it("apply_changes explains a rejected signature and an unknown outcome", async () => {
      const rejected = { error: { code: "signature_rejected", message: "no", errors: [{ id: "e-1", reason: "signature_writes_not_enabled" }] } };
      await start([jsonHandler(422, rejected), jsonHandler(502, { error: "bad_gateway" })]);
      const { client } = await connectedClient();
      const a = await client.callTool({ name: "apply_changes", arguments: { pending_id: "pc-1" } });
      expect(text(a)).toContain("switched off on the server");
      const b = await client.callTool({ name: "apply_changes", arguments: { pending_id: "pc-1" } });
      expect(text(b)).toContain("may have been applied anyway");
      expect(server!.requests).toHaveLength(2);
    });

    it("apply_changes returns the signing links the change created", async () => {
      const pc = {
        id: "pc-2",
        status: "applied",
        applied_batch_id: "b-2",
        summary: "link",
        operations: [],
        preview: [],
        counts: { creates: 1, updates: 0, deletes: 0 },
        expires_at: "x"
      };
      const links = [{ index: 0, signature_request_id: "sr-1", url: "https://jetlog.app/sign/tok", expires_at: "2026-10-08T00:00:00Z", entry_count: 2 }];
      await start([jsonHandler(200, { pending_change: pc, links }), jsonHandler(200, { pending_change: pc })]);
      const { client } = await connectedClient();
      const r = await client.callTool({ name: "apply_changes", arguments: { pending_id: "pc-2" } });
      expect(r.isError).toBeFalsy();
      expect((r.structuredContent as { links: unknown[] }).links).toEqual(links);
      expect(text(r)).toContain("https://jetlog.app/sign/tok");
      expect(text(r)).toContain("Anyone who has it can sign");

      const plain = await client.callTool({ name: "apply_changes", arguments: { pending_id: "pc-2" } });
      expect(plain.structuredContent).not.toHaveProperty("links");
    });
  });
});
