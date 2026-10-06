import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, applyChanges, getPendingChange, proposeChanges } from "../../src/api/client.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

describe("ApiClient", () => {
  it("sends the expected headers and no x-client-version", async () => {
    const server = new TestServer([jsonHandler(200, { ok: true })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      await client.get("/api/cli/v1/me");

      const req = server.requests[0]!;
      expect(req.headers["authorization"]).toBe("Bearer jlp_abc");
      expect(req.headers["x-jetlog-client"]).toMatch(/^jetlog-cli\//);
      expect(req.headers["x-client-version"]).toBeUndefined();
      expect(req.headers["user-agent"]).toMatch(/jetlog-cli/);
    } finally {
      await server.stop();
    }
  });

  it("retries on 429 honoring retry-after, then succeeds", async () => {
    const server = new TestServer([
      jsonHandler(429, { error: "rate_limited", retry_after: 0 }, { "retry-after": "0" }),
      jsonHandler(200, { ok: true })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 2 });
      const result = await client.get<{ ok: boolean }>("/api/cli/v1/me");
      expect(result.ok).toBe(true);
      expect(server.requests.length).toBe(2);
    } finally {
      await server.stop();
    }
  });

  it("retries on 5xx then throws a clear error after exhausting retries", async () => {
    const server = new TestServer([
      jsonHandler(500, { error: "server_error" }),
      jsonHandler(500, { error: "server_error" })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 1 });
      await expect(client.get("/api/cli/v1/me")).rejects.toMatchObject({ status: 500 });
      expect(server.requests.length).toBe(2);
    } finally {
      await server.stop();
    }
  });

  it("maps 401 to a clear not-logged-in message", async () => {
    const server = new TestServer([jsonHandler(401, { error: "invalid_token" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_bad" });
      await expect(client.get("/api/cli/v1/me")).rejects.toThrow(/not logged in|invalid/);
    } finally {
      await server.stop();
    }
  });

  it("maps 403 insufficient_scope to a scope-specific message", async () => {
    const server = new TestServer([jsonHandler(403, { error: "insufficient_scope" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      await expect(client.get("/api/cli/v1/me")).rejects.toThrow(/scope/);
    } finally {
      await server.stop();
    }
  });

  it("does not send an Authorization header when skipAuth is set", async () => {
    const server = new TestServer([jsonHandler(200, { ok: true })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      await client.request("/oauth/device_authorization", { method: "POST", skipAuth: true, body: {} });
      expect(server.requests[0]!.headers["authorization"]).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("ApiError carries status and code", async () => {
    const server = new TestServer([jsonHandler(403, { error: "route_not_available_to_token" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      await client.get("/api/cli/v1/me");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
      expect((err as ApiError).code).toBe("route_not_available_to_token");
    } finally {
      await server.stop();
    }
  });
});

describe("pending changes", () => {
  const samplePendingChange = {
    id: "pc-1",
    status: "pending",
    summary: "test",
    operations: [{ op: "create", resource: "entry", id: "e-1", data: {} }],
    preview: [{ index: 0, op: "create", resource: "entry", id: "e-1", before: null, after: { id: "e-1" }, changed_fields: [] }],
    counts: { creates: 1, updates: 0, deletes: 0 },
    expires_at: "2026-01-02T00:00:00Z"
  };

  it("proposeChanges returns ok:true with the pending change on 201", async () => {
    const server = new TestServer([jsonHandler(201, { pending_change: samplePendingChange })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await proposeChanges(client, "test", [{ op: "create", resource: "entry", data: {} }]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.pendingChange.id).toBe("pc-1");
      expect(server.requests[0]!.body).toEqual({ summary: "test", operations: [{ op: "create", resource: "entry", data: {} }] });
    } finally {
      await server.stop();
    }
  });

  it("proposeChanges surfaces field-level errors on 422 without throwing", async () => {
    const server = new TestServer([
      jsonHandler(422, { error: { message: "Invalid operations", errors: [{ index: 0, field: "data", message: "bad" }] } })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await proposeChanges(client, "test", [{ op: "create", resource: "entry", data: {} }]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.errors).toEqual([{ index: 0, field: "data", message: "bad" }]);
      }
    } finally {
      await server.stop();
    }
  });

  it("proposeChanges surfaces open_cap_reached on 409 without throwing", async () => {
    const server = new TestServer([
      jsonHandler(409, { error: { message: "Too many open pending changes", code: "open_cap_reached" } })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await proposeChanges(client, "test", [{ op: "create", resource: "entry", data: {} }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("open_cap_reached");
    } finally {
      await server.stop();
    }
  });

  it("applyChanges returns ok:true on 200", async () => {
    const server = new TestServer([
      jsonHandler(200, { pending_change: { ...samplePendingChange, status: "applied", applied_batch_id: "batch-1" } })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await applyChanges(client, "pc-1");
      expect(result.ok).toBe(true);
      if (result.ok === true) expect(result.pendingChange.applied_batch_id).toBe("batch-1");
    } finally {
      await server.stop();
    }
  });

  it("applyChanges surfaces a 409 stale response with its fresh preview, without throwing", async () => {
    const freshPreview = [{ index: 0, op: "update", resource: "entry", id: "e-1", before: {}, after: {}, changed_fields: ["remarks"] }];
    const server = new TestServer([
      jsonHandler(409, { error: "stale", pending_change: { ...samplePendingChange, status: "stale", preview: freshPreview } })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await applyChanges(client, "pc-1");
      expect(result.ok).toBe("stale");
      if (result.ok === "stale") expect(result.pendingChange.preview).toEqual(freshPreview);
    } finally {
      await server.stop();
    }
  });

  it("applyChanges surfaces wrong_token as a non-throwing failure", async () => {
    const server = new TestServer([
      jsonHandler(403, { error: { message: "This change was proposed by a different token", code: "wrong_token" } })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await applyChanges(client, "pc-1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("wrong_token");
    } finally {
      await server.stop();
    }
  });

  it("getPendingChange returns the pending change", async () => {
    const server = new TestServer([jsonHandler(200, { pending_change: samplePendingChange })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const pendingChange = await getPendingChange(client, "pc-1");
      expect(pendingChange.id).toBe("pc-1");
    } finally {
      await server.stop();
    }
  });
});
