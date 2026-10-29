import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProfile } from "../../src/auth/credentials.js";
import { changesApply, changesPropose, changesShow } from "../../src/commands/changes.js";
import { getProposeChangesJsonSchema } from "../../src/changes-schema.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

const samplePendingChange = {
  id: "pc-1",
  status: "pending",
  summary: "add a flight",
  operations: [{ op: "create", resource: "entry", id: "e-1", data: {} }],
  preview: [{ index: 0, op: "create", resource: "entry", id: "e-1", before: null, after: { id: "e-1" }, changed_fields: [] }],
  counts: { creates: 1, updates: 0, deletes: 0 },
  expires_at: "2026-01-06T00:00:00Z"
};

describe("changes commands", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-changes-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  it("show fetches and prints the pending change", async () => {
    const server = new TestServer([jsonHandler(200, { pending_change: samplePendingChange })]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await changesShow({ profile: "default", id: "pc-1", json: true });
      expect(server.requests[0]!.path).toBe("/api/pending_changes/pc-1");
    } finally {
      await server.stop();
    }
  });

  it("apply fetches the preview then applies with --yes, skipping the confirmation prompt", async () => {
    const server = new TestServer([
      jsonHandler(200, { pending_change: samplePendingChange }),
      jsonHandler(200, { pending_change: { ...samplePendingChange, status: "applied", applied_batch_id: "batch-1" } })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await changesApply({ profile: "default", id: "pc-1", yes: true });
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]!.method).toBe("GET");
      expect(server.requests[1]!.method).toBe("POST");
      expect(server.requests[1]!.path).toBe("/api/pending_changes/pc-1/apply");
    } finally {
      await server.stop();
    }
  });

  it("apply does nothing further when the change is already decided", async () => {
    const server = new TestServer([jsonHandler(200, { pending_change: { ...samplePendingChange, status: "rejected" } })]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await changesApply({ profile: "default", id: "pc-1", yes: true });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("apply surfaces a stale response without throwing, and does not treat it as a hard error", async () => {
    const server = new TestServer([
      jsonHandler(200, { pending_change: samplePendingChange }),
      jsonHandler(409, { error: "stale", pending_change: { ...samplePendingChange, status: "stale" } })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await changesApply({ profile: "default", id: "pc-1", yes: true });
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.exitCode = undefined;
      await server.stop();
    }
  });

  it("apply passes operationIndices through to the apply request", async () => {
    const server = new TestServer([
      jsonHandler(200, { pending_change: samplePendingChange }),
      jsonHandler(200, { pending_change: { ...samplePendingChange, status: "applied", applied_batch_id: "batch-1" } })
    ]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await changesApply({ profile: "default", id: "pc-1", yes: true, operationIndices: [0] });
      expect(server.requests[1]!.body).toEqual({ operation_indices: [0] });
    } finally {
      await server.stop();
    }
  });

  it("apply prints the signing links of the change once, URL on stdout and details on stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    const applied = { ...samplePendingChange, status: "applied", applied_batch_id: "batch-1" };
    const links = [{ index: 0, signature_request_id: "sr-1", url: "https://jetlog.app/sign/tok\u001b[31m", expires_at: "2026-10-08T00:00:00Z", entry_count: 2 }];
    const server = new TestServer([jsonHandler(200, { pending_change: samplePendingChange }), jsonHandler(200, { pending_change: { ...applied, links } })]);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    try {
      await changesApply({ profile: "default", id: "pc-1", yes: true });
      expect(out).toHaveLength(1);
      expect(out[0]).toContain("https://jetlog.app/sign/tok");
      expect(out[0]).not.toContain("\u001b");
      const text = err.join("\n");
      expect(text).toContain("applied:");
      expect(text).toContain("sr-1");
      expect(text).toContain("2 entries");
      expect(text).toContain("jetlog signatures revoke sr-1");
    } finally {
      vi.restoreAllMocks();
      await server.stop();
    }
  });

  describe("propose", () => {
    const payload = {
      summary: "Correct the registration",
      operations: [{ op: "update", resource: "entry", id: "e-1", data: { registration: "PH-EZA" } }]
    };
    const proposed = {
      ...samplePendingChange,
      summary: "Correct the registration",
      operations: payload.operations,
      preview: [
        {
          index: 0,
          op: "update",
          resource: "entry",
          id: "e-1",
          before: { registration: "PH-EZB" },
          after: { registration: "PH-EZA" },
          changed_fields: ["registration"]
        }
      ],
      counts: { creates: 0, updates: 1, deletes: 0 }
    };
    let file: string;

    async function writePayload(value: unknown): Promise<void> {
      file = join(dir, "payload.json");
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    }

    afterEach(() => vi.restoreAllMocks());

    it("sends the payload, prints before and after per field and the exact apply command", async () => {
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
      const server = new TestServer([jsonHandler(201, { pending_change: proposed })]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
      await writePayload(payload);
      try {
        await changesPropose({ profile: "default", file });
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]!.method).toBe("POST");
        expect(server.requests[0]!.path).toBe("/api/pending_changes");
        expect(server.requests[0]!.body).toEqual(payload);
        const text = out.join("\n");
        expect(text).toContain('registration: "PH-EZB" -> "PH-EZA"');
        expect(text).toContain("jetlog changes apply pc-1");
        expect(text).toContain("Nothing has been written yet");
      } finally {
        await server.stop();
      }
    });

    it("accepts notes on a person", async () => {
      const ops = [{ op: "update", resource: "person", id: "p1", data: { notes: "prefers the left seat" } }];
      const server = new TestServer([jsonHandler(201, { pending_change: { ...proposed, operations: ops } })]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
      await writePayload({ summary: "Add notes", operations: ops });
      vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await changesPropose({ profile: "default", file });
        expect(server.requests[0]!.body).toMatchObject({ operations: ops });
      } finally {
        await server.stop();
      }
    });

    it("prints machine-readable output with --json", async () => {
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
      const server = new TestServer([jsonHandler(201, { pending_change: proposed })]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
      await writePayload(payload);
      try {
        await changesPropose({ profile: "default", file, json: true });
        const parsed = JSON.parse(out.join("\n"));
        expect(parsed.id).toBe("pc-1");
        expect(parsed.next).toBe("jetlog changes apply pc-1");
        expect(parsed.counts.updates).toBe(1);
        expect(parsed.preview[0].after).toEqual({ registration: "PH-EZA" });
      } finally {
        await server.stop();
      }
    });

    it("rejects an invalid payload before any request is made", async () => {
      const server = new TestServer([]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
      await writePayload({ summary: "x", operations: [{ op: "rename", resource: "entry" }] });
      try {
        await expect(changesPropose({ profile: "default", file })).rejects.toThrow(/operations\.0\.op/);
        expect(server.requests).toHaveLength(0);
      } finally {
        await server.stop();
      }
    });

    it("rejects text that is not JSON", async () => {
      await writePayload("not json");
      await expect(changesPropose({ profile: "default", file })).rejects.toThrow(/could not read the payload as JSON/);
    });

    it("tells the pilot how to get write access on an insufficient_scope answer", async () => {
      const server = new TestServer([jsonHandler(403, { error: "insufficient_scope" })]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
      await writePayload(payload);
      try {
        await expect(changesPropose({ profile: "default", file })).rejects.toThrow(/jetlog login --scope write/);
      } finally {
        await server.stop();
      }
    });

    it("surfaces a server validation error", async () => {
      const server = new TestServer([jsonHandler(422, { error: { code: "validation_failed", message: "invalid", errors: [{ index: 0, field: "registration", message: "bad field" }] } })]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
      await writePayload(payload);
      try {
        await expect(changesPropose({ profile: "default", file })).rejects.toThrow(/operation 0, registration: bad field/);
      } finally {
        await server.stop();
      }
    });

    it("refuses text the server would refuse, per operation and field, before any request", async () => {
      const server = new TestServer([]);
      await server.start();
      await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
      await writePayload({
        summary: "x".repeat(501),
        operations: [
          { op: "update", resource: "entry", id: "e-1", data: { registration: "PH\u200BEZA" } },
          { op: "update", resource: "entry", id: "e-2", data: { remarks: "a\u0000b" } }
        ]
      });
      try {
        const error = await changesPropose({ profile: "default", file }).catch((e: Error) => e);
        expect((error as Error).message).toContain("summary: must be at most 500 characters");
        expect((error as Error).message).toContain("operation 0, registration: must not contain control, bidi or zero-width characters");
        expect((error as Error).message).toContain("operation 1, remarks: must not contain the NUL character (U+0000)");
        expect(server.requests).toHaveLength(0);
      } finally {
        await server.stop();
      }
    });

    it("exposes a JSON Schema for the payload", () => {
      const schema = getProposeChangesJsonSchema() as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties)).toEqual(["summary", "operations"]);
    });

    describe("places", () => {
      // The preview shape POST /api/pending_changes really returns for a place create (backend places.md).
      const placeAfter = {
        id: "pl-1",
        version: 2,
        is_deleted: false,
        code: "EHAM",
        icao: "EHAM",
        iata: "AMS",
        name: "Schiphol",
        latitude: 52.3086,
        longitude: 4.7639,
        country_code: "NL",
        timezone: "Europe/Amsterdam",
        kind: "airport"
      };

      it("sends a place create and prints its preview", async () => {
        const ops = [
          {
            op: "create",
            resource: "place",
            data: { icao: "EHAM", iata: "AMS", name: "Schiphol", latitude: 52.3086, longitude: 4.7639, country_code: "nl", timezone: "Europe/Amsterdam" }
          }
        ];
        const preview = [{ index: 0, op: "create", resource: "place", id: "pl-1", before: null, after: placeAfter, changed_fields: ["code", "name", "icao", "iata"] }];
        const server = new TestServer([jsonHandler(201, { pending_change: { ...proposed, operations: ops, preview, counts: { creates: 1, updates: 0, deletes: 0 } } })]);
        await server.start();
        await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
        await writePayload({ summary: "Add Schiphol", operations: ops });
        const out: string[] = [];
        vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
        try {
          await changesPropose({ profile: "default", file });
          expect(server.requests[0]!.body).toEqual({ summary: "Add Schiphol", operations: ops });
          expect(out.join("\n")).toContain("[0] create place pl-1");
          expect(out.join("\n")).toContain("changed: code, name, icao, iata");
        } finally {
          await server.stop();
        }
      });

      it("accepts a place update, a delete without data and clearing values with null", async () => {
        const ops = [
          { op: "update", resource: "place", id: "pl-1", data: { name: null, timezone: "Europe/Amsterdam", latitude: null, kind: "airport" } },
          { op: "delete", resource: "place", id: "pl-2" },
          { op: "update", resource: "place", id: "pl-3", data: { is_deleted: false, code: "ZZ01" } }
        ];
        const server = new TestServer([jsonHandler(201, { pending_change: { ...proposed, operations: ops } })]);
        await server.start();
        await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
        await writePayload({ summary: "Places", operations: ops });
        vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          await changesPropose({ profile: "default", file });
          expect(server.requests[0]!.body).toMatchObject({ operations: ops });
        } finally {
          await server.stop();
        }
      });

      it("refuses an unknown key or a wrong type in a place before any request", async () => {
        const server = new TestServer([]);
        await server.start();
        await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
        try {
          const cases: [Record<string, unknown>, RegExp][] = [
            [{ icao_code: "EHAM" }, /operations\.0\.data: a place does not have "icao_code"\. Place fields: code, icao, iata, name, latitude, longitude, country_code, timezone, kind, is_deleted/],
            [{ latitude: "52.3" }, /operations\.0\.data\.latitude/],
            [{ latitude: 91 }, /operations\.0\.data\.latitude: must be a number from -90 to 90/],
            [{ longitude: -180.5 }, /operations\.0\.data\.longitude: must be a number from -180 to 180/],
            [{ country_code: "NLD" }, /operations\.0\.data\.country_code: must be a two-letter ISO country code/],
            [{ kind: "heliport" }, /operations\.0\.data\.kind: must be "airport"/],
            [{ icao: 1234 }, /operations\.0\.data\.icao/],
            [{ is_deleted: "yes" }, /operations\.0\.data\.is_deleted/]
          ];
          for (const [data, error] of cases) {
            await writePayload({ summary: "x", operations: [{ op: "create", resource: "place", data }] });
            await expect(changesPropose({ profile: "default", file }), JSON.stringify(data)).rejects.toThrow(error);
          }
          expect(server.requests).toHaveLength(0);
        } finally {
          await server.stop();
        }
      });

      it("does not apply the place rules to other resources", async () => {
        const ops = [{ op: "update", resource: "aircraft", id: "a-1", data: { latitude: "not a place" } }];
        const server = new TestServer([jsonHandler(201, { pending_change: { ...proposed, operations: ops } })]);
        await server.start();
        await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
        await writePayload({ summary: "x", operations: ops });
        vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          await changesPropose({ profile: "default", file });
          expect(server.requests).toHaveLength(1);
        } finally {
          await server.stop();
        }
      });

      it("shows the server's place rule errors per operation", async () => {
        const server = new TestServer([
          jsonHandler(422, {
            error: {
              message: "Invalid operations",
              errors: [{ index: 0, field: "code", message: "is already a code of your place 20c06f97-c201-426d-934f-347df6bcbbdc" }]
            }
          })
        ]);
        await server.start();
        await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
        await writePayload({ summary: "x", operations: [{ op: "create", resource: "place", data: { code: "ZZ01" } }] });
        try {
          await expect(changesPropose({ profile: "default", file })).rejects.toThrow(
            /operation 0, code: is already a code of your place 20c06f97-c201-426d-934f-347df6bcbbdc/
          );
        } finally {
          await server.stop();
        }
      });

      it("lists place as a resource in the JSON Schema, which stays representable", () => {
        const schema = getProposeChangesJsonSchema() as {
          properties: { operations: { items: { properties: { resource: { enum: string[] } } } } };
        };
        expect(schema.properties.operations.items.properties.resource.enum).toContain("place");
      });
    });
  });
});
