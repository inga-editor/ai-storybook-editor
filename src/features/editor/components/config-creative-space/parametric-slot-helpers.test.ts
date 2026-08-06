// parametric-slot-helpers.test.ts — Unit tests for pure parametric-slot helpers:
// validators, seed builders, gender seed, clampAge, nextPhotoKey,
// normalizeParametricSlot (null/partial/idempotent/edge), and buildDisplayValues
// (preview-seed vs persisted).
// vitest only — NO node builtins (tsc -b type-checks with vite/client types).

import { describe, it, expect } from 'vitest';
import {
  AGE_HARD_LIMITS,
  DEFAULT_PARAMETRIC_SLOT,
  DEFAULT_PHOTO_FLAGS,
  SEED_COUNTRY_CODES,
  SEED_RELIGIONS,
  buildDisplayValues,
  clampAge,
  nextPhotoKey,
  normalizeGenderSeed,
  normalizeParametricSlot,
  seedCountryValues,
  seedReligionValues,
  validateCountryCode,
  validateReligionName,
} from './parametric-slot-helpers';
import type { BookParametricSlot } from '@/types/editor';

describe('validateCountryCode', () => {
  it('normalizes to uppercase 2-letter code', () => {
    expect(validateCountryCode('vn', [])).toBe('VN');
    expect(validateCountryCode('  us ', [])).toBe('US');
  });
  it('rejects non-2-letter / non-alpha', () => {
    expect(validateCountryCode('USA', [])).toBeNull();
    expect(validateCountryCode('V', [])).toBeNull();
    expect(validateCountryCode('V1', [])).toBeNull();
    expect(validateCountryCode('', [])).toBeNull();
  });
  it('rejects duplicate (case-insensitive)', () => {
    expect(validateCountryCode('vn', ['VN'])).toBeNull();
    expect(validateCountryCode('VN', ['vn'])).toBeNull();
  });
});

describe('validateReligionName', () => {
  it('trims and preserves casing', () => {
    expect(validateReligionName('  Buddhism ', [])).toBe('Buddhism');
  });
  it('rejects empty / whitespace', () => {
    expect(validateReligionName('', [])).toBeNull();
    expect(validateReligionName('   ', [])).toBeNull();
  });
  it('rejects duplicate (case-insensitive)', () => {
    expect(validateReligionName('islam', ['Islam'])).toBeNull();
    expect(validateReligionName('BUDDHISM', ['Buddhism'])).toBeNull();
  });
});

describe('seed builders', () => {
  it('seedCountryValues → all enabled, matches SEED_COUNTRY_CODES', () => {
    const seeded = seedCountryValues();
    expect(seeded).toHaveLength(SEED_COUNTRY_CODES.length);
    expect(seeded.every((v) => v.is_enabled)).toBe(true);
    expect(seeded.map((v) => v.code)).toEqual(SEED_COUNTRY_CODES);
  });
  it('seedReligionValues → all enabled, matches SEED_RELIGIONS', () => {
    const seeded = seedReligionValues();
    expect(seeded).toHaveLength(SEED_RELIGIONS.length);
    expect(seeded.every((v) => v.is_enabled)).toBe(true);
    expect(seeded.map((v) => v.name)).toEqual(SEED_RELIGIONS);
  });
});

describe('normalizeGenderSeed', () => {
  it('blank / null / undefined → null', () => {
    expect(normalizeGenderSeed('')).toBeNull();
    expect(normalizeGenderSeed('   ')).toBeNull();
    expect(normalizeGenderSeed(null)).toBeNull();
    expect(normalizeGenderSeed(undefined)).toBeNull();
  });
  it('non-empty → trimmed value', () => {
    expect(normalizeGenderSeed(' female ')).toBe('female');
  });
});

describe('clampAge', () => {
  const entry = { age_min: 5, age_max: 12 };
  it('age_min clamps to [0, age_max]', () => {
    expect(clampAge('age_min', -3, entry)).toBe(0);
    expect(clampAge('age_min', 20, entry)).toBe(12); // capped at age_max
    expect(clampAge('age_min', 8, entry)).toBe(8);
  });
  it('age_max clamps to [age_min, 100]', () => {
    expect(clampAge('age_max', 3, entry)).toBe(5); // floored at age_min
    expect(clampAge('age_max', 200, entry)).toBe(AGE_HARD_LIMITS.max);
    expect(clampAge('age_max', 30, entry)).toBe(30);
  });
  it('null pair falls back to hard limits', () => {
    expect(clampAge('age_min', 50, { age_min: null, age_max: null })).toBe(50);
    expect(clampAge('age_max', 50, { age_min: null, age_max: null })).toBe(50);
    expect(clampAge('age_max', 999, { age_min: null, age_max: null })).toBe(100);
  });
});

describe('nextPhotoKey', () => {
  const photo = (key: string) => ({ key, ...DEFAULT_PHOTO_FLAGS });
  it('empty list → photo_1', () => {
    expect(nextPhotoKey([])).toBe('photo_1');
  });
  it('appends after contiguous keys', () => {
    expect(nextPhotoKey([photo('photo_1'), photo('photo_2')])).toBe('photo_3');
  });
  it('reuses the smallest gap after a delete', () => {
    expect(nextPhotoKey([photo('photo_2'), photo('photo_3')])).toBe('photo_1');
    expect(nextPhotoKey([photo('photo_1'), photo('photo_3')])).toBe('photo_2');
  });
  it('ignores non-pattern keys', () => {
    expect(nextPhotoKey([photo('custom'), photo('photo_1')])).toBe('photo_2');
  });
});

describe('normalizeParametricSlot', () => {
  it('null / undefined → null (preserves empty-state)', () => {
    expect(normalizeParametricSlot(null)).toBeNull();
    expect(normalizeParametricSlot(undefined)).toBeNull();
  });
  it('non-object → null with no throw', () => {
    expect(normalizeParametricSlot(42)).toBeNull();
    expect(normalizeParametricSlot('x')).toBeNull();
  });
  it('empty object → full default-ish shape (empty arrays, master OFF)', () => {
    const n = normalizeParametricSlot({});
    expect(n).toEqual(DEFAULT_PARAMETRIC_SLOT);
  });
  it('fills missing axes / arrays', () => {
    const n = normalizeParametricSlot({ characters: undefined, country: { is_enabled: true } });
    expect(n?.characters).toEqual([]);
    expect(n?.photos).toEqual([]);
    expect(n?.country).toEqual({ is_enabled: true, values: [] });
    expect(n?.religion).toEqual({ is_enabled: false, values: [] });
  });
  it('photos: drops keyless, de-dupes keys, defaults absent flags to true', () => {
    const n = normalizeParametricSlot({
      photos: [
        { key: 'photo_1', is_enabled: false, original: true, real: false, styled: true },
        { original: false },
        { key: 'photo_1', real: false },
        { key: 'photo_2' },
      ],
    });
    expect(n?.photos).toEqual([
      { key: 'photo_1', is_enabled: false, original: true, real: false, styled: true },
      { key: 'photo_2', is_enabled: true, original: true, real: true, styled: true },
    ]);
  });
  it('drops entries without a key; de-dupes character keys (first wins)', () => {
    const n = normalizeParametricSlot({
      characters: [
        { key: 'a', name: 'A', gender: 'f', age_min: 0, age_max: 15 },
        { name: 'no-key' },
        { key: 'a', name: 'dup', gender: null, age_min: null, age_max: null },
      ],
    });
    expect(n?.characters).toHaveLength(1);
    expect(n?.characters[0].name).toBe('A');
  });
  it('lone age bound → both null (paired axis)', () => {
    const n = normalizeParametricSlot({ characters: [{ key: 'a', age_min: 3, age_max: null }] });
    expect(n?.characters[0].age_min).toBeNull();
    expect(n?.characters[0].age_max).toBeNull();
  });
  it('age_min > age_max from external data → clamps age_max up', () => {
    const n = normalizeParametricSlot({ characters: [{ key: 'a', age_min: 10, age_max: 4 }] });
    expect(n?.characters[0].age_min).toBe(10);
    expect(n?.characters[0].age_max).toBe(10);
  });
  it('zodiac absent → null (axis OFF)', () => {
    const n = normalizeParametricSlot({ characters: [{ key: 'a', name: null, gender: null, age_min: null, age_max: null }] });
    expect(n?.characters[0].zodiac).toBeNull();
  });
  it('zodiac in 1..12 → preserved', () => {
    const n = normalizeParametricSlot({ characters: [{ key: 'a', zodiac: 7 }] });
    expect(n?.characters[0].zodiac).toBe(7);
  });
  it('zodiac out of range / non-integer → null', () => {
    expect(normalizeParametricSlot({ characters: [{ key: 'a', zodiac: 0 }] })?.characters[0].zodiac).toBeNull();
    expect(normalizeParametricSlot({ characters: [{ key: 'a', zodiac: 13 }] })?.characters[0].zodiac).toBeNull();
    expect(normalizeParametricSlot({ characters: [{ key: 'a', zodiac: 3.5 }] })?.characters[0].zodiac).toBeNull();
  });
  it('uppercases + de-dupes country codes; keeps explicit is_enabled false', () => {
    const n = normalizeParametricSlot({
      country: { is_enabled: true, values: [{ code: 'vn', is_enabled: false }, { code: 'VN' }, { code: 'us' }] },
    });
    expect(n?.country.values).toEqual([
      { code: 'VN', is_enabled: false },
      { code: 'US', is_enabled: true },
    ]);
  });
  it('de-dupes religion names case-insensitively; default is_enabled true', () => {
    const n = normalizeParametricSlot({
      religion: { is_enabled: true, values: [{ name: 'Islam' }, { name: 'islam' }, { name: 'Buddhism', is_enabled: false }] },
    });
    expect(n?.religion.values).toEqual([
      { name: 'Islam', is_enabled: true },
      { name: 'Buddhism', is_enabled: false },
    ]);
  });
  it('is idempotent (round-trips a normalized value)', () => {
    const once = normalizeParametricSlot({
      characters: [{ key: 'a', name: 'A', gender: null, age_min: 2, age_max: 8 }],
      photos: [{ key: 'photo_1', is_enabled: false, original: true, real: false, styled: true }],
      country: { is_enabled: true, values: [{ code: 'vn', is_enabled: true }] },
      religion: { is_enabled: false, values: [] },
    });
    const twice = normalizeParametricSlot(once);
    expect(twice).toEqual(once);
  });
});

describe('buildDisplayValues', () => {
  const slotOff: BookParametricSlot = DEFAULT_PARAMETRIC_SLOT;

  it('master OFF + empty values → SEED preview (isPreviewSeed true)', () => {
    const c = buildDisplayValues('country', slotOff);
    expect(c.isPreviewSeed).toBe(true);
    expect(c.values.map((v) => v.label)).toEqual(SEED_COUNTRY_CODES);
    expect(c.values.every((v) => v.is_enabled)).toBe(true);

    const r = buildDisplayValues('religion', slotOff);
    expect(r.isPreviewSeed).toBe(true);
    expect(r.values.map((v) => v.label)).toEqual(SEED_RELIGIONS);
  });

  it('master ON → maps persisted values, isPreviewSeed false', () => {
    const slot: BookParametricSlot = {
      characters: [],
      photos: [],
      country: { is_enabled: true, values: [{ code: 'VN', is_enabled: true }, { code: 'US', is_enabled: false }] },
      religion: { is_enabled: false, values: [] },
    };
    const c = buildDisplayValues('country', slot);
    expect(c.isPreviewSeed).toBe(false);
    expect(c.values).toEqual([
      { label: 'VN', is_enabled: true },
      { label: 'US', is_enabled: false },
    ]);
  });

  it('master OFF but values present → persisted (NOT preview seed)', () => {
    const slot: BookParametricSlot = {
      characters: [],
      photos: [],
      country: { is_enabled: false, values: [{ code: 'VN', is_enabled: true }] },
      religion: { is_enabled: false, values: [] },
    };
    const c = buildDisplayValues('country', slot);
    expect(c.isPreviewSeed).toBe(false);
    expect(c.values).toEqual([{ label: 'VN', is_enabled: true }]);
  });

  it('master ON but empty values (external data) → empty list, NOT re-seeded', () => {
    const slot: BookParametricSlot = {
      characters: [],
      photos: [],
      country: { is_enabled: true, values: [] },
      religion: { is_enabled: false, values: [] },
    };
    const c = buildDisplayValues('country', slot);
    expect(c.isPreviewSeed).toBe(false);
    expect(c.values).toEqual([]);
  });
});
