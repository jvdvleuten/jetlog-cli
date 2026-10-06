import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveProfile } from "../../src/auth/credentials.js";
import { photosGet, photosSet } from "../../src/commands/photos.js";
import { TestServer, jsonHandler, type Handler } from "../helpers/test-server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const PEOPLE = { people: [{ id: "p1", first_name: "Jan", last_name: "Jansen", photo_attachment_id: null }, { id: "p2", first_name: "Els", last_name: "Bakker", photo_attachment_id: "ph-2" }] };

describe("photos commands", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-photos-"));
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

  it("get and set tell a token without the files scope to log in again, not that there is no photo", async () => {
    // What a token without `files` really gets: `has_photo`, but no `photo_attachment_id` key.
    const noFiles = { people: [{ id: "p2", first_name: "Els", last_name: "Bakker", has_photo: true }] };
    const image = join(dir, "files", "els.png");
    await writeFile(image, PNG);
    await withServer([jsonHandler(200, noFiles)], async () => {
      await expect(photosGet({ profile: "default", personId: "p2" })).rejects.toThrow(/files scope.*jetlog login/);
    });
    await withServer([jsonHandler(200, noFiles)], async (server) => {
      await expect(photosSet({ profile: "default", personId: "p2", image, yes: true })).rejects.toThrow(/files scope.*jetlog login/);
      expect(server.requests).toHaveLength(1);
    });
  });

  it("set uploads the image and writes photo_attachment_id on the person", async () => {
    const image = join(dir, "files", "jan.png");
    await writeFile(image, PNG);
    let server!: TestServer;
    await withServer(
      [
        jsonHandler(200, PEOPLE),
        jsonHandler(201, { id: "batch-1" }),
        (req, res) =>
          jsonHandler(201, { id: "att-1", status: "pending", upload: { url: `${server.baseUrl}/bucket/att-1`, headers: { "content-type": "image/png" } } })(req, res),
        (_req, res) => res.writeHead(200).end(),
        jsonHandler(200, { id: "att-1", status: "stored" }),
        jsonHandler(200, { people: [{ id: "p1" }] })
      ],
      async (s) => {
        server = s;
        await photosSet({ profile: "default", personId: "p1", image, yes: true });
        expect(server.requests[2]!.body).toMatchObject({ kind: "person_photo", content_type: "image/png" });
        const put = server.requests[5]!;
        expect(put.method).toBe("PUT");
        expect(put.path).toBe("/api/people");
        expect(put.headers["x-jetlog-batch-id"]).toBe("batch-1");
        expect(put.body).toEqual({ people: [{ id: "p1", photo_attachment_id: "att-1" }] });
      }
    );
  });

  it("set refuses an unknown person and a PDF before uploading anything", async () => {
    const image = join(dir, "files", "jan.png");
    await writeFile(image, PNG);
    await withServer([jsonHandler(200, PEOPLE)], async (server) => {
      await expect(photosSet({ profile: "default", personId: "nope", image, yes: true })).rejects.toThrow(/person nope not found/);
      expect(server.requests).toHaveLength(1);
    });
    const pdf = join(dir, "files", "doc.pdf");
    await writeFile(pdf, "%PDF-1.7\n");
    await expect(photosSet({ profile: "default", personId: "p1", image: pdf, yes: true })).rejects.toThrow(/supported file type/);
  });

  it("get downloads the photo into the target", async () => {
    const sha = createHash("sha256").update(PNG).digest("hex");
    const target = join(dir, "els.png");
    let server!: TestServer;
    await withServer(
      [
        jsonHandler(200, PEOPLE),
        (req, res) => jsonHandler(200, { attachments: [{ id: "ph-2", sha256: sha, content_type: "image/png", url: `${server.baseUrl}/dl/ph-2`, expires_at: "x" }] })(req, res),
        (_req, res) => res.writeHead(200).end(PNG)
      ],
      async (s) => {
        server = s;
        await photosGet({ profile: "default", personId: "p2", output: target });
        expect((await readFile(target)).equals(PNG)).toBe(true);
      }
    );
  });

  it("get says so when the person has no photo", async () => {
    await withServer([jsonHandler(200, PEOPLE)], async () => {
      await expect(photosGet({ profile: "default", personId: "p1" })).rejects.toThrow(/Jan Jansen has no photo/);
    });
  });
});
