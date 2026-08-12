// book-bundle-api.test.ts — GET /api/editor/book-bundle/{bookId}: URL build via
// authorizedFetch, lenient additive parse, and error-code mapping.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BookBundleApiError, fetchBookBundle, mapBundleErrorCode } from './book-bundle-api';
import { SessionExpiredError } from '../auth/session-errors';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const BASE = 'https://swap.test';

beforeEach(() => {
  vi.stubEnv('VITE_REMIX_SWAP_SERVICE_BASE_URL', BASE);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const okData = {
  contractVersion: 1,
  book: { id: 'b1', title: 'T', remix: null },
  snapshot: { id: 's1', book_id: 'b1', version: '202601010000' },
  artStyle: null,
  humans: [],
  voices: [],
};

describe('mapBundleErrorCode', () => {
  it('prefers service code over HTTP status', () => {
    expect(mapBundleErrorCode('NOT_FOUND', 500)).toBe('NOT_FOUND');
    expect(mapBundleErrorCode('FORBIDDEN', 200)).toBe('FORBIDDEN');
    expect(mapBundleErrorCode('TOKEN_INVALID', 200)).toBe('TOKEN_INVALID');
  });
  it('falls back to HTTP status', () => {
    expect(mapBundleErrorCode(undefined, 404)).toBe('NOT_FOUND');
    expect(mapBundleErrorCode(undefined, 401)).toBe('TOKEN_INVALID');
    expect(mapBundleErrorCode(undefined, 403)).toBe('FORBIDDEN');
    expect(mapBundleErrorCode(undefined, 503)).toBe('SERVER');
    expect(mapBundleErrorCode(undefined, 422)).toBe('VALIDATION_ERROR');
  });
});

describe('fetchBookBundle — success', () => {
  it('builds URL via authorizedFetch and returns the parsed bundle', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: okData }));
    const bundle = await fetchBookBundle('b1', af);
    expect(af.mock.calls[0][0]).toBe(`${BASE}/api/editor/book-bundle/b1`);
    expect(af.mock.calls[0][1].method).toBe('GET');
    expect(bundle.book.id).toBe('b1');
    expect(bundle.snapshot.id).toBe('s1');
    expect(bundle.humans).toEqual([]);
    expect(bundle.voices).toEqual([]);
    expect(bundle.contractVersion).toBe(1);
  });

  it('lenient: defaults artStyle/humans/voices and tolerates a missing contractVersion + unknown fields', async () => {
    const af = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          book: { id: 'b1', futureField: 1 },
          snapshot: { id: 's1' },
          somethingNew: true, // unknown top-level field ignored
        },
      }),
    );
    const bundle = await fetchBookBundle('b1', af);
    expect(bundle.contractVersion).toBe(0);
    expect(bundle.artStyle).toBeNull();
    expect(bundle.humans).toEqual([]);
    expect(bundle.voices).toEqual([]);
  });
});

describe('fetchBookBundle — error mapping', () => {
  const errBody = (code: string) => ({ success: false, error: { code, message: 'msg' } });

  it('404 → NOT_FOUND', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse(errBody('NOT_FOUND'), 404));
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({
      name: 'BookBundleApiError',
      code: 'NOT_FOUND',
    });
  });

  it('401 → TOKEN_INVALID', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse(errBody('TOKEN_INVALID'), 401));
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('403 → FORBIDDEN', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse({ success: false }, 403));
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('5xx → SERVER', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse(errBody('INTERNAL'), 500));
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({ code: 'SERVER' });
  });

  it('network throw → NETWORK', async () => {
    const af = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('SessionExpiredError → SESSION_EXPIRED', async () => {
    const af = vi.fn().mockRejectedValue(new SessionExpiredError('gone'));
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('missing book.id → SERVER', async () => {
    const af = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { book: {}, snapshot: { id: 's1' } } }),
    );
    await expect(fetchBookBundle('b1', af)).rejects.toBeInstanceOf(BookBundleApiError);
  });

  it('missing snapshot → SERVER', async () => {
    const af = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { book: { id: 'b1' } } }),
    );
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({ code: 'SERVER' });
  });

  it('re-throws an AbortError untouched (superseded run)', async () => {
    const af = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(fetchBookBundle('b1', af)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
