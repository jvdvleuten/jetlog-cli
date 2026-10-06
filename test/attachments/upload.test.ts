import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import { imageDimensions, inspectFile, sniffContentType, uploadFile } from "../../src/attachments/upload.js";
import { configDir } from "../../src/auth/credentials.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const PDF = Buffer.from("%PDF-1.7\nbody");

/** A PNG head that states `width` by `height` pixels (signature, IHDR chunk header, sizes). */
function pngOfSize(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

/** A JPEG with one APP0 segment before the SOF0 segment that states the size. */
function jpegOfSize(width: number, height: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe("attachment upload", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-upload-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    await mkdir(join(dir, "files"));
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  it("sniffs the type from the bytes, ignoring the name", async () => {
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffContentType(PDF)).toBe("application/pdf");
    expect(sniffContentType(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")]))).toBe("image/heic");
    expect(sniffContentType(Buffer.from("just text"))).toBeUndefined();
    const path = join(dir, "files", "scan.pdf");
    await writeFile(path, PNG);
    expect((await inspectFile(path, "entry_file")).contentType).toBe("image/png");
  });

  it("reads the pixel size of a PNG and a JPEG from the head", () => {
    expect(imageDimensions(pngOfSize(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(jpegOfSize(9000, 100))).toEqual({ width: 9000, height: 100 });
    expect(imageDimensions(PNG)).toBeUndefined();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]))).toBeUndefined();
  });

  it("refuses a signature or photo above the pixel limit before any request, and says what to do", async () => {
    const wide = join(dir, "files", "wide.png");
    await writeFile(wide, pngOfSize(5000, 100));
    await expect(inspectFile(wide, "signature")).rejects.toThrow(/5000 by 100 pixels.*4096 pixels on each side.*Resize/);
    const tall = join(dir, "files", "tall.png");
    await writeFile(tall, pngOfSize(100, 4097));
    await expect(inspectFile(tall, "signature")).rejects.toThrow(/4097 pixels/);
    const big = join(dir, "files", "big.jpg");
    await writeFile(big, jpegOfSize(9000, 100));
    await expect(inspectFile(big, "person_photo")).rejects.toThrow(/9000 by 100 pixels.*8192/);
  });

  it("accepts images at the pixel limit, and does not check the size of entry files", async () => {
    const edge = join(dir, "files", "edge.png");
    await writeFile(edge, pngOfSize(4096, 4096));
    await expect(inspectFile(edge, "signature")).resolves.toMatchObject({ contentType: "image/png" });
    const photo = join(dir, "files", "photo.jpg");
    await writeFile(photo, jpegOfSize(8192, 8192));
    await expect(inspectFile(photo, "person_photo")).resolves.toMatchObject({ contentType: "image/jpeg" });
    const scan = join(dir, "files", "scan.png");
    await writeFile(scan, pngOfSize(12000, 12000));
    await expect(inspectFile(scan, "entry_file")).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("refuses a type the kind does not accept", async () => {
    const path = join(dir, "files", "doc.pdf");
    await writeFile(path, PDF);
    await expect(inspectFile(path, "person_photo")).rejects.toThrow(/supported file type/);
    await expect(inspectFile(path, "signature")).rejects.toThrow(/supported file type/);
  });

  it("refuses a file above the kind cap before reading it", async () => {
    const path = join(dir, "files", "big.png");
    await writeFile(path, PNG);
    await truncate(path, 2 * 1024 * 1024 + 1);
    await expect(inspectFile(path, "person_photo")).rejects.toThrow(/too large/);
    await expect(inspectFile(path, "entry_file")).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("refuses a missing file, an empty file and a directory", async () => {
    await expect(inspectFile(join(dir, "files", "nope.png"), "entry_file")).rejects.toThrow(/no such file/);
    const empty = join(dir, "files", "empty.png");
    await writeFile(empty, "");
    await expect(inspectFile(empty, "entry_file")).rejects.toThrow(/empty/);
    await expect(inspectFile(join(dir, "files"), "entry_file")).rejects.toThrow(/not a regular file/);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without opening it", async () => {
    const fifo = join(dir, "files", "pipe.png");
    execFileSync("mkfifo", [fifo]);
    await expect(inspectFile(fifo, "entry_file")).rejects.toThrow(/not a regular file/);
  });

  it("refuses a path under the CLI config directory, also through a symlink", async () => {
    await mkdir(configDir(), { recursive: true });
    const secret = join(configDir(), "credentials.json");
    await writeFile(secret, PNG);
    await expect(inspectFile(secret, "entry_file")).rejects.toThrow(/never uploaded/);
    const link = join(dir, "files", "innocent.png");
    await symlink(secret, link);
    await expect(inspectFile(link, "entry_file")).rejects.toThrow(/never uploaded/);
  });

  it("follows a symlink to an allowed regular file", async () => {
    const real = join(dir, "files", "real.png");
    await writeFile(real, PNG);
    const link = join(dir, "files", "link.png");
    await symlink(real, link);
    const file = await inspectFile(link, "entry_file");
    expect(file.fileName).toBe("link.png");
    expect(file.byteSize).toBe(PNG.length);
  });

  it("uploads: declare, PUT with the signed headers, confirm", async () => {
    const path = join(dir, "files", "ramp.png");
    await writeFile(path, PNG);
    const sha = createHash("sha256").update(PNG).digest("hex");
    const server = new TestServer([
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "att-1",
            status: "pending",
            upload: { url: `${server.baseUrl}/bucket/att-1`, headers: { "content-type": "image/png", "content-length": String(PNG.length) } }
          })
        );
      },
      (_req, res) => res.writeHead(200).end(),
      jsonHandler(200, { id: "att-1", status: "stored" })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await uploadFile(client, "entry_file", path);
      expect(result).toEqual({ path: await realpath(path), attachment_id: "att-1", sha256: sha, content_type: "image/png", byte_size: PNG.length, file_name: "ramp.png", deduped: false });
      expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /api/attachments",
        "PUT /bucket/att-1",
        "POST /api/attachments/att-1/confirm"
      ]);
      expect(server.requests[0]!.body).toEqual({ kind: "entry_file", sha256: sha, content_type: "image/png", byte_size: PNG.length });
      expect(server.requests[1]!.headers["authorization"]).toBeUndefined();
      expect(server.requests[1]!.rawBody.equals(PNG)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("skips the PUT and the confirm when the server already has the content", async () => {
    const path = join(dir, "files", "dup.pdf");
    await writeFile(path, PDF);
    const server = new TestServer([jsonHandler(200, { id: "att-9", status: "stored", upload: null })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await uploadFile(client, "entry_file", path);
      expect(result.deduped).toBe(true);
      expect(result.attachment_id).toBe("att-9");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});
