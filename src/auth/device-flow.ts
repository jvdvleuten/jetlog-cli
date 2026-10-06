/**
 * RFC 8628 device authorization grant, client side.
 *
 * Coded to the RFC rather than one specific server revision: a security
 * pass on the backend (client_id binding, slow_down interval bump,
 * invalid_grant) may or may not have landed yet, so this treats
 * `invalid_grant` the same as `expired_token`/`access_denied` (a terminal
 * failure) rather than assuming it can't happen.
 */

import { ApiClient, ApiError, type DeviceAuthorizationResponse, type DeviceTokenResponse } from "../api/client.js";

export const CLIENT_ID = "jetlog-cli";

export interface StartDeviceFlowOptions {
  client: ApiClient;
  /** Space separated scopes, e.g. `read files` or `read write files signatures`. */
  scope: string;
  clientName?: string;
}

export async function startDeviceAuthorization(
  opts: StartDeviceFlowOptions
): Promise<DeviceAuthorizationResponse> {
  return opts.client.post<DeviceAuthorizationResponse>(
    "/oauth/device_authorization",
    {
      client_id: CLIENT_ID,
      client_name: opts.clientName ?? "jetlog-cli",
      scope: opts.scope
    },
    { skipAuth: true }
  );
}

export type PollTickReason = "pending" | "slow_down";

export interface PollTickInfo {
  /**
   * True once the backend reports the request was opened in the Jetlog app
   * (`jetlog_viewed` on the `authorization_pending` response).
   */
  viewed: boolean;
}

export interface PollDeviceTokenOptions {
  client: ApiClient;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  /** Called before each sleep, so callers can show a spinner/dots. */
  onTick?: (reason: PollTickReason, nextIntervalSeconds: number, info: PollTickInfo) => void;
  /** Called once, the first time the backend says the app has opened the request. */
  onViewed?: () => void;
  /** The match number shown to the user, used in the `number_mismatch` message. */
  matchNumber?: number;
  /** Checked between polls; throwing (e.g. on Ctrl-C) aborts the poll loop. */
  signal?: AbortSignal;
}

export class DeviceFlowError extends Error {
  readonly reason: string;
  /** The server's `error_description`, e.g. `number_mismatch`. */
  readonly description?: string;
  constructor(reason: string, description?: string, matchNumber?: number) {
    super(deviceFlowMessage(reason, description, matchNumber));
    this.name = "DeviceFlowError";
    this.reason = reason;
    this.description = description;
  }
}

function deviceFlowMessage(reason: string, description?: string, matchNumber?: number): string {
  switch (reason) {
    case "access_denied":
      if (description === "number_mismatch") {
        const shown = matchNumber !== undefined ? ` ${matchNumber}` : " shown here";
        return `the number picked in the app didn't match${shown}, so nothing was approved. Run \`jetlog login\` again.`;
      }
      return "login was denied in the app.";
    case "expired_token":
      return "the code expired before it was approved. Run `jetlog login` again.";
    case "invalid_grant":
      return "the login session is no longer valid.";
    default:
      return `device login failed: ${reason}`;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/**
 * Polls `/oauth/token` until the user approves/denies, or the code expires.
 * Resolves with the minted access token on success.
 */
export async function pollDeviceToken(opts: PollDeviceTokenOptions): Promise<DeviceTokenResponse> {
  let interval = opts.intervalSeconds;
  let viewedSeen = false;
  const deadline = Date.now() + opts.expiresInSeconds * 1000;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new DeviceFlowError("expired_token");
    }

    await sleep(interval * 1000, opts.signal);

    try {
      const token = await opts.client.post<DeviceTokenResponse>(
        "/oauth/token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: opts.deviceCode,
          client_id: CLIENT_ID
        },
        { skipAuth: true }
      );
      return token;
    } catch (err) {
      if (!(err instanceof ApiError) || !err.code) throw err;

      switch (err.code) {
        case "authorization_pending": {
          const viewed = err.body?.jetlog_viewed === true;
          if (viewed && !viewedSeen) {
            viewedSeen = true;
            opts.onViewed?.();
          }
          opts.onTick?.("pending", interval, { viewed });
          continue;
        }
        case "slow_down":
          interval += 5;
          opts.onTick?.("slow_down", interval, { viewed: viewedSeen });
          continue;
        case "access_denied":
        case "expired_token":
        case "invalid_grant":
          throw new DeviceFlowError(err.code, err.description, opts.matchNumber);
        default:
          throw err;
      }
    }
  }
}
