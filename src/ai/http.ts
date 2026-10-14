/**
 * Small fetch wrapper for the provider HTTP APIs. It mirrors what the
 * official SDKs did for us: up to 2 retries on 408, 409, 429 and 5xx (and on
 * network errors) with exponential backoff that honours `retry-after`, and a
 * 10 minute timeout per request.
 */
const MAX_RETRIES = 2;
const TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_STATUSES = new Set([408, 409, 429]);
const MAX_RETRY_DELAY_MS = 8000;

export async function postJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(backoff(attempt, null));
        continue;
      }
      throw new Error(`${label} request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.ok) return response.json();
    if ((RETRY_STATUSES.has(response.status) || response.status >= 500) && attempt < MAX_RETRIES) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(backoff(attempt, response.headers.get("retry-after")));
      continue;
    }
    throw new Error(`${label} API error ${response.status}: ${await errorMessage(response)}`);
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 <= MAX_RETRY_DELAY_MS) return seconds * 1000;
  return Math.min(500 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
    const err = parsed.error;
    if (typeof err === "string") return err;
    if (err && typeof err.message === "string") return err.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 500) || response.statusText || "no details";
}
