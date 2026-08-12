// use-editor-session.test.ts — boot flow (exchange / local resume / needs_admin_app), one-time
// fragment wipe, the mid-session sessionExpired flag (status stays 'authed'), and the
// expiresSoon timer. ADR-053: no refresh — resume is a synchronous local exp check (0 network).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('./swap-service-auth-api', () => ({
  exchangeHandoffAssertion: vi.fn(),
}));

import { exchangeHandoffAssertion, type EditorSessionGrant } from './swap-service-auth-api';
import { AdminAuthError } from './session-errors';
import { __resetSessionKeeperForTest, authorizedFetch } from './editor-session-keeper';
import { __resetHandoffConsumedForTest, useEditorSession } from './use-editor-session';

const mockExchange = vi.mocked(exchangeHandoffAssertion);
const ACCESS_KEY = 'remix-editor.access_token';
const ADMIN_NAME_KEY = 'remix-editor.admin_name';

/** base64url-encode an ASCII string (no padding). */
function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a fake JWT carrying a specific `exp` (epoch seconds). */
function makeJwt(expEpochSec: number): string {
  return `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify({ exp: expEpochSec }))}.sig`;
}

/** A grant whose access token is a JWT expiring `ttlSec` from now. */
function jwtGrant(ttlSec: number, adminName?: string): EditorSessionGrant {
  return {
    access_token: makeJwt(Math.floor(Date.now() / 1000) + ttlSec),
    expires_in: ttlSec,
    admin_name: adminName,
  };
}

function setLocation(hash: string) {
  window.history.replaceState(
    null,
    '',
    `/book/b1${hash ? (hash.startsWith('#') ? hash : `#${hash}`) : ''}`,
  );
}

beforeEach(() => {
  __resetSessionKeeperForTest();
  __resetHandoffConsumedForTest();
  mockExchange.mockReset();
  window.sessionStorage.clear();
  setLocation('');
});

afterEach(() => setLocation(''));

describe('useEditorSession — boot', () => {
  it('handoff present → exchange OK → authed, fragment wiped, adminDisplay set', async () => {
    setLocation('#handoff=code-1');
    mockExchange.mockResolvedValue(jwtGrant(3600, 'Alice'));

    const { result } = renderHook(() => useEditorSession());
    // Fragment must vanish synchronously on mount (before any await).
    expect(window.location.hash).toBe('');

    await waitFor(() => expect(result.current.sessionStatus).toBe('authed'));
    expect(mockExchange).toHaveBeenCalledWith('code-1');
    expect(result.current.adminDisplay).toBe('Alice');
    expect(result.current.sessionExpired).toBe(false);
  });

  it('handoff present → exchange fail → needs_admin_app', async () => {
    setLocation('#handoff=bad');
    mockExchange.mockRejectedValue(new AdminAuthError('HANDOFF_INVALID'));

    const { result } = renderHook(() => useEditorSession());
    await waitFor(() => expect(result.current.sessionStatus).toBe('needs_admin_app'));
  });

  it('no handoff, live stored token → resume authed with ZERO network calls', async () => {
    window.sessionStorage.setItem(ACCESS_KEY, makeJwt(Math.floor(Date.now() / 1000) + 3600));
    window.sessionStorage.setItem(ADMIN_NAME_KEY, 'Bob');

    const { result } = renderHook(() => useEditorSession());
    await waitFor(() => expect(result.current.sessionStatus).toBe('authed'));
    expect(result.current.adminDisplay).toBe('Bob');
    expect(mockExchange).not.toHaveBeenCalled(); // resume = local exp check, no exchange
  });

  it('no handoff, expired stored token → needs_admin_app + storage cleared', async () => {
    window.sessionStorage.setItem(ACCESS_KEY, makeJwt(Math.floor(Date.now() / 1000) - 60));

    const { result } = renderHook(() => useEditorSession());
    await waitFor(() => expect(result.current.sessionStatus).toBe('needs_admin_app'));
    expect(window.sessionStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('no handoff, no token → needs_admin_app (no network calls)', async () => {
    const { result } = renderHook(() => useEditorSession());
    await waitFor(() => expect(result.current.sessionStatus).toBe('needs_admin_app'));
    expect(mockExchange).not.toHaveBeenCalled();
  });
});

describe('useEditorSession — mid-session expiry', () => {
  it('a 401 flips sessionExpired without leaving authed', async () => {
    window.sessionStorage.setItem(ACCESS_KEY, makeJwt(Math.floor(Date.now() / 1000) + 3600));

    const { result } = renderHook(() => useEditorSession());
    await waitFor(() => expect(result.current.sessionStatus).toBe('authed'));

    // A later data request returns 401 (revoked/expired) → keeper signals expiry.
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      await authorizedFetch('/api/x');
    });
    vi.unstubAllGlobals();

    await waitFor(() => expect(result.current.sessionExpired).toBe(true));
    expect(result.current.sessionStatus).toBe('authed'); // stays authed — no state destroy
  });
});

describe('useEditorSession — expiresSoon timer', () => {
  it('flips expiresSoon once the token is within 15 min of exp', async () => {
    vi.useFakeTimers();
    try {
      // Token 20 min out ⇒ initially NOT soon; advancing 6 min crosses the 15-min threshold.
      window.sessionStorage.setItem(ACCESS_KEY, makeJwt(Math.floor(Date.now() / 1000) + 20 * 60));

      const { result } = renderHook(() => useEditorSession());
      await act(async () => {
        await Promise.resolve(); // flush the (synchronous) resume boot microtask
      });
      expect(result.current.sessionStatus).toBe('authed');
      expect(result.current.expiresSoon).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(6 * 60_000); // now 14 min from exp → interval tick fires
      });
      expect(result.current.expiresSoon).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
