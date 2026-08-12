// book-bundle-api.ts — GET /api/editor/book-bundle/{bookId} over the injected
// `authorizedFetch` (the sub-app's single HTTP path: Bearer attached + one
// silent refresh/retry on TOKEN_EXPIRED). No bare `fetch`.
//
// Parse is LENIENT + additive-only (mirrors player-api.ts): only `book.id` and
// `snapshot` are required; `contractVersion` is log-only and never gates parse;
// unknown fields pass through untouched. Failures throw `BookBundleApiError`
// carrying a `RemixEditorErrorCode` — mapped from the service `error.code` first,
// HTTP status as fallback (404→NOT_FOUND, 401→TOKEN_INVALID, 403→FORBIDDEN,
// 5xx→SERVER, network→NETWORK).
import { createLogger } from '@/utils/logger';
import { SessionExpiredError } from '../auth/session-errors';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';
import type { RemixEditorErrorCode } from '../types/remix-editor-status';
import type { RemixEditorBookBundle } from './remix-editor-bundle-types';

const log = createLogger('RemixEditor', 'BookBundleApi');

/** Typed transport error. `code` is the display taxonomy (mapped to hard-coded copy
 *  by the error state — the raw `message` is NEVER shown verbatim). */
export class BookBundleApiError extends Error {
  readonly code: RemixEditorErrorCode;
  constructor(code: RemixEditorErrorCode, message: string) {
    super(message);
    this.name = 'BookBundleApiError';
    this.code = code;
  }
}

/** Base URL read at call time (not frozen at module load) so `vi.stubEnv` works. */
function serviceBaseUrl(): string {
  return (import.meta.env.VITE_REMIX_SWAP_SERVICE_BASE_URL as string | undefined) ?? '';
}

/** Map the service `error.code` (+ HTTP status fallback) to the display taxonomy. */
export function mapBundleErrorCode(
  serviceCode: string | undefined,
  httpStatus: number,
): RemixEditorErrorCode {
  switch (serviceCode) {
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'FORBIDDEN':
      return 'FORBIDDEN';
    case 'TOKEN_MISSING':
      return 'TOKEN_MISSING';
    case 'TOKEN_INVALID':
      return 'TOKEN_INVALID';
    case 'TOKEN_EXPIRED':
      return 'TOKEN_EXPIRED';
    case 'VALIDATION_ERROR':
      return 'VALIDATION_ERROR';
    default:
      break;
  }
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus === 401) return 'TOKEN_INVALID';
  if (httpStatus === 403) return 'FORBIDDEN';
  if (httpStatus >= 500) return 'SERVER';
  if (httpStatus >= 400) return 'VALIDATION_ERROR';
  return 'SERVER';
}

interface ServiceErrorShape {
  code?: string;
  message?: string;
}

async function parseErrorBody(res: Response): Promise<ServiceErrorShape> {
  try {
    const body = await res.json();
    const err = body?.error;
    if (err && typeof err === 'object') {
      return {
        code: typeof err.code === 'string' ? err.code : undefined,
        message: typeof err.message === 'string' ? err.message : undefined,
      };
    }
  } catch {
    // non-JSON body — fall through to the generic message
  }
  return {};
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Load the book bundle for `bookId`. Throws `BookBundleApiError` on any failure
 * (or re-throws an `AbortError` untouched so the caller can drop a superseded run).
 */
export async function fetchBookBundle(
  bookId: string,
  authorizedFetch: AuthorizedFetch,
  signal?: AbortSignal,
): Promise<RemixEditorBookBundle> {
  const url = `${serviceBaseUrl().replace(/\/$/, '')}/api/editor/book-bundle/${encodeURIComponent(bookId)}`;
  log.info('fetchBookBundle', 'request', { bookId });

  let res: Response;
  try {
    res = await authorizedFetch(url, { method: 'GET', signal });
  } catch (err) {
    if (isAbort(err)) throw err; // superseded run — let the caller drop it
    if (err instanceof SessionExpiredError) {
      log.warn('fetchBookBundle', 'session expired', { bookId });
      throw new BookBundleApiError('SESSION_EXPIRED', err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('fetchBookBundle', 'network error', { bookId, message });
    throw new BookBundleApiError('NETWORK', message);
  }

  if (!res.ok) {
    const { code, message } = await parseErrorBody(res);
    const mapped = mapBundleErrorCode(code, res.status);
    log.error('fetchBookBundle', 'http error', {
      bookId,
      httpStatus: res.status,
      code: code ?? mapped,
    });
    throw new BookBundleApiError(mapped, message ?? `HTTP ${res.status}`);
  }

  let json: { success?: boolean; data?: unknown } | null;
  try {
    json = (await res.json()) as { success?: boolean; data?: unknown };
  } catch (err) {
    log.error('fetchBookBundle', 'malformed json', { bookId });
    throw new BookBundleApiError('SERVER', err instanceof Error ? err.message : 'malformed json');
  }

  if (!json || json.success !== true || typeof json.data !== 'object' || json.data === null) {
    log.error('fetchBookBundle', 'unexpected envelope', { bookId });
    throw new BookBundleApiError('SERVER', 'unexpected response envelope');
  }

  // ── LENIENT parse: only `book.id` + `snapshot` required; everything else is
  //    additive / defaulted. Unknown fields flow through unchanged.
  const data = json.data as Record<string, unknown>;
  const book = data.book as RemixEditorBookBundle['book'] | undefined;
  if (!book || typeof book.id !== 'string') {
    throw new BookBundleApiError('SERVER', 'bundle missing book.id');
  }
  const snapshot = data.snapshot as RemixEditorBookBundle['snapshot'] | undefined;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new BookBundleApiError('SERVER', 'bundle missing snapshot');
  }

  const bundle: RemixEditorBookBundle = {
    contractVersion: typeof data.contractVersion === 'number' ? data.contractVersion : 0,
    book,
    snapshot,
    artStyle: (data.artStyle as RemixEditorBookBundle['artStyle']) ?? null,
    humans: Array.isArray(data.humans) ? (data.humans as RemixEditorBookBundle['humans']) : [],
    voices: Array.isArray(data.voices) ? (data.voices as RemixEditorBookBundle['voices']) : [],
  };

  log.info('fetchBookBundle', 'ok', {
    bookId,
    hasSnapshot: !!snapshot.id,
    humans: bundle.humans.length,
    voices: bundle.voices.length,
    contractVersion: bundle.contractVersion,
  });
  return bundle;
}
