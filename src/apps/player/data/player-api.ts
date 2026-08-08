// player-api.ts — Token-gated data source for the Player sub-app.
//
// Contract: POST `${VITE_IMAGE_API_BASE_URL}/api/player/get-book-preview`, auth via
// `Authorization: Bearer <token>` (NOT X-API-Key — that would leak in the bundle), body
// `'{}'` (scope lives in the token claims — the client NEVER sends bookId/remixId).
//
// Parse is LENIENT (governance: additive-only): unknown fields pass through, missing new
// fields default, unknown enums fall back. Only `book.id` is required. Precedent
// `share-api.ts` puts the token in the BODY — the player puts it in the HEADER; don't copy that.

import { createLogger } from '@/utils/logger';
import type { PlayerErrorCode } from '../embed/player-messages';
import {
  PlayerApiError,
  type PlayableBookPayload,
  type PlayerDataSource,
  type PlayerViewConfig,
} from './player-types';

const log = createLogger('Player', 'PlayerApi');

const IMAGE_API_BASE_URL = import.meta.env.VITE_IMAGE_API_BASE_URL;
const ENDPOINT = '/api/player/get-book-preview';

/**
 * Map an HTTP error to a `PlayerErrorCode`. Reads `error.code` from the body — NOT the
 * status alone — because 401 splits into TOKEN_EXPIRED (retryable) vs TOKEN_INVALID.
 */
function mapError(status: number, bodyCode: unknown): PlayerErrorCode {
  if (status === 401) {
    return bodyCode === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
  }
  if (status === 404) return 'NOT_FOUND'; // includes book-without-snapshot
  if (status === 429) return 'RATE_LIMITED';
  if (status === 403) return 'FORBIDDEN'; // unreachable — defensive fallback
  return 'SERVER'; // 5xx, lowercase "internal_error", unknown codes
}

/** Parse `Retry-After` (seconds form) → number, else undefined. */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Normalize the view config leniently:
 *  - editions: coerce to booleans; if all three are false/absent → all true (show everything).
 *  - languages: keep only entries with a `code`; default `name` to `''` (UI does `name || code`).
 */
function normalizeViewConfig(raw: unknown): PlayerViewConfig {
  const v = (raw ?? {}) as Record<string, unknown>;
  const e = (v.editions ?? {}) as Record<string, unknown>;

  const classic = Boolean(e.classic);
  const dynamic = Boolean(e.dynamic);
  const interactive = Boolean(e.interactive);
  const allFalse = !classic && !dynamic && !interactive;
  const editions = allFalse
    ? { classic: true, dynamic: true, interactive: true }
    : { classic, dynamic, interactive };

  const languages = Array.isArray(v.languages)
    ? (v.languages as unknown[])
        .filter(
          (l): l is Record<string, unknown> =>
            typeof l === 'object' &&
            l !== null &&
            typeof (l as Record<string, unknown>).code === 'string' &&
            ((l as Record<string, unknown>).code as string).length > 0,
        )
        .map((l) => ({
          name: typeof l.name === 'string' ? (l.name as string) : '',
          code: l.code as string,
        }))
    : [];

  return { editions, languages };
}

/**
 * Create a `PlayerDataSource` bound to one opaque token. Each `loadPlayableBook` call is a
 * single POST; pass an `AbortSignal` to cancel it (the hook uses this to drop stale races).
 */
export function createTokenDataSource(token: string): PlayerDataSource {
  return {
    async loadPlayableBook(signal?: AbortSignal): Promise<PlayableBookPayload> {
      const url = `${IMAGE_API_BASE_URL}${ENDPOINT}`;
      log.info('loadPlayableBook', 'request', { tokenLen: token.length });

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: '{}', // scope is in the token — never send bookId/remixId
          signal,
        });
      } catch {
        // Network failure OR abort. Aborts are discarded by the hook's nonce guard.
        log.warn('loadPlayableBook', 'fetch threw (network/abort)', {
          aborted: signal?.aborted ?? false,
        });
        throw new PlayerApiError('NETWORK');
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null); // error body may not be JSON
        const bodyCode = (body as { error?: { code?: unknown } } | null)?.error?.code;
        const code = mapError(res.status, bodyCode);
        const retryAfter =
          res.status === 429 ? parseRetryAfterSeconds(res.headers.get('Retry-After')) : undefined;
        log.error('loadPlayableBook', 'http error', {
          status: res.status,
          errorCode: code,
          retryAfterSeconds: retryAfter,
        });
        throw new PlayerApiError(code, retryAfter);
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        log.error('loadPlayableBook', 'malformed 200 (json parse)', { status: res.status });
        throw new PlayerApiError('SERVER');
      }

      // Minimal lenient guard — only the field render truly requires. Do NOT strip
      // unknown fields: additive-only fields must pass through untouched.
      const d = data as Record<string, unknown>;
      const book = d?.book as { id?: unknown } | undefined;
      if (!book?.id) {
        log.error('loadPlayableBook', 'malformed 200 (missing book.id)', { status: res.status });
        throw new PlayerApiError('SERVER');
      }

      const snapshot = (d.snapshot ?? null) as PlayableBookPayload['snapshot'];
      const spreadCount = snapshot?.illustration?.spreads?.length ?? 0;
      const contractVersion = typeof d.contractVersion === 'number' ? d.contractVersion : 0;
      log.debug('loadPlayableBook', 'response ok', {
        status: res.status,
        contractVersion,
        spreadCount,
      });

      return {
        contractVersion,
        viewConfig: normalizeViewConfig(d.viewConfig),
        book: d.book as PlayableBookPayload['book'],
        snapshot,
      };
    },
  };
}
