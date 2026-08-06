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
  normalizeParams,
  normalizeRemixStory,
  normalizeRemixTraits,
  normalizeBookTypography,
  CONFIG_SECTIONS,
  REMIX_STORY_FEATURES,
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
      story: {
        preset: { is_enabled: false },
        branch: { is_enabled: false },
        spread_pool: { is_enabled: false },
      },
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
      spread_pool: { is_enabled: false },
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

  it('migrates a legacy character (top-level traits[]) into params.visual.traits', () => {
    const result = normalizeBookRemix({
      characters: [{ key: 'elara', name: 'Elara', is_enabled: true, traits: [] }],
    });
    const entry = result!.characters[0] as unknown as Record<string, unknown>;
    // Legacy top-level traits[] is NOT re-emitted (no double-write).
    expect(entry).not.toHaveProperty('traits');
    const traits = result!.characters[0].params.visual.traits;
    expect(traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(traits.every((t) => t.is_enabled === true)).toBe(true);
    // Legacy fully (no params) → all 4 text params ON (preserve name-swap, USER S1).
    expect(result!.characters[0].params.name.is_enabled).toBe(true);
    expect(result!.characters[0].params.visual.is_enabled).toBe(true);
  });
});

describe('normalizeParams (CAST per-param reader tolerance, phase 03)', () => {
  it('legacy entry (no params) → 4 text params ON + visual ON with traits from top-level traits[]', () => {
    const p = normalizeParams({ traits: [{ type: 'outfit', is_enabled: false }] });
    expect(p.name.is_enabled).toBe(true);
    expect(p.gender.is_enabled).toBe(true);
    expect(p.age.is_enabled).toBe(true);
    expect(p.zodiac.is_enabled).toBe(true);
    expect(p.visual.is_enabled).toBe(true);
    // Traits materialized to 5 canonical; the gated-off outfit is preserved.
    expect(p.visual.traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(p.visual.traits.find((t) => t.type === 'outfit')!.is_enabled).toBe(false);
    expect(p.visual.traits.find((t) => t.type === 'face')!.is_enabled).toBe(true);
  });

  it('legacy entry with no traits at all → 5 traits default ON', () => {
    const p = normalizeParams({});
    expect(p.visual.traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(p.visual.traits.every((t) => t.is_enabled)).toBe(true);
  });

  it('shape-new but a text key missing → that param OFF', () => {
    const p = normalizeParams({
      params: {
        name: { is_enabled: true },
        // gender / age / zodiac missing → OFF
        visual: { is_enabled: false, traits: [] },
      },
    });
    expect(p.name.is_enabled).toBe(true);
    expect(p.gender.is_enabled).toBe(false);
    expect(p.age.is_enabled).toBe(false);
    expect(p.zodiac.is_enabled).toBe(false);
    // Visual node present → its is_enabled honored (false); traits refilled to 5 ON.
    expect(p.visual.is_enabled).toBe(false);
    expect(p.visual.traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(p.visual.traits.every((t) => t.is_enabled)).toBe(true);
  });

  it('shape-new with empty visual.traits → refilled to 5 canonical entries ON', () => {
    const p = normalizeParams({
      params: {
        name: { is_enabled: false },
        gender: { is_enabled: false },
        age: { is_enabled: false },
        zodiac: { is_enabled: false },
        visual: { is_enabled: true, traits: [] },
      },
    });
    expect(p.visual.traits.map((t) => t.type)).toEqual(TRAIT_TYPES);
    expect(p.visual.traits.every((t) => t.is_enabled)).toBe(true);
  });

  it('shape-new missing visual node → falls back to legacy top-level traits[], visual ON', () => {
    const p = normalizeParams({
      params: { name: { is_enabled: true } },
      traits: [{ type: 'hair', is_enabled: false }],
    });
    expect(p.visual.is_enabled).toBe(true);
    expect(p.visual.traits.find((t) => t.type === 'hair')!.is_enabled).toBe(false);
  });
});

describe('normalizeRemixStory (Spread Pool reader tolerance 2026-08-03)', () => {
  it('fills spread_pool OFF when legacy story (shape 2026-07-31) lacks the key', () => {
    const out = normalizeRemixStory({
      preset: { is_enabled: true },
      branch: { is_enabled: false },
    });
    expect(out).toEqual({
      preset: { is_enabled: true },
      branch: { is_enabled: false },
      spread_pool: { is_enabled: false },
    });
  });

  it('preserves an explicit spread_pool gate', () => {
    const out = normalizeRemixStory({
      preset: { is_enabled: false },
      branch: { is_enabled: false },
      spread_pool: { is_enabled: true },
    });
    expect(out.spread_pool.is_enabled).toBe(true);
  });

  it('fills all three gates OFF for undefined story', () => {
    expect(normalizeRemixStory(undefined)).toEqual({
      preset: { is_enabled: false },
      branch: { is_enabled: false },
      spread_pool: { is_enabled: false },
    });
  });
});

describe('CONFIG_SECTIONS — Spread Pool sidebar entry (2026-08-03)', () => {
  const keys = CONFIG_SECTIONS.map((s) => s.key);

  it('contains the spread-pool section with PascalCase Layers icon', () => {
    const entry = CONFIG_SECTIONS.find((s) => s.key === 'spread-pool');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('Spread Pool');
    expect(entry!.icon).toBe('Layers'); // PascalCase — lowercase 'layers' → blank icon
  });

  it('orders remix < branch < spread-pool < parametric-slot', () => {
    const remix = keys.indexOf('remix');
    const branch = keys.indexOf('branch');
    const pool = keys.indexOf('spread-pool');
    const parametric = keys.indexOf('parametric-slot');
    expect(remix).toBeGreaterThanOrEqual(0);
    expect(remix).toBeLessThan(branch);
    expect(branch).toBeLessThan(pool);
    expect(pool).toBeLessThan(parametric);
  });

  it('exposes spread_pool as the 3rd STORY remix feature row', () => {
    expect(REMIX_STORY_FEATURES.map((f) => f.key)).toEqual([
      'preset',
      'branch',
      'spread_pool',
    ]);
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
