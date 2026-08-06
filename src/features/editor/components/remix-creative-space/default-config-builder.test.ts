// default-config-builder.test.ts — Reshape 2026-07-31 (4-tab): object-param
// signature; story materialize-always (even with book gate OFF); memories filter
// against parametric_slot; props no longer emitted; characters follow the
// effective cast of the default presets.

import { describe, it, expect } from 'vitest';
import { defaultConfigFromBookRemix, isBookRemixEmpty } from './default-config-builder';
import type { DefaultConfigInput } from './default-config-builder';
import { TRAIT_TYPES } from '@/constants/trait-constants';
import type { BookRemix, CastingAxis, ParametricPhotoEntry } from '@/types/editor';
import type { BranchSpreadOption, PoolSpreadOption } from '@/types/remix';

const book: BookRemix = {
  // Story gates OFF on purpose — story must still materialize (materialize-always).
  story: { preset: { is_enabled: false }, branch: { is_enabled: false }, spread_pool: { is_enabled: false } },
  memories: {
    is_enabled: true,
    photos: [
      { key: 'photo_1', is_enabled: true }, // present in parametric slot → kept
      { key: 'photo_2', is_enabled: true }, // NOT in parametric slot → dropped
      { key: 'photo_3', is_enabled: false }, // disabled → dropped
    ],
  },
  languages: [
    { name: 'English', code: 'en_US', is_enabled: true },
    { name: 'Vietnamese', code: 'vi_VN', is_enabled: false },
  ],
  voices: [
    { key: 'narrator', name: 'Narrator', is_enabled: true },
    { key: 'char_a', name: 'Alice', is_enabled: true },
    { key: 'char_b', name: 'Bob', is_enabled: false },
  ],
  // Reshape 2026-08-06 (phase 03): trait gates live under params.visual.traits.
  characters: [
    {
      key: 'char_a',
      name: 'Alice',
      is_enabled: true,
      params: {
        name: { is_enabled: true },
        gender: { is_enabled: true },
        age: { is_enabled: true },
        zodiac: { is_enabled: true },
        visual: {
          is_enabled: true,
          traits: [
            { type: 'face', is_enabled: true },
            { type: 'hair', is_enabled: false },
          ],
        },
      },
    },
    {
      key: 'char_b',
      name: 'Bob',
      is_enabled: false,
      params: {
        name: { is_enabled: true },
        gender: { is_enabled: true },
        age: { is_enabled: true },
        zodiac: { is_enabled: true },
        visual: { is_enabled: true, traits: [] },
      },
    },
  ],
};

const castingAxes: CastingAxis[] = [
  {
    id: 'axis1',
    name: 'Lead',
    actants: [{ id: 'act1', name: 'Hero' }],
    presets: [
      { id: 'p1', name: 'Default', is_default: true, actants: [{ actant_id: 'act1', actor_id: 'char_a', actor_type: 1 }] },
      { id: 'p2', name: 'Alt', is_default: false, actants: [{ actant_id: 'act1', actor_id: 'char_b', actor_type: 1 }] },
    ],
  },
];

const branchSpreads: BranchSpreadOption[] = [
  {
    spread_id: 'sp1',
    spread_number: '3',
    title: 'Which way?',
    branches: [
      { section_id: 'sec_left', title: 'Left', is_default: false },
      { section_id: 'sec_right', title: 'Right', is_default: true },
    ],
  },
];

const parametricPhotos: ParametricPhotoEntry[] = [
  { key: 'photo_1', is_enabled: true, original: true, real: false, styled: false },
];

const poolSpreads: PoolSpreadOption[] = [
  { spread_id: 'pool_a', spread_number: '2', title: 'Iceland', thumbnail_url: null, is_default: true },
  { spread_id: 'pool_b', spread_number: '5', title: 'Kenya', thumbnail_url: 'u', is_default: false },
];

const input: DefaultConfigInput = {
  bookRemix: book,
  castingAxes,
  branchSpreads,
  poolSpreads,
  parametricPhotos,
  snapshotCharacterKeys: ['char_a', 'char_b'],
};

describe('defaultConfigFromBookRemix — reshape 2026-07-31', () => {
  const config = defaultConfigFromBookRemix(input);

  it('materializes story ALWAYS (gates OFF): one preset/branch entry seeded to defaults', () => {
    expect(config.story.presets).toEqual([{ axis_id: 'axis1', preset_id: 'p1' }]);
    // default branch (is_default) wins over array-first.
    expect(config.story.branches).toEqual([{ spread_id: 'sp1', section_id: 'sec_right' }]);
  });

  it('seeds pool_spreads ALWAYS (gate OFF): one entry per option, is_enabled = pool.is_default', () => {
    expect(config.story.pool_spreads).toEqual([
      { spread_id: 'pool_a', is_enabled: true },
      { spread_id: 'pool_b', is_enabled: false },
    ]);
  });

  it('seeds characters from the personalize set (default presets), snapshot order + 5 traits', () => {
    expect(config.characters.map((c) => c.key)).toEqual(['char_a']);
    const a = config.characters[0];
    const aTraits = a.traits!; // char_a is visual-swappable → traits present
    expect(aTraits).toHaveLength(TRAIT_TYPES.length);
    expect(aTraits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(aTraits.find((t) => t.type === 'face')?.is_enabled).toBe(true);
    expect(aTraits.find((t) => t.type === 'hair')?.is_enabled).toBe(false);
    // Missing-in-book trait → defaults enabled (normalizeRemixTraits).
    expect(aTraits.find((t) => t.type === 'outfit')?.is_enabled).toBe(true);
    expect(a.base_image_url).toBeNull();
    expect(a.human_id).toBeNull();
    expect(a.visual).toBeNull();
  });

  it('⚡2026-08-06 seeds a TEXT-ONLY entry (visual OFF) WITHOUT traits / base_image_url', () => {
    // char_c: master ON, name ON, visual OFF, not cast → personalize but not swappable.
    const textOnlyBook: BookRemix = {
      ...book,
      characters: [
        ...book.characters,
        {
          key: 'char_c',
          name: 'Cara',
          is_enabled: true,
          params: {
            name: { is_enabled: true },
            gender: { is_enabled: false },
            age: { is_enabled: false },
            zodiac: { is_enabled: false },
            visual: { is_enabled: false, traits: [] },
          },
        },
      ],
    };
    const cfg = defaultConfigFromBookRemix({
      ...input,
      bookRemix: textOnlyBook,
      snapshotCharacterKeys: ['char_a', 'char_b', 'char_c'],
    });
    const c = cfg.characters.find((x) => x.key === 'char_c');
    expect(c).toBeDefined();
    expect(c).not.toHaveProperty('traits');
    expect(c).not.toHaveProperty('base_image_url');
    expect(c!.is_enabled).toBe(true);
  });

  it('filters memories photos to enabled ∩ parametric_slot; style default; url null', () => {
    expect(config.memories.is_enabled).toBe(true);
    expect(config.memories.style).toBe('styled');
    expect(config.memories.photos.map((p) => p.key)).toEqual(['photo_1']);
    expect(config.memories.photos[0].media_url).toBeNull();
    expect(config.memories.photos[0].is_enabled).toBe(true);
  });

  it('does NOT emit props; builds voices/languages from book gates', () => {
    expect(config.props).toBeUndefined();
    expect(config.voices.map((v) => v.key)).toEqual(['narrator', 'char_a']);
    expect(config.voices.every((v) => v.voice_id === null)).toBe(true);
    expect(config.languages.map((l) => l.code)).toEqual(['en_US']);
    // Legacy singular field must not exist on the reshaped config.
    expect(config as unknown as Record<string, unknown>).not.toHaveProperty('narrator');
  });

  it('drops story entries when an axis has no preset / a spread has no branch', () => {
    const cfg = defaultConfigFromBookRemix({
      ...input,
      castingAxes: [{ id: 'axis0', name: 'Empty', actants: [], presets: [] }],
      branchSpreads: [{ spread_id: 'sp0', spread_number: '1', title: 'x', branches: [] }],
    });
    expect(cfg.story.presets).toEqual([]);
    expect(cfg.story.branches).toEqual([]);
  });
});

describe('isBookRemixEmpty', () => {
  it('is false when any section (incl. story/memories) has an enabled entry', () => {
    expect(isBookRemixEmpty(book)).toBe(false); // memories enabled
    expect(
      isBookRemixEmpty({
        ...book,
        story: { preset: { is_enabled: true }, branch: { is_enabled: false }, spread_pool: { is_enabled: false } },
        memories: { is_enabled: false, photos: [] },
        voices: [{ key: 'narrator', name: 'Narrator', is_enabled: false }],
        characters: [],
        languages: [{ name: 'English', code: 'en_US', is_enabled: false }],
      }),
    ).toBe(false); // story.preset enabled
    expect(
      isBookRemixEmpty({
        ...book,
        story: { preset: { is_enabled: false }, branch: { is_enabled: false }, spread_pool: { is_enabled: true } },
        memories: { is_enabled: false, photos: [] },
        voices: [{ key: 'narrator', name: 'Narrator', is_enabled: false }],
        characters: [],
        languages: [{ name: 'English', code: 'en_US', is_enabled: false }],
      }),
    ).toBe(false); // story.spread_pool enabled
  });

  it('is true for null or all-disabled book remix', () => {
    expect(isBookRemixEmpty(null)).toBe(true);
    expect(
      isBookRemixEmpty({
        story: { preset: { is_enabled: false }, branch: { is_enabled: false }, spread_pool: { is_enabled: false } },
        memories: { is_enabled: false, photos: [] },
        languages: [{ name: 'English', code: 'en_US', is_enabled: false }],
        voices: [{ key: 'narrator', name: 'Narrator', is_enabled: false }],
        characters: [],
      }),
    ).toBe(true);
  });
});
