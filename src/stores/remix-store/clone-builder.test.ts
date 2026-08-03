// clone-builder.test.ts — Unit tests for buildRemixClonePayload pure transform.
// Reshape 2026-07-31 (linear remix + casting materialization + cast sets):
//   - illustration is walked to a linear path; `sections` emits [], every
//     `branch_setting` is stripped.
//   - `characters[]` = VISUAL cast roster (preset ⊗ snapshot keys, NO swap
//     gate — amend 2026-07-31); the swap surface is the purged
//     `remix_config.characters[]` (gate ∩ roster). Appearance-check is REMOVED —
//     a displaced default actor is dropped even if a plain layer's tags still
//     mention it.
//   - `props: []` always; `remix_config.props` is never emitted.
//   - `remix_config.voices` carry VERBATIM — never purged by cast (voice ⊥
//     visual swap ⊥ casting).
// Crops are still filled by `computeCropSheets` in the INSERT path (one empty
// batch skeleton here).

import { describe, it, expect } from 'vitest';
import { buildRemixClonePayload, makeBatchSkeleton } from './clone-builder';
import type { CloneBuilderInput } from './clone-builder';
import type { RemixConfig } from '@/types/remix';
import type { BookRemix, CastingAxis } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { IllustrationData } from '@/types/illustration-types';
import type { BaseSpread, SpreadImage } from '@/types/spread-types';

// ── Fixture builders ─────────────────────────────────────────────────────────

/** Character carrying a base variant (type=0). */
function makeChar(key: string): Character {
  return {
    order: 0,
    key,
    name: key,
    basic_info: {},
    personality: {},
    variants: [
      {
        name: 'base',
        key: `${key}_v0`,
        type: 0,
        appearance: {},
        visual_description: '',
        illustrations: [],
        image_references: [],
      },
    ],
    voice_setting: null,
  } as unknown as Character;
}

function makeIllustration(spreads: BaseSpread[] = [], sections: unknown[] = []): IllustrationData {
  return { spreads, sections } as unknown as IllustrationData;
}

/** Single axis: default preset casts a1→c1, alt preset casts a1→c2 (chars). */
function makeAxis(): CastingAxis {
  return {
    id: 'ax1',
    name: 'Hero',
    actants: [{ id: 'a1', name: 'Lead' }],
    presets: [
      { id: 'p_def', name: 'Default', is_default: true, actants: [{ actant_id: 'a1', actor_id: 'c1', actor_type: 1 }] },
      { id: 'p_alt', name: 'Alt', is_default: false, actants: [{ actant_id: 'a1', actor_id: 'c2', actor_type: 1 }] },
    ],
  };
}

function makeBookRemix(enabledKeys: string[]): BookRemix {
  return {
    story: { preset: { is_enabled: true }, branch: { is_enabled: true }, spread_pool: { is_enabled: false } },
    characters: enabledKeys.map((k) => ({ key: k, name: k, is_enabled: true, traits: [] })),
    memories: { is_enabled: false, photos: [] },
    voices: [],
    languages: [],
  };
}

function makeConfig(over: Partial<RemixConfig> = {}): RemixConfig {
  return {
    story: { presets: [], branches: [], pool_spreads: [] },
    characters: [],
    memories: { is_enabled: false, style: 'styled', photos: [] },
    voices: [],
    languages: [{ name: 'VI', code: 'vi_VN', is_enabled: true }],
    ...over,
  } as RemixConfig;
}

interface BuildOverrides {
  characters?: Character[];
  illustration?: IllustrationData;
  castingAxes?: CastingAxis[];
  bookRemix?: BookRemix;
  config?: RemixConfig;
  name?: string;
}

function build(over: BuildOverrides = {}) {
  const characters = over.characters ?? [];
  const input: CloneBuilderInput = {
    snapshotId: 'snap-1',
    illustration: over.illustration ?? makeIllustration(),
    characters,
    props: [],
    castingAxes: over.castingAxes ?? [],
    bookRemix: over.bookRemix ?? makeBookRemix(characters.map((c) => c.key)),
  };
  return buildRemixClonePayload(input, over.config ?? makeConfig(), over.name ?? 'Test Remix');
}

// ── makeBatchSkeleton ─────────────────────────────────────────────────────────

describe('makeBatchSkeleton', () => {
  it('builds an empty batch with a uuid id, the given order/name, empty crop_sheets', () => {
    const b = makeBatchSkeleton(0, 'Batch 1');
    expect(b.order).toBe(0);
    expect(b.name).toBe('Batch 1');
    expect(b.crop_sheets).toEqual([]);
    expect(typeof b.id).toBe('string');
    expect(b.id.length).toBeGreaterThan(0);
    expect((b as unknown as { keys?: unknown }).keys).toBeUndefined();
  });

  it('mints a distinct id per call', () => {
    expect(makeBatchSkeleton(0, 'a').id).not.toBe(makeBatchSkeleton(0, 'b').id);
  });
});

// ── row shape: one batch, props:[], remix_config.props absent ─────────────────

describe('buildRemixClonePayload — row shape', () => {
  it('produces exactly one empty batch skeleton', () => {
    const r = build({ characters: [makeChar('c1')] });
    expect(r.mixes).toHaveLength(1);
    expect(r.mixes[0].crop_sheets).toEqual([]);
  });

  it('always emits props: [] and never emits remix_config.props', () => {
    const cfg = makeConfig({ props: [{ key: 'p1', prop_id: null, visual: null, is_enabled: true }] });
    const r = build({ characters: [makeChar('c1')], config: cfg });
    expect(r.props).toEqual([]);
    expect('props' in r.remix_config).toBe(false);
  });

  it('passes through snapshot_id + cloned illustration; default name when omitted', () => {
    const r = build({ characters: [makeChar('c1')], name: '' });
    expect(r.snapshot_id).toBe('snap-1');
    expect(r.illustration.spreads).toEqual([]);
    expect(r.name).toBe('New Remix');
  });
});

// ── linear clone: sections=[], no branch_setting ──────────────────────────────

function spread(id: string, extra: Partial<BaseSpread> = {}): BaseSpread {
  return { id, pages: [{ number: 1 }], images: [], textboxes: [], ...extra } as unknown as BaseSpread;
}

describe('buildRemixClonePayload — linear clone', () => {
  it('emits sections:[] and strips branch_setting from every spread', () => {
    const s1 = spread('s1', {
      branch_setting: { branches: [{ section_id: 'sec1', is_default: true }] },
    });
    const s2 = spread('s2');
    const illustration = makeIllustration(
      [s1, s2],
      [{ id: 'sec1', title: 'x', start_spread_id: 's2', end_spread_id: 's2' }],
    );
    const r = build({ characters: [makeChar('c1')], illustration });

    expect(r.illustration.sections).toEqual([]);
    expect(r.illustration.spreads.map((s) => s.id)).toEqual(['s1', 's2']);
    for (const s of r.illustration.spreads) {
      expect((s as { branch_setting?: unknown }).branch_setting).toBeUndefined();
    }
  });
});

// ── spread pool filter (clone step c2) ───────────────────────────────────────

describe('buildRemixClonePayload — spread pool filter', () => {
  it('excludes an unchecked pool spread and strips the `pool` key from every spread', () => {
    const normal = spread('n1');
    const pool = spread('p1', { pool: { is_true: true, is_default: false } });
    const illustration = makeIllustration([normal, pool]);
    const cfg = makeConfig({
      story: { presets: [], branches: [], pool_spreads: [{ spread_id: 'p1', is_enabled: false }] },
    });
    const r = build({ characters: [makeChar('c1')], illustration, config: cfg });

    expect(r.illustration.spreads.map((s) => s.id)).toEqual(['n1']);
    for (const s of r.illustration.spreads) {
      expect((s as { pool?: unknown }).pool).toBeUndefined();
    }
  });

  it('keeps an enabled pool spread but strips `pool`, preserving title + thumbnail_url (P2)', () => {
    const pool = spread('p1', {
      pool: { is_true: true, is_default: false },
      thumbnail_url: 'https://cdn/p1.png',
      title: { en_US: { text: 'Alt Page' } },
    });
    const illustration = makeIllustration([spread('n1'), pool]);
    const cfg = makeConfig({
      story: { presets: [], branches: [], pool_spreads: [{ spread_id: 'p1', is_enabled: true }] },
    });
    const r = build({ characters: [makeChar('c1')], illustration, config: cfg });

    const kept = r.illustration.spreads.find((s) => s.id === 'p1');
    expect(kept).toBeDefined();
    expect((kept as { pool?: unknown }).pool).toBeUndefined();
    expect((kept as { thumbnail_url?: string }).thumbnail_url).toBe('https://cdn/p1.png');
    expect((kept as { title?: unknown }).title).toEqual({ en_US: { text: 'Alt Page' } });
  });

  it('carries pool_spreads verbatim into remix_config.story', () => {
    const choices = [{ spread_id: 'p1', is_enabled: false }];
    const cfg = makeConfig({ story: { presets: [], branches: [], pool_spreads: choices } });
    const r = build({ characters: [makeChar('c1')], illustration: makeIllustration([spread('n1')]), config: cfg });
    expect(r.remix_config.story.pool_spreads).toEqual(choices);
  });

  it('regression: a book with no pool spreads keeps every spread and emits no `pool` key', () => {
    const illustration = makeIllustration([spread('a'), spread('b'), spread('c')]);
    const r = build({ characters: [makeChar('c1')], illustration });
    expect(r.illustration.spreads.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    for (const s of r.illustration.spreads) {
      expect((s as { pool?: unknown }).pool).toBeUndefined();
    }
  });
});

// ── cast sets (NO layer-content scan) ────────────────────────────────────────

function makeAltStoryConfig(): RemixConfig {
  return makeConfig({ story: { presets: [{ axis_id: 'ax1', preset_id: 'p_alt' }], branches: [], pool_spreads: [] } });
}

describe('buildRemixClonePayload — cast sets', () => {
  it('characters[] = visual roster: displaced default actor (c1) dropped, chosen (c2) + untouched (c3) kept', () => {
    const r = build({
      characters: [makeChar('c1'), makeChar('c2'), makeChar('c3')],
      castingAxes: [makeAxis()],
      config: makeAltStoryConfig(),
    });
    expect(r.characters.map((c) => c.key)).toEqual(['c2', 'c3']);
  });

  it('drops the displaced default actor EVEN IF a plain layer still tags it (regression: no layer-content scan)', () => {
    const plainImageTaggingC1: SpreadImage = {
      id: 'img-plain',
      geometry: { x: 0, y: 0, w: 10, h: 10 },
      tags: [{ type: 'character', object_key: 'c1', variant_key: 'c1_v0' }],
    } as unknown as SpreadImage;
    const illustration = makeIllustration([spread('s1', { images: [plainImageTaggingC1] })]);
    const r = build({
      characters: [makeChar('c1'), makeChar('c2'), makeChar('c3')],
      castingAxes: [makeAxis()],
      config: makeAltStoryConfig(),
      illustration,
    });
    // c1 must still be gone despite the plain-layer tag mentioning it.
    expect(r.characters.map((c) => c.key)).toEqual(['c2', 'c3']);
    // The plain layer's tags are untouched (no casting_slot → no rewrite).
    expect(r.illustration.spreads[0].images[0].tags).toEqual([
      { type: 'character', object_key: 'c1', variant_key: 'c1_v0' },
    ]);
  });

  it('voices carry VERBATIM — a visually re-cast role keeps its voice slot (no cast purge)', () => {
    const cfg = makeConfig({
      story: { presets: [{ axis_id: 'ax1', preset_id: 'p_alt' }], branches: [], pool_spreads: [] },
      voices: [
        { key: 'narrator', name: 'Narrator', voice_id: null, is_enabled: true },
        { key: 'c1', name: 'C1', voice_id: null, is_enabled: true }, // displaced default — still speaks
        { key: 'c2', name: 'C2', voice_id: null, is_enabled: true },
        { key: 'c3', name: 'C3', voice_id: null, is_enabled: true },
      ],
    });
    const r = build({
      characters: [makeChar('c1'), makeChar('c2'), makeChar('c3')],
      castingAxes: [makeAxis()],
      config: cfg,
    });
    expect(r.remix_config.voices.map((v) => v.key).sort()).toEqual(['c1', 'c2', 'c3', 'narrator']);
  });

  it('cast-in actor NOT book-enabled: cloned into characters[] but purged from remix_config (F1)', () => {
    const cfg = makeConfig({
      story: { presets: [{ axis_id: 'ax1', preset_id: 'p_alt' }], branches: [], pool_spreads: [] },
      characters: [
        { key: 'c2', human_id: null, visual: null, traits: [], base_image_url: null, is_enabled: true },
        { key: 'c3', human_id: null, visual: null, traits: [], base_image_url: null, is_enabled: true },
      ],
    });
    const r = build({
      characters: [makeChar('c1'), makeChar('c2'), makeChar('c3')],
      castingAxes: [makeAxis()],
      config: cfg,
      // c2 (the chosen actor) is NOT enabled in the book gate.
      bookRemix: makeBookRemix(['c1', 'c3']),
    });
    // Roster is unGated — the materialized actor stays resolvable.
    expect(r.characters.map((c) => c.key)).toEqual(['c2', 'c3']);
    // Swap surface excludes it.
    expect(r.remix_config.characters.map((c) => c.key)).toEqual(['c3']);
  });

  it('purges remix_config.characters to the swappable set', () => {
    const cfg = makeConfig({
      story: { presets: [{ axis_id: 'ax1', preset_id: 'p_alt' }], branches: [], pool_spreads: [] },
      characters: [
        { key: 'c1', human_id: null, visual: null, traits: [], base_image_url: null, is_enabled: true },
        { key: 'c2', human_id: null, visual: null, traits: [], base_image_url: null, is_enabled: true },
        { key: 'c3', human_id: null, visual: null, traits: [], base_image_url: null, is_enabled: true },
      ],
    });
    const r = build({
      characters: [makeChar('c1'), makeChar('c2'), makeChar('c3')],
      castingAxes: [makeAxis()],
      config: cfg,
    });
    expect(r.remix_config.characters.map((c) => c.key)).toEqual(['c2', 'c3']);
  });

  it('dangling chosen actor → slot skipped (default kept), remix still builds', () => {
    const axis: CastingAxis = {
      id: 'ax1',
      name: 'Hero',
      actants: [{ id: 'a1', name: 'Lead' }],
      presets: [
        { id: 'p_def', name: 'Default', is_default: true, actants: [{ actant_id: 'a1', actor_id: 'c1', actor_type: 1 }] },
        { id: 'p_alt', name: 'Alt', is_default: false, actants: [{ actant_id: 'a1', actor_id: 'ghost', actor_type: 1 }] },
      ],
    };
    const r = build({
      characters: [makeChar('c1'), makeChar('c2'), makeChar('c3')],
      castingAxes: [axis],
      config: makeAltStoryConfig(),
    });
    // ghost is dangling → skipped entirely → default c1 NOT displaced.
    expect(r.characters.map((c) => c.key)).toEqual(['c1', 'c2', 'c3']);
  });

  it('book gate does NOT touch the roster: a book-disabled cast-in actor is still cloned (amend 2026-07-31)', () => {
    const r = build({
      characters: [makeChar('c1'), makeChar('c2'), makeChar('c3')],
      bookRemix: makeBookRemix(['c1', 'c3']), // c2 not enabled at book level
      castingAxes: [makeAxis()],
      config: makeAltStoryConfig(),
    });
    // c1 displaced by c2 → out of the VISUAL roster; c2 stays despite the gate
    // (its image is materialized into the content — the gate only shapes the
    // swap surface in remix_config.characters[]).
    expect(r.characters.map((c) => c.key)).toEqual(['c2', 'c3']);
  });
});
