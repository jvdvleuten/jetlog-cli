/**
 * The write commands that touch signatures, files and photos always preview and ask unless `--yes`.
 * Every other test passes `yes: true`, so this file pins the prompt itself: a no sends no write, a yes
 * without `--yes` does, and the confirm function is what decides.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfile } from "../../src/auth/credentials.js";

const confirmMock = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>());
vi.mock("../../src/commands/confirm.js", () => ({ confirm: confirmMock }));

import { attachmentsAdd, attachmentsRemove } from "../../src/commands/attachments.js";
import { photosSet } from "../../src/commands/photos.js";
import { signaturesAttach, signaturesRequest, signaturesUnwaive, signaturesWaive } from "../../src/commands/signatures.js";
import { TestServer, jsonHandler, type Handler } from "../helpers/test-server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const common = { profile: "default" };

const entry = (extra: Record<string, unknown> = {}) => ({
  id: "e1",
  date: "2026-10-01",
  flight_number: "KL1234",
  from: "AMS",
  to: "LHR",
  signature: "none",
  is_bulk: false,
  attachments: [],
  ...extra
});
const ROW = { id: "r1", version: 4, entry_id: "e1", attachment_id: "a1", file_name: "ramp.png", is_deleted: false };

interface Case {
  name: string;
  /** Handlers up to and including the prompt, i.e. the reads. */
  reads: Handler[];
  /** Handlers after the prompt, i.e. the writes. */
  writes: (server: () => TestServer) => Handler[];
  run: (file: string) => Promise<void>;
  /** The write that must (not) be sent. */
  write: string;
}

const upload =
  (server: () => TestServer): Handler[] => [
    (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "att-1", status: "pending", upload: { url: `${server().baseUrl}/bucket/att-1`, headers: { "content-type": "image/png" } } }));
    },
    (_req, res) => res.writeHead(200).end(),
    jsonHandler(200, { id: "att-1", status: "stored" })
  ];

const cases: Case[] = [
  {
    name: "signatures attach",
    reads: [jsonHandler(200, entry())],
    writes: (server) => [jsonHandler(201, { id: "b1" }), ...upload(server), jsonHandler(200, { entries: [{ id: "e1" }] })],
    run: (file) => signaturesAttach({ ...common, entryId: "e1", image: file }),
    write: "PUT /api/entries"
  },
  {
    name: "signatures waive",
    reads: [jsonHandler(200, entry())],
    writes: () => [jsonHandler(201, { id: "b1" }), jsonHandler(200, { entries: [] })],
    run: () => signaturesWaive({ ...common, entryIds: ["e1"] }),
    write: "PUT /api/entries"
  },
  {
    name: "signatures unwaive",
    reads: [jsonHandler(200, entry({ signature: "waived" }))],
    writes: () => [jsonHandler(201, { id: "b1" }), jsonHandler(200, { entries: [] })],
    run: () => signaturesUnwaive({ ...common, entryIds: ["e1"] }),
    write: "PUT /api/entries"
  },
  {
    name: "signatures request",
    reads: [jsonHandler(200, entry())],
    writes: () => [jsonHandler(201, { signature_request: { id: "req-1", url: "https://jetlog.app/sign/abc", expires_at: "2026-10-08T10:00:00Z" } })],
    run: () => signaturesRequest({ ...common, entryIds: ["e1"] }),
    write: "POST /api/signature_requests"
  },
  {
    name: "attachments add",
    reads: [jsonHandler(200, entry())],
    writes: (server) => [jsonHandler(201, { id: "b1" }), ...upload(server), jsonHandler(200, { entry_attachments: [] })],
    run: (file) => attachmentsAdd({ ...common, entryId: "e1", files: [file] }),
    write: "PUT /api/entry_attachments"
  },
  {
    name: "attachments remove",
    reads: [jsonHandler(200, { entry_attachments: [ROW], sync_cursor: 4 })],
    writes: () => [jsonHandler(201, { id: "b1" }), jsonHandler(200, { entry_attachments: [] })],
    run: () => attachmentsRemove({ ...common, id: "r1" }),
    write: "PUT /api/entry_attachments"
  },
  {
    name: "photos set",
    reads: [jsonHandler(200, { people: [{ id: "p1", first_name: "Jan", last_name: "Jansen", photo_attachment_id: null }] })],
    writes: (server) => [jsonHandler(201, { id: "b1" }), ...upload(server), jsonHandler(200, { people: [] })],
    run: (file) => photosSet({ ...common, personId: "p1", image: file }),
    write: "PUT /api/people"
  }
];

describe("confirmation prompts of the write commands", () => {
  let dir: string;
  let file: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-prompts-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
    await mkdir(join(dir, "files"));
    file = join(dir, "files", "image.png");
    await writeFile(file, PNG);
    confirmMock.mockReset();
    err = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  async function run(c: Case, answer: boolean): Promise<string[]> {
    confirmMock.mockResolvedValue(answer);
    let server!: TestServer;
    server = new TestServer([...c.reads, ...c.writes(() => server)]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await c.run(file);
      return server.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
    } finally {
      await server.stop();
    }
  }

  it.each(cases)("$name asks, and answering no sends no write and prints aborted", async (c) => {
    const requests = await run(c, false);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(c.reads.length);
    expect(requests.some((r) => r === c.write || r.startsWith("POST /api/import_batches") || r.startsWith("POST /api/attachments"))).toBe(false);
    expect(err.join("\n")).toContain("aborted");
  });

  it.each(cases)("$name asks, and answering yes without --yes sends the write", async (c) => {
    const requests = await run(c, true);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(requests).toContain(c.write);
    expect(err.join("\n")).not.toContain("aborted");
  });
});
