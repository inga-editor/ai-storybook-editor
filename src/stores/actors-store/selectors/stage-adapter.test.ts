// stage-adapter.test.ts — the StageDataAdapter is useMemo-stabilized: an unchanged
// store yields the SAME adapter ref across rerenders (no useShallow re-render loop),
// while swapping the pair yields a fresh adapter.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ActorPair } from '@/types/actors';

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

import { useActorsStore } from '../index';
import { useActorStageAdapter } from './stage-adapter';

function pair(id: string): ActorPair {
  return {
    id,
    snapshot_id: 'snap-1',
    owner_id: null,
    actant_id: 'act-hero',
    actor_id: 'miu_cat',
    actor_type: 1,
    mixes: [],
    rmbgs: [],
    upscales: [],
    created_at: '',
    updated_at: '',
  };
}

beforeEach(() => {
  useActorsStore.setState({ actorPairs: [pair('pair-1'), pair('pair-2')], jobs: [] });
});

describe('useActorStageAdapter', () => {
  it('returns a ref-stable adapter across rerenders when state is unchanged', () => {
    const { result, rerender } = renderHook(() => useActorStageAdapter('pair-1', 'mixes'));
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(first.ownerId).toBe('pair-1');
  });

  it('rebuilds the adapter when the target pair changes', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useActorStageAdapter(id, 'mixes'),
      { initialProps: { id: 'pair-1' } },
    );
    const first = result.current;
    rerender({ id: 'pair-2' });
    expect(result.current).not.toBe(first);
    expect(result.current.ownerId).toBe('pair-2');
  });
});
