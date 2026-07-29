// actor-visual-precondition.test.ts — swap UX gate: missing entity → false,
// base-variant image → true, non-base variant image → true.

import { describe, expect, it } from 'vitest';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { ActorPair } from '@/types/actors';
import { actorHasVisual, type ActorVisualSnapshot } from './actor-visual-precondition';

function pair(over: Partial<ActorPair> = {}): ActorPair {
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

function character(key: string, variants: unknown[]): Character {
  return { key, name: key, variants } as unknown as Character;
}

function variant(illustrations: unknown[]) {
  return { key: 'v', name: 'v', illustrations };
}

describe('actorHasVisual', () => {
  it('returns false when the entity is missing (deleted)', () => {
    const snapshot: ActorVisualSnapshot = { characters: [], props: [] };
    expect(actorHasVisual(snapshot, pair())).toBe(false);
  });

  it('returns true when the base variant carries a selected illustration', () => {
    const snapshot: ActorVisualSnapshot = {
      characters: [
        character('miu_cat', [
          variant([{ media_url: 'https://cdn.example.invalid/base.png', is_selected: true }]),
        ]),
      ],
      props: [],
    };
    expect(actorHasVisual(snapshot, pair())).toBe(true);
  });

  it('returns true when a non-base variant has an image but the base does not', () => {
    const snapshot: ActorVisualSnapshot = {
      characters: [
        character('miu_cat', [
          variant([]),
          variant([{ media_url: 'https://cdn.example.invalid/alt.png', is_selected: false }]),
        ]),
      ],
      props: [],
    };
    expect(actorHasVisual(snapshot, pair())).toBe(true);
  });

  it('resolves a prop (actor_type 2) from the props pool', () => {
    const snapshot: ActorVisualSnapshot = {
      characters: [],
      props: [
        { key: 'sunny_prop', name: 'Sunny', variants: [variant([])] } as unknown as Prop,
      ],
    };
    // Prop exists but has no image → false; presence alone is not enough.
    expect(actorHasVisual(snapshot, pair({ actor_id: 'sunny_prop', actor_type: 2 }))).toBe(false);
  });
});
