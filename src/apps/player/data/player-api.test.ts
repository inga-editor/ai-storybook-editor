// player-api.test.ts — token-gated data source: contract, lenient parse, error mapping.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createTokenDataSource } from './player-api';
import { PlayerApiError } from './player-types';

interface FakeResponseInit {
  ok?: boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  throwOnJson?: boolean;
}

function fakeResponse({ status, body, headers = {}, throwOnJson }: FakeResponseInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => {
      if (throwOnJson) throw new SyntaxError('bad json');
      return body;
    },
  } as unknown as Response;
}

function stubFetch(impl: (...args: unknown[]) => Promise<Response> | Response) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

const OK_BODY = {
  contractVersion: 3,
  viewConfig: {
    editions: { classic: true, dynamic: false, interactive: false },
    languages: [{ name: 'Tiếng Việt', code: 'vi' }],
  },
  book: { id: 'book-1', title: 'B' },
  snapshot: { id: 'snap-1', version: '1', illustration: { spreads: [{}, {}], sections: [] } },
};

describe('createTokenDataSource.loadPlayableBook', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('sends Bearer token in header + empty body (no bookId)', async () => {
    const mock = stubFetch(() => fakeResponse({ status: 200, body: OK_BODY }));
    await createTokenDataSource('secret-tok').loadPlayableBook();

    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-tok' });
    expect(init.body).toBe('{}');
  });

  it('parses a valid 200 response', async () => {
    stubFetch(() => fakeResponse({ status: 200, body: OK_BODY }));
    const payload = await createTokenDataSource('t').loadPlayableBook();

    expect(payload.contractVersion).toBe(3);
    expect(payload.book.id).toBe('book-1');
    expect(payload.snapshot?.id).toBe('snap-1');
    expect(payload.viewConfig.editions).toEqual({
      classic: true,
      dynamic: false,
      interactive: false,
    });
  });

  it('passes through UNKNOWN fields (additive-only, no strip/reject)', async () => {
    const body = {
      ...OK_BODY,
      brandNewTopLevelField: { foo: 1 },
      book: { ...OK_BODY.book, futureField: 'x' },
    };
    stubFetch(() => fakeResponse({ status: 200, body }));
    const payload = await createTokenDataSource('t').loadPlayableBook();

    expect(payload.book.id).toBe('book-1');
    // unknown field survived on the book object
    expect((payload.book as unknown as Record<string, unknown>).futureField).toBe('x');
  });

  it('defaults editions to all-true when viewConfig absent', async () => {
    const body = { ...OK_BODY, viewConfig: undefined };
    stubFetch(() => fakeResponse({ status: 200, body }));
    const payload = await createTokenDataSource('t').loadPlayableBook();

    expect(payload.viewConfig.editions).toEqual({
      classic: true,
      dynamic: true,
      interactive: true,
    });
    expect(payload.viewConfig.languages).toEqual([]);
  });

  it('defaults editions to all-true when all three are false', async () => {
    const body = {
      ...OK_BODY,
      viewConfig: { editions: { classic: false, dynamic: false, interactive: false }, languages: [] },
    };
    stubFetch(() => fakeResponse({ status: 200, body }));
    const payload = await createTokenDataSource('t').loadPlayableBook();
    expect(payload.viewConfig.editions).toEqual({
      classic: true,
      dynamic: true,
      interactive: true,
    });
  });

  it("preserves languages[].name === '' (UI falls back to code)", async () => {
    const body = {
      ...OK_BODY,
      viewConfig: { editions: { classic: true }, languages: [{ name: '', code: 'en' }] },
    };
    stubFetch(() => fakeResponse({ status: 200, body }));
    const payload = await createTokenDataSource('t').loadPlayableBook();
    expect(payload.viewConfig.languages).toEqual([{ name: '', code: 'en' }]);
  });

  it('drops language entries without a code', async () => {
    const body = {
      ...OK_BODY,
      viewConfig: {
        editions: { classic: true },
        languages: [{ name: 'X' }, { name: 'Y', code: 'vi' }],
      },
    };
    stubFetch(() => fakeResponse({ status: 200, body }));
    const payload = await createTokenDataSource('t').loadPlayableBook();
    expect(payload.viewConfig.languages).toEqual([{ name: 'Y', code: 'vi' }]);
  });

  it('accepts snapshot: null defensively', async () => {
    const body = { ...OK_BODY, snapshot: null };
    stubFetch(() => fakeResponse({ status: 200, body }));
    const payload = await createTokenDataSource('t').loadPlayableBook();
    expect(payload.snapshot).toBeNull();
  });

  it('maps 401 TOKEN_EXPIRED → TOKEN_EXPIRED', async () => {
    stubFetch(() => fakeResponse({ status: 401, body: { error: { code: 'TOKEN_EXPIRED' } } }));
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  it('maps other 401 → TOKEN_INVALID', async () => {
    stubFetch(() => fakeResponse({ status: 401, body: { error: { code: 'TOKEN_MISSING' } } }));
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('maps 401 with no error.code → TOKEN_INVALID (safe, non-retryable)', async () => {
    stubFetch(() => fakeResponse({ status: 401, body: {} }));
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('maps 404 → NOT_FOUND', async () => {
    stubFetch(() => fakeResponse({ status: 404, body: { error: { code: 'NOT_FOUND' } } }));
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps 429 → RATE_LIMITED and reads Retry-After seconds', async () => {
    stubFetch(() =>
      fakeResponse({ status: 429, body: { error: { code: 'RATE_LIMITED' } }, headers: { 'Retry-After': '42' } }),
    );
    try {
      await createTokenDataSource('t').loadPlayableBook();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlayerApiError);
      expect((err as PlayerApiError).code).toBe('RATE_LIMITED');
      expect((err as PlayerApiError).retryAfterSeconds).toBe(42);
    }
  });

  it('maps 500 lowercase internal_error → SERVER', async () => {
    stubFetch(() => fakeResponse({ status: 500, body: { error: { code: 'internal_error' } } }));
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'SERVER',
    });
  });

  it('maps a fetch throw → NETWORK', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('throws SERVER on malformed 200 (missing book.id)', async () => {
    stubFetch(() => fakeResponse({ status: 200, body: { book: {} } }));
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'SERVER',
    });
  });

  it('throws SERVER on unparseable 200 json', async () => {
    stubFetch(() => fakeResponse({ status: 200, throwOnJson: true }));
    await expect(createTokenDataSource('t').loadPlayableBook()).rejects.toMatchObject({
      code: 'SERVER',
    });
  });
});
