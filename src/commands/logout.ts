import { deleteProfile } from "../auth/credentials.js";

/**
 * There is no PAT-reachable self-revoke endpoint today (the
 * `/api/access_tokens` management routes only accept an app login), revoking a token
 * server-side has to happen from the Jetlog app's Settings screen. This
 * only deletes the local credential, which is still useful on its own
 * (the token keeps working server-side until revoked or it expires, but
 * this CLI forgets it).
 */
export async function logout(profile: string): Promise<void> {
  const deleted = await deleteProfile(profile);
  if (deleted) {
    console.log(`Logged out (profile: ${profile}). The token itself isn't revoked server-side, so do that from the Jetlog app's Settings if needed.`);
  } else {
    console.log(`Not logged in (profile: ${profile}).`);
  }
}
