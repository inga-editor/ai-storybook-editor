// player-embed-api.test.ts — pins the mint-token contract handling.
//
// The endpoint's SUCCESS shape is FLAT (`{token, tokenType, expiresAt, consumer}` —
// no `success` field), while failures arrive as an envelope (`{success:false,
// error:{code,message}}`, possibly on a 2xx) or a bare non-2xx. These tests pin
// both directions plus the auth precondition, because a shape misread here would
// silently classify every successful mint as a failure (the callImageApi trap
// documented in the module header).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mintPlayerToken, PlayerTokenError } from './player-embed-api';

const mockedGetSession = vi.hoisted(() => vi.fn());
const mockedLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: mockedGetSession } },
}));
vi.mock('@/utils/logger', () => ({ createLogger: () => mockedLog }));

const BASE_URL = 'https://image-api.test';
const ACCESS_TOKEN = 'session-jwt-abc';

const fetchMock = vi.fn();

/** Minimal Response-like object (no node builtins in FE tests). */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_IMAGE_API_BASE_URL', BASE_URL);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  mockedGetSession.mockReset().mockResolvedValue({
    data: { session: { access_token: ACCESS_TOKEN } },
    error: null,
  });
  Object.values(mockedLog).forEach((fn) => fn.mockReset());
});

describe('mintPlayerToken — success (flat shape)', () => {
  it('returns {token, expiresAt} from the FLAT success body and sends Bearer + ttl', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        token: 'player-token-1',
        tokenType: 'Bearer',
        expiresAt: '2026-08-10T12:00:00Z',
        consumer: 'preview',
      }),
    );

    const result = await mintPlayerToken('book-1');
    expect(result).toEqual({ token: 'player-token-1', expiresAt: '2026-08-10T12:00:00Z' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/player/mint-token`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ bookId: 'book-1', ttlSeconds: 3600 });
  });

  it('flat body missing token/expiresAt → MALFORMED_RESPONSE', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { tokenType: 'Bearer' }));
    await expect(mintPlayerToken('book-1')).rejects.toMatchObject({
      name: 'PlayerTokenError',
      code: 'MALFORMED_RESPONSE',
    });
  });
});

describe('mintPlayerToken — failure paths', () => {
  it('failure ENVELOPE on 2xx → PlayerTokenError with the backend code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: false, error: { code: 'NOT_FOUND', message: 'book gone' } }),
    );
    await expect(mintPlayerToken('book-x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'book gone',
    });
  });

  it('failure envelope on non-2xx → backend code wins over HTTP status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { success: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }),
    );
    await expect(mintPlayerToken('book-x')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('bare non-2xx without envelope → HTTP_{status}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: 'boom' }));
    await expect(mintPlayerToken('book-x')).rejects.toMatchObject({ code: 'HTTP_500' });
  });

  it('no active session → UNAUTHENTICATED, fetch never called', async () => {
    mockedGetSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(mintPlayerToken('book-x')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connection error → NETWORK', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(mintPlayerToken('book-x')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('thrown errors are PlayerTokenError instances', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, null));
    await expect(mintPlayerToken('book-x')).rejects.toBeInstanceOf(PlayerTokenError);
  });

  it('never logs the token itself (tokenLen only)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        token: 'super-secret-token',
        tokenType: 'Bearer',
        expiresAt: '2026-08-10T12:00:00Z',
        consumer: 'preview',
      }),
    );
    await mintPlayerToken('book-1');
    const allLogged = JSON.stringify(
      Object.values(mockedLog).flatMap((fn) => fn.mock.calls),
    );
    expect(allLogged).not.toContain('super-secret-token');
  });
});
