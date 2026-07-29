// seed-initial-actor-batch.test.ts — Crops-stage seed: no matching layer → null,
// default-entry media_url priority, and tags are CLONED (never aliased).

import { describe, expect, it } from 'vitest';
import type { BaseSpread } from '@/types/spread-types';
import type { ActorPair } from '@/types/actors';
import { seedInitialActorBatch } from './seed-initial-actor-batch';
import spreadsJson from '../__fixtures__/spreads-with-casting.json';

const spreads = spreadsJson as unknown as BaseSpread[];

function makePair(actantId: string): ActorPair {
  return {
    id: 'pair-1',
    snapshot_id: 'snap-1',
    owner_id: null,
    actant_id: actantId,
    actor_id: 'miu_cat',
    actor_type: 1,
    mixes: [],
    rmbgs: [],
    upscales: [],
    created_at: '',
    updated_at: '',
  };
}

describe('seedInitialActorBatch', () => {
  it('returns null when no playable layer casts the pair actant', () => {
    expect(seedInitialActorBatch(makePair('act-nobody'), spreads)).toBeNull();
  });

  it('seeds one crop-ref per matching layer using the is_default media_url', () => {
    const refs = seedInitialActorBatch(makePair('act-hero'), spreads);
    expect(refs).not.toBeNull();
    expect(refs).toHaveLength(1);
    expect(refs![0]).toMatchObject({
      spread_id: 's1',
      id: 'L1',
      media_url: 'https://cdn.example.invalid/cat-default.png',
      nativeDim: { w: 200, h: 300 },
    });
  });

  it('clones the layer tags into a fresh array', () => {
    const layerTags = spreads[0].images[0].tags;
    const refs = seedInitialActorBatch(makePair('act-hero'), spreads)!;
    expect(refs[0].tags).toEqual(layerTags);
    // Must be a distinct array — the batch owns its own snapshot.
    expect(refs[0].tags).not.toBe(layerTags);
  });
});
