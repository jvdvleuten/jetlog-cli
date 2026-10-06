import { ApiClient, DEFAULT_BASE_URL, type MeResponse } from "../api/client.js";
import { resolveToken, resolveBaseUrl } from "../auth/credentials.js";

export async function whoami(profile: string, opts: { json?: boolean } = {}): Promise<void> {
  const token = await resolveToken(profile);
  if (!token) {
    console.error(`error: not logged in (profile: ${profile}). Run \`jetlog login\`.`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = (await resolveBaseUrl(profile)) ?? DEFAULT_BASE_URL;
  const client = new ApiClient({ baseUrl, token });
  const me = await client.get<MeResponse>("/api/cli/v1/me");

  if (opts.json) {
    console.log(JSON.stringify(me, null, 2));
    return;
  }

  console.log(`email:       ${me.email ?? "(none)"}`);
  console.log(`user id:     ${me.user_id}`);
  console.log(`auth:        ${me.auth_kind}`);
  if (me.token) {
    console.log(`token name:  ${me.token.name ?? "(unnamed)"}`);
    console.log(`scopes:      ${me.token.scopes.join(", ")}`);
    console.log(`expires at:  ${me.token.expires_at ?? "(never)"}`);
  }
  console.log(`server:      ${me.server_version ?? "unknown"}`);
}
