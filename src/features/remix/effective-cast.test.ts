// effective-cast.test.ts — 1-export contract (no appearance-check / no tag scan).
// Covers: default preset, preset change replacing the default actor
// (UNCONDITIONAL drop), a newly-cast actor, an axis with no preset, a dangling
// preset entry (→ default), a dangling ACTOR key (→ skip + still cast the rest),
// and snapshot-order preservation.

import { describe, it, expect } from 'vitest';
import { effectiveCastKeys } from './effective-cast';
import type { CastingAxis } from '@/types/editor';
import type { BookRemix } from '@/types/editor';
import type { RemixPresetChoice } from '@/types/remix';

// All 3 chars enabled in the book gate; snapshot order c1, c2, c3.
const bookRemix = {
  characters: [
    { key: 'c1', name: 'C1', is_enabled: true, traits: [] },
    { key: 'c2', name: 'C2', is_enabled: true, traits: [] },
    { key: 'c3', name: 'C3', is_enabled: true, traits: [] },
  ],
} as unknown as BookRemix;

const snapshotCharacterKeys = ['c1', 'c2', 'c3'];

// One axis: default preset casts actant→c1; alt preset casts actant→c3.
const axis: CastingAxis = {
  id: 'ax',
  name: 'Lead',
  actants: [{ id: 'a1', name: 'Hero' }],
  presets: [
    { id: 'def', name: 'Default', is_default: true, actants: [{ actant_id: 'a1', actor_id: 'c1', actor_type: 1 }] },
    { id: 'alt', name: 'Alt', is_default: false, actants: [{ actant_id: 'a1', actor_id: 'c3', actor_type: 1 }] },
  ],
};

const base = { castingAxes: [axis], bookRemix, snapshotCharacterKeys };

describe('effectiveCastKeys', () => {
  it('default preset → all enabled snapshot chars, snapshot order', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'def' }];
    expect(effectiveCastKeys({ ...base, storyPresets: presets })).toEqual(['c1', 'c2', 'c3']);
  });

  it('alt preset replaces the default actor UNCONDITIONALLY (c1 dropped, c3 stays)', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'alt' }];
    // c1 was the default actor for a1, now replaced by c3 → c1 removed; c3 already present.
    expect(effectiveCastKeys({ ...base, storyPresets: presets })).toEqual(['c2', 'c3']);
  });

  it('newly-cast actor (not a default anywhere) is added', () => {
    // Axis whose default casts nobody in a1 but alt casts c2 → c2 chosen, no default replaced.
    const axis2: CastingAxis = {
      id: 'ax2',
      name: 'Side',
      actants: [{ id: 'b1', name: 'Side' }],
      presets: [
        { id: 'd2', name: 'D', is_default: true, actants: [] },
        { id: 'a2', name: 'A', is_default: false, actants: [{ actant_id: 'b1', actor_id: 'c2', actor_type: 1 }] },
      ],
    };
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax2', preset_id: 'a2' }];
    expect(
      effectiveCastKeys({ castingAxes: [axis2], bookRemix, snapshotCharacterKeys, storyPresets: presets }),
    ).toEqual(['c1', 'c2', 'c3']);
  });

  it('axis with zero presets contributes nothing (no crash)', () => {
    const empty: CastingAxis = { id: 'e', name: 'E', actants: [], presets: [] };
    expect(
      effectiveCastKeys({ castingAxes: [empty], bookRemix, snapshotCharacterKeys, storyPresets: [] }),
    ).toEqual(['c1', 'c2', 'c3']);
  });

  it('dangling preset entry (unknown preset_id) falls back to default', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'ghost' }];
    // Falls back to default (casts c1) → same as default preset.
    expect(effectiveCastKeys({ ...base, storyPresets: presets })).toEqual(['c1', 'c2', 'c3']);
  });

  it('dangling ACTOR key is skipped; remaining actors still cast', () => {
    const axisDangling: CastingAxis = {
      id: 'axd',
      name: 'Dangle',
      actants: [
        { id: 'd1', name: 'One' },
        { id: 'd2', name: 'Two' },
      ],
      presets: [
        {
          id: 'pd',
          name: 'P',
          is_default: true,
          actants: [
            { actant_id: 'd1', actor_id: 'ghost', actor_type: 1 }, // not in snapshot → skip
            { actant_id: 'd2', actor_id: 'c2', actor_type: 1 }, // valid
          ],
        },
      ],
    };
    const presets: RemixPresetChoice[] = [{ axis_id: 'axd', preset_id: 'pd' }];
    // No crash; 'ghost' never enters the cast; enabled snapshot chars remain.
    expect(
      effectiveCastKeys({ castingAxes: [axisDangling], bookRemix, snapshotCharacterKeys, storyPresets: presets }),
    ).toEqual(['c1', 'c2', 'c3']);
  });

  it('only book-enabled characters survive (gate filter)', () => {
    const gatedBook = {
      characters: [
        { key: 'c1', name: 'C1', is_enabled: true, traits: [] },
        { key: 'c2', name: 'C2', is_enabled: false, traits: [] },
        { key: 'c3', name: 'C3', is_enabled: true, traits: [] },
      ],
    } as unknown as BookRemix;
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'def' }];
    expect(
      effectiveCastKeys({ castingAxes: [axis], bookRemix: gatedBook, snapshotCharacterKeys, storyPresets: presets }),
    ).toEqual(['c1', 'c3']);
  });
});
