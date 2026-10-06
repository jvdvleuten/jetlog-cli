import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProfile } from "../../src/auth/credentials.js";
import { changesApply, changesShow } from "../../src/commands/changes.js";
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
});
