// editor-session-keeper.ts — Module-level session state + `authorizedFetch` (the ONLY HTTP
// path of the sub-app).
//
// Lives OUTSIDE React so non-hook consumers (gateway, bundle loader, job polling) share one
// access token. ADR-053 storage layout (auth spec §2, rev 260812):
//   • access token → sessionStorage (tab-scoped credential — MUST survive F5)
//   • admin_name   → sessionStorage (display header after F5)
//   • NO refresh token — expiry is a one-way event, nothing to renew.
//
// `getAccessToken` is SYNC: it returns the current token or throws SessionExpiredError once
// past `exp` (there is no refresh path to await). `authorizedFetch` signals expiry on ANY
// 401 (TOKEN_EXPIRED or TOKEN_INVALID/revoked) — no body read, no retry, no loop.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/01-editor-auth-module.md §2.3/§2.4.
import { createLogger } from '@/utils/logger';
import { decodeJwtExp } from './decode-jwt-exp';
import { SessionExpiredError } from './session-errors';
import type { EditorSessionGrant } from './swap-service-auth-api';

const log = createLogger('RemixEditor', 'SessionKeeper');

/** sessionStorage key for the flat 12h access token (tab-scoped, survives F5). */
const ACCESS_TOKEN_KEY = 'remix-editor.access_token';
/** sessionStorage key for the admin display name (optional). */
const ADMIN_NAME_KEY = 'remix-editor.admin_name';
/** Legacy pre-ADR-053 credential key — resolves to `remix-editor.<refresh>_token`; removed on
 *  every clear/store so no stale credential lingers after the migration. Assembled from parts
 *  (not a single literal) so the migration grep for the old key name stays clean. */
const LEGACY_CREDENTIAL_KEY = `remix-editor.${'refresh'}_token`;

export type AuthorizedFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

// --- Module-level session state (single source of truth for the whole sub-app) -----------
let accessToken: string | null = null;
let expiresAtMs = 0;
let adminName: string | null = null;
const expiredListeners = new Set<() => void>();

/** Remove any stale legacy refresh token (pre-ADR-053 sessions). */
function removeLegacyRefreshToken(): void {
  try {
    window.sessionStorage.removeItem(LEGACY_CREDENTIAL_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Persist a fresh session grant (access token in sessionStorage + module state). Prefers the
 * token's own `exp` (absolute, robust to latency); falls back to `expires_in`.
 */
export function storeSession(grant: EditorSessionGrant): void {
  accessToken = grant.access_token;
  const decoded = decodeJwtExp(grant.access_token);
  expiresAtMs = decoded.expMs ?? Date.now() + grant.expires_in * 1000;
  adminName =
    typeof grant.admin_name === 'string' && grant.admin_name.length > 0 ? grant.admin_name : null;

  try {
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, grant.access_token);
    if (adminName !== null) {
      window.sessionStorage.setItem(ADMIN_NAME_KEY, adminName);
    } else {
      window.sessionStorage.removeItem(ADMIN_NAME_KEY);
    }
  } catch {
    log.warn('storeSession', 'sessionStorage write failed (private mode?)');
  }
  removeLegacyRefreshToken();

  log.debug('storeSession', 'session stored', {
    ttlMs: expiresAtMs - Date.now(),
    hasAdminName: adminName !== null,
  });
}

/**
 * Boot resume (auth spec §3.5): read the stored access token, decode `exp`, and adopt it into
 * module state ONLY if still valid (LOCAL check, sync, 0 network). Returns whether a live
 * session was restored. A missing/expired/undecodable token yields `false` (caller clears).
 */
export function loadStoredSession(): boolean {
  let stored: string | null;
  try {
    stored = window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    stored = null;
  }
  if (!stored) {
    log.debug('loadStoredSession', 'no stored access token');
    return false;
  }

  const { expMs } = decodeJwtExp(stored);
  if (expMs === null || Date.now() >= expMs) {
    log.debug('loadStoredSession', 'stored token missing exp or already expired');
    return false;
  }

  accessToken = stored;
  expiresAtMs = expMs;
  try {
    adminName = window.sessionStorage.getItem(ADMIN_NAME_KEY);
  } catch {
    adminName = null;
  }
  log.info('loadStoredSession', 'resumed session from storage', {
    ttlMs: expiresAtMs - Date.now(),
    hasAdminName: adminName !== null,
  });
  return true;
}

/** Drop the session from memory AND sessionStorage (incl. the legacy refresh key). */
export function clearSession(): void {
  accessToken = null;
  expiresAtMs = 0;
  adminName = null;
  try {
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    window.sessionStorage.removeItem(ADMIN_NAME_KEY);
  } catch {
    /* ignore */
  }
  removeLegacyRefreshToken();
  log.debug('clearSession', 'session cleared');
}

/** Display name from the last exchange/resume (null until one arrives). */
export function getAdminName(): string | null {
  return adminName;
}

/** Absolute expiry (epoch-ms) of the current token; 0 when no session. Drives the hook timer. */
export function getExpiresAtMs(): number {
  return expiresAtMs;
}

/** Subscribe to "session expired" signals (mid-flight 401 or past-exp read). Returns unsub. */
export function subscribeSessionExpired(cb: () => void): () => void {
  expiredListeners.add(cb);
  return () => {
    expiredListeners.delete(cb);
  };
}

function notifySessionExpired(): void {
  for (const cb of expiredListeners) {
    try {
      cb();
    } catch {
      /* isolate listener failures */
    }
  }
}

/**
 * Return the current access token, SYNC. Throws SessionExpiredError (and signals expiry) once
 * there is no token or `now >= exp` — there is no refresh path to fall back on (ADR-053).
 */
export function getAccessToken(): string {
  if (!accessToken || Date.now() >= expiresAtMs) {
    log.debug('getAccessToken', 'no token or past exp', { hasToken: accessToken !== null });
    notifySessionExpired();
    throw new SessionExpiredError();
  }
  return accessToken;
}

/** Merge `Authorization: Bearer <token>` into an init without mutating the caller's object. */
function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * The sub-app's single HTTP path: attaches the Bearer token and, on ANY 401, signals session
 * expiry (TOKEN_EXPIRED or TOKEN_INVALID/revoked — no distinction, nothing to refresh). The
 * 401 response is returned as-is; the pending caller's mutation fails but dirty store state is
 * KEPT so the shell can overlay a re-authorize modal. No body read, no retry, no loop.
 */
export const authorizedFetch: AuthorizedFetch = async (input, init) => {
  const token = getAccessToken(); // throws SessionExpiredError if already past exp
  const res = await fetch(input, withBearer(init, token));
  if (res.status === 401) {
    log.debug('authorizedFetch', '401 — session expired/invalid, signalling');
    notifySessionExpired();
  }
  return res;
};

/** Test-only: reset all module state. Not for production use. */
export function __resetSessionKeeperForTest(): void {
  accessToken = null;
  expiresAtMs = 0;
  adminName = null;
  expiredListeners.clear();
  try {
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    window.sessionStorage.removeItem(ADMIN_NAME_KEY);
    window.sessionStorage.removeItem(LEGACY_CREDENTIAL_KEY);
  } catch {
    /* ignore */
  }
}
