// derive-actor-options.test.ts — cascade actor options: All-presets union dedupe,
// single-preset ≤1 option, already_added / current_default disable, uncast empty.

import { describe, expect, it } from 'vitest';
import type { BookCastingSlot } from '@/types/editor';
import type { ActorPair } from '@/types/actors';
import { deriveActorOptions, type ActorEntityRef } from './derive-actor-options';
import castingSlotJson from './__fixtures__/casting-slot.json';
import actorPairsJson from './__fixtures__/actor-pairs.json';

const castingSlot = castingSlotJson as BookCastingSlot;
const allPairs = actorPairsJson as ActorPair[];

const characters: ActorEntityRef[] = [
  { key: 'miu_cat', name: 'Miu' },
  { key: 'rex_dog', name: 'Rex' },
  { key: 'shared_dog', name: 'Shared Dog' },
];

function derive(args: {
  presetId: string | null;
  actantId: string | null;
  actorPairs?: ActorPair[];
}) {
  return deriveActorOptions({
    castingSlot,
    axisId: 'axis-1',
    presetId: args.presetId,
    actantId: args.actantId,
    actorPairs: args.actorPairs ?? [],
    characters,
    props: [],
  });
}

describe('deriveActorOptions', () => {
  it('unions across presets and dedupes a shared mapping (All presets)', () => {
    const opts = derive({ presetId: null, actantId: 'act-sidekick' });
    // shared_dog is mapped in BOTH preset-cat and preset-dog → 1 deduped option.
    expect(opts).toHaveLength(1);
    expect(opts[0].actorId).toBe('shared_dog');
    expect(opts[0].sourcePresets.sort()).toEqual(['Cat', 'Dog']);
  });

  it('returns ≤1 option scoped to a single preset (no source chips)', () => {
    const opts = derive({ presetId: 'preset-cat', actantId: 'act-hero' });
    expect(opts).toHaveLength(1);
    expect(opts[0].actorId).toBe('miu_cat');
    expect(opts[0].sourcePresets).toEqual([]);
  });

  it('disables an option already backed by an actors row (already_added)', () => {
    const heroCat = allPairs.filter((p) => p.id === 'pair-hero-cat');
    const opts = derive({ presetId: null, actantId: 'act-hero', actorPairs: heroCat });
    const miu = opts.find((o) => o.actorId === 'miu_cat')!;
    const rex = opts.find((o) => o.actorId === 'rex_dog')!;
    expect(miu.disabledReason).toBe('already_added');
    expect(rex.disabledReason).toBeNull();
  });

  it('disables the default-preset actor with nothing to swap (current_default)', () => {
    // No actors row → already_added cannot mask it; miu_cat is the default preset bind.
    const opts = derive({ presetId: null, actantId: 'act-hero', actorPairs: [] });
    const miu = opts.find((o) => o.actorId === 'miu_cat')!;
    expect(miu.disabledReason).toBe('current_default');
  });

  it('returns [] when the scoped preset does not cast the actant', () => {
    // preset-cat casts hero + sidekick, never act-uncast.
    expect(derive({ presetId: 'preset-cat', actantId: 'act-uncast' })).toEqual([]);
  });

  it('returns [] without an axis or actant selection', () => {
    expect(derive({ presetId: null, actantId: null })).toEqual([]);
  });
});
