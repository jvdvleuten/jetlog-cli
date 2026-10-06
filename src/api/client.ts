/**
 * Typed fetch client for Jetlog's CLI-facing backend endpoints:
 * - the RFC 8628 device-authorization grant (`/oauth/device_authorization`,
 *   `/oauth/token`)
 * - the read-only CLI query facade (`/api/cli/v1/*`)
 * - the version-cursor sync mirror (`/api/entries` etc.), used for a full
 *   export
 *
 * Never sends `x-client-version` (that's the iOS app-version gate and
 * returns 426 for anything that isn't a recognized iOS build). Sends
 * `x-jetlog-client` + a User-Agent instead.
 */

export const DEFAULT_BASE_URL = "https://jetlog.app";

export const CLI_VERSION = "0.1.0";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  /** OAuth `error_description` (RFC 6749), e.g. `number_mismatch`. */
  readonly description?: string;
  /** The parsed error body, so extension members (e.g. `jetlog_viewed`) stay readable. */
  readonly body?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfter?: number,
    extra: { description?: string; body?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.description = extra.description;
    this.body = extra.body;
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
  /** Max retry attempts for 429/5xx responses (default 3). */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Skip the Authorization header (device-flow endpoints are unauthenticated). */
  skipAuth?: boolean;
  /** Extra request headers (e.g. `x-jetlog-batch-id` for a PAT write). */
  headers?: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageForStatus(status: number, code: string | undefined, bodyError: string | undefined): string {
  switch (status) {
    case 401:
      return "not logged in, or your token is invalid/expired. Run `jetlog login`.";
    case 403:
      if (code === "insufficient_scope") {
        return "your token doesn't have the scope needed for this (try `jetlog login --scope write` if you need write access).";
      }
      if (code === "route_not_available_to_token") {
        return "this operation isn't available to a personal access token.";
      }
      return "forbidden.";
    case 404:
      return "not found.";
    case 429:
      return "rate limited, try again later.";
    default:
      if (status >= 500) return "Jetlog server error, try again later.";
      return bodyError ?? code ?? `HTTP ${status}`;
  }
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Like `request()`, but never throws on a non-2xx response, returns
   * `{status, body}` instead, so a caller that needs to inspect a
   * structured error body (e.g. the pending-changes 409 `"stale"` response,
   * which carries a fresh preview alongside the error) can do so without
   * `ApiError` discarding it. Still retries 429/5xx the same way
   * `request()` does. `request()` is built on top of this.
   */
  async requestRaw<T = unknown>(path: string, opts: RequestOptions = {}): Promise<{ status: number; body: T }> {
    const method = opts.method ?? "GET";
    const url = new URL(path, this.baseUrl + "/");
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value === undefined || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "x-jetlog-client": `jetlog-cli/${CLI_VERSION}`,
      "User-Agent": `jetlog-cli/${CLI_VERSION}`,
      ...opts.headers
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (!opts.skipAuth && this.token) headers.Authorization = `Bearer ${this.token}`;

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw new ApiError(`network error: ${(err as Error).message}`, 0);
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < this.maxRetries) {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterMs = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) * 1000 : backoffMs(attempt);
          await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : backoffMs(attempt));
          attempt++;
          continue;
        }
      }

      if (response.status === 204) return { status: 204, body: undefined as T };
      const body = (await response.json().catch(() => ({}))) as T;
      return { status: response.status, body };
    }
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { status, body } = await this.requestRaw<Record<string, unknown>>(path, opts);

    if (status >= 200 && status < 300) {
      return (status === 204 ? undefined : body) as T;
    }

    // Most endpoints send `{"error":"some_code"}`; the newer write-path
    // endpoints send
    // `{"error":{"message":"...","code":"...",...}}` instead, handle both.
    const errorField = body.error;
    const code =
      typeof errorField === "string"
        ? errorField
        : errorField && typeof errorField === "object" && typeof (errorField as Record<string, unknown>).code === "string"
          ? ((errorField as Record<string, unknown>).code as string)
          : undefined;
    const bodyMessage =
      errorField && typeof errorField === "object" && typeof (errorField as Record<string, unknown>).message === "string"
        ? ((errorField as Record<string, unknown>).message as string)
        : undefined;
    const description = typeof body.error_description === "string" ? body.error_description : undefined;
    throw new ApiError(messageForStatus(status, code, bodyMessage ?? code), status, code, undefined, {
      description,
      body
    });
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>(path, { method: "GET", query });
  }

  post<T = unknown>(path: string, body?: unknown, opts: Partial<RequestOptions> = {}): Promise<T> {
    return this.request<T>(path, { method: "POST", body, ...opts });
  }

  put<T = unknown>(path: string, body?: unknown, opts: Partial<RequestOptions> = {}): Promise<T> {
    return this.request<T>(path, { method: "PUT", body, ...opts });
  }

  delete<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>(path, { method: "DELETE", query });
  }

  /**
   * Conditional GET: sends `If-None-Match: ifNoneMatch` (when given) and
   * returns `{ status: 304 }` instead of throwing when the server confirms
   * the cached copy is still fresh, unlike `request()`, which treats
   * anything outside 200-299 as an error. Used for long-cached, rarely
   * changing catalogs (e.g. `/api/cli/v1/airlines`) where re-fetching the
   * full body on every run would be wasteful. Shares `request()`'s
   * 429/5xx retry behavior.
   */
  async getWithETag<T = unknown>(
    path: string,
    ifNoneMatch?: string
  ): Promise<{ status: 200; body: T; etag?: string } | { status: 304 }> {
    const url = new URL(path, this.baseUrl + "/");
    const headers: Record<string, string> = {
      "x-jetlog-client": `jetlog-cli/${CLI_VERSION}`,
      "User-Agent": `jetlog-cli/${CLI_VERSION}`
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), { method: "GET", headers });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw new ApiError(`network error: ${(err as Error).message}`, 0);
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < this.maxRetries) {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterMs = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) * 1000 : backoffMs(attempt);
          await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : backoffMs(attempt));
          attempt++;
          continue;
        }
      }

      if (response.status === 304) return { status: 304 };

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const code = typeof body.error === "string" ? body.error : undefined;
        throw new ApiError(messageForStatus(response.status, code, code), response.status, code);
      }

      const etag = response.headers.get("etag") ?? undefined;
      return { status: 200, body: (await response.json()) as T, etag };
    }
  }
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  const jitter = Math.random() * 250;
  return base + jitter;
}

// ---------------------------------------------------------------------
// Response shapes (read API + device flow). Kept intentionally loose
// (only the fields this CLI actually reads) since the server is the
// source of truth, see CLAUDE.md on backend contracts.
// ---------------------------------------------------------------------

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  /** Two-digit number the user has to pick in the app (QR + number-matching login). */
  match_number: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  token_id: string | number;
}

export interface MeResponse {
  user_id: string | number;
  self_person_id: string | number;
  email: string | null;
  auth_kind: string;
  token: {
    id: string | number;
    name: string | null;
    scopes: string[];
    client_kind: string;
    expires_at: string | null;
  } | null;
  server_version: string | null;
}

export interface EntriesPage {
  entries: Record<string, unknown>[];
  pagination: {
    limit: number;
    has_more: boolean;
    next_cursor: { date: string; id: string | number } | null;
  };
}

export interface PeopleResponse {
  people: Record<string, unknown>[];
}

export interface AircraftResponse {
  aircraft: Record<string, unknown>[];
}

export interface SyncEntriesPage {
  entries: Record<string, unknown>[];
  sync_cursor: number | null;
}

export interface SyncFstdPage {
  fstd: Record<string, unknown>[];
  sync_cursor: number | null;
}

// ---------------------------------------------------------------------
// Write-path response shapes (`jetlog import`/`jetlog batches`).
// ---------------------------------------------------------------------

export interface ImportBatch {
  id: string;
  kind?: string;
  source_format?: string | null;
  label?: string | null;
  client?: string | null;
  token_id?: string | number | null;
  created_at: string;
  last_write_at?: string | null;
  created_count?: number;
  edited_count?: number;
  live_created_count?: number;
  changed_since_import_count?: number;
  status?: string;
  removed_at?: string | null;
}

export interface ImportBatchesResponse {
  import_batches: ImportBatch[];
}

export interface CleanupPreview {
  would_delete: number;
  changed_since_import: number;
  edited_entries_untouched: number;
  people_would_delete: number;
  signed_kept: number;
}

export type CleanupResult = { deleted: number; people_deleted?: number } | { status: "removing" };

/** `PUT /api/entries|people|aircraft|fstd` response shape, same as the app's. */
export interface WriteResourcePage {
  entries?: Record<string, unknown>[];
  people?: Record<string, unknown>[];
  aircraft?: Record<string, unknown>[];
  fstd?: Record<string, unknown>[];
}

/**
 * Creates an import batch (`POST /api/import_batches`), opens the
 * `x-jetlog-batch-id` scope every subsequent PAT write under this import
 * must carry.
 */
export function createImportBatch(
  client: ApiClient,
  attrs: { kind?: "import" | "edit" | "mcp"; source_format?: string; label?: string; client?: string }
): Promise<ImportBatch> {
  return client.post<ImportBatch>("/api/import_batches", attrs);
}

export function listImportBatches(client: ApiClient): Promise<ImportBatchesResponse> {
  return client.get<ImportBatchesResponse>("/api/import_batches");
}

export function deleteImportBatch(client: ApiClient, id: string, dryRun: boolean): Promise<CleanupPreview | CleanupResult> {
  return client.delete<CleanupPreview | CleanupResult>(`/api/import_batches/${encodeURIComponent(id)}`, {
    dry_run: dryRun || undefined
  });
}

export function cleanupImportBatches(
  client: ApiClient,
  sources: ("cli" | "mcp")[],
  dryRun: boolean
): Promise<CleanupPreview | CleanupResult> {
  return client.post<CleanupPreview | CleanupResult>("/api/import_batches/cleanup", { sources, dry_run: dryRun });
}

/** Max rows per `PUT /api/entries|people|aircraft|fstd` request (server-enforced, 413 above this). */
export const MAX_WRITE_ROWS = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * PUTs `rows` to the given resource endpoint in chunks of at most
 * `MAX_WRITE_ROWS`, carrying the active `x-jetlog-batch-id` on every chunk.
 * Returns every chunk's merged response rows for the resource key.
 */
export async function putResourceChunked(
  client: ApiClient,
  resource: "entries" | "people" | "aircraft" | "fstd",
  rows: Record<string, unknown>[],
  batchId: string
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const batch of chunk(rows, MAX_WRITE_ROWS)) {
    if (batch.length === 0) continue;
    const page = await client.put<WriteResourcePage>(
      `/api/${resource}`,
      { [resource]: batch },
      { headers: { "x-jetlog-batch-id": batchId } }
    );
    results.push(...(page[resource] ?? []));
  }
  return results;
}

// ---------------------------------------------------------------------
// Airline ICAO<->IATA catalog (`GET /api/cli/v1/airlines`, read scope).
// Long-cached (ETag-revalidated), so this is one `getWithETag` call, not
// chunked/paginated, see `src/import/airlines.ts`.
// ---------------------------------------------------------------------

export interface AirlineRow {
  name: string;
  iata: string;
  icao: string;
}

export interface AirlinesResponse {
  airlines: AirlineRow[];
}

// ---------------------------------------------------------------------
// Pending changes, the AI-proposes/user-confirms write flow
// (`POST /api/pending_changes`: `.../:id/apply`, `GET .../:id`). PAT
// write scope only. See JetlogAPI's `pending_change_controller.ex` for
// the authoritative contract this mirrors; nothing here writes by
// itself, `proposeChanges` only validates + stores a preview,
// `applyChanges` is the one call that actually writes.
// ---------------------------------------------------------------------

export interface PendingChangeOperationInput {
  op: "create" | "update" | "delete";
  resource: "entry" | "person" | "aircraft" | "fstd";
  /** Required for update/delete; omit (or leave undefined) for create. */
  id?: string;
  data?: Record<string, unknown>;
  /** Entry creates only. Server default true: the pilot is added to `people`. `false` leaves the pilot off. */
  add_self?: boolean;
}

export interface PendingChangePreviewEntry {
  index: number;
  op: string;
  resource: string;
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed_fields: string[];
}

export interface PendingChangeCounts {
  creates: number;
  updates: number;
  deletes: number;
}

export interface PendingChange {
  id: string;
  status: string;
  client_kind?: string | null;
  client_name?: string | null;
  summary: string;
  operations: PendingChangeOperationInput[];
  preview: PendingChangePreviewEntry[];
  counts: PendingChangeCounts;
  error?: unknown;
  expires_at: string;
  decided_at?: string | null;
  applied_batch_id?: string | null;
  reverted_indices?: number[] | null;
  created_at?: string;
}

export interface PendingChangeFieldError {
  index: number | null;
  field: string | null;
  message: string;
}

function extractErrorCode(body: Record<string, unknown> | undefined): string | undefined {
  const errorField = body?.error;
  if (typeof errorField === "string") return errorField;
  if (errorField && typeof errorField === "object" && typeof (errorField as Record<string, unknown>).code === "string") {
    return (errorField as Record<string, unknown>).code as string;
  }
  return undefined;
}

function extractFieldErrors(body: Record<string, unknown> | undefined): PendingChangeFieldError[] | undefined {
  const errorField = body?.error;
  if (errorField && typeof errorField === "object" && Array.isArray((errorField as Record<string, unknown>).errors)) {
    return (errorField as Record<string, unknown>).errors as PendingChangeFieldError[];
  }
  return undefined;
}

function extractErrorMessage(status: number, body: Record<string, unknown> | undefined): string {
  const errorField = body?.error;
  const bodyMessage =
    errorField && typeof errorField === "object" && typeof (errorField as Record<string, unknown>).message === "string"
      ? ((errorField as Record<string, unknown>).message as string)
      : undefined;
  const code = extractErrorCode(body);
  return messageForStatus(status, code, bodyMessage ?? code);
}

export type ProposeChangesResult =
  | { ok: true; pendingChange: PendingChange }
  | { ok: false; status: number; code?: string; errors?: PendingChangeFieldError[]; message: string };

/**
 * `POST /api/pending_changes`: validates `operations` and stores a
 * preview. Nothing is written. On a 422 validation failure, `errors` is
 * the field-level list from the server; on 409 `open_cap_reached`, `code`
 * is set accordingly.
 */
export async function proposeChanges(
  client: ApiClient,
  summary: string,
  operations: PendingChangeOperationInput[]
): Promise<ProposeChangesResult> {
  const { status, body } = await client.requestRaw<Record<string, unknown>>("/api/pending_changes", {
    method: "POST",
    body: { summary, operations }
  });
  if (status === 201) {
    return { ok: true, pendingChange: (body as { pending_change: PendingChange }).pending_change };
  }
  return {
    ok: false,
    status,
    code: extractErrorCode(body),
    errors: extractFieldErrors(body),
    message: extractErrorMessage(status, body)
  };
}

export type ApplyChangesResult =
  | { ok: true; pendingChange: PendingChange }
  | { ok: "stale"; pendingChange: PendingChange }
  | { ok: false; status: number; code?: string; message: string };

/**
 * `POST /api/pending_changes/:id/apply`: writes for real. MUST be called
 * with the SAME token that proposed the change. A 409 `"stale"` response
 * (the underlying data changed since propose) is NOT treated as a hard
 * failure, it carries a fresh preview in `pendingChange` for the caller
 * to show the user again.
 */
export async function applyChanges(client: ApiClient, id: string, operationIndices?: number[]): Promise<ApplyChangesResult> {
  const body: Record<string, unknown> = {};
  if (operationIndices) body.operation_indices = operationIndices;

  const { status, body: respBody } = await client.requestRaw<Record<string, unknown>>(
    `/api/pending_changes/${encodeURIComponent(id)}/apply`,
    { method: "POST", body }
  );

  if (status === 200) {
    return { ok: true, pendingChange: (respBody as { pending_change: PendingChange }).pending_change };
  }
  if (status === 409 && respBody.error === "stale") {
    return { ok: "stale", pendingChange: (respBody as { pending_change: PendingChange }).pending_change };
  }
  return { ok: false, status, code: extractErrorCode(respBody), message: extractErrorMessage(status, respBody) };
}

/** `GET /api/pending_changes/:id`: the proposing token's own proposal (or any of the JWT user's, from the app). */
export async function getPendingChange(client: ApiClient, id: string): Promise<PendingChange> {
  const { pending_change } = await client.get<{ pending_change: PendingChange }>(
    `/api/pending_changes/${encodeURIComponent(id)}`
  );
  return pending_change;
}
