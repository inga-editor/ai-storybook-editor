// inject-slice.test.ts — injectActorFinals: empty entries → no lock/API call;
// per-entry actant guard drops mismatched finals; a `blocked` outcome applies
// nothing locally. runLockedApplyCasting + snapshot store are faked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActorPair } from '@/types/actors';
import type { RemixStageBatchRow } from '@/types/remix';

const h = vi.hoisted(() => ({
  applyOutcome: 'saved' as 'saved' | 'blocked' | 'failed',
  captured: {} as { input?: { entries: Array<{ image_id: string }> } },
  applyCastingResult: vi.fn(),
  snapshotSpreads: [] as unknown[],
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  runLockedApplyCasting: vi.fn(),
}));

h.runLockedApplyCasting.mockImplementation(
  async (
    _target: unknown,
    input: { entries: Array<{ image_id: string }> },
    applyLocal: (r: { applied: number; skipped: [] }) => void,
  ) => {
    h.captured.input = input;
    if (h.applyOutcome === 'saved') applyLocal({ applied: input.entries.length, skipped: [] });
    return h.applyOutcome;
  },
);

vi.mock('@/apis/supabase', () => ({
  supabase: {
    from: vi.fn(),
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
vi.mock('@/features/editor/utils/locked-apply-casting', () => ({
  runLockedApplyCasting: (...a: unknown[]) => h.runLockedApplyCasting(...a),
}));
vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: {
    getState: () => ({
      meta: { id: 'snap-1', bookId: 'book-1' },
      illustration: { spreads: h.snapshotSpreads },
      applyCastingResult: h.applyCastingResult,
    }),
  },
}));
vi.mock('sonner', () => ({ toast: h.toast }));

import { useActorsStore } from '../index';

/** A pair whose upscales carry two winner finals: L1 (kept) + L2 (mismatch). */
function pairWithFinals(): ActorPair {
  const upscales: RemixStageBatchRow[] = [
    {
      id: 'batch-1',
      order: 0,
      name: 'Batch 1',
      crop_sheets: [
        {
          title: '',
          sheet_geometry: { width: 100, height: 100 },
          image_url: '',
          original_crops: [],
          swap_results: [
            {
              media_url: null,
              created_time: 'now',
              is_selected: true,
              crops: [
                { spread_id: 's1', id: 'L1', media_url: 'https://cdn.example.invalid/final-L1.png', is_final: true },
                { spread_id: 's1', id: 'L2', media_url: 'https://cdn.example.invalid/final-L2.png', is_final: true },
              ],
            },
          ],
        },
      ],
    },
  ];
  return {
    id: 'pair-1',
    snapshot_id: 'snap-1',
    owner_id: null,
    actant_id: 'act-hero',
    actor_id: 'miu_cat',
    actor_type: 1,
    mixes: [],
    rmbgs: [],
    upscales,
    created_at: '',
    updated_at: '',
  };
}

/** s1 with L1 bound to act-hero (kept) and L2 bound to act-other (dropped). */
const spreadsWithGuard = [
  {
    id: 's1',
    images: [
      { id: 'L1', casting_slot: { actant_id: 'act-hero', actors: [] } },
      { id: 'L2', casting_slot: { actant_id: 'act-other', actors: [] } },
    ],
  },
];

const store = () => useActorsStore.getState();

beforeEach(() => {
  h.applyOutcome = 'saved';
  h.captured = {};
  h.snapshotSpreads = spreadsWithGuard;
  useActorsStore.setState({ actorPairs: [], selectedPairId: null, injectState: {} });
  vi.clearAllMocks();
});

describe('injectActorFinals', () => {
  it('makes no lock/API call when the pair has no finals', async () => {
    const pair = pairWithFinals();
    pair.upscales = []; // no winner finals → no entries
    useActorsStore.setState({ actorPairs: [pair] });

    const res = await store().injectActorFinals('pair-1');
    expect(res).toEqual({ applied: 0, skipped: [] });
    expect(h.runLockedApplyCasting).not.toHaveBeenCalled();
    expect(store().injectState['pair-1']).toBe('idle');
  });

  it('drops an entry whose target layer is bound to a different actant', async () => {
    useActorsStore.setState({ actorPairs: [pairWithFinals()] });

    const res = await store().injectActorFinals('pair-1');
    // L2 (act-other) filtered out — only L1 reaches apply-casting.
    expect(h.runLockedApplyCasting).toHaveBeenCalledTimes(1);
    expect(h.captured.input?.entries.map((e) => e.image_id)).toEqual(['L1']);
    expect(res.applied).toBe(1);
  });

  it('applies nothing locally when the lock is blocked by a peer', async () => {
    h.applyOutcome = 'blocked';
    useActorsStore.setState({ actorPairs: [pairWithFinals()] });

    const res = await store().injectActorFinals('pair-1');
    expect(res.applied).toBe(0);
    expect(h.applyCastingResult).not.toHaveBeenCalled();
    expect(store().injectState['pair-1']).toBe('idle');
  });
});
