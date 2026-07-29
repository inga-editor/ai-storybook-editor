// actor-coverage.test.ts — pure coverage compute: total (layers casting the
// actant) + injected (layers already holding this actor with a non-empty
// media_url); total=0 case; empty media_url NOT counted as injected.

import { describe, expect, it } from 'vitest';
import type { BaseSpread } from '@/types/spread-types';
import type { ActorPair } from '@/types/actors';
import { computeActorCoverage } from './actor-coverage';

function pair(id: string, actantId: string, actorId = 'miu_cat'): ActorPair {
  return {
    id,
    snapshot_id: 'snap-1',
    owner_id: null,
    actant_id: actantId,
    actor_id: actorId,
    actor_type: 1,
    mixes: [],
    rmbgs: [],
    upscales: [],
    created_at: '',
    updated_at: '',
  };
}

function layer(actantId: string, injectedUrl?: string) {
  return {
    id: `img-${Math.random()}`,
    geometry: { x: 0, y: 0, w: 10, h: 10 },
    casting_slot: {
      actant_id: actantId,
      actors:
        injectedUrl !== undefined
          ? [{ id: 'miu_cat', actor_type: 1, media_url: injectedUrl, is_default: true }]
          : [],
    },
  };
}

function spread(images: unknown[]): BaseSpread {
  return { id: `sp-${Math.random()}`, pages: [], images, textboxes: [] } as unknown as BaseSpread;
}

describe('computeActorCoverage', () => {
  it('counts total layers per actant and injected ones with media_url', () => {
    const spreads = [
      spread([
        layer('act-hero', 'https://cdn.example.invalid/a.png'), // injected
        layer('act-hero'), // cast target, not injected
        layer('act-villain', 'https://cdn.example.invalid/v.png'), // other actant
      ]),
    ];
    const cov = computeActorCoverage(spreads, [pair('p-hero', 'act-hero')]);
    expect(cov['p-hero']).toEqual({ injected: 1, total: 2 });
  });

  it('reports total=0 for a pair whose actant no layer casts', () => {
    const spreads = [spread([layer('act-hero', 'https://cdn.example.invalid/a.png')])];
    const cov = computeActorCoverage(spreads, [pair('p-ghost', 'act-ghost')]);
    expect(cov['p-ghost']).toEqual({ injected: 0, total: 0 });
  });

  it('does not count an entry with empty media_url as injected', () => {
    const spreads = [spread([layer('act-hero', '')])]; // present entry, blank URL
    const cov = computeActorCoverage(spreads, [pair('p-hero', 'act-hero')]);
    expect(cov['p-hero']).toEqual({ injected: 0, total: 1 });
  });
});
