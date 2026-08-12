// editor-service-client.test.ts — parse the `/api/editor/*` ServiceError envelope,
// map codes to the gateway taxonomy, and route every request through authorizedFetch.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callEditorApi, mapEditorErrorCode } from './editor-service-client';
import { RemixGatewayError } from '@/stores/remix-store/gateway/remix-data-gateway';
import { SessionExpiredError } from '../auth/session-errors';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const BASE = 'https://swap.test';

beforeEach(() => {
  vi.stubEnv('VITE_REMIX_SWAP_SERVICE_BASE_URL', BASE);
});

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

describe('callEditorApi — success', () => {
  it('returns the `data` payload and builds URL + query + method', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { remixes: [] } }));
    const data = await callEditorApi<{ remixes: unknown[] }>({
      authorizedFetch: af,
      method: 'GET',
      path: '/api/editor/remixes',
      query: { snapshot_id: 'snap-1', empty: '', skip: undefined },
    });
    expect(data).toEqual({ remixes: [] });
    const [url, init] = af.mock.calls[0];
    expect(url).toBe(`${BASE}/api/editor/remixes?snapshot_id=snap-1`);
    expect(init.method).toBe('GET');
    // GET carries no Content-Type / body.
    expect(init.body).toBeUndefined();
  });

  it('serializes a JSON body for POST with Content-Type', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { remix: { id: 'r1' } } }));
    await callEditorApi({
      authorizedFetch: af,
      method: 'POST',
      path: '/api/editor/remixes',
      body: { name: 'x' },
    });
    const [, init] = af.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'x' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});

describe('callEditorApi — error mapping', () => {
  const errBody = (code: string, message = 'msg', details?: Record<string, unknown>) =>
    ({ success: false, error: { code, message, ...(details ? { details } : {}) } });

  it('404 NOT_FOUND → RemixGatewayError code NOT_FOUND + httpStatus', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse(errBody('NOT_FOUND'), 404));
    await expect(
      callEditorApi({ authorizedFetch: af, method: 'GET', path: '/api/editor/remixes/x' }),
    ).rejects.toMatchObject({ name: 'RemixGatewayError', code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('422 SNAPSHOT_NOT_FOUND → distinct code', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse(errBody('SNAPSHOT_NOT_FOUND'), 422));
    await expect(
      callEditorApi({ authorizedFetch: af, method: 'POST', path: '/api/editor/remixes', body: {} }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND', httpStatus: 422 });
  });

  it('409 REMIX_BUSY → distinct code + verbatim message', async () => {
    const af = vi.fn().mockResolvedValue(jsonResponse(errBody('REMIX_BUSY', 'has active job'), 409));
    await expect(
      callEditorApi({ authorizedFetch: af, method: 'DELETE', path: '/api/editor/remixes/x' }),
    ).rejects.toMatchObject({ code: 'REMIX_BUSY', httpStatus: 409, message: 'has active job' });
  });

  it('network throw → NETWORK', async () => {
    const af = vi.fn().mockRejectedValue(new TypeError('offline'));
    await expect(
      callEditorApi({ authorizedFetch: af, method: 'GET', path: '/api/editor/remixes' }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('SessionExpiredError → SESSION_EXPIRED', async () => {
    const af = vi.fn().mockRejectedValue(new SessionExpiredError('gone'));
    await expect(
      callEditorApi({ authorizedFetch: af, method: 'GET', path: '/api/editor/remixes' }),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('malformed JSON on 2xx → SERVER', async () => {
    const af = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(
      callEditorApi({ authorizedFetch: af, method: 'GET', path: '/api/editor/remixes' }),
    ).rejects.toMatchObject({ code: 'SERVER' });
  });
});

describe('mapEditorErrorCode', () => {
  it('maps known service codes', () => {
    expect(mapEditorErrorCode('REMIX_BUSY', 409)).toBe('REMIX_BUSY');
    expect(mapEditorErrorCode('SNAPSHOT_NOT_FOUND', 422)).toBe('SNAPSHOT_NOT_FOUND');
    expect(mapEditorErrorCode('COLUMN_NOT_WRITABLE', 400)).toBe('VALIDATION_ERROR');
    expect(mapEditorErrorCode('TOKEN_INVALID', 401)).toBe('SESSION_EXPIRED');
  });

  it('falls back by HTTP status for unknown codes', () => {
    expect(mapEditorErrorCode(undefined, 500)).toBe('SERVER');
    expect(mapEditorErrorCode('WAT', 404)).toBe('NOT_FOUND');
    expect(mapEditorErrorCode('WAT', 409)).toBe('CONFLICT');
    expect(mapEditorErrorCode('WAT', 400)).toBe('VALIDATION_ERROR');
  });
});

// Sanity: the exported error type is the real gateway error (not a local clone).
it('throws the real RemixGatewayError type', async () => {
  const af = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'x' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await callEditorApi({ authorizedFetch: af, method: 'GET', path: '/api/editor/remixes/x' }).catch(
    (e) => expect(e).toBeInstanceOf(RemixGatewayError),
  );
});
