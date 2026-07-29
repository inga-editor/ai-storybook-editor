// resolve-casting-preview-url.test.ts — layer preview URL + status vs selected pair:
// has cast entry / actant match but no entry / dangling (actant mismatch or no pair).

import { describe, expect, it } from 'vitest';
import type { SpreadImage } from '@/types/spread-types';
import type { ActorPair } from '@/types/actors';
import { resolveCastingPreviewUrl } from './resolve-casting-preview-url';

const DEFAULT_URL = 'https://cdn.example.invalid/layer-default.png';
const CAST_URL = 'https://cdn.example.invalid/cast-actor.png';

function makePair(over: Partial<ActorPair> = {}): ActorPair {
  return {
    id: 'pair-1',
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
    ...over,
  };
}

function makeLayer(slot?: SpreadImage['casting_slot']): SpreadImage {
  return {
    id: 'L1',
    geometry: { x: 0, y: 0, w: 100, h: 100 },
    media_url: DEFAULT_URL,
    casting_slot: slot,
  } as SpreadImage;
}

describe('resolveCastingPreviewUrl', () => {
  it('shows the cast media_url + cast status when the actor entry exists', () => {
    const layer = makeLayer({
      actant_id: 'act-hero',
      actors: [{ id: 'miu_cat', actor_type: 1, media_url: CAST_URL, is_default: true }],
    });
    const res = resolveCastingPreviewUrl(layer, makePair());
    expect(res).toEqual({ url: CAST_URL, status: 'cast', isHighlighted: true });
  });

  it('highlights but shows not_generated when the actant matches but no entry', () => {
    const layer = makeLayer({ actant_id: 'act-hero', actors: [] });
    const res = resolveCastingPreviewUrl(layer, makePair());
    expect(res).toEqual({ url: DEFAULT_URL, status: 'not_generated', isHighlighted: true });
  });

  it('does not highlight a layer whose actant differs from the pair (dangling)', () => {
    const layer = makeLayer({ actant_id: 'act-villain', actors: [] });
    const res = resolveCastingPreviewUrl(layer, makePair());
    expect(res).toEqual({ url: DEFAULT_URL, status: 'not_highlighted', isHighlighted: false });
  });

  it('does not highlight when no pair is selected', () => {
    const res = resolveCastingPreviewUrl(makeLayer(), null);
    expect(res).toEqual({ url: DEFAULT_URL, status: 'not_highlighted', isHighlighted: false });
  });
});
