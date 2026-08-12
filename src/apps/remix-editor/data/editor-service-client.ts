// editor-service-client.ts — Thin HTTP client for the swap-service EDITOR envelope.
//
// ⚠️ ENVELOPE SPLIT (ADR-052): the Remix Swap Service speaks TWO different response
// envelopes. This client handles the `/api/editor/*` (+ `/api/jobs/status`) group,
// which uses the ServiceError shape:
//     success: { "success": true,  "data": {...} }
//     failure: { "success": false, "error": { "code", "message", "details"? } }
// The PORTED endpoints (`/api/jobs/*`, `/api/remix/*`, `/api/retouch/*`,
// `/api/image/*`) keep image-api's OWN envelope and go through
// `@/apis/image-api-client` (already re-seamed in Phase 02) — do NOT route them here.
//
// Every request goes through the injected `authorizedFetch` (the sub-app's single
// HTTP path: attaches the editor-session Bearer + refreshes/retries once on
// TOKEN_EXPIRED). No bare `fetch` to the service.

import { createLogger } from '@/utils/logger';
import {
  RemixGatewayError,
  type RemixGatewayErrorCode,
} from '@/stores/remix-store/gateway/remix-data-gateway';
import { SessionExpiredError } from '../auth/session-errors';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';

const log = createLogger('API', 'SwapService');

export type EditorApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface CallEditorApiArgs {
  authorizedFetch: AuthorizedFetch;
  method: EditorApiMethod;
  /** Absolute service path, e.g. '/api/editor/remixes'. */
  path: string;
  /** Optional query params (undefined / '' values dropped). */
  query?: Record<string, string | number | undefined>;
  /** JSON request body (POST / PATCH only). */
  body?: unknown;
}

interface ServiceErrorShape {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** Base URL read at call time (not frozen at module load) so `vi.stubEnv` works in
 *  tests and a runtime env override is honored. */
function serviceBaseUrl(): string {
  return (import.meta.env.VITE_REMIX_SWAP_SERVICE_BASE_URL as string | undefined) ?? '';
}

function buildUrl(path: string, query?: CallEditorApiArgs['query']): string {
  const base = serviceBaseUrl().replace(/\/$/, '');
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

/** Map the service `error.code` (+ HTTP status fallback) to the gateway taxonomy.
 *  `SNAPSHOT_NOT_FOUND` + `REMIX_BUSY` stay distinct so their call sites can toast
 *  a specific message; everything else collapses onto the closest family. */
export function mapEditorErrorCode(
  serviceCode: string | undefined,
  httpStatus: number,
): RemixGatewayErrorCode {
  switch (serviceCode) {
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'REMIX_BUSY':
      return 'REMIX_BUSY';
    case 'SNAPSHOT_NOT_FOUND':
      return 'SNAPSHOT_NOT_FOUND';
    case 'VALIDATION_ERROR':
    case 'COLUMN_NOT_WRITABLE':
      return 'VALIDATION_ERROR';
    case 'FORBIDDEN':
      return 'FORBIDDEN';
    case 'TOKEN_MISSING':
    case 'TOKEN_INVALID':
    case 'TOKEN_EXPIRED':
      return 'SESSION_EXPIRED';
    default:
      break;
  }
  if (httpStatus >= 500) return 'SERVER';
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus === 409) return 'CONFLICT';
  if (httpStatus === 403) return 'FORBIDDEN';
  if (httpStatus === 401) return 'SESSION_EXPIRED';
  if (httpStatus >= 400) return 'VALIDATION_ERROR';
  return 'UNKNOWN';
}

async function parseErrorBody(res: Response): Promise<ServiceErrorShape> {
  try {
    const body = await res.json();
    const err = body?.error;
    if (err && typeof err === 'object') {
      return {
        code: typeof err.code === 'string' ? err.code : undefined,
        message: typeof err.message === 'string' ? err.message : undefined,
        details:
          typeof err.details === 'object' && err.details !== null
            ? (err.details as Record<string, unknown>)
            : undefined,
      };
    }
  } catch {
    // non-JSON body — fall through to the generic message
  }
  return {};
}

/**
 * Call an `/api/editor/*` (or `/api/jobs/status`) endpoint and return its `data`
 * payload typed as `T`. Throws `RemixGatewayError` on any failure (HTTP error,
 * malformed envelope, network, or an expired session). The backend message is
 * preserved verbatim so existing store toasts stay unchanged.
 */
export async function callEditorApi<T>(args: CallEditorApiArgs): Promise<T> {
  const { authorizedFetch, method, path, query, body } = args;
  const url = buildUrl(path, query);
  const hasBody = body !== undefined && (method === 'POST' || method === 'PATCH');

  log.info('callEditorApi', 'request', {
    method,
    path,
    hasQuery: query !== undefined,
    hasBody,
  });

  const init: RequestInit = {
    method,
    ...(hasBody ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  };

  let res: Response;
  try {
    res = await authorizedFetch(url, init);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      log.warn('callEditorApi', 'session expired', { method, path });
      throw new RemixGatewayError(err.message, { code: 'SESSION_EXPIRED', cause: err });
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('callEditorApi', 'network error', { method, path, message });
    throw new RemixGatewayError(`Không kết nối được máy chủ (${message})`, {
      code: 'NETWORK',
      cause: err,
    });
  }

  if (!res.ok) {
    const { code, message, details } = await parseErrorBody(res);
    const gatewayCode = mapEditorErrorCode(code, res.status);
    log.error('callEditorApi', 'http error', {
      method,
      path,
      httpStatus: res.status,
      code: code ?? gatewayCode,
    });
    throw new RemixGatewayError(message ?? `HTTP ${res.status}`, {
      code: gatewayCode,
      httpStatus: res.status,
      details,
    });
  }

  let json: { success?: boolean; data?: T } | null;
  try {
    json = (await res.json()) as { success?: boolean; data?: T };
  } catch (err) {
    log.error('callEditorApi', 'malformed json', { method, path });
    throw new RemixGatewayError('Máy chủ trả về dữ liệu không hợp lệ', {
      code: 'SERVER',
      cause: err,
    });
  }

  if (!json || json.success !== true) {
    log.error('callEditorApi', 'unexpected envelope', { method, path });
    throw new RemixGatewayError('Máy chủ trả về phản hồi không hợp lệ', { code: 'SERVER' });
  }

  log.debug('callEditorApi', 'ok', { method, path, httpStatus: res.status });
  return json.data as T;
}
