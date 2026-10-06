import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { saveProfile } from "../src/auth/credentials.js";
import { getActiveAirportIndex, getEmptyAirportIndex, setActiveAirportIndex } from "../src/airports/index.js";
import { TestServer, jsonHandler, type Handler } from "./helpers/test-server.js";

async function connectedClient() {
  const server = await createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP server", () => {
  // Isolate from the real ~/.config/jetlog/credentials.json so these tests
  // never register the read tools (or hit a real token) unless a test
  // explicitly sets one up.
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-mcp-test-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.JETLOG_TOKEN;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the expected tools (without push_payload when nothing is configured; read and write tools are always present)", async () => {
    delete process.env.JETLOG_USER_KEY;
    delete process.env.JETLOG_PARTNER_KEY;
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "apply_changes",
        "compute_totals",
        "convert_file",
        "create_upload_link",
        "download_attachment",
        "get_change_status",
        "get_import_schema",
        "get_upload_link_status",
        "import_preview",
        "list_aircraft",
        "list_entry_attachments",
        "list_people",
        "make_import_links",
        "propose_changes",
        "search_entries",
        "upload_file",
        "validate_payload",
        "whoami"
      ].sort()
    );
  });

  it("registers the read tools once JETLOG_TOKEN is set", async () => {
    process.env.JETLOG_TOKEN = "jlp_abc";
    delete process.env.JETLOG_USER_KEY;
    delete process.env.JETLOG_PARTNER_KEY;
    try {
      const { client } = await connectedClient();
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["whoami", "search_entries", "list_people", "list_aircraft"])
      );
    } finally {
      delete process.env.JETLOG_TOKEN;
    }
  });

  it("whoami tool calls the read API and returns the account", async () => {
    const server = new TestServer([
      jsonHandler(200, {
        user_id: 1,
        self_person_id: 1,
        email: "pilot@example.com",
        auth_kind: "pat",
        token: null,
        server_version: "1.0.0"
      })
    ]);
    await server.start();
    process.env.JETLOG_TOKEN = "jlp_abc";
    process.env.JETLOG_BASE_URL = server.baseUrl;
    try {
      const { client } = await connectedClient();
      const result = await client.callTool({ name: "whoami", arguments: {} });
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(JSON.parse(text).email).toBe("pilot@example.com");
    } finally {
      delete process.env.JETLOG_TOKEN;
      delete process.env.JETLOG_BASE_URL;
      await server.stop();
    }
  });

  it("registers push_payload when both keys are set", async () => {
    process.env.JETLOG_USER_KEY = "u";
    process.env.JETLOG_PARTNER_KEY = "p";
    try {
      const { client } = await connectedClient();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("push_payload");
    } finally {
      delete process.env.JETLOG_USER_KEY;
      delete process.env.JETLOG_PARTNER_KEY;
    }
  });

  it("get_import_schema returns a JSON Schema with entries/people", async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({ name: "get_import_schema", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const schema = JSON.parse(text);
    expect(schema.properties).toHaveProperty("entries");
    expect(schema.properties).toHaveProperty("people");
  });

  it("validate_payload reports an error for a missing date", async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({
      name: "validate_payload",
      arguments: { payload: { entries: [{ flight_number: "KL1023" }], people: [] } }
    });
    expect(result.isError).toBe(true);
  });

  it("make_import_links returns at least one link", async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({
      name: "make_import_links",
      arguments: {
        payload: { entries: [{ date: "2026-01-05", flight_number: "KL1023" }], people: [] }
      }
    });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const { links } = JSON.parse(text);
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toMatch(/^https:\/\/jetlog\.app\/import\?data=/);
  });

  it("import_preview parses a file and returns links without writing anything, when not logged in", async () => {
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, "fixture.json");
    await writeFile(
      file,
      JSON.stringify({
        entries: [{ type: "flight", date: "2026-01-01", flight_number: "KL1001", from: "EHAM", to: "LFPG", people: [{ ref_id: "SELF", role: "PIC" }] }]
      })
    );
    const { client } = await connectedClient();
    const result = await client.callTool({ name: "import_preview", arguments: { path: file, format: "deeplink-json" } });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.matchedAgainstExistingData).toBe(false);
    expect(parsed.parsedEntries).toBe(1);
    expect(parsed.links.length).toBeGreaterThan(0);
  });

  it("import_preview matches against the user's own data when logged in", async () => {
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, "fixture.json");
    await writeFile(
      file,
      JSON.stringify({
        entries: [{ type: "flight", date: "2026-01-01", flight_number: "KL1001", from: "EHAM", to: "LFPG", people: [{ ref_id: "SELF", role: "PIC" }] }]
      })
    );
    // Routed by path: `import_preview` loads the logged-in airport catalog and places first, and the
    // airline catalog request is not ordered relative to the mirror requests.
    const routes: Record<string, unknown> = {
      "/api/system_places": { system_places: [], sync_cursor: 0 },
      "/api/places": { places: [], sync_cursor: 0 },
      "/api/cli/v1/me": { user_id: 1, self_person_id: "self-1", email: "pilot@example.com", auth_kind: "pat", token: null, server_version: "1.0.0" },
      "/api/cli/v1/entries": { entries: [], pagination: { limit: 200, has_more: false, next_cursor: null } },
      "/api/cli/v1/people": { people: [] },
      "/api/cli/v1/aircraft": { aircraft: [] },
      "/api/fstd": { fstd: [], sync_cursor: 0 },
      "/api/cli/v1/airlines": { airlines: [] }
    };
    const routed: Handler = (req, res) => jsonHandler(200, routes[req.path.split("?")[0]!] ?? {})(req, res);
    const server = new TestServer(Array.from({ length: 12 }, () => routed));
    await server.start();
    process.env.JETLOG_TOKEN = "jlp_abc";
    process.env.JETLOG_BASE_URL = server.baseUrl;
    try {
      const { client } = await connectedClient();
      const result = await client.callTool({ name: "import_preview", arguments: { path: file, format: "deeplink-json" } });
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      const parsed = JSON.parse(text);
      expect(parsed.matchedAgainstExistingData).toBe(true);
      expect(parsed.newEntries).toBe(1);
      expect(parsed.updatedEntries).toBe(0);
    } finally {
      delete process.env.JETLOG_TOKEN;
      delete process.env.JETLOG_BASE_URL;
      await server.stop();
    }
  });

  it("convert_file sets the airport index explicitly: the empty index when offline or logged out, regardless of earlier calls", async () => {
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, "fixture.json");
    await writeFile(
      file,
      JSON.stringify({
        entries: [{ type: "flight", date: "2026-01-01", flight_number: "KL1001", from: "EHAM", to: "LFPG", people: [{ ref_id: "SELF", role: "PIC" }] }]
      })
    );
    const routes: Record<string, unknown> = {
      "/api/system_places": { system_places: [], sync_cursor: 0 },
      "/api/places": { places: [], sync_cursor: 0 }
    };
    const routed: Handler = (req, res) => jsonHandler(200, routes[req.path.split("?")[0]!] ?? {})(req, res);
    const server = new TestServer(Array.from({ length: 12 }, () => routed));
    await server.start();
    process.env.JETLOG_TOKEN = "jlp_abc";
    process.env.JETLOG_BASE_URL = server.baseUrl;
    try {
      const { client } = await connectedClient();
      const run = (args: Record<string, unknown>) => client.callTool({ name: "convert_file", arguments: { path: file, format: "deeplink-json", ...args } });

      await run({});
      expect(getActiveAirportIndex()).not.toBe(getEmptyAirportIndex());

      await run({ offline: true });
      expect(getActiveAirportIndex()).toBe(getEmptyAirportIndex());
    } finally {
      setActiveAirportIndex(undefined);
      delete process.env.JETLOG_TOKEN;
      delete process.env.JETLOG_BASE_URL;
      await server.stop();
    }
  });

  it("exposes the format rules resource", async () => {
    const { client } = await connectedClient();
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === "jetlog://format-rules")).toBe(true);
  });

  describe("pending changes (propose_changes/apply_changes/get_change_status)", () => {
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
    const writeCalls: [string, Record<string, unknown>][] = [
      ["propose_changes", { summary: "x", operations: [{ op: "create", resource: "entry", data: {} }] }],
      ["apply_changes", { pending_id: "pc-1" }],
      ["get_change_status", { pending_id: "pc-1" }]
    ];
    const readCalls: [string, Record<string, unknown>][] = [
      ["search_entries", {}],
      ["list_people", {}],
      ["list_aircraft", {}]
    ];
    // The file tools sit behind the same access gates, plus the files scope (test/mcp-files.test.ts).
    const fileWriteCalls: [string, Record<string, unknown>][] = [
      ["upload_file", { path: "/tmp/ramp.png", kind: "entry_file" }],
      ["create_upload_link", { purpose: "entry_files", entry_id: "e-1" }]
    ];
    const fileReadCalls: [string, Record<string, unknown>][] = [
      ["list_entry_attachments", { entry_id: "e-1" }],
      ["download_attachment", { attachment_id: "a-1" }],
      ["get_upload_link_status", { upload_link_id: "ul-1" }]
    ];
    const originalProfile = process.env.JETLOG_PROFILE;
    afterEach(() => {
      if (originalProfile === undefined) delete process.env.JETLOG_PROFILE;
      else process.env.JETLOG_PROFILE = originalProfile;
    });

    it("are registered but return a fix-it error when not logged in", async () => {
      const { client } = await connectedClient();
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["propose_changes", "apply_changes", "get_change_status", "whoami"]));
      for (const [name, args] of [...writeCalls, ...readCalls, ...fileWriteCalls, ...fileReadCalls]) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(true);
        expect(text(result), name).toContain("not logged in");
        expect(text(result), name).toContain("jetlog login --scope write");
        expect(text(result), name).toContain("JETLOG_PROFILE");
        expect(text(result), name).not.toContain("--profile");
      }
    });

    it("include --profile in the fix when JETLOG_PROFILE is a named profile", async () => {
      process.env.JETLOG_PROFILE = "work";
      const { client } = await connectedClient();
      const result = await client.callTool({ name: "propose_changes", arguments: writeCalls[0]![1] });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("jetlog login --scope write --profile work");
    });

    it("whoami does not error when logged out", async () => {
      const { client } = await connectedClient();
      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ logged_in: false, can_write: false, profile: "default" });
      expect(text(result)).toContain("jetlog login --scope write");
    });

    it("server instructions describe the access state", async () => {
      const none = await connectedClient();
      expect(none.client.getInstructions()).toContain("NOT logged in");
      expect(none.client.getInstructions()).toContain("jetlog login --scope write");
      expect(none.client.getInstructions()).toContain("apply_changes only after they explicitly confirm");

      await saveProfile("default", { token: "jlp_abc", scope: "read" });
      const ro = await connectedClient();
      expect(ro.client.getInstructions()).toContain("READ-ONLY");

      await saveProfile("default", { token: "jlp_abc", scope: "read write" });
      const rw = await connectedClient();
      expect(rw.client.getInstructions()).toContain("read and write access");
      expect(rw.client.getInstructions()).not.toContain("jetlog login");
    });

    it("write tools return a read-only error for a read-only profile, reads still work", async () => {
      await saveProfile("default", { token: "jlp_abc", scope: "read" });
      const { client } = await connectedClient();
      for (const [name, args] of [...writeCalls, ...fileWriteCalls]) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(true);
        expect(text(result), name).toContain("read-only");
        expect(text(result), name).toContain("nothing was changed");
        expect(text(result), name).toContain("jetlog login --scope write");
      }
    });

    it("whoami reports can_write for a stored profile", async () => {
      const me = { user_id: 1, self_person_id: 1, email: "p@example.com", auth_kind: "pat", token: null, server_version: "1" };
      const server = new TestServer([jsonHandler(200, me), jsonHandler(200, me)]);
      await server.start();
      process.env.JETLOG_BASE_URL = server.baseUrl;
      try {
        await saveProfile("default", { token: "jlp_abc", scope: "read" });
        const ro = await (await connectedClient()).client.callTool({ name: "whoami", arguments: {} });
        expect(ro.structuredContent).toMatchObject({ logged_in: true, can_write: false, email: "p@example.com", profile: "default" });
        await saveProfile("default", { token: "jlp_abc", scope: "read write" });
        const rw = await (await connectedClient()).client.callTool({ name: "whoami", arguments: {} });
        expect(rw.structuredContent).toMatchObject({ logged_in: true, can_write: true });
      } finally {
        delete process.env.JETLOG_BASE_URL;
        await server.stop();
      }
    });

    it("maps a server-side scope_missing error (unknown-scope token) to the read-only message", async () => {
      const server = new TestServer([
        jsonHandler(403, { error: "scope_missing" }),
        jsonHandler(403, { error: "scope_missing" }),
        jsonHandler(403, { error: "scope_missing" })
      ]);
      await server.start();
      process.env.JETLOG_TOKEN = "jlp_abc";
      process.env.JETLOG_BASE_URL = server.baseUrl;
      try {
        const { client } = await connectedClient();
        for (const [name, args] of writeCalls) {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, name).toBe(true);
          expect(text(result), name).toContain("read-only");
          expect(text(result), name).toContain("jetlog login --scope write");
        }
      } finally {
        delete process.env.JETLOG_TOKEN;
        delete process.env.JETLOG_BASE_URL;
        await server.stop();
      }
    });

    describe("crew reporting", () => {
      const propose = async (inputOps: unknown[], storedOps: unknown[]) => {
        const pc = {
          id: "pc-1", status: "pending", summary: "x", operations: storedOps, preview: [],
          counts: { creates: storedOps.length, updates: 0, deletes: 0 }, expires_at: "2026-01-06T00:00:00Z"
        };
        const server = new TestServer([jsonHandler(201, { pending_change: pc })]);
        await server.start();
        await saveProfile("default", { token: "jlp_abc", scope: "read write" });
        process.env.JETLOG_BASE_URL = server.baseUrl;
        try {
          const { client } = await connectedClient();
          return await client.callTool({ name: "propose_changes", arguments: { summary: "x", operations: inputOps } });
        } finally {
          delete process.env.JETLOG_BASE_URL;
          await server.stop();
        }
      };
      const msg = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

      it("reports crew and the auto-added pilot when the input had no people", async () => {
        const r = await propose(
          [{ op: "create", resource: "entry", data: { date: "2026-03-02" } }],
          [{ op: "create", resource: "entry", data: { date: "2026-03-02", people: [{ person_id: "7", role: "PIC" }] } }]
        );
        expect(r.structuredContent).toMatchObject({ crew: [{ index: 0, people: [{ person_id: "7", role: "PIC", is_self: true }] }] });
        expect(msg(r)).toContain("Operation 0: the pilot was added automatically as PIC (their default role).");
        expect(msg(r)).toContain("Say so when you show the preview, so they can correct the role.");
      });

      it("combines operations that share a role into one sentence", async () => {
        const stored = { op: "create", resource: "entry", data: { people: [{ person_id: "7", role: "PIC" }] } };
        const r = await propose([{ op: "create", resource: "entry", data: {} }, { op: "create", resource: "entry", data: {} }], [stored, stored]);
        expect(msg(r)).toContain("Operations 0, 1: the pilot was added automatically as PIC (their default role).");
      });

      it("adds no sentence when the input used SELF with a role, and flags the rewritten pilot", async () => {
        const r = await propose(
          [{ op: "create", resource: "entry", data: { people: [{ person_id: "self", role: "CP" }] } }],
          [{ op: "create", resource: "entry", data: { people: [{ person_id: "7", role: "CP" }] } }]
        );
        expect(msg(r)).not.toContain("added automatically");
        expect(r.structuredContent).toMatchObject({ crew: [{ people: [{ person_id: "7", is_self: true }] }] });
      });

      it("adds no sentence when add_self is false", async () => {
        const r = await propose(
          [{ op: "create", resource: "entry", add_self: false, data: { people: [{ person_id: "9", role: "FO" }] } }],
          [{ op: "create", resource: "entry", data: { people: [{ person_id: "9", role: "FO" }] } }]
        );
        expect(msg(r)).not.toContain("added automatically");
        const people = (r.structuredContent as { crew: { people: { is_self?: boolean }[] }[] }).crew[0]!.people;
        expect(people[0]!.is_self).toBeUndefined();
      });
    });

    it("forwards add_self and SELF people items to the propose endpoint", async () => {
      const pendingChange = {
        id: "pc-1",
        status: "pending",
        summary: "x",
        operations: [],
        preview: [],
        counts: { creates: 1, updates: 0, deletes: 0 },
        expires_at: "2026-01-06T00:00:00Z"
      };
      const server = new TestServer([jsonHandler(201, { pending_change: pendingChange })]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", scope: "read write" });
      process.env.JETLOG_BASE_URL = server.baseUrl;
      try {
        const { client } = await connectedClient();
        const result = await client.callTool({
          name: "propose_changes",
          arguments: {
            summary: "x",
            operations: [{ op: "create", resource: "entry", add_self: false, data: { people: [{ person_id: "SELF", role: "CP" }] } }]
          }
        });
        expect(result.isError).toBeFalsy();
        const body = server.requests[0]!.body as { operations: { add_self: boolean; data: { people: unknown } }[] };
        expect(body.operations[0].add_self).toBe(false);
        expect(body.operations[0].data.people).toEqual([{ person_id: "SELF", role: "CP" }]);
      } finally {
        delete process.env.JETLOG_BASE_URL;
        await server.stop();
      }
    });

    it("ARE registered for a write-scoped profile", async () => {
      await saveProfile("default", { token: "jlp_abc", scope: "read write" });
      try {
        const { client } = await connectedClient();
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        expect(names).toEqual(
          expect.arrayContaining(["propose_changes", "apply_changes", "get_change_status"])
        );
      } finally {
        delete process.env.JETLOG_TOKEN;
      }
    });

    it("ARE registered when JETLOG_TOKEN is set without a stored profile (unknown scope, best effort)", async () => {
      process.env.JETLOG_TOKEN = "jlp_abc";
      try {
        const { client } = await connectedClient();
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("propose_changes");
      } finally {
        delete process.env.JETLOG_TOKEN;
      }
    });

    it("propose_changes then apply_changes writes for real end to end", async () => {
      const pendingChange = {
        id: "pc-1",
        status: "pending",
        summary: "add a flight",
        operations: [{ op: "create", resource: "entry", id: "e-1", data: { date: "2026-01-05" } }],
        preview: [
          { index: 0, op: "create", resource: "entry", id: "e-1", before: null, after: { id: "e-1", date: "2026-01-05" }, changed_fields: [] }
        ],
        counts: { creates: 1, updates: 0, deletes: 0 },
        expires_at: "2026-01-06T00:00:00Z"
      };
      const server = new TestServer([
        jsonHandler(201, { pending_change: pendingChange }),
        jsonHandler(200, { pending_change: { ...pendingChange, status: "applied", applied_batch_id: "batch-1" } })
      ]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", scope: "read write" });
      process.env.JETLOG_BASE_URL = server.baseUrl;
      try {
        const { client } = await connectedClient();

        const proposed = await client.callTool({
          name: "propose_changes",
          arguments: { summary: "add a flight", operations: [{ op: "create", resource: "entry", data: { date: "2026-01-05" } }] }
        });
        expect(proposed.isError).toBeFalsy();
        expect((proposed.structuredContent as { pending_id: string }).pending_id).toBe("pc-1");

        const applied = await client.callTool({ name: "apply_changes", arguments: { pending_id: "pc-1" } });
        expect(applied.isError).toBeFalsy();
        expect((applied.structuredContent as { applied_batch_id: string }).applied_batch_id).toBe("batch-1");
        expect(server.requests[1]!.path).toBe("/api/pending_changes/pc-1/apply");
      } finally {
        delete process.env.JETLOG_BASE_URL;
        await server.stop();
      }
    });

    it("apply_changes surfaces a stale response as a non-error result with a fresh preview", async () => {
      const freshPreview = [
        { index: 0, op: "update", resource: "entry", id: "e-1", before: {}, after: {}, changed_fields: ["remarks"] }
      ];
      const server = new TestServer([
        jsonHandler(409, {
          error: "stale",
          pending_change: {
            id: "pc-1",
            status: "stale",
            summary: "x",
            operations: [],
            preview: freshPreview,
            counts: { creates: 0, updates: 1, deletes: 0 },
            expires_at: "2026-01-06T00:00:00Z"
          }
        })
      ]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", scope: "read write" });
      process.env.JETLOG_BASE_URL = server.baseUrl;
      try {
        const { client } = await connectedClient();
        const result = await client.callTool({ name: "apply_changes", arguments: { pending_id: "pc-1" } });
        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { status: string }).status).toBe("stale");
      } finally {
        delete process.env.JETLOG_BASE_URL;
        await server.stop();
      }
    });

    it("propose_changes surfaces a validation failure as isError:true", async () => {
      const server = new TestServer([
        jsonHandler(422, { error: { message: "Invalid operations", errors: [{ index: 0, field: "data", message: "bad field" }] } })
      ]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", scope: "read write" });
      process.env.JETLOG_BASE_URL = server.baseUrl;
      try {
        const { client } = await connectedClient();
        const result = await client.callTool({
          name: "propose_changes",
          arguments: { summary: "x", operations: [{ op: "create", resource: "entry", data: {} }] }
        });
        expect(result.isError).toBe(true);
      } finally {
        delete process.env.JETLOG_BASE_URL;
        await server.stop();
      }
    });

    it("get_change_status reports the current status", async () => {
      const server = new TestServer([
        jsonHandler(200, {
          pending_change: {
            id: "pc-1",
            status: "applied",
            summary: "x",
            operations: [],
            preview: [],
            counts: { creates: 0, updates: 0, deletes: 0 },
            expires_at: "2026-01-06T00:00:00Z",
            applied_batch_id: "batch-1"
          }
        })
      ]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", scope: "read write" });
      process.env.JETLOG_BASE_URL = server.baseUrl;
      try {
        const { client } = await connectedClient();
        const result = await client.callTool({ name: "get_change_status", arguments: { pending_id: "pc-1" } });
        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { status: string }).status).toBe("applied");
      } finally {
        delete process.env.JETLOG_BASE_URL;
        await server.stop();
      }
    });
  });
});
