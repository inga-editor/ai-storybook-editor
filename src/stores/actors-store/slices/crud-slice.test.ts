// crud-slice.test.ts — createActorPair: happy INSERT, the 23505 (uq_actors_pair)
// collaborator-race reuse path (SELECT existing + no throw), and the
// no-active-snapshot guard. Supabase client fully faked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawActorRow } from '../supabase-mapping';

// ── Faked module boundaries (hoisted so vi.mock factories can reference them) ──
// A thenable PostgREST-style builder: chain methods return the builder;
// single()/maybeSingle() resolve their configured result; awaiting the builder
// itself (delete().eq()) resolves `terminal`. Each from() call shifts one result.
const h = vi.hoisted(() => {
  const state = {
    fromQueue: [] as Array<Record<string, unknown>>,
    snapshotMeta: { id: 'snap-1', bookId: 'book-1' } as { id: string; bookId: string },
    toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    supabaseFrom: vi.fn(),
  };
  function makeBuilder(result: Record<string, unknown>) {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.insert = chain;
    b.select = chain;
    b.eq = chain;
    b.delete = chain;
    b.update = chain;
    b.single = () => Promise.resolve(result.single ?? { data: null, error: null });
    b.maybeSingle = () => Promise.resolve(result.maybeSingle ?? { data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result.terminal ?? { error: null }).then(resolve, reject);
    return b;
  }
  state.supabaseFrom = vi.fn(() => makeBuilder(state.fromQueue.shift() ?? {}));
  return state;
});

vi.mock('@/apis/supabase', () => ({
  supabase: {
    from: (...a: unknown[]) => h.supabaseFrom(...a),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
}));
vi.mock('@/apis/supabase-realtime', () => ({ ensureRealtimeAuth: vi.fn() }));
vi.mock('@/apis/jobs-api', () => ({
  cancelJobRemote: vi.fn(),
  enqueueActorStageJob: vi.fn(),
  EnqueueJobError: class extends Error {},
}));
vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: { getState: () => ({ meta: h.snapshotMeta }) },
}));
vi.mock('sonner', () => ({ toast: h.toast }));

import { useActorsStore } from '../index';

function rawRow(over: Partial<RawActorRow> = {}): RawActorRow {
  return {
    id: 'actor-1',
    snapshot_id: 'snap-1',
    owner_id: 'user-1',
    actant_id: 'act-hero',
    actor_id: 'miu_cat',
    actor_type: 1,
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    ...over,
  };
}

const input = {
  axisId: 'axis-1',
  presetId: null,
  actantId: 'act-hero',
  actorId: 'miu_cat',
  actorType: 1 as const,
};

const store = () => useActorsStore.getState();

beforeEach(() => {
  h.fromQueue = [];
  h.snapshotMeta = { id: 'snap-1', bookId: 'book-1' };
  useActorsStore.setState({ actorPairs: [], selectedPairId: null });
  vi.clearAllMocks();
});

describe('createActorPair', () => {
  it('inserts a row and selects it', async () => {
    h.fromQueue = [{ single: { data: rawRow(), error: null } }];
    const pair = await store().createActorPair(input);
    expect(pair.id).toBe('actor-1');
    expect(store().actorPairs.map((p) => p.id)).toEqual(['actor-1']);
    expect(store().selectedPairId).toBe('actor-1');
  });

  it('reuses the existing row on 23505 without throwing (collaborator race)', async () => {
    h.fromQueue = [
      { single: { data: null, error: { code: '23505' } } }, // insert conflicts
      { maybeSingle: { data: rawRow({ id: 'actor-existing' }), error: null } }, // reuse SELECT
    ];
    const pair = await store().createActorPair(input);
    expect(pair.id).toBe('actor-existing');
    expect(store().actorPairs.map((p) => p.id)).toEqual(['actor-existing']);
    expect(store().selectedPairId).toBe('actor-existing');
    expect(h.toast.info).toHaveBeenCalledTimes(1);
    expect(h.supabaseFrom).toHaveBeenCalledTimes(2);
  });

  it('throws NO_ACTIVE_SNAPSHOT when there is no open snapshot', async () => {
    h.snapshotMeta = { id: '', bookId: '' };
    await expect(store().createActorPair(input)).rejects.toThrow('NO_ACTIVE_SNAPSHOT');
    expect(h.supabaseFrom).not.toHaveBeenCalled();
  });
});
