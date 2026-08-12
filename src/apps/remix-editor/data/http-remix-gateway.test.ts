// http-remix-gateway.test.ts — the 5-method gateway wiring + the not-found/busy
// error semantics the store depends on.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHttpRemixGateway } from './http-remix-gateway';
import { RemixGatewayError } from '@/stores/remix-store/gateway/remix-data-gateway';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockCall = vi.hoisted(() => vi.fn());
vi.mock('./editor-service-client', () => ({ callEditorApi: mockCall }));

const af = vi.fn(); // never actually called (callEditorApi is mocked); just an identity
const gw = createHttpRemixGateway(af);

beforeEach(() => {
  mockCall.mockReset();
});

describe('listBySnapshot', () => {
  it('GETs /api/editor/remixes with snapshot_id query and returns data.remixes', async () => {
    mockCall.mockResolvedValue({ remixes: [{ id: 'r1' }, { id: 'r2' }] });
    const rows = await gw.listBySnapshot('snap-1');
    expect(rows).toHaveLength(2);
    const args = mockCall.mock.calls[0][0];
    expect(args).toMatchObject({
      method: 'GET',
      path: '/api/editor/remixes',
      query: { snapshot_id: 'snap-1' },
    });
  });
});

describe('getById', () => {
  it('returns data.remix on success', async () => {
    mockCall.mockResolvedValue({ remix: { id: 'r1' } });
    expect(await gw.getById('r1')).toEqual({ id: 'r1' });
    expect(mockCall.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: '/api/editor/remixes/r1',
    });
  });

  it('maps 404 NOT_FOUND → null (maybeSingle parity)', async () => {
    mockCall.mockRejectedValue(new RemixGatewayError('gone', { code: 'NOT_FOUND', httpStatus: 404 }));
    expect(await gw.getById('missing')).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    mockCall.mockRejectedValue(new RemixGatewayError('boom', { code: 'SERVER', httpStatus: 500 }));
    await expect(gw.getById('r1')).rejects.toMatchObject({ code: 'SERVER' });
  });
});

describe('create', () => {
  it('POSTs the payload and returns data.remix', async () => {
    const payload = { snapshot_id: 'snap-1', name: 'My remix' } as never;
    mockCall.mockResolvedValue({ remix: { id: 'r-new' } });
    const row = await gw.create(payload);
    expect(row).toEqual({ id: 'r-new' });
    expect(mockCall.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/api/editor/remixes',
      body: payload,
    });
  });

  it('propagates 422 SNAPSHOT_NOT_FOUND (distinct code)', async () => {
    mockCall.mockRejectedValue(
      new RemixGatewayError('no snapshot', { code: 'SNAPSHOT_NOT_FOUND', httpStatus: 422 }),
    );
    await expect(gw.create({} as never)).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
  });
});

describe('updateColumns', () => {
  it('PATCHes /columns with a { columns } body', async () => {
    mockCall.mockResolvedValue({ remix_id: 'r1', updated_columns: ['name'] });
    await gw.updateColumns('r1', { name: 'renamed' });
    expect(mockCall.mock.calls[0][0]).toMatchObject({
      method: 'PATCH',
      path: '/api/editor/remixes/r1/columns',
      body: { columns: { name: 'renamed' } },
    });
  });
});

describe('remove', () => {
  it('DELETEs the remix (200 {deleted} resolves)', async () => {
    mockCall.mockResolvedValue({ remix_id: 'r1', deleted: true });
    await expect(gw.remove('r1')).resolves.toBeUndefined();
    expect(mockCall.mock.calls[0][0]).toMatchObject({
      method: 'DELETE',
      path: '/api/editor/remixes/r1',
    });
  });

  it('propagates 409 REMIX_BUSY as a distinct code', async () => {
    mockCall.mockRejectedValue(
      new RemixGatewayError('busy', { code: 'REMIX_BUSY', httpStatus: 409 }),
    );
    await expect(gw.remove('r1')).rejects.toMatchObject({ code: 'REMIX_BUSY' });
  });
});
