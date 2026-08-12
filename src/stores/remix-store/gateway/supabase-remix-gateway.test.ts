// supabase-remix-gateway.test.ts — Unit tests for the editor `RemixDataGateway`
// impl. Asserts the 5 methods build the expected supabase chains, surface data,
// map `PostgrestError` → `RemixGatewayError` (message preserved), and that the
// dynamic-column allowlist guard rejects a stray key BEFORE any DB call.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase chain mock (hoisted before the impl import) ────────────────────────
const { selectOrder, selectEqMaybe, insertSingle, updateEq, deleteEq, fromMock } =
  vi.hoisted(() => {
    const selectOrder = vi.fn();
    const selectEqMaybe = vi.fn();
    const insertSingle = vi.fn();
    const updateEq = vi.fn();
    const deleteEq = vi.fn();
    const fromMock = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: selectOrder,
          maybeSingle: selectEqMaybe,
        })),
      })),
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: insertSingle })) })),
      update: vi.fn(() => ({ eq: updateEq })),
      delete: vi.fn(() => ({ eq: deleteEq })),
    }));
    return { selectOrder, selectEqMaybe, insertSingle, updateEq, deleteEq, fromMock };
  });

vi.mock('@/apis/supabase', () => ({ supabase: { from: fromMock } }));

import { supabaseRemixGateway } from './supabase-remix-gateway';
import { RemixGatewayError } from './remix-data-gateway';
import type { InsertableRemixRow } from '@/types/remix';

const pgError = { message: 'db down', code: '500', details: '', hint: '' };

beforeEach(() => {
  fromMock.mockClear();
  selectOrder.mockReset();
  selectEqMaybe.mockReset();
  insertSingle.mockReset();
  updateEq.mockReset();
  deleteEq.mockReset();
});

describe('listBySnapshot', () => {
  it('returns rows ordered by created_at ascending', async () => {
    selectOrder.mockResolvedValue({ data: [{ id: 'r1' }, { id: 'r2' }], error: null });
    const rows = await supabaseRemixGateway.listBySnapshot('snap-1');
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(fromMock).toHaveBeenCalledWith('remixes');
  });

  it('coalesces a null data payload to []', async () => {
    selectOrder.mockResolvedValue({ data: null, error: null });
    expect(await supabaseRemixGateway.listBySnapshot('snap-1')).toEqual([]);
  });

  it('maps PostgrestError → RemixGatewayError (message preserved)', async () => {
    selectOrder.mockResolvedValue({ data: null, error: pgError });
    await expect(supabaseRemixGateway.listBySnapshot('snap-1')).rejects.toMatchObject({
      message: 'db down',
      code: 'SERVER',
    });
  });
});

describe('getById', () => {
  it('returns the row when present', async () => {
    selectEqMaybe.mockResolvedValue({ data: { id: 'r1' }, error: null });
    expect(await supabaseRemixGateway.getById('r1')).toEqual({ id: 'r1' });
  });

  it('returns null when the row is absent', async () => {
    selectEqMaybe.mockResolvedValue({ data: null, error: null });
    expect(await supabaseRemixGateway.getById('r1')).toBeNull();
  });

  it('throws on error', async () => {
    selectEqMaybe.mockResolvedValue({ data: null, error: pgError });
    await expect(supabaseRemixGateway.getById('r1')).rejects.toBeInstanceOf(RemixGatewayError);
  });
});

describe('create', () => {
  const payload = { snapshot_id: 'snap-1', name: 'X' } as unknown as InsertableRemixRow;

  it('returns the inserted row', async () => {
    insertSingle.mockResolvedValue({ data: { id: 'new-1' }, error: null });
    expect(await supabaseRemixGateway.create(payload)).toEqual({ id: 'new-1' });
  });

  it('throws when insert returns no row', async () => {
    insertSingle.mockResolvedValue({ data: null, error: null });
    await expect(supabaseRemixGateway.create(payload)).rejects.toBeInstanceOf(RemixGatewayError);
  });

  it('throws (message preserved) on error', async () => {
    insertSingle.mockResolvedValue({ data: null, error: pgError });
    await expect(supabaseRemixGateway.create(payload)).rejects.toMatchObject({ message: 'db down' });
  });
});

describe('updateColumns', () => {
  it('resolves on success and issues one update', async () => {
    updateEq.mockResolvedValue({ error: null });
    await expect(
      supabaseRemixGateway.updateColumns('r1', { name: 'Renamed' }),
    ).resolves.toBeUndefined();
    expect(updateEq).toHaveBeenCalledWith('id', 'r1');
  });

  it('accepts the dynamic stage columns (rmbgs/upscales) — parity', async () => {
    updateEq.mockResolvedValue({ error: null });
    await expect(
      supabaseRemixGateway.updateColumns('r1', { rmbgs: [], upscales: [] }),
    ).resolves.toBeUndefined();
  });

  it('rejects a non-writable column BEFORE any DB call', async () => {
    await expect(
      supabaseRemixGateway.updateColumns('r1', {
        // @ts-expect-error — intentionally stray key to exercise the guard
        status: 'ready',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('maps a persist error (message preserved)', async () => {
    updateEq.mockResolvedValue({ error: pgError });
    await expect(
      supabaseRemixGateway.updateColumns('r1', { name: 'X' }),
    ).rejects.toMatchObject({ message: 'db down', code: 'SERVER' });
  });
});

describe('remove', () => {
  it('resolves on success', async () => {
    deleteEq.mockResolvedValue({ error: null });
    await expect(supabaseRemixGateway.remove('r1')).resolves.toBeUndefined();
    expect(deleteEq).toHaveBeenCalledWith('id', 'r1');
  });

  it('throws on error', async () => {
    deleteEq.mockResolvedValue({ error: pgError });
    await expect(supabaseRemixGateway.remove('r1')).rejects.toBeInstanceOf(RemixGatewayError);
  });
});
