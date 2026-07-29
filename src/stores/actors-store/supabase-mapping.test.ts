// supabase-mapping.test.ts — JSONB null/absent/malformed → [] coalesce + round-trip.

import { describe, expect, it } from 'vitest';
import { mapRowToActorPair, type RawActorRow } from './supabase-mapping';

function makeRawRow(overrides: Partial<RawActorRow> = {}): RawActorRow {
  return {
    id: 'actor-1',
    snapshot_id: 'snap-1',
    owner_id: 'user-1',
    actant_id: 'actant-1',
    actor_id: 'miu_cat',
    actor_type: 1,
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    ...overrides,
  };
}

const BATCH = {
  id: 'batch-1',
  order: 0,
  name: 'Batch 1',
  crop_sheets: [
    {
      title: 'sheet 1',
      sheet_geometry: { width: 100, height: 100 },
      image_url: '',
      swap_results: [],
      original_crops: [],
    },
  ],
};

describe('mapRowToActorPair', () => {
  it('coalesces null/absent/malformed JSONB columns to []', () => {
    const pair = mapRowToActorPair(
      makeRawRow({ mixes: null, rmbgs: undefined, upscales: 'garbage' }),
    );
    expect(pair.mixes).toEqual([]);
    expect(pair.rmbgs).toEqual([]);
    expect(pair.upscales).toEqual([]);
  });

  it('round-trips scalar fields + preserves populated pipeline arrays', () => {
    const pair = mapRowToActorPair(
      makeRawRow({ actor_type: 2, mixes: [BATCH] }),
    );
    expect(pair.id).toBe('actor-1');
    expect(pair.snapshot_id).toBe('snap-1');
    expect(pair.owner_id).toBe('user-1');
    expect(pair.actant_id).toBe('actant-1');
    expect(pair.actor_id).toBe('miu_cat');
    expect(pair.actor_type).toBe(2);
    expect(pair.mixes).toEqual([BATCH]);
    expect(pair.rmbgs).toEqual([]);
    expect(pair.upscales).toEqual([]);
    expect(pair.created_at).toBe('2026-07-29T00:00:00Z');
  });

  it('defaults owner_id to null when absent', () => {
    const pair = mapRowToActorPair(makeRawRow({ owner_id: null }));
    expect(pair.owner_id).toBeNull();
  });
});
