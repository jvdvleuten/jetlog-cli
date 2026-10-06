import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import { startDeviceAuthorization, pollDeviceToken, DeviceFlowError } from "../../src/auth/device-flow.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

describe("device flow", () => {
  it("starts a device authorization and returns the grant", async () => {
    const server = new TestServer([
      jsonHandler(200, {
        device_code: "dc_1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://jetlog.app/device",
        verification_uri_complete: "https://jetlog.app/device?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 5,
        match_number: 42
      })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      const grant = await startDeviceAuthorization({ client, scope: "read" });
      expect(grant.user_code).toBe("ABCD-EFGH");
      expect(grant.match_number).toBe(42);
      expect(server.requests[0]!.body).toMatchObject({ client_id: "jetlog-cli", scope: "read" });
    } finally {
      await server.stop();
    }
  });

  it("polls through authorization_pending before succeeding", async () => {
    const server = new TestServer([
      jsonHandler(400, { error: "authorization_pending" }),
      jsonHandler(400, { error: "authorization_pending" }),
      jsonHandler(200, {
        access_token: "jlp_minted",
        token_type: "Bearer",
        scope: "read",
        expires_in: 7776000,
        token_id: 1
      })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      const ticks: string[] = [];
      const token = await pollDeviceToken({
        client,
        deviceCode: "dc_1",
        intervalSeconds: 0.01,
        expiresInSeconds: 30,
        onTick: (reason) => ticks.push(reason)
      });
      expect(token.access_token).toBe("jlp_minted");
      expect(ticks.filter((t) => t === "pending").length).toBe(2);
    } finally {
      await server.stop();
    }
  });

  it("slow_down adds 5 seconds to the poll interval", { timeout: 7000 }, async () => {
    const server = new TestServer([
      jsonHandler(400, { error: "slow_down" }),
      jsonHandler(200, {
        access_token: "jlp_minted",
        token_type: "Bearer",
        scope: "read",
        expires_in: 7776000,
        token_id: 1
      })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      const ticks: Array<[string, number]> = [];
      await pollDeviceToken({
        client,
        deviceCode: "dc_1",
        intervalSeconds: 0.01,
        expiresInSeconds: 30,
        onTick: (reason, nextInterval) => ticks.push([reason, nextInterval])
      });
      expect(ticks[0]).toEqual(["slow_down", 5.01]);
    } finally {
      await server.stop();
    }
  });

  it("surfaces access_denied as a terminal DeviceFlowError", async () => {
    const server = new TestServer([jsonHandler(400, { error: "access_denied" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      await expect(
        pollDeviceToken({ client, deviceCode: "dc_1", intervalSeconds: 0.01, expiresInSeconds: 30 })
      ).rejects.toBeInstanceOf(DeviceFlowError);
    } finally {
      await server.stop();
    }
  });

  it("surfaces invalid_grant (newer server behavior) as terminal too", async () => {
    const server = new TestServer([jsonHandler(400, { error: "invalid_grant" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      await expect(
        pollDeviceToken({ client, deviceCode: "dc_1", intervalSeconds: 0.01, expiresInSeconds: 30 })
      ).rejects.toThrow(/no longer valid/);
    } finally {
      await server.stop();
    }
  });

  it("times out locally once expiresInSeconds has elapsed", async () => {
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(
      pollDeviceToken({ client, deviceCode: "dc_1", intervalSeconds: 0.01, expiresInSeconds: 0 })
    ).rejects.toMatchObject({ reason: "expired_token" });
  });

  it("maps access_denied + number_mismatch to its own message", async () => {
    const server = new TestServer([
      jsonHandler(400, { error: "access_denied", error_description: "number_mismatch" })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      const err = await pollDeviceToken({
        client,
        deviceCode: "dc_1",
        intervalSeconds: 0.01,
        expiresInSeconds: 30,
        matchNumber: 42
      }).catch((e) => e);
      expect(err).toBeInstanceOf(DeviceFlowError);
      expect(err.reason).toBe("access_denied");
      expect(err.description).toBe("number_mismatch");
      expect(err.message).toContain("didn't match 42");
      expect(err.message).toContain("jetlog login");
    } finally {
      await server.stop();
    }
  });

  it("keeps the plain denial message when there is no error_description", async () => {
    const server = new TestServer([jsonHandler(400, { error: "access_denied" })]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      const err = await pollDeviceToken({
        client,
        deviceCode: "dc_1",
        intervalSeconds: 0.01,
        expiresInSeconds: 30,
        matchNumber: 42
      }).catch((e) => e);
      expect(err.message).toBe("login was denied in the app.");
    } finally {
      await server.stop();
    }
  });

  it("reports jetlog_viewed once through onViewed and the tick info", async () => {
    const server = new TestServer([
      jsonHandler(400, { error: "authorization_pending" }),
      jsonHandler(400, { error: "authorization_pending", jetlog_viewed: true }),
      jsonHandler(400, { error: "authorization_pending", jetlog_viewed: true }),
      jsonHandler(200, {
        access_token: "jlp_minted",
        token_type: "Bearer",
        scope: "read",
        expires_in: 7776000,
        token_id: 1
      })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl });
      let viewedCalls = 0;
      const viewedFlags: boolean[] = [];
      await pollDeviceToken({
        client,
        deviceCode: "dc_1",
        intervalSeconds: 0.01,
        expiresInSeconds: 30,
        onViewed: () => viewedCalls++,
        onTick: (_reason, _interval, info) => viewedFlags.push(info.viewed)
      });
      expect(viewedCalls).toBe(1);
      expect(viewedFlags).toEqual([false, true, true]);
    } finally {
      await server.stop();
    }
  });
});
