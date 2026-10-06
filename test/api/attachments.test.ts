import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  ApiError,
  applyChanges,
  attachmentDownloadUrls,
  confirmAttachment,
  createAttachment,
  createSignatureRequest,
  createUploadLink,
  getEntry,
  getUploadLink,
  getPresigned,
  putPresigned
} from "../../src/api/client.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);

describe("attachment client calls", () => {
  it("createAttachment posts the declaration and returns a dedupe hit as upload null", async () => {
    const server = new TestServer([jsonHandler(200, { id: "a1", status: "stored", upload: null })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const sha = createHash("sha256").update(PNG).digest("hex");
      const created = await createAttachment(client, { kind: "entry_file", sha256: sha, content_type: "image/png", byte_size: PNG.length });
      expect(created.upload).toBeNull();
      expect(server.requests[0]!.method).toBe("POST");
      expect(server.requests[0]!.path).toBe("/api/attachments");
      expect(server.requests[0]!.body).toEqual({ kind: "entry_file", sha256: sha, content_type: "image/png", byte_size: PNG.length });
    } finally {
      await server.stop();
    }
  });

  it("putPresigned sends the signed headers exactly (content-length included) and no Authorization header", async () => {
    const server = new TestServer([(_req, res) => res.writeHead(200).end()]);
    await server.start();
    try {
      await putPresigned(
        {
          url: `${server.baseUrl}/bucket/obj?X-Amz-Signature=abc`,
          headers: { "content-type": "image/png", "x-amz-checksum-sha256": "c2hhMjU2", "content-length": String(PNG.length) }
        },
        PNG
      );
      const req = server.requests[0]!;
      expect(req.method).toBe("PUT");
      expect(req.path).toBe("/bucket/obj?X-Amz-Signature=abc");
      expect(req.headers["content-type"]).toBe("image/png");
      expect(req.headers["x-amz-checksum-sha256"]).toBe("c2hhMjU2");
      expect(req.headers["content-length"]).toBe(String(PNG.length));
      expect(req.headers["authorization"]).toBeUndefined();
      expect(req.headers["x-jetlog-client"]).toBeUndefined();
      expect(req.rawBody.equals(PNG)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("putPresigned turns a storage refusal into an ApiError that does not look like a Jetlog 403", async () => {
    const server = new TestServer([(_req, res) => res.writeHead(403).end("<Error/>")]);
    await server.start();
    try {
      await expect(putPresigned({ url: `${server.baseUrl}/x`, headers: {} }, PNG)).rejects.toMatchObject({
        code: "upload_failed",
        message: expect.stringContaining("HTTP 403")
      });
    } finally {
      await server.stop();
    }
  });

  it("getPresigned returns the bytes without an Authorization header", async () => {
    const server = new TestServer([(_req, res) => res.writeHead(200).end(PNG)]);
    await server.start();
    try {
      const bytes = await getPresigned(`${server.baseUrl}/dl`);
      expect(bytes.equals(PNG)).toBe(true);
      expect(server.requests[0]!.headers["authorization"]).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("confirmAttachment retries a 503 and then succeeds", async () => {
    const server = new TestServer([jsonHandler(503, { error: "storage_unavailable" }), jsonHandler(200, { id: "a1", status: "stored" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 2 });
      await expect(confirmAttachment(client, "a1")).resolves.toEqual({ id: "a1", status: "stored" });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it("confirmAttachment does not retry a 500", async () => {
    const server = new TestServer([jsonHandler(500, { error: "boom" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
      await expect(confirmAttachment(client, "a1")).rejects.toMatchObject({ status: 500 });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("confirmAttachment maps a 409 not_uploaded to a plain message", async () => {
    const server = new TestServer([jsonHandler(409, { error: "not_uploaded" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const err = await confirmAttachment(client, "a1").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/did not reach storage/);
    } finally {
      await server.stop();
    }
  });

  it("attachmentDownloadUrls posts the ids and keeps forbidden and gone", async () => {
    const server = new TestServer([jsonHandler(200, { attachments: [], gone: ["g1"], forbidden: ["s1"] })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await attachmentDownloadUrls(client, ["g1", "s1"]);
      expect(result.forbidden).toEqual(["s1"]);
      expect(server.requests[0]!.body).toEqual({ ids: ["g1", "s1"] });
    } finally {
      await server.stop();
    }
  });

  it("getEntry accepts an enveloped and a bare entry", async () => {
    const server = new TestServer([jsonHandler(200, { entry: { id: "e1", signature: "none" } }), jsonHandler(200, { id: "e2", signature: "signed" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      expect((await getEntry(client, "e1")).signature).toBe("none");
      expect((await getEntry(client, "e2")).signature).toBe("signed");
      expect(server.requests[0]!.path).toBe("/api/cli/v1/entries/e1");
    } finally {
      await server.stop();
    }
  });
});

describe("retry limits", () => {
  it("fails at once when retry-after is above 60 seconds, naming the wait", async () => {
    const server = new TestServer([jsonHandler(429, { error: "rate_limited" }, { "retry-after": "3600" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
      const err = await client.get("/api/cli/v1/me").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toBe("rate limited, try again in 60 minutes.");
      expect(err.retryAfter).toBe(3600);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("still sleeps and retries a per-minute window 429 of up to 60 seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "45", "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new ApiClient({ baseUrl: "http://localhost:1", token: "jlp_abc", maxRetries: 3 });
      const pending = client.get("/api/cli/v1/me");
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("never retries attachment_quota_exceeded or signature_budget_exceeded", async () => {
    for (const code of ["attachment_quota_exceeded", "signature_budget_exceeded"]) {
      const server = new TestServer([jsonHandler(429, { error: code }, { "retry-after": "1" })]);
      await server.start();
      try {
        const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
        await expect(client.post("/api/attachments", {})).rejects.toMatchObject({ status: 429, code });
        expect(server.requests).toHaveLength(1);
      } finally {
        await server.stop();
      }
    }
  });

  it("still retries an ordinary 429 with a short retry-after", async () => {
    const server = new TestServer([jsonHandler(429, { error: "rate_limited" }, { "retry-after": "1" }), jsonHandler(200, { ok: true })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 2 });
      await expect(client.get("/api/cli/v1/me")).resolves.toEqual({ ok: true });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it("fails at once on a 503 whose retry-after is above 60 seconds", async () => {
    const server = new TestServer([jsonHandler(503, { error: "unavailable" }, { "retry-after": "3600" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
      await expect(client.get("/api/cli/v1/me")).rejects.toMatchObject({ status: 503 });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("does not retry too_many_open_links and says how to free a slot", async () => {
    const server = new TestServer([jsonHandler(429, { error: { code: "too_many_open_links", message: "x" }, max: 5 })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
      const err = await createSignatureRequest(client, ["e1"]).catch((e) => e);
      expect(err).toMatchObject({ status: 429, code: "too_many_open_links" });
      expect(err.message).toContain("5 open signing links");
      expect(err.message).toContain("jetlog signatures revoke");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("createSignatureRequest never retries a 5xx, because the link may exist already", async () => {
    const server = new TestServer([jsonHandler(502, { error: "bad_gateway" }), jsonHandler(201, { id: "req-1", url: "u", expires_at: "t" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
      const err = await createSignatureRequest(client, ["e1"]).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(502);
      expect(err.message).toContain("may have been created anyway");
      expect(err.message).toContain("open signing links in the Jetlog app");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("createSignatureRequest still retries a short 429", async () => {
    const server = new TestServer([jsonHandler(429, { error: "rate_limited" }, { "retry-after": "1" }), jsonHandler(201, { signature_request: { id: "req-1", url: "u", expires_at: "t" } })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 2 });
      await expect(createSignatureRequest(client, ["e1"])).resolves.toMatchObject({ id: "req-1" });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it("tells the user to log in again on 403 insufficient_scope", async () => {
    const server = new TestServer([jsonHandler(403, { error: { code: "insufficient_scope", message: "x" } })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      await expect(client.post("/api/attachments", {})).rejects.toThrow(/jetlog login/);
    } finally {
      await server.stop();
    }
  });
});

describe("upload link client calls", () => {
  it("createUploadLink posts the target and unwraps upload_link", async () => {
    const server = new TestServer([jsonHandler(201, { upload_link: { id: "ul-1", url: "https://jetlog.app/upload/t", purpose: "entry_files", expires_at: "t" } })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const link = await createUploadLink(client, { purpose: "entry_files", entry_id: "e1" });
      expect(link).toMatchObject({ id: "ul-1", url: "https://jetlog.app/upload/t" });
      expect(server.requests[0]!.method).toBe("POST");
      expect(server.requests[0]!.path).toBe("/api/upload_links");
      expect(server.requests[0]!.body).toEqual({ purpose: "entry_files", entry_id: "e1" });
    } finally {
      await server.stop();
    }
  });

  it("createUploadLink never retries a 5xx", async () => {
    const server = new TestServer([jsonHandler(500, { error: "boom" }), jsonHandler(201, { upload_link: { id: "ul-1" } })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 2 });
      await expect(createUploadLink(client, { purpose: "person_photo", person_id: "p1" })).rejects.toThrow("check the open upload links in the Jetlog app");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("getUploadLink reads the status, enveloped or bare", async () => {
    const server = new TestServer([
      jsonHandler(200, { upload_link: { status: "open", files_landed: 0 } }),
      jsonHandler(200, { status: "closed", files_landed: 2 })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      expect(await getUploadLink(client, "ul 1")).toMatchObject({ status: "open" });
      expect(server.requests[0]!.path).toBe("/api/upload_links/ul%201");
      expect(await getUploadLink(client, "ul-2")).toMatchObject({ status: "closed", files_landed: 2 });
    } finally {
      await server.stop();
    }
  });
});

describe("applyChanges links", () => {
  const pc = { id: "pc-1", status: "applied", summary: "x", operations: [], preview: [], counts: { creates: 1, updates: 0, deletes: 0 }, expires_at: "t" };
  const links = [{ index: 0, signature_request_id: "sr-1", url: "https://jetlog.app/sign/t", expires_at: "t", entry_count: 1 }];

  it("reads links beside the pending change or inside it, and defaults to none", async () => {
    const server = new TestServer([
      jsonHandler(200, { pending_change: pc, links }),
      jsonHandler(200, { pending_change: { ...pc, links } }),
      jsonHandler(200, { pending_change: pc })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      for (const expected of [links, links, []]) {
        const result = await applyChanges(client, "pc-1");
        expect(result.ok).toBe(true);
        if (result.ok === true) expect(result.links).toEqual(expected);
      }
    } finally {
      await server.stop();
    }
  });
});

describe("upload link cap message", () => {
  it("names upload links, not signing links, when the cap is hit", async () => {
    const server = new TestServer([jsonHandler(429, { error: { code: "too_many_open_links", message: "x" }, max: 5 })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
      const err = await createUploadLink(client, { purpose: "entry_files", entry_id: "e1" }).catch((e) => e);
      expect(err).toMatchObject({ status: 429, code: "too_many_open_links" });
      expect(err.message).toContain("5 open upload links");
      expect(err.message).not.toContain("signing");
      expect(err.message).not.toContain("jetlog signatures revoke");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

describe("applyChanges failures", () => {
  async function applyOnce(handlers: ReturnType<typeof jsonHandler>[]) {
    const server = new TestServer(handlers);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 3 });
      return { result: await applyChanges(client, "pc-1"), requests: server.requests };
    } finally {
      await server.stop();
    }
  }

  it("keeps the per-entry reasons of a 422 signature_rejected", async () => {
    const body = { error: { code: "signature_rejected", message: "no", errors: [{ id: "e-1", reason: "signature_conflict" }] } };
    const { result } = await applyOnce([jsonHandler(422, body)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("signature_rejected");
      expect(result.message).toContain("signature and a waiver");
    }
  });

  it("explains signature_writes_not_enabled", async () => {
    const body = { error: { code: "signature_rejected", message: "no", errors: [{ id: "e-1", reason: "signature_writes_not_enabled" }] } };
    const { result } = await applyOnce([jsonHandler(422, body)]);
    if (result.ok === false) expect(result.message).toContain("switched off on the server");
    else throw new Error("expected a failure");
  });

  it("keeps the entry ids of signature_not_applied", async () => {
    const body = { error: { code: "signature_not_applied", message: "no", entry_ids: ["e-7"] } };
    const { result } = await applyOnce([jsonHandler(409, body)]);
    if (result.ok === false) expect(result.message).toContain("e-7");
    else throw new Error("expected a failure");
  });

  it("does not retry a 5xx, and says the change may have been applied and a link cannot be shown again", async () => {
    const { result, requests } = await applyOnce([jsonHandler(502, { error: "bad_gateway" }), jsonHandler(200, { pending_change: {} })]);
    expect(requests).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.message).toContain("may have been applied anyway");
      expect(result.message).toContain("revoke it in the Jetlog app");
    }
  });

  it("adds the same hint to a 409 not_decidable", async () => {
    const body = { error: { message: "Pending change already decided", code: "not_decidable" } };
    const { result } = await applyOnce([jsonHandler(409, body)]);
    if (result.ok === false) {
      expect(result.code).toBe("not_decidable");
      expect(result.message).toContain("already decided");
      expect(result.message).toContain("may have been applied anyway");
    } else throw new Error("expected a failure");
  });

  it("does not retry a dropped connection, and returns the same hint instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:1", token: "jlp_abc", maxRetries: 3, fetchImpl });
    const result = await applyChanges(client, "pc-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.status).toBe(0);
      expect(result.message).toContain("socket hang up");
      expect(result.message).toContain("may have been applied anyway");
    }
  });

  it("still retries a 429", async () => {
    const { result, requests } = await applyOnce([
      jsonHandler(429, { error: "rate_limited" }, { "retry-after": "1" }),
      jsonHandler(200, { pending_change: { id: "pc-1", status: "applied" } })
    ]);
    expect(requests).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  it("passes missing_scopes of a 403 through", async () => {
    const body = { error: "insufficient_scope", message: "sign in again", missing_scopes: ["signatures"] };
    const { result } = await applyOnce([jsonHandler(403, body)]);
    if (result.ok === false) {
      expect(result.code).toBe("insufficient_scope");
      expect(result.missingScopes).toEqual(["signatures"]);
    } else throw new Error("expected a failure");
  });
});
