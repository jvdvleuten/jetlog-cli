import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProfile } from "../../src/auth/credentials.js";
import { runImport } from "../../src/commands/import.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

const FIXTURE = {
  entries: [
    {
      type: "flight",
      date: "2026-01-01",
      flight_number: "KL1001",
      from: "EHAM",
      to: "LFPG",
      people: [
        { ref_id: "SELF", role: "PIC" },
        { ref_id: "REF2", role: "FO" }
      ]
    }
  ],
  people: [{ ref_id: "REF2", first_name: "Jane", last_name: "Doe" }]
};

function meHandler() {
  return jsonHandler(200, { user_id: 1, self_person_id: "self-1", email: "pilot@example.com", auth_kind: "pat", token: null, server_version: "1.0.0" });
}

/** `runImport` loads the logged-in airport catalog and places first (`useLoggedInAirports`). */
function airportHandlers() {
  return [jsonHandler(200, { system_places: [], sync_cursor: 0 }), jsonHandler(200, { places: [], sync_cursor: 0 })];
}

function mirrorHandlers() {
  return [
    ...airportHandlers(),
    meHandler(),
    jsonHandler(200, { entries: [], pagination: { limit: 200, has_more: false, next_cursor: null } }),
    jsonHandler(200, { people: [] }),
    jsonHandler(200, { aircraft: [] }),
    jsonHandler(200, { fstd: [], sync_cursor: 0 }),
    // `fetchAirlineCatalog` always reads its on-disk cache (empty here, a
    // fresh XDG_CACHE_HOME per test) before issuing this request, so it
    // consistently lands after the 5 synchronously-dispatched mirror calls.
    jsonHandler(200, { airlines: [] })
  ];
}

describe("runImport", () => {
  let configDir: string;
  let cacheDir: string;
  let file: string;
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  const originalXdgCache = process.env.XDG_CACHE_HOME;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "jetlog-cli-import-config-"));
    cacheDir = await mkdtemp(join(tmpdir(), "jetlog-cli-import-cache-"));
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.XDG_CACHE_HOME = cacheDir;
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
    file = join(configDir, "fixture.json");
    await writeFile(file, JSON.stringify(FIXTURE), "utf-8");
  });

  afterEach(async () => {
    if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfig;
    if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCache;
    await rm(configDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("--dry-run only reads the mirror and never writes anything", async () => {
    const server = new TestServer(mirrorHandlers());
    await server.start();
    await saveProfile("default", { token: "jlp_write", baseUrl: server.baseUrl });
    try {
      await runImport({ files: [file], from: "deeplink-json", dryRun: true, profile: "default" });
      expect(server.requests.every((r) => r.method === "GET")).toBe(true);
      expect(server.requests.length).toBe(8);
    } finally {
      await server.stop();
    }
  });

  it("--yes writes people then entries under a freshly created batch", async () => {
    const server = new TestServer([
      ...mirrorHandlers(),
      jsonHandler(201, { id: "batch-1", created_at: "2026-01-01T00:00:00Z" }),
      jsonHandler(200, { people: [{ id: "new-person", first_name: "Jane", last_name: "Doe" }] }),
      jsonHandler(200, { entries: [{ id: "new-entry" }] })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_write", baseUrl: server.baseUrl });
    try {
      await runImport({ files: [file], from: "deeplink-json", yes: true, profile: "default", label: "test import" });

      const methodsAfterMirror = server.requests.slice(8).map((r) => ({ method: r.method, path: r.path.split("?")[0] }));
      expect(methodsAfterMirror).toEqual([
        { method: "POST", path: "/api/import_batches" },
        { method: "PUT", path: "/api/people" },
        { method: "PUT", path: "/api/entries" }
      ]);

      const peopleReq = server.requests[9]!;
      expect(peopleReq.headers["x-jetlog-batch-id"]).toBe("batch-1");
      const peopleBody = peopleReq.body as { people: { id: string; first_name: string }[] };
      expect(peopleBody.people[0]!.first_name).toBe("Jane");
      const newPersonId = peopleBody.people[0]!.id;

      const entriesReq = server.requests[10]!;
      expect(entriesReq.headers["x-jetlog-batch-id"]).toBe("batch-1");
      const entriesBody = entriesReq.body as { entries: { flight_number: string; people: { person_id: string }[] }[] };
      expect(entriesBody.entries[0]!.flight_number).toBe("KL1001");
      // SELF resolves to the logged-in user's own person id, REF2 to the newly created (client-assigned) person id.
      expect(entriesBody.entries[0]!.people.map((p) => p.person_id).sort()).toEqual([newPersonId, "self-1"].sort());
    } finally {
      await server.stop();
    }
  });

  it("reuses the active batch from a previous run instead of opening a new one", async () => {
    const server = new TestServer([
      ...mirrorHandlers(),
      jsonHandler(200, { import_batches: [{ id: "batch-reused", status: "active" }] }),
      jsonHandler(200, { people: [{ id: "new-person" }] }),
      jsonHandler(200, { entries: [{ id: "new-entry" }] })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_write", baseUrl: server.baseUrl });
    await mkdir(join(cacheDir, "jetlog"), { recursive: true });
    await writeFile(
      join(cacheDir, "jetlog", "last-import-batch-default.json"),
      JSON.stringify({ batchId: "batch-reused", importerId: "deeplink-json" })
    );
    try {
      await runImport({ files: [file], from: "deeplink-json", yes: true, profile: "default" });
      const afterMirror = server.requests.slice(8);
      expect(afterMirror[0]!.path).toBe("/api/import_batches");
      expect(afterMirror[0]!.method).toBe("GET");
      expect(afterMirror[1]!.headers["x-jetlog-batch-id"]).toBe("batch-reused");
    } finally {
      await server.stop();
    }
  });
});
