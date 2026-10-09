/**
 * `jetlog push`, deprecated. Sends a payload to the External Partner API with
 * the partner key pair. Partners move to token authentication, which this CLI
 * does not implement: it is for apps and services, not for the pilot.
 */
import { validatePayload, type Payload } from "../schema.js";

/** The guide that explains the move from the key pair to tokens. */
export const PARTNER_MIGRATION_URL = "https://github.com/jvdvleuten/JetlogAPI/blob/main/MIGRATION.md";

/** The `--help` text of `jetlog push`. */
export const PUSH_DESCRIPTION =
  "Deprecated: push a Jetlog import payload to the External Partner API with the key pair " +
  `(JETLOG_USER_KEY and JETLOG_PARTNER_KEY). Migration guide: ${PARTNER_MIGRATION_URL}`;

/** One line for stderr. Scripts parse stdout, so this never goes there. */
export const PUSH_DEPRECATION_NOTICE =
  "warning: jetlog push is deprecated. The key pair it uses (JETLOG_USER_KEY and JETLOG_PARTNER_KEY) is being " +
  `replaced by token authentication. Migration guide: ${PARTNER_MIGRATION_URL}`;

const BATCH_SIZE = 500;

export async function runPush(content: string, opts: { baseUrl: string; dryRun?: boolean }): Promise<void> {
  console.error(PUSH_DEPRECATION_NOTICE);

  const data = JSON.parse(content);
  const result = validatePayload(data, "api");
  if (!result.valid || !result.payload) {
    for (const e of result.structuralErrors) {
      console.error(`error: ${e.path || "(root)"}: ${e.message}`);
    }
    for (const e of result.modeErrors) {
      console.error(`error: entries[${e.index}]: ${e.message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (opts.dryRun) {
    console.log(`valid: ${result.payload.entries?.length ?? 0} entries, dry run, nothing sent`);
    return;
  }

  const userKey = process.env.JETLOG_USER_KEY;
  const partnerKey = process.env.JETLOG_PARTNER_KEY;
  if (!userKey || !partnerKey) {
    console.error("error: JETLOG_USER_KEY and JETLOG_PARTNER_KEY must be set");
    process.exitCode = 1;
    return;
  }

  const entries = result.payload.entries ?? [];
  for (let i = 0; i < entries.length || i === 0; i += BATCH_SIZE) {
    const batch: Payload = {
      entries: entries.slice(i, i + BATCH_SIZE),
      people: i === 0 ? result.payload.people ?? [] : []
    };
    if (batch.entries!.length === 0 && i !== 0) break;

    const response = await fetch(`${opts.baseUrl}/external/v1/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userKey}:${partnerKey}`
      },
      body: JSON.stringify(batch)
    });
    const body = (await response.json().catch(() => ({}))) as {
      skipped?: unknown[];
      warnings?: unknown[];
      error?: string;
    };
    if (!response.ok) {
      console.error(`error: HTTP ${response.status}: ${body.error ?? "unknown error"}`);
      process.exitCode = 1;
      continue;
    }
    if (body.skipped?.length) console.log(`skipped: ${JSON.stringify(body.skipped, null, 2)}`);
    if (body.warnings?.length) console.log(`warnings: ${JSON.stringify(body.warnings, null, 2)}`);
    console.log(`batch ${Math.floor(i / BATCH_SIZE) + 1}: OK`);

    if (entries.length === 0) break;
  }
}
