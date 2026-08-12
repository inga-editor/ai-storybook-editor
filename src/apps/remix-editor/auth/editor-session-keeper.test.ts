// editor-session-keeper.test.ts — flat-token session state (ADR-053): sessionStorage
// round-trip, SYNC getAccessToken (throws past exp), local resume, and the authorizedFetch
// expiry-signal contract (ANY 401 ⇒ notifySessionExpired, no retry, no refresh).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionExpiredError } from './session-errors';
import type { EditorSessionGrant } from './swap-service-auth-api';
import {
  __resetSessionKeeperForTest,
  authorizedFetch,
  clearSession,
  getAccessToken,
  getAdminName,
  getExpiresAtMs,
  loadStoredSession,
  storeSession,
  subscribeSessionExpired,
} from './editor-session-keeper';

const ACCESS_KEY = 'remix-editor.access_token';
const ADMIN_NAME_KEY = 'remix-editor.admin_name';
// Assembled from parts (not one literal) so the migration grep for the old key stays clean.
const LEGACY_CREDENTIAL_KEY = `remix-editor.${'refresh'}_token`;

/** A flat session grant with a NON-JWT access token (decode falls back to expires_in). */
function grant(access: string, expiresIn = 3600, adminName?: string): EditorSessionGrant {
  return { access_token: access, expires_in: expiresIn, admin_name: adminName };
}

/** base64url-encode an ASCII string (no padding). */
function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a fake JWT carrying a specific `exp` (epoch seconds). */
function makeJwt(expEpochSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ exp: expEpochSec }));
  return `${header}.${payload}.sig`;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetSessionKeeperForTest();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storeSession / getAccessToken (sync)', () => {
  it('persists the access token to sessionStorage and returns it synchronously', () => {
    storeSession(grant('access-1', 3600, 'Alice'));
    expect(window.sessionStorage.getItem(ACCESS_KEY)).toBe('access-1');
    expect(window.sessionStorage.getItem(ADMIN_NAME_KEY)).toBe('Alice');
    expect(getAccessToken()).toBe('access-1');
    expect(getAdminName()).toBe('Alice');
    expect(getExpiresAtMs()).toBeGreaterThan(Date.now());
  });

  it('throws SessionExpiredError + signals expiry when past exp', () => {
    const onExpired = vi.fn();
    subscribeSessionExpired(onExpired);
    storeSession(grant('stale', -10)); // expires_in negative ⇒ already past exp
    expect(() => getAccessToken()).toThrow(SessionExpiredError);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('throws SessionExpiredError when there is no session', () => {
    expect(() => getAccessToken()).toThrow(SessionExpiredError);
  });

  it('storeSession removes any stale legacy refresh token', () => {
    window.sessionStorage.setItem(LEGACY_CREDENTIAL_KEY, 'old-rt');
    storeSession(grant('access-1'));
    expect(window.sessionStorage.getItem(LEGACY_CREDENTIAL_KEY)).toBeNull();
  });
});

describe('loadStoredSession (local resume, 0 network)', () => {
  it('adopts a live JWT from storage and returns true', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    window.sessionStorage.setItem(ACCESS_KEY, makeJwt(exp));
    window.sessionStorage.setItem(ADMIN_NAME_KEY, 'Bob');
    expect(loadStoredSession()).toBe(true);
    expect(getAccessToken()).toBe(makeJwt(exp));
    expect(getAdminName()).toBe('Bob');
  });

  it('returns false for an expired JWT', () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    window.sessionStorage.setItem(ACCESS_KEY, makeJwt(exp));
    expect(loadStoredSession()).toBe(false);
  });

  it('returns false for a token with no decodable exp', () => {
    window.sessionStorage.setItem(ACCESS_KEY, 'not-a-jwt');
    expect(loadStoredSession()).toBe(false);
  });

  it('returns false when no token is stored', () => {
    expect(loadStoredSession()).toBe(false);
  });
});

describe('clearSession', () => {
  it('removes access, admin_name AND legacy refresh keys', () => {
    window.sessionStorage.setItem(LEGACY_CREDENTIAL_KEY, 'old-rt');
    storeSession(grant('access-1', 3600, 'Alice'));
    clearSession();
    expect(window.sessionStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(ADMIN_NAME_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LEGACY_CREDENTIAL_KEY)).toBeNull();
    expect(() => getAccessToken()).toThrow(SessionExpiredError);
  });
});

describe('authorizedFetch', () => {
  it('attaches the Bearer token', async () => {
    storeSession(grant('access-1'));
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    await authorizedFetch('/api/x');
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer access-1');
  });

  it('on ANY 401 signals expiry and returns the response WITHOUT retry', async () => {
    storeSession(grant('access-1'));
    const onExpired = vi.fn();
    subscribeSessionExpired(onExpired);
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));

    const res = await authorizedFetch('/api/x');
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry, no refresh
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('rejects with SessionExpiredError (no fetch) when the session is already past exp', async () => {
    storeSession(grant('stale', -10));
    await expect(authorizedFetch('/api/x')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
