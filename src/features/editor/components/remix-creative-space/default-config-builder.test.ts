// default-config-builder.test.ts — Reshape coverage (2026-05-20/21):
// narrator singular → voices[] collection; characters[] gain traits[] (5 entries,
// book-gated) + base_image_url:null. Only book-enabled entries seed the draft.

import { describe, it, expect } from 'vitest';
import { defaultConfigFromBookRemix, isBookRemixEmpty } from './default-config-builder';
import { TRAIT_TYPES } from '@/constants/trait-constants';
import type { BookRemix } from '@/types/editor';

const book: BookRemix = {
  story: { preset: { is_enabled: false }, branch: { is_enabled: true } },
  memories: { is_enabled: true, photos: [{ key: 'photo_1', is_enabled: true }] },
  languages: [
    { name: 'English', code: 'en_US', is_enabled: true },
    { name: 'Vietnamese', code: 'vi_VN', is_enabled: false },
  ],
  voices: [
    { key: 'narrator', name: 'Narrator', is_enabled: true },
    { key: 'char_a', name: 'Alice', is_enabled: true },
    { key: 'char_b', name: 'Bob', is_enabled: false },
  ],
  characters: [
    {
      key: 'char_a',
      name: 'Alice',
      is_enabled: true,
      // Partial gate: face on, hair off; missing traits → reader fills enabled.
      traits: [
        { type: 'face', is_enabled: true },
        { type: 'hair', is_enabled: false },
      ],
    },
    { key: 'char_b', name: 'Bob', is_enabled: false, traits: [] },
  ],
};

describe('defaultConfigFromBookRemix — reshape', () => {
  const config = defaultConfigFromBookRemix(book);

  it('builds voices[] from enabled book voices (no narrator singular)', () => {
    expect(config.voices.map((v) => v.key)).toEqual(['narrator', 'char_a']);
    expect(config.voices.every((v) => v.voice_id === null)).toBe(true);
    expect(config.voices.find((v) => v.key === 'narrator')?.name).toBe('Narrator');
    // Legacy singular field must not exist on the reshaped config.
    expect(config as unknown as Record<string, unknown>).not.toHaveProperty('narrator');
  });

  it('seeds only book-enabled characters with 5 trait toggles + null base_image_url', () => {
    expect(config.characters.map((c) => c.key)).toEqual(['char_a']);
    const a = config.characters[0];
    expect(a.traits).toHaveLength(TRAIT_TYPES.length);
    expect(a.traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(a.traits.find((t) => t.type === 'face')?.is_enabled).toBe(true);
    expect(a.traits.find((t) => t.type === 'hair')?.is_enabled).toBe(false);
    // Missing-in-book trait → defaults enabled (normalizeRemixTraits).
    expect(a.traits.find((t) => t.type === 'outfit')?.is_enabled).toBe(true);
    expect(a.base_image_url).toBeNull();
    expect(a.human_id).toBeNull();
    expect(a.visual).toBeNull();
  });

  it('seeds empty props (book.remix dropped props 2026-07-31) + filters languages by book gate', () => {
    expect(config.props).toEqual([]);
    expect(config.languages.map((l) => l.code)).toEqual(['en_US']);
  });
});

describe('isBookRemixEmpty', () => {
  it('is false when any section has an enabled entry', () => {
    expect(isBookRemixEmpty(book)).toBe(false);
  });
  it('is true for null or all-disabled book remix', () => {
    expect(isBookRemixEmpty(null)).toBe(true);
    expect(
      isBookRemixEmpty({
        story: { preset: { is_enabled: false }, branch: { is_enabled: false } },
        memories: { is_enabled: false, photos: [] },
        languages: [{ name: 'English', code: 'en_US', is_enabled: false }],
        voices: [{ key: 'narrator', name: 'Narrator', is_enabled: false }],
        characters: [],
      }),
    ).toBe(true);
  });
});
