// config-constants.test.ts — Unit tests for book.remix normalization helpers.
// Covers the 2026-05-21 reshape (narrator singular → voices[]) + unified trait
// order + the 2026-07-31 4-tab reshape (story/memories added, props dropped).
// Key regression guards:
//   - normalizeBookRemix MUST drop legacy `narrator` and NOT seed voices[]
//     (Validation S1 decision; remix not in production). This test exists so a
//     future change cannot silently re-introduce narrator→voices seeding.
//   - normalizeBookRemix MUST drop legacy `props[]` (never re-emit) and fill
//     story/memories defaults (all OFF) for pre-reshape rows.
//   - normalizeRemixTraits MUST always emit the 5 canonical entries in order,
//     filling missing ones with is_enabled: true.

import { describe, it, expect } from 'vitest';
import {
  normalizeBookRemix,
  normalizeRemixTraits,
  normalizeBookTypography,
  DEFAULT_TYPOGRAPHY,
} from './config-constants';
import { TRAIT_TYPES } from './trait-constants';

describe('normalizeBookRemix', () => {
  it('returns null for null/undefined raw (preserves "not configured" state)', () => {
    expect(normalizeBookRemix(null)).toBeNull();
    expect(normalizeBookRemix(undefined)).toBeNull();
  });

  it('returns null for non-object raw', () => {
    expect(normalizeBookRemix('garbage')).toBeNull();
    expect(normalizeBookRemix(42)).toBeNull();
  });

  it('coerces missing fields to full default shape (story/memories all OFF)', () => {
    const result = normalizeBookRemix({});
    expect(result).toEqual({
      story: { preset: { is_enabled: false }, branch: { is_enabled: false } },
      characters: [],
      memories: { is_enabled: false, photos: [] },
      voices: [],
      languages: [],
    });
  });

  it('drops legacy props[] and never re-emits the key (reshape 2026-07-31)', () => {
    const result = normalizeBookRemix({
      props: [{ key: 'magic_sword', name: 'Magic Sword', is_enabled: true }],
    });
    expect(result).not.toBeNull();
    expect(result as unknown as Record<string, unknown>).not.toHaveProperty('props');
  });

  it('preserves story gates and memories overlay when present', () => {
    const result = normalizeBookRemix({
      story: { preset: { is_enabled: true }, branch: { is_enabled: false } },
      memories: { is_enabled: true, photos: [{ key: 'photo_1', is_enabled: true }] },
    });
    expect(result!.story.preset.is_enabled).toBe(true);
    expect(result!.story.branch.is_enabled).toBe(false);
    expect(result!.memories.is_enabled).toBe(true);
    expect(result!.memories.photos).toEqual([{ key: 'photo_1', is_enabled: true }]);
  });

  it('coerces partial/garbage story + memories nodes to safe defaults', () => {
    const result = normalizeBookRemix({
      story: { preset: {} }, // branch missing, preset.is_enabled missing
      memories: { photos: 'garbage' }, // is_enabled missing, photos not an array
    });
    expect(result!.story).toEqual({
      preset: { is_enabled: false },
      branch: { is_enabled: false },
    });
    expect(result!.memories).toEqual({ is_enabled: false, photos: [] });
  });

  it('coerces memories.photos entries (keyless dropped, is_enabled → strict boolean)', () => {
    const result = normalizeBookRemix({
      memories: {
        is_enabled: true,
        photos: [
          { key: 'photo_1', is_enabled: 'yes' }, // truthy non-boolean → false
          { foo: 1 }, // keyless garbage → dropped
          { key: 'photo_2', is_enabled: true },
        ],
      },
    });
    expect(result!.memories.photos).toEqual([
      { key: 'photo_1', is_enabled: false },
      { key: 'photo_2', is_enabled: true },
    ]);
  });

  it('drops legacy narrator singular and does NOT seed voices[]', () => {
    // Legacy book had narrator enabled — must NOT carry over into voices[].
    const result = normalizeBookRemix({ narrator: { is_enabled: true } });
    expect(result).not.toBeNull();
    expect(result!.voices).toEqual([]);
    // No 'narrator' key leaks into the normalized shape.
    expect(result as unknown as Record<string, unknown>).not.toHaveProperty('narrator');
  });

  it('preserves an explicit voices[] collection', () => {
    const voices = [
      { key: 'narrator', name: 'Narrator', is_enabled: true },
      { key: 'elara', name: 'Elara', is_enabled: false },
    ];
    const result = normalizeBookRemix({ voices });
    expect(result!.voices).toEqual(voices);
  });

  it('normalizes each character traits[] to the 5 canonical entries', () => {
    const result = normalizeBookRemix({
      characters: [{ key: 'elara', name: 'Elara', is_enabled: true, traits: [] }],
    });
    const traits = result!.characters[0].traits;
    expect(traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(traits.every((t) => t.is_enabled === true)).toBe(true);
  });
});

describe('normalizeRemixTraits', () => {
  it('fills all 5 canonical traits when undefined', () => {
    const traits = normalizeRemixTraits(undefined);
    expect(traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(traits.every((t) => t.is_enabled)).toBe(true);
  });

  it('preserves existing is_enabled and re-orders to canonical', () => {
    const traits = normalizeRemixTraits([
      { type: 'outfit', is_enabled: false },
      { type: 'face', is_enabled: false },
    ]);
    expect(traits.map((t) => t.type)).toEqual(TRAIT_TYPES); // canonical order
    expect(traits.find((t) => t.type === 'outfit')!.is_enabled).toBe(false);
    expect(traits.find((t) => t.type === 'face')!.is_enabled).toBe(false);
    // Missing entries default to true.
    expect(traits.find((t) => t.type === 'hair')!.is_enabled).toBe(true);
  });
});

describe('normalizeBookTypography', () => {
  it('returns null for null/undefined (preserves "not configured" state)', () => {
    expect(normalizeBookTypography(null)).toBeNull();
    expect(normalizeBookTypography(undefined)).toBeNull();
  });

  it('returns null for non-object raw', () => {
    expect(normalizeBookTypography('garbage')).toBeNull();
    expect(normalizeBookTypography(42)).toBeNull();
  });

  it('clones legacy-flat map into all 3 steps with INDEPENDENT deep copies', () => {
    const flat = { en_US: { ...DEFAULT_TYPOGRAPHY, size: 20 } };
    const result = normalizeBookTypography(flat)!;

    // All three steps carry the same values...
    expect(result.sketch.en_US.size).toBe(20);
    expect(result.illustration.en_US.size).toBe(20);
    expect(result.retouch.en_US.size).toBe(20);

    // ...but are NOT shared references (mutating one must not bleed to others).
    result.sketch.en_US.size = 99;
    expect(result.illustration.en_US.size).toBe(20);
    expect(result.retouch.en_US.size).toBe(20);
    // And detached from the source object.
    expect(result.illustration.en_US).not.toBe(flat.en_US);
  });

  it('passes through nested shape and fills any missing step key with {}', () => {
    const nested = {
      sketch: { en_US: { ...DEFAULT_TYPOGRAPHY, size: 10 } },
      illustration: { vi_VN: { ...DEFAULT_TYPOGRAPHY, size: 11 } },
      // retouch missing
    };
    const result = normalizeBookTypography(nested)!;
    expect(result.sketch.en_US.size).toBe(10);
    expect(result.illustration.vi_VN.size).toBe(11);
    expect(result.retouch).toEqual({});
  });

  it('is idempotent (normalizing a normalized value is stable)', () => {
    const flat = { en_US: { ...DEFAULT_TYPOGRAPHY, size: 20 } };
    const once = normalizeBookTypography(flat)!;
    const twice = normalizeBookTypography(once)!;
    expect(twice).toEqual(once);
  });

  it('treats an empty object as empty nested (no crash)', () => {
    expect(normalizeBookTypography({})).toEqual({ sketch: {}, illustration: {}, retouch: {} });
  });
});
