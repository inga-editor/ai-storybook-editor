// player-embed-api.ts — Mints a short-lived Player embed token so the editor can
// preview a book inside the deployed Player sub-app (iframe + postMessage bridge).
//   mintPlayerToken() → POST /api/player/mint-token
//
// Auth = Supabase user JWT (Bearer) ONLY — same session-token pattern as
// cost-api / provenance-api, but this endpoint does NOT go through
// image-api-client: its SUCCESS shape is FLAT `{token, tokenType, expiresAt,
// consumer}` (no `success` field), which `callImageApi<R extends {success}>`
// would misread as a failure. A direct fetch with explicit shape handling is
// the smallest correct client.
//
// Failure contract (real backend): envelope `{success:false, error:{code,message}}`
// (can arrive on 2xx OR non-2xx) OR a bare non-2xx. All failures throw
// PlayerTokenError with a stable `code` the modal can branch on.
//
// ⚠️ NEVER log the token — log `tokenLen` only.

import { supabase } from './supabase';
import { createLogger } from '@/utils/logger';

const log = createLogger('API', 'PlayerEmbedApi');

/** TTL requested for every preview token. 1h comfortably outlives a preview
 *  session; the modal re-mints on `player:token-expired` anyway. */
const MINT_TTL_SECONDS = 3600;

/** Typed failure for token minting. `code` is either a backend error code
 *  (e.g. NOT_FOUND, RATE_LIMITED) or a client-side one:
 *  UNAUTHENTICATED | NETWORK | MALFORMED_RESPONSE | HTTP_{status}. */
export class PlayerTokenError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlayerTokenError';
    this.code = code;
  }
}

export interface MintedPlayerToken {
  token: string;
  expiresAt: string;
}

/** Extract `{code, message}` from the failure envelope, defensively. */
function readErrorEnvelope(body: unknown): { code?: string; message?: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  if (rec.success !== false) return null;
  const err = typeof rec.error === 'object' && rec.error !== null ? (rec.error as Record<string, unknown>) : {};
  return {
    code: typeof err.code === 'string' ? err.code : undefined,
    message: typeof err.message === 'string' ? err.message : undefined,
  };
}

/**
 * Mint a Player embed token for one book on behalf of the signed-in editor user.
 * Throws PlayerTokenError on every failure path (the preview modal maps codes to UI).
 */
export async function mintPlayerToken(bookId: string): Promise<MintedPlayerToken> {
  log.info('mintPlayerToken', 'request', { bookId, ttlSeconds: MINT_TTL_SECONDS });

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (sessionError || !accessToken) {
    log.warn('mintPlayerToken', 'no active session — cannot mint', {
      bookId,
      sessionError: sessionError?.message,
    });
    throw new PlayerTokenError('UNAUTHENTICATED', 'You must be signed in to preview.');
  }

  let response: Response;
  try {
    response = await fetch(`${import.meta.env.VITE_IMAGE_API_BASE_URL}/api/player/mint-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ bookId, ttlSeconds: MINT_TTL_SECONDS }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('mintPlayerToken', 'connection error', { bookId, message });
    throw new PlayerTokenError('NETWORK', message || 'Network error');
  }

  // Body may be the flat success, the failure envelope (even on 2xx), or unparseable.
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    log.debug('mintPlayerToken', 'response body not JSON', { bookId, status: response.status });
  }

  const envelope = readErrorEnvelope(body);
  if (envelope) {
    const code = envelope.code ?? `HTTP_${response.status}`;
    const message = envelope.message ?? `Mint token failed (HTTP ${response.status})`;
    log.warn('mintPlayerToken', 'failure envelope', { bookId, status: response.status, code });
    throw new PlayerTokenError(code, message);
  }

  if (!response.ok) {
    log.warn('mintPlayerToken', 'http error without envelope', { bookId, status: response.status });
    throw new PlayerTokenError(`HTTP_${response.status}`, `Mint token failed (HTTP ${response.status})`);
  }

  // Flat success: {token, tokenType, expiresAt, consumer}
  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const token = typeof rec.token === 'string' ? rec.token : '';
  const expiresAt = typeof rec.expiresAt === 'string' ? rec.expiresAt : '';
  if (!token || !expiresAt) {
    log.error('mintPlayerToken', 'malformed success body', {
      bookId,
      bodyKeys: typeof body === 'object' && body !== null ? Object.keys(body) : [],
    });
    throw new PlayerTokenError('MALFORMED_RESPONSE', 'Mint token response missing token/expiresAt.');
  }

  log.info('mintPlayerToken', 'ok', { bookId, tokenLen: token.length, expiresAt });
  return { token, expiresAt };
}
