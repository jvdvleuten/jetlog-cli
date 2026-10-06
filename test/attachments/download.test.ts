import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadRoot, saveInsideRoot, safeFileName, saveAttachment } from "../../src/attachments/download.js";

describe("safeFileName", () => {
  it("keeps only the last path part", () => {
    expect(safeFileName("../../etc/passwd", "application/pdf")).toBe("passwd.pdf");
    expect(safeFileName("C:\\Users\\x\\load sheet.pdf", "application/pdf")).toBe("load sheet.pdf");
  });

  it("removes control and bidirectional characters", () => {
    expect(safeFileName("a\u001b[31mb\u202egnp.exe\u0000.pdf", "application/pdf")).toBe("a[31mbgnp.exe.pdf");
  });

  it("forces the extension to match the content type", () => {
    expect(safeFileName("ramp.exe", "image/jpeg")).toBe("ramp.jpg");
    expect(safeFileName("ramp", "image/png")).toBe("ramp.png");
    expect(safeFileName("ramp.JPEG", "image/jpeg")).toBe("ramp.JPEG");
    expect(safeFileName("photo.png", "application/pdf")).toBe("photo.pdf");
  });

  it("never returns a hidden or empty name and stays within 255 bytes", () => {
    expect(safeFileName(".bashrc", "application/pdf")).toBe("bashrc.pdf");
    expect(safeFileName(" .hidden", "image/png")).toBe("hidden.png");
    expect(safeFileName("\t.x", "image/png")).toBe("x.png");
    expect(safeFileName(". . name", "image/png")).toBe("name.png");
    expect(safeFileName("", "image/png")).toBe("attachment.png");
    expect(safeFileName("..", "image/png")).toBe("attachment.png");
    expect(Buffer.byteLength(safeFileName("é".repeat(400) + ".pdf", "application/pdf"))).toBeLessThanOrEqual(255);
  });
});

describe("saveAttachment", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-save-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const meta = { attachment_id: "0123456789abcdef", content_type: "application/pdf", file_name: "../sneaky.pdf" };

  it("writes a sanitised name inside the directory with mode 0600", async () => {
    const path = await saveAttachment(meta, Buffer.from("bytes"), { dir });
    expect(path).toBe(join(dir, "sneaky.pdf"));
    expect((await readFile(path)).toString()).toBe("bytes");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("falls back to a name from the attachment id when the server sent none", async () => {
    const path = await saveAttachment({ attachment_id: "0123456789abcdef", content_type: "image/png" }, Buffer.from("x"), { dir });
    expect(path).toBe(join(dir, "attachment-01234567.png"));
  });

  it("refuses to overwrite without force, and overwrites with it", async () => {
    await writeFile(join(dir, "sneaky.pdf"), "old");
    await expect(saveAttachment(meta, Buffer.from("new"), { dir })).rejects.toThrow(/already exists.*--force/);
    expect((await readFile(join(dir, "sneaky.pdf"))).toString()).toBe("old");
    await saveAttachment(meta, Buffer.from("new"), { dir, force: true });
    expect((await readFile(join(dir, "sneaky.pdf"))).toString()).toBe("new");
  });

  it("honours an explicit path, and treats an existing directory as a target directory", async () => {
    const explicit = join(dir, "mine.bin");
    expect(await saveAttachment(meta, Buffer.from("a"), { path: explicit })).toBe(explicit);
    await expect(saveAttachment(meta, Buffer.from("b"), { path: explicit })).rejects.toThrow(/already exists/);
    expect(await saveAttachment(meta, Buffer.from("c"), { path: dir })).toBe(join(dir, "sneaky.pdf"));
  });
});

describe("saveInsideRoot", () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-root-"));
    root = join(dir, "root");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const meta = { attachment_id: "0123456789abcdef", content_type: "application/pdf" };

  it("creates the root and keeps every name inside it, whatever the name says", async () => {
    for (const name of ["../../escape.pdf", "/etc/passwd", "..", "a/b/c.pdf", "..\\..\\x.pdf"]) {
      const path = await saveInsideRoot(root, meta, Buffer.from("x"), name);
      expect(path.startsWith(await realpath(root))).toBe(true);
    }
    expect((await readdir(dir)).sort()).toEqual(["root"]);
    expect((await readdir(root)).sort()).toEqual(["attachment-01234567.pdf", "c.pdf", "escape.pdf", "passwd.pdf", "x.pdf"]);
  });

  it("never overwrites, and never follows a symlink at the target name", async () => {
    await mkdir(root, { recursive: true });
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "precious");
    await symlink(outside, join(root, "link.pdf"));
    await writeFile(join(root, "kept.pdf"), "old");
    await expect(saveInsideRoot(root, meta, Buffer.from("new"), "link.pdf")).rejects.toThrow(/never overwritten/);
    await expect(saveInsideRoot(root, meta, Buffer.from("new"), "kept.pdf")).rejects.toThrow(/never overwritten/);
    expect((await readFile(outside)).toString()).toBe("precious");
    expect((await readFile(join(root, "kept.pdf"))).toString()).toBe("old");
  });

  it("resolves a root that is itself a symlink and writes into its target", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    await symlink(real, root);
    const path = await saveInsideRoot(root, meta, Buffer.from("x"), "a.pdf");
    expect(await readdir(real)).toEqual(["a.pdf"]);
    expect((await readFile(path)).toString()).toBe("x");
  });

  it("writes with mode 0600", async () => {
    const path = await saveInsideRoot(root, meta, Buffer.from("x"), "a.pdf");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("downloadRoot", () => {
  const original = process.env.JETLOG_DOWNLOAD_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.JETLOG_DOWNLOAD_DIR;
    else process.env.JETLOG_DOWNLOAD_DIR = original;
  });

  it("defaults to ~/Downloads/jetlog and honours JETLOG_DOWNLOAD_DIR", () => {
    delete process.env.JETLOG_DOWNLOAD_DIR;
    expect(downloadRoot().endsWith(join("Downloads", "jetlog"))).toBe(true);
    process.env.JETLOG_DOWNLOAD_DIR = "/tmp/somewhere";
    expect(downloadRoot()).toBe("/tmp/somewhere");
  });
});
