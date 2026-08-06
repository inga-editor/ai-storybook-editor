// effective-cast.test.ts — cast-sets contract (no appearance-check / no tag
// scan). ⚠️ Amend 2026-07-31 + per-param 2026-08-06: resolver returns THREE
// sets — visualCastKeys (no gate), personalizeKeys (is_enabled ∧ ≥1 param on,
// NOT ∩ cast), swappableKeys (params.visual ON ∩ visualCast). Covers:
// default preset, preset change replacing the default actor (UNCONDITIONAL
// drop), a newly-cast actor, an axis with no preset, a dangling preset entry
// (→ default), a dangling ACTOR key (→ skip + still cast the rest),
// snapshot-order preservation, gate orthogonality, personalize ≠ swappable
// (visual OFF), re-cast keeps text personalize, and the casting name map.

import { describe, it, expect } from 'vitest';
import {
  resolveRemixCastSets,
  personalizeCastKeys,
  buildCastingNameMap,
} from './effective-cast';
import type { CastingAxis } from '@/types/editor';
import type { BookRemix, RemixCharacterEntry } from '@/types/editor';
import type { RemixPresetChoice } from '@/types/remix';

/** Book character with per-param gates (all ON by default, override per param). */
function bc(
  key: string,
  opts: {
    enabled?: boolean;
    name?: boolean;
    gender?: boolean;
    age?: boolean;
    zodiac?: boolean;
    visual?: boolean;
  } = {},
): RemixCharacterEntry {
  return {
    key,
    name: key.toUpperCase(),
    is_enabled: opts.enabled ?? true,
    params: {
      name: { is_enabled: opts.name ?? true },
      gender: { is_enabled: opts.gender ?? true },
      age: { is_enabled: opts.age ?? true },
      zodiac: { is_enabled: opts.zodiac ?? true },
      visual: { is_enabled: opts.visual ?? true, traits: [] },
    },
  };
}

// All 3 chars enabled, every param ON; snapshot order c1, c2, c3.
const bookRemix = { characters: [bc('c1'), bc('c2'), bc('c3')] } as unknown as BookRemix;

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

describe('resolveRemixCastSets', () => {
  it('default preset → all snapshot chars in every set, snapshot order', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'def' }];
    const sets = resolveRemixCastSets({ ...base, storyPresets: presets });
    expect(sets.visualCastKeys).toEqual(['c1', 'c2', 'c3']);
    expect(sets.personalizeKeys).toEqual(['c1', 'c2', 'c3']);
    expect(sets.swappableKeys).toEqual(['c1', 'c2', 'c3']);
  });

  it('alt preset replaces the default actor UNCONDITIONALLY (c1 dropped, c3 stays)', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'alt' }];
    // c1 was the default actor for a1, now replaced by c3 → c1 removed; c3 already present.
    const sets = resolveRemixCastSets({ ...base, storyPresets: presets });
    expect(sets.visualCastKeys).toEqual(['c2', 'c3']);
    expect(sets.swappableKeys).toEqual(['c2', 'c3']);
    // personalize is INDEPENDENT of cast — c1 still book-enabled with params on.
    expect(sets.personalizeKeys).toEqual(['c1', 'c2', 'c3']);
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
    const sets = resolveRemixCastSets({
      castingAxes: [axis2], bookRemix, snapshotCharacterKeys, storyPresets: presets,
    });
    expect(sets.visualCastKeys).toEqual(['c1', 'c2', 'c3']);
  });

  it('axis with zero presets contributes nothing (no crash)', () => {
    const empty: CastingAxis = { id: 'e', name: 'E', actants: [], presets: [] };
    const sets = resolveRemixCastSets({
      castingAxes: [empty], bookRemix, snapshotCharacterKeys, storyPresets: [],
    });
    expect(sets.visualCastKeys).toEqual(['c1', 'c2', 'c3']);
  });

  it('dangling preset entry (unknown preset_id) falls back to default', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'ghost' }];
    // Falls back to default (casts c1) → same as default preset.
    expect(resolveRemixCastSets({ ...base, storyPresets: presets }).visualCastKeys)
      .toEqual(['c1', 'c2', 'c3']);
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
    // No crash; 'ghost' never enters the cast; snapshot chars remain.
    expect(
      resolveRemixCastSets({
        castingAxes: [axisDangling], bookRemix, snapshotCharacterKeys, storyPresets: presets,
      }).visualCastKeys,
    ).toEqual(['c1', 'c2', 'c3']);
  });

  it('gate is ORTHOGONAL: disabled char leaves personalize+swappable but stays in the visual roster', () => {
    const gatedBook = {
      characters: [bc('c1'), bc('c2', { enabled: false }), bc('c3')],
    } as unknown as BookRemix;
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'def' }];
    const sets = resolveRemixCastSets({
      castingAxes: [axis], bookRemix: gatedBook, snapshotCharacterKeys, storyPresets: presets,
    });
    expect(sets.visualCastKeys).toEqual(['c1', 'c2', 'c3']); // NO gate on the roster
    expect(sets.personalizeKeys).toEqual(['c1', 'c3']); // c2 master OFF → no row
    expect(sets.swappableKeys).toEqual(['c1', 'c3']);
  });

  it('cast-in actor NOT book-enabled: in the roster, not swappable (F1 fix)', () => {
    const gatedBook = {
      // c3 (the alt actor) has master OFF → neither personalize nor swappable.
      characters: [bc('c1'), bc('c2'), bc('c3', { enabled: false })],
    } as unknown as BookRemix;
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'alt' }];
    const sets = resolveRemixCastSets({
      castingAxes: [axis], bookRemix: gatedBook, snapshotCharacterKeys, storyPresets: presets,
    });
    expect(sets.visualCastKeys).toEqual(['c2', 'c3']); // c3 materialized into content
    expect(sets.swappableKeys).toEqual(['c2']); // …but locked for swap
  });

  it('personalize ≠ swappable: visual OFF but a text param ON → row, not swap surface', () => {
    // c2 has ONLY name on (visual OFF) → personalize but NOT swappable.
    const mixedBook = {
      characters: [
        bc('c1'),
        bc('c2', { name: true, gender: false, age: false, zodiac: false, visual: false }),
        bc('c3'),
      ],
    } as unknown as BookRemix;
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'def' }];
    const sets = resolveRemixCastSets({
      castingAxes: [axis], bookRemix: mixedBook, snapshotCharacterKeys, storyPresets: presets,
    });
    expect(sets.personalizeKeys).toEqual(['c1', 'c2', 'c3']); // c2 has a param → row
    expect(sets.swappableKeys).toEqual(['c1', 'c3']); // c2 visual OFF → no visual swap
    expect(sets.visualCastKeys).toEqual(['c1', 'c2', 'c3']); // still in the roster
  });

  it('all params OFF → excluded from personalize entirely', () => {
    const offBook = {
      characters: [
        bc('c1'),
        bc('c2', { name: false, gender: false, age: false, zodiac: false, visual: false }),
        bc('c3'),
      ],
    } as unknown as BookRemix;
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'def' }];
    const sets = resolveRemixCastSets({
      castingAxes: [axis], bookRemix: offBook, snapshotCharacterKeys, storyPresets: presets,
    });
    expect(sets.personalizeKeys).toEqual(['c1', 'c3']); // c2 no param on → no row
    expect(sets.swappableKeys).toEqual(['c1', 'c3']);
  });

  it('re-cast OUT of visual keeps text personalize (rationale: still in the text)', () => {
    // alt preset drops c1 from the roster, but c1 is book-enabled with name on →
    // personalize keeps it so its name still swaps in the story text.
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'alt' }];
    const sets = resolveRemixCastSets({ ...base, storyPresets: presets });
    expect(sets.visualCastKeys).not.toContain('c1'); // re-cast out of visuals
    expect(sets.personalizeKeys).toContain('c1'); // …but still text-personalizable
    expect(sets.swappableKeys).not.toContain('c1'); // …and not visually swapped
  });
});

describe('personalizeCastKeys', () => {
  it('mirrors resolveRemixCastSets().personalizeKeys', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'alt' }];
    expect(personalizeCastKeys({ ...base, storyPresets: presets })).toEqual(
      resolveRemixCastSets({ ...base, storyPresets: presets }).personalizeKeys,
    );
  });
});

describe('buildCastingNameMap', () => {
  const snapshotCharacters = [
    { key: 'c1', name: 'Miu' },
    { key: 'c2', name: 'Didi' },
    { key: 'c3', name: 'Leo' },
  ];

  it('maps the chosen actor to the displaced default actor NAME', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'alt' }];
    expect(buildCastingNameMap(presets, [axis], snapshotCharacters)).toEqual({ c3: 'Miu' });
  });

  it('actant keeping its default produces no entry', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'def' }];
    expect(buildCastingNameMap(presets, [axis], snapshotCharacters)).toEqual({});
  });

  it('displaced default missing from the snapshot is skipped (soft-fail)', () => {
    const presets: RemixPresetChoice[] = [{ axis_id: 'ax', preset_id: 'alt' }];
    expect(buildCastingNameMap(presets, [axis], [{ key: 'c3', name: 'Leo' }])).toEqual({});
  });
});
