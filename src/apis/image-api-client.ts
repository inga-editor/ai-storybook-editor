import { createLogger } from '@/utils/logger';
import { supabase } from './supabase';

const log = createLogger('API', 'ImageApiClient');

const imageApiBaseUrl = import.meta.env.VITE_IMAGE_API_BASE_URL as string;
const imageApiKey = import.meta.env.VITE_IMAGE_API_KEY as string;

/**
 * Read (GET) endpoints get a bounded timeout so a slow/hung upstream degrades to
 * a retryable TIMEOUT failure instead of an indefinite pending fetch — the
 * collaborator-space "infinite spinner" failure mode (loaders gate on a promise
 * that never settles). Mutating POSTs deliberately get NO default timeout: the
 * AI image/chat endpoints legitimately run for minutes.
 */
const DEFAULT_GET_TIMEOUT_MS = 30_000;

/** `fetch` with an optional abort-on-timeout. Omitting `timeoutMs` = no timeout. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number
): Promise<Response> {
  if (!timeoutMs) return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Failure shape returned by callImageApi on non-2xx or network error. */
export interface ImageApiFailure {
  success: false;
  error: string;
  httpStatus: number;
  errorCode?: string;
  /** Structured `detail.error.details` from the FastAPI envelope (e.g. sketch-spread
   *  `{ failures: [{code, message}] }`). Generic — consumers cast to their own shape. */
  errorDetails?: Record<string, unknown>;
}

/** Fetch Bearer header from active Supabase session; undefined when unauthenticated
 *  (share-preview / pre-login). Image/retouch endpoints ignore unknown Bearer;
 *  jobs/* endpoints require it for RLS user-id resolution. */
async function getAuthHeader(): Promise<string | undefined> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      log.warn('getAuthHeader', 'session lookup failed', { error: error.message });
      return undefined;
    }
    const token = data.session?.access_token;
    return token ? `Bearer ${token}` : undefined;
  } catch (err) {
    log.warn('getAuthHeader', 'unexpected error', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/**
 * Generic client for the FastAPI image-api service.
 * Always sends X-API-Key (service-to-service); also sends Authorization: Bearer
 * when a Supabase session exists. Image/retouch endpoints ignore the Bearer
 * header; jobs/* endpoints require it for RLS user_id resolution.
 * On failure returns ImageApiFailure (success: false) with httpStatus + errorCode for
 * precise downstream classification — callers cast via `as ImageApiFailure` after !success check.
 */
export async function callImageApi<R extends { success: boolean; error?: string }>(
  path: string,
  body: object,
  opts?: { keepalive?: boolean }
): Promise<R | ImageApiFailure> {
  const url = `${imageApiBaseUrl}${path}`;
  const payload = body as Record<string, unknown>;

  log.info('callImageApi', 'request', { path, method: 'POST', payloadKeys: Object.keys(payload || {}) });

  const headers = await buildHeaders(true);

  try {
    // `keepalive` (flush-on-hidden): lets the POST outlive the page unload so a held+dirty item is
    // still persisted when the tab is hidden/closed. The browser caps a keepalive body at 64KB —
    // callers measure the body and pass `keepalive:false` when it would exceed that (still a normal
    // fetch, best-effort). Omitted for every other call (identical behavior to before).
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(opts?.keepalive ? { keepalive: true } : {}),
    });

    if (!response.ok) {
      const { message, errorCode, errorDetails } = await extractErrorInfo(path, response);
      return { success: false, error: message, httpStatus: response.status, errorCode, errorDetails };
    }

    const data = await response.json();
    log.debug('callImageApi', 'response ok', { path, status: response.status });
    return data as R;
  } catch (err) {
    return classifyFetchError(path, err);
  }
}

/**
 * GET counterpart of callImageApi for read-only endpoints (e.g. collaboration
 * list-invitations). Same auth (X-API-Key + optional Bearer) and error
 * classification; no request body. Bearer is REQUIRED by JWT-gated endpoints —
 * unauthenticated callers get a 401 ImageApiFailure (expected pre-login).
 */
export async function callImageApiGet<R extends { success: boolean; error?: string }>(
  path: string
): Promise<R | ImageApiFailure> {
  const url = `${imageApiBaseUrl}${path}`;

  log.info('callImageApiGet', 'request', { path, method: 'GET' });

  const headers = await buildHeaders(false);

  try {
    const response = await fetchWithTimeout(url, { method: 'GET', headers }, DEFAULT_GET_TIMEOUT_MS);

    if (!response.ok) {
      const { message, errorCode, errorDetails } = await extractErrorInfo(path, response);
      return { success: false, error: message, httpStatus: response.status, errorCode, errorDetails };
    }

    const data = await response.json();
    log.debug('callImageApiGet', 'response ok', { path, status: response.status });
    return data as R;
  } catch (err) {
    return classifyFetchError(path, err);
  }
}

/**
 * PATCH counterpart of callImageApi for partial-update endpoints (e.g. admin
 * user update). Same auth (X-API-Key + optional Bearer), JSON body, and error
 * classification. No default timeout — consistent with mutating POSTs.
 */
export async function callImageApiPatch<R extends { success: boolean; error?: string }>(
  path: string,
  body: object
): Promise<R | ImageApiFailure> {
  const url = `${imageApiBaseUrl}${path}`;
  const payload = body as Record<string, unknown>;

  log.info('callImageApiPatch', 'request', { path, method: 'PATCH', payloadKeys: Object.keys(payload || {}) });

  const headers = await buildHeaders(true);

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const { message, errorCode, errorDetails } = await extractErrorInfo(path, response);
      return { success: false, error: message, httpStatus: response.status, errorCode, errorDetails };
    }

    const data = await response.json();
    log.debug('callImageApiPatch', 'response ok', { path, status: response.status });
    return data as R;
  } catch (err) {
    return classifyFetchError(path, err);
  }
}

/**
 * DELETE counterpart of callImageApi for destructive endpoints (e.g. admin user
 * soft-delete). Sends X-API-Key + optional Bearer, no request body, and reuses
 * the shared error classification. No default timeout — consistent with mutating
 * POSTs (a soft-delete + auth-ban round-trip can be slow upstream).
 */
export async function callImageApiDelete<R extends { success: boolean; error?: string }>(
  path: string
): Promise<R | ImageApiFailure> {
  const url = `${imageApiBaseUrl}${path}`;

  log.info('callImageApiDelete', 'request', { path, method: 'DELETE' });

  const headers = await buildHeaders(false);

  try {
    const response = await fetch(url, { method: 'DELETE', headers });

    if (!response.ok) {
      const { message, errorCode, errorDetails } = await extractErrorInfo(path, response);
      return { success: false, error: message, httpStatus: response.status, errorCode, errorDetails };
    }

    const data = await response.json();
    log.debug('callImageApiDelete', 'response ok', { path, status: response.status });
    return data as R;
  } catch (err) {
    return classifyFetchError(path, err);
  }
}

/** Build the shared image-api headers: always X-API-Key, Bearer when a session
 *  exists, Content-Type only when a JSON body is sent. */
async function buildHeaders(withJsonBody: boolean): Promise<Record<string, string>> {
  const authHeader = await getAuthHeader();
  const headers: Record<string, string> = { 'X-API-Key': imageApiKey };
  if (withJsonBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }
  return headers;
}

function classifyFetchError(path: string, err: unknown): ImageApiFailure {
  const name = (err as { name?: string } | null)?.name;
  const rawMessage = err instanceof Error ? err.message : String(err);

  // AbortError = our client-side timeout fired (fetchWithTimeout). Surface it as
  // a distinct retryable TIMEOUT so the UI can prompt a retry instead of reading
  // it as a generic unknown failure.
  if (name === 'AbortError') {
    log.error('callImageApi', 'request timed out', { path, message: rawMessage });
    return {
      success: false,
      error: 'Máy chủ phản hồi quá lâu — vui lòng thử lại.',
      httpStatus: 0,
      errorCode: 'TIMEOUT',
    };
  }

  // TypeError from fetch = connection-level: offline, DNS, CORS, gateway reset mid-stream (including upstream timeout closing connection)
  if (err instanceof TypeError) {
    log.error('callImageApi', 'connection error', { path, message: rawMessage });
    return {
      success: false,
      error: `Không kết nối được máy chủ (${rawMessage}). Có thể máy chủ đang xử lý quá lâu hoặc mất kết nối — vui lòng thử lại.`,
      httpStatus: 0,
      errorCode: 'CONNECTION_ERROR',
    };
  }

  log.error('callImageApi', 'unknown error', { path, name, message: rawMessage });
  return { success: false, error: rawMessage || 'Unknown network error', httpStatus: 0, errorCode: 'UNKNOWN' };
}

async function extractErrorInfo(
  path: string,
  response: Response
): Promise<{ message: string; errorCode?: string; errorDetails?: Record<string, unknown> }> {
  try {
    const body = await response.json();
    // FastAPI HTTPException shape: { detail: { error: { code, message, details? } } }
    // FastAPI string detail:        { detail: "string" }
    // Top-level fallbacks:          { error: { code, message, details? } } | { error: string } | { message: string }
    const detail = body?.detail;
    const detailError = typeof detail === 'object' && detail !== null ? detail.error : undefined;

    const errorCode: string | undefined =
      (typeof detailError === 'object' && detailError !== null ? detailError.code : undefined) ??
      (typeof body?.error === 'object' && body.error !== null ? body.error.code : undefined);

    // Structured details (precedent: combine-audio-chunks-api). Pass through as-is —
    // consumers cast to their endpoint's shape (e.g. spread failures[]).
    const rawDetails =
      (typeof detailError === 'object' && detailError !== null ? detailError.details : undefined) ??
      (typeof body?.error === 'object' && body.error !== null ? body.error.details : undefined);
    const errorDetails: Record<string, unknown> | undefined =
      typeof rawDetails === 'object' && rawDetails !== null
        ? (rawDetails as Record<string, unknown>)
        : undefined;

    const message: string =
      (typeof detailError === 'object' && detailError !== null && typeof detailError.message === 'string'
        ? detailError.message
        : null) ??
      (typeof detail === 'string' ? detail : null) ??
      (typeof body?.error === 'object' && body.error !== null
        ? (body.error.message ?? JSON.stringify(body.error))
        : null) ??
      (typeof body?.error === 'string' ? body.error : null) ??
      body?.message ??
      `HTTP ${response.status}`;

    log.error('extractErrorInfo', 'http error', {
      path, message, errorCode, hasDetails: errorDetails !== undefined, status: response.status,
    });
    return { message: String(message), errorCode, errorDetails };
  } catch {
    // Response body not parseable as JSON
  }
  const fallback = `HTTP ${response.status} ${response.statusText}`;
  log.error('extractErrorInfo', 'http error (no body)', { path, fallback, status: response.status });
  return { message: fallback };
}
