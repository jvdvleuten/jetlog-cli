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
  /** Which statuses are retried (default: 429 and every 5xx). Confirming an upload retries 503 only. */
  retryOn?: (status: number) => boolean;
  /** Retry after a network error (default true). Off for a POST whose lost response must not be repeated. */
  retryNetworkErrors?: boolean;
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

/**
 * Longest `retry-after` the client sleeps for. Above this it fails at once, so an hourly limit never parks a command.
 * 60 s is the largest fixed window of the per-minute buckets, which answer with 1 to 60 s and must keep being waited out.
 */
const MAX_RETRY_AFTER_SECONDS = 60;

/** 429 codes that mean "not now", so retrying only burns time and budget. */
const NEVER_RETRIED_CODES = new Set(["attachment_quota_exceeded", "signature_budget_exceeded", "too_many_open_links"]);

const defaultRetryOn = (status: number): boolean => status === 429 || status >= 500;

/** Plain-words messages for the attachment write codes, which carry no useful text of their own. */
const CODE_MESSAGES: Record<string, string> = {
  attachment_quota_exceeded: "your attachment storage quota for now is used up. Try again later, or remove files you no longer need.",
  too_many_pending_uploads: "too many uploads are still waiting to be confirmed. Wait a moment and try again.",
  entry_attachment_cap: "an entry can hold at most 20 files.",
  immutable_reference: "a file row cannot be pointed at another entry or file. Remove it and add the file again.",
  invalid_attachment_reference: "the uploaded file is not usable as an attachment. Try the upload again.",
  invalid_photo_reference: "the uploaded image is not usable as a photo. Try the upload again.",
  not_uploaded: "the upload did not reach storage. Try again.",
  invalid_content: "the server rejected the file's content. Check that it is a valid file of an accepted type.",
  unknown_entry_ids: "that entry does not exist in your logbook.",
  invalid_target: "that entry or person does not exist in your logbook.",
  signature_not_applied:
    "the signature change did not land, because the entry was changed more recently from another device. Nothing was written. Try again.",
  signature_budget_exceeded: "the hourly limit for signature actions is used up. Try again later.",
  too_many_open_links: "you already have 5 open signing links. Revoke one with `jetlog signatures revoke <request-id>` or wait until one expires."
};

/** Plain words for the `reason` of one `signature_rejected` error row. */
const SIGNATURE_REASON_MESSAGES: Record<string, string> = {
  inline_signature_not_supported: "inline signatures are not supported, attach a PNG image instead.",
  signature_removal_not_allowed: "a signature cannot be removed by a token.",
  invalid_signature_reference: "the uploaded image is not usable as a signature. Try the upload again.",
  entry_not_signable: "this entry cannot be signed (it is a bulk entry, deleted or unknown).",
  already_signed: "this entry is already signed, and a token cannot replace a signature.",
  signature_origin_not_allowed:
    "this image was captured in the app or through a signing link, so a token cannot reuse it. Upload the image from a file instead.",
  signature_conflict: "a signature and a waiver cannot be set in the same change.",
  signature_writes_not_enabled: "signature changes by AI clients are switched off on the server for now."
};

const SAFE_ID = /^[\w-]{1,64}$/;

/** The object that carries extension members of an error body: the body itself, or its `error` object. */
function errorBodies(body: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!body) return [];
  const inner = body.error;
  return inner && typeof inner === "object" ? [body, inner as Record<string, unknown>] : [body];
}

function firstArray(body: Record<string, unknown> | undefined, keys: string[]): unknown[] {
  for (const source of errorBodies(body)) {
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function safeIds(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string" && SAFE_ID.test(v));
}

/** Messages that need the error body: the per-entry reasons and ids of the signature errors. */
function messageForBodyCode(code: string, body: Record<string, unknown> | undefined): string | undefined {
  if (code === "signature_rejected") {
    const rows = firstArray(body, ["errors"]).filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
    const lines = rows.map((row) => {
      const reason = typeof row.reason === "string" ? row.reason : "";
      const text = SIGNATURE_REASON_MESSAGES[reason] ?? (/^[a-z_]{1,64}$/.test(reason) ? `the signature was rejected (${reason}).` : "the signature was rejected.");
      const id = typeof row.id === "string" && SAFE_ID.test(row.id) ? row.id : undefined;
      return rows.length > 1 && id ? `entry ${id}: ${text}` : text;
    });
    return lines.length > 0 ? [...new Set(lines)].join(" ") : "the signature was rejected.";
  }
  if (code === "entries_not_signable") {
    const ids = safeIds(firstArray(body, ["ids", "entry_ids", "entries"]));
    return `these entries cannot be signed here, because they are bulk, deleted or already signed${ids.length > 0 ? `: ${ids.join(", ")}` : ""}.`;
  }
  if (code === "signature_not_applied") {
    const ids = safeIds(firstArray(body, ["ids", "entry_ids", "entries"]));
    const base = CODE_MESSAGES.signature_not_applied!;
    return ids.length > 0 ? `${base} Entries: ${ids.join(", ")}.` : base;
  }
  return undefined;
}

function waitText(seconds: number): string {
  if (seconds <= 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function messageForStatus(
  status: number,
  code: string | undefined,
  bodyError: string | undefined,
  retryAfter?: number,
  body?: Record<string, unknown>
): string {
  if (code) {
    const fromBody = messageForBodyCode(code, body);
    if (fromBody) return fromBody;
    if (code === "signature_budget_exceeded" && retryAfter !== undefined) {
      return `the hourly limit for signature actions is used up. Try again in ${waitText(retryAfter)}.`;
    }
    if (CODE_MESSAGES[code]) return CODE_MESSAGES[code]!;
  }
  switch (status) {
    case 401:
      return "not logged in, or your token is invalid/expired. Run `jetlog login`.";
    case 403:
      if (code === "insufficient_scope") {
        return "your token is missing a scope needed for this. Run `jetlog login` again to grant it (add `--scope write` if you need to change things).";
      }
      if (code === "route_not_available_to_token") {
        return "this operation isn't available to a personal access token.";
      }
      return "forbidden.";
    case 404:
      return "not found.";
    case 429:
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_SECONDS) {
        return `rate limited, try again in ${waitText(retryAfter)}.`;
      }
      return "rate limited, try again later.";
    default:
      if (status >= 500) return "Jetlog server error, try again later.";
      return bodyError ?? code ?? `HTTP ${status}`;
  }
}

/**
 * How long to sleep before retrying `response`, or undefined when it must not be retried:
 * out of attempts, a status the caller does not retry, a `retry-after` above the cap (any
 * status, so a maintenance page cannot park a command), or a 429 that carries one of the
 * "not now" codes.
 */
async function retryDelayMs(
  response: Response,
  attempt: number,
  maxRetries: number,
  retryOn: (status: number) => boolean
): Promise<number | undefined> {
  if (attempt >= maxRetries || !retryOn(response.status)) return undefined;
  const header = response.headers.get("retry-after");
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > MAX_RETRY_AFTER_SECONDS) return undefined;
  if (response.status === 429) {
    const body = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>;
    const code = extractErrorCode(body);
    if (code && NEVER_RETRIED_CODES.has(code)) return undefined;
  }
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : backoffMs(attempt);
}

function parseRetryAfter(response: Response): number | undefined {
  const seconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** Shown when a token without the `files` scope reads an entry or person: the server then leaves the file keys out. */
export const FILES_SCOPE_MESSAGE = "your token is missing the files scope. Run `jetlog login` again to grant it.";

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
  async requestRaw<T = unknown>(
    path: string,
    opts: RequestOptions = {}
  ): Promise<{ status: number; body: T; retryAfter?: number }> {
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
        if (attempt < this.maxRetries && opts.retryNetworkErrors !== false) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw new ApiError(`network error: ${(err as Error).message}`, 0);
      }

      const delay = await retryDelayMs(response, attempt, this.maxRetries, opts.retryOn ?? defaultRetryOn);
      if (delay !== undefined) {
        await sleep(delay);
        attempt++;
        continue;
      }

      if (response.status === 204) return { status: 204, body: undefined as T };
      const body = (await response.json().catch(() => ({}))) as T;
      return { status: response.status, body, retryAfter: parseRetryAfter(response) };
    }
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { status, body, retryAfter } = await this.requestRaw<Record<string, unknown>>(path, opts);

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
    throw new ApiError(messageForStatus(status, code, bodyMessage ?? code, retryAfter, body), status, code, retryAfter, {
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

      const delay = await retryDelayMs(response, attempt, this.maxRetries, defaultRetryOn);
      if (delay !== undefined) {
        await sleep(delay);
        attempt++;
        continue;
      }

      if (response.status === 304) return { status: 304 };

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const code = typeof body.error === "string" ? body.error : undefined;
        const retryAfter = parseRetryAfter(response);
        throw new ApiError(messageForStatus(response.status, code, code, retryAfter), response.status, code, retryAfter);
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
  /** Entries a token signed (no app or link signature): deleted with the batch. */
  token_signed_would_delete?: number;
  /** Entries signed through a token-created signing link: kept unless `include_link_signed` is set. */
  link_signed_kept?: number;
}

export type CleanupResult = { deleted: number; people_deleted?: number } | { status: "removing" };

/** `PUT /api/entries|people|aircraft|fstd` response shape, same as the app's. */
export interface WriteResourcePage {
  entries?: Record<string, unknown>[];
  people?: Record<string, unknown>[];
  aircraft?: Record<string, unknown>[];
  fstd?: Record<string, unknown>[];
  entry_attachments?: Record<string, unknown>[];
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

export function deleteImportBatch(
  client: ApiClient,
  id: string,
  dryRun: boolean,
  includeLinkSigned = false
): Promise<CleanupPreview | CleanupResult> {
  return client.delete<CleanupPreview | CleanupResult>(`/api/import_batches/${encodeURIComponent(id)}`, {
    dry_run: dryRun || undefined,
    include_link_signed: includeLinkSigned || undefined
  });
}

export function cleanupImportBatches(
  client: ApiClient,
  sources: ("cli" | "mcp")[],
  dryRun: boolean,
  includeLinkSigned = false
): Promise<CleanupPreview | CleanupResult> {
  return client.post<CleanupPreview | CleanupResult>("/api/import_batches/cleanup", {
    sources,
    dry_run: dryRun,
    ...(includeLinkSigned ? { include_link_signed: true } : {})
  });
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
  resource: "entries" | "people" | "aircraft" | "fstd" | "entry_attachments",
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
  resource: "entry" | "person" | "aircraft" | "fstd" | "entry_attachment" | "signature_link";
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
  return messageForStatus(status, code, bodyMessage ?? code, undefined, body);
}

/** The scopes a 403 `insufficient_scope` names as missing (`files`, `signatures`), in a safe shape. */
function extractMissingScopes(body: Record<string, unknown> | undefined): string[] | undefined {
  for (const source of errorBodies(body)) {
    const value = source.missing_scopes;
    if (Array.isArray(value)) {
      const scopes = value.filter((v): v is string => typeof v === "string" && /^[a-z_]{1,32}$/.test(v));
      if (scopes.length > 0) return scopes;
    }
  }
  return undefined;
}

export type ProposeChangesResult =
  | { ok: true; pendingChange: PendingChange }
  | { ok: false; status: number; code?: string; errors?: PendingChangeFieldError[]; missingScopes?: string[]; message: string };

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
    missingScopes: extractMissingScopes(body),
    message: extractErrorMessage(status, body)
  };
}

/** A signing link minted by an applied `signature_link` operation. The URL is shown once, here. */
export interface AppliedLink {
  index?: number;
  signature_request_id: string;
  url: string;
  expires_at: string;
  entry_count?: number;
}

export type ApplyChangesResult =
  | { ok: true; pendingChange: PendingChange; links: AppliedLink[] }
  | { ok: "stale"; pendingChange: PendingChange }
  | { ok: false; status: number; code?: string; missingScopes?: string[]; message: string };

/**
 * Added to an apply error that leaves the outcome open. Applying is not idempotent when the change holds a
 * `signature_link`: the link URL exists only in the one response, so a lost response cannot be replayed.
 */
const APPLY_OUTCOME_UNKNOWN =
  " The change may have been applied anyway, so check its status before proposing it again. If it contained a " +
  "signing link, that link exists but its URL cannot be shown a second time: revoke it in the Jetlog app and propose again.";

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

  // Only a 429 is retried: a 5xx or a dropped connection may come after the commit, and a repeat would then
  // answer 409 not_decidable while the signing link of the first run is lost.
  let outcome: { status: number; body: Record<string, unknown> };
  try {
    outcome = await client.requestRaw<Record<string, unknown>>(`/api/pending_changes/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body,
      retryOn: (s) => s === 429,
      retryNetworkErrors: false
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      return { ok: false, status: 0, code: "network_error", message: `${err.message}.${APPLY_OUTCOME_UNKNOWN}` };
    }
    throw err;
  }
  const { status, body: respBody } = outcome;

  if (status === 200) {
    const pendingChange = (respBody as { pending_change: PendingChange }).pending_change;
    // The contract names `links` on the apply result without pinning where it sits, so both places are read.
    const links = (respBody.links ?? (pendingChange as { links?: unknown } | undefined)?.links) as AppliedLink[] | undefined;
    return { ok: true, pendingChange, links: Array.isArray(links) ? links : [] };
  }
  if (status === 409 && respBody.error === "stale") {
    return { ok: "stale", pendingChange: (respBody as { pending_change: PendingChange }).pending_change };
  }
  const code = extractErrorCode(respBody);
  const unknownOutcome = status >= 500 || (status === 409 && code === "not_decidable");
  return {
    ok: false,
    status,
    code,
    missingScopes: extractMissingScopes(respBody),
    message: extractErrorMessage(status, respBody) + (unknownOutcome ? APPLY_OUTCOME_UNKNOWN : "")
  };
}

/** `GET /api/pending_changes/:id`: the proposing token's own proposal (or any of the JWT user's, from the app). */
export async function getPendingChange(client: ApiClient, id: string): Promise<PendingChange> {
  const { pending_change } = await client.get<{ pending_change: PendingChange }>(
    `/api/pending_changes/${encodeURIComponent(id)}`
  );
  return pending_change;
}

// ---------------------------------------------------------------------
// Attachments: entry files and person photos. Bytes go to storage through a presigned URL, never
// through the Jetlog API, and the Authorization header never leaves for storage.
// ---------------------------------------------------------------------

export type AttachmentKind = "entry_file" | "person_photo" | "signature";

/** `POST /api/attachments` upload target. `headers` must be sent exactly as given (they are signed). */
export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  expires_at?: string;
}

export interface CreateAttachmentResponse {
  id: string;
  status: string;
  /** Null when this exact content is already stored (dedupe), so nothing is uploaded. */
  upload: PresignedUpload | null;
}

export function createAttachment(
  client: ApiClient,
  attrs: { kind: AttachmentKind; sha256: string; content_type: string; byte_size: number }
): Promise<CreateAttachmentResponse> {
  return client.post<CreateAttachmentResponse>("/api/attachments", attrs);
}

/** Confirms an upload. Retries 503 (storage briefly unreadable, the row stays pending), nothing else. */
export function confirmAttachment(client: ApiClient, id: string): Promise<{ id: string; status: string }> {
  return client.post<{ id: string; status: string }>(`/api/attachments/${encodeURIComponent(id)}/confirm`, undefined, {
    retryOn: (status) => status === 503 || status === 429
  });
}

export interface AttachmentDownloadUrl {
  id: string;
  sha256: string;
  content_type: string;
  url: string;
  expires_at: string;
}

export interface AttachmentDownloadUrlsResponse {
  attachments: AttachmentDownloadUrl[];
  /** Ids with no row for this user. */
  gone?: string[];
  /** Ids a token may never download (signature images). */
  forbidden?: string[];
}

export function attachmentDownloadUrls(client: ApiClient, ids: string[]): Promise<AttachmentDownloadUrlsResponse> {
  return client.post<AttachmentDownloadUrlsResponse>("/api/attachments/download_urls", { ids });
}

/** PUTs `bytes` to a presigned URL with exactly the headers the server signed. No Authorization header, ever. */
export async function putPresigned(upload: PresignedUpload, bytes: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(upload.url, { method: "PUT", headers: { ...upload.headers }, body: bytes });
  } catch (err) {
    throw new ApiError(`upload failed: ${(err as Error).message}`, 0, "upload_failed");
  }
  if (!response.ok) {
    throw new ApiError(`upload to storage failed (HTTP ${response.status}).`, response.status, "upload_failed");
  }
}

/** GETs bytes from a presigned URL. No Authorization header, ever. */
export async function getPresigned(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET" });
  } catch (err) {
    throw new ApiError(`download failed: ${(err as Error).message}`, 0, "download_failed");
  }
  if (!response.ok) {
    throw new ApiError(`download from storage failed (HTTP ${response.status}).`, response.status, "download_failed");
  }
  return Buffer.from(await response.arrayBuffer());
}

export interface EntryAttachmentRow {
  id: string;
  attachment_id: string;
  file_name: string;
  content_type?: string;
  byte_size?: number;
  position?: number;
}

/** `GET /api/cli/v1/entries/:id`: the facade entry plus signature and attachment state. */
export type EntryDetail = Record<string, unknown> & {
  id: string;
  signature?: "none" | "waived" | "signed";
  signature_attachment_id?: string | null;
  signature_sha256?: string | null;
  is_bulk?: boolean;
  attachments?: EntryAttachmentRow[];
};

/** Accepts both `{entry: {...}}` and the bare entry, since the route's envelope is not pinned in the contract. */
export async function getEntry(client: ApiClient, id: string): Promise<EntryDetail> {
  const body = await client.get<Record<string, unknown>>(`/api/cli/v1/entries/${encodeURIComponent(id)}`);
  const inner = body.entry;
  return (inner && typeof inner === "object" ? inner : body) as EntryDetail;
}

/** `GET /api/entry_attachments` page: the app's sync rows for entry files. */
export interface EntryAttachmentsPage {
  entry_attachments: Record<string, unknown>[] | null;
  sync_cursor?: number | null;
}

/** One page of the sync mirror of entry file rows (read scope). */
export function listEntryAttachmentsPage(client: ApiClient, afterVersion: number, limit = 1000): Promise<EntryAttachmentsPage> {
  return client.get<EntryAttachmentsPage>("/api/entry_attachments", { after_version: afterVersion, limit });
}

// ---------------------------------------------------------------------
// Remote signing links. The URL is shown once, at creation.
// ---------------------------------------------------------------------

export interface SignatureRequest {
  id: string;
  url: string;
  expires_at: string;
}

/**
 * POSTs to a route that mints a bearer link. Not idempotent: every success creates a new link, so a 5xx is
 * never retried (the link may exist already) and its message says where to look.
 */
async function postMintingLink(client: ApiClient, path: string, body: Record<string, unknown>, what: string, where: string): Promise<Record<string, unknown>> {
  try {
    return await client.post<Record<string, unknown>>(path, body, { retryOn: (status) => status === 429 });
  } catch (err) {
    if (err instanceof ApiError && err.status >= 500) {
      throw new ApiError(
        `${err.message} The ${what} may have been created anyway, so check the open ${what}s in ${where} before trying again.`,
        err.status,
        err.code,
        err.retryAfter,
        { description: err.description, body: err.body }
      );
    }
    throw err;
  }
}

/** `POST /api/signature_requests`. Accepts `{signature_request: {...}}` and the bare object. */
export async function createSignatureRequest(client: ApiClient, entryIds: string[]): Promise<SignatureRequest> {
  const body = await postMintingLink(client, "/api/signature_requests", { entry_ids: entryIds }, "signing link", "the Jetlog app");
  const inner = body.signature_request;
  return (inner && typeof inner === "object" ? inner : body) as unknown as SignatureRequest;
}

/** `DELETE /api/signature_requests/:id`: a token may revoke only requests its own login created. */
export function revokeSignatureRequest(client: ApiClient, id: string): Promise<unknown> {
  return client.delete(`/api/signature_requests/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------
// Upload links: a short-lived page where the pilot adds files or a
// photo from another device. Creating one changes nothing in the logbook; the files land as applied changes.
// ---------------------------------------------------------------------

export type UploadLinkPurpose = "entry_files" | "person_photo" | "entry_signature";

export interface UploadLink {
  id: string;
  url: string;
  purpose: UploadLinkPurpose;
  entry_id?: string | null;
  person_id?: string | null;
  target_label?: string;
  max_files?: number;
  max_bytes_per_file?: number;
  accepted_types?: string[];
  requires_owner_verification?: boolean;
  expires_at: string;
}

export interface UploadLinkStatus {
  status: "open" | "closed" | "expired" | "revoked";
  files_landed: number;
  files?: { file_name?: string; content_type?: string; byte_size?: number; attachment_id?: string }[];
  expires_at?: string;
}

const UPLOAD_LINK_CAP_MESSAGE = "you already have 5 open upload links. They expire after 30 minutes, or revoke one in the Jetlog app.";

/** `POST /api/upload_links` (write and files scope). Accepts `{upload_link: {...}}` and the bare object. */
export async function createUploadLink(
  client: ApiClient,
  target: { purpose: UploadLinkPurpose; entry_id?: string; person_id?: string }
): Promise<UploadLink> {
  let body: Record<string, unknown>;
  try {
    body = await postMintingLink(client, "/api/upload_links", target, "upload link", "the Jetlog app");
  } catch (err) {
    // The same code as the signing link cap, but a different list and no CLI command to revoke from.
    if (err instanceof ApiError && err.code === "too_many_open_links") {
      throw new ApiError(UPLOAD_LINK_CAP_MESSAGE, err.status, err.code, err.retryAfter, { description: err.description, body: err.body });
    }
    throw err;
  }
  const inner = body.upload_link;
  return (inner && typeof inner === "object" ? inner : body) as unknown as UploadLink;
}

/** `GET /api/upload_links/:id`: scoped to the login that created the link, 404 for any other. */
export async function getUploadLink(client: ApiClient, id: string): Promise<UploadLinkStatus> {
  const body = await client.get<Record<string, unknown>>(`/api/upload_links/${encodeURIComponent(id)}`);
  const inner = body.upload_link;
  return (inner && typeof inner === "object" ? inner : body) as unknown as UploadLinkStatus;
}
