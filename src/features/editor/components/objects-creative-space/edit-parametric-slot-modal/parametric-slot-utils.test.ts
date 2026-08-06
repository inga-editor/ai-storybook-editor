// parametric-slot-utils.test.ts — Unit tests for the pure EditParametricSlotModal helpers:
// domain derivation (5 key families), row merge + dangling ordering, default resolution
// tolerance, control-key/label formatting, immutable slot mutations and payload building.
// vitest only — NO node builtins (test files type-check with vite/client types).

import { describe, it, expect } from 'vitest';
import type { Book } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { ItemParametricSlot } from '@/types/spread-types';
import { GENDER_OPTIONS } from '@/constants/character-constants';
import {
  axisFromKey,
  buildParametricPayload,
  countIllustrations,
  domainValues,
  formatControlKey,
  isPhotoAxisKey,
  isRuntimeOnlyValue,
  labelFor,
  mapValue,
  mergeRows,
  resolveDefaultValue,
  splitCharacterAxis,
  withClearedIllustrations,
  withDefaultValue,
  withPrependedIllustration,
  withSelectedIllustration,
  withValueEntry,
  withoutIllustration,
} from './parametric-slot-utils';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeBook(): Book {
  return {
    parametric_slot: {
      characters: [
        { key: 'miu', name: 'Miu', gender: 'female', age_min: 3, age_max: 6, zodiac: null },
        { key: 'bo', name: 'Bo', gender: null, age_min: null, age_max: null, zodiac: null },
        // Config panel seeds the literal 'unspecified' for a character with no snapshot gender.
        { key: 'sun', name: 'Sun', gender: 'unspecified', age_min: null, age_max: null, zodiac: null },
        // Free-text gender straight from an imported / AI-authored character.
        { key: 'lan', name: 'Lan', gender: 'Nữ', age_min: null, age_max: null, zodiac: null },
      ],
      photos: [
        { key: 'photo_1', is_enabled: true, original: true, real: true, styled: false },
        { key: 'photo_2', is_enabled: false, original: true, real: true, styled: true },
      ],
      country: {
        is_enabled: true,
        values: [
          { code: 'VN', is_enabled: true },
          { code: 'US', is_enabled: true },
          { code: 'JP', is_enabled: false },
        ],
      },
      religion: {
        is_enabled: true,
        values: [
          { name: 'Buddhism', is_enabled: true },
          { name: 'Islam', is_enabled: false },
        ],
      },
    },
  } as unknown as Book;
}

const CHARACTERS = [
  { key: 'miu', name: 'Miu Cat', basic_info: { gender: 'female' } },
  { key: 'sun', name: 'Sun', basic_info: { gender: '' } },
  // Snapshot gender is free text and need not match the canonical vocab.
  { key: 'lan', name: 'Lan', basic_info: { gender: 'Nữ' } },
] as unknown as Character[];

function illustration(url: string, isSelected = false) {
  return { media_url: url, created_time: '2026-07-28T00:00:00Z', is_selected: isSelected };
}

function makeSlot(key: string, values: ItemParametricSlot['values']): ItemParametricSlot {
  return { key, values };
}

// ── Key parsing ───────────────────────────────────────────────────────────────

describe('splitCharacterAxis / isPhotoAxisKey', () => {
  it('splits on the LAST dot and only for gender/age', () => {
    expect(splitCharacterAxis('miu.gender')).toEqual({ charKey: 'miu', axis: 'gender' });
    expect(splitCharacterAxis('a.b.age')).toEqual({ charKey: 'a.b', axis: 'age' });
    expect(splitCharacterAxis('miu.height')).toBeNull();
    expect(splitCharacterAxis('country')).toBeNull();
    expect(splitCharacterAxis('.gender')).toBeNull();
  });

  it('treats anything not shared/character as a photo key', () => {
    expect(isPhotoAxisKey('photo_2')).toBe(true);
    expect(isPhotoAxisKey('country')).toBe(false);
    expect(isPhotoAxisKey('religion')).toBe(false);
    expect(isPhotoAxisKey('miu.age')).toBe(false);
  });

  it('flags only photo real/styled as runtime-only', () => {
    expect(isRuntimeOnlyValue('photo_1', 'real')).toBe(true);
    expect(isRuntimeOnlyValue('photo_1', 'styled')).toBe(true);
    expect(isRuntimeOnlyValue('photo_1', 'original')).toBe(false);
    expect(isRuntimeOnlyValue('country', 'real')).toBe(false);
  });
});

// ── Domain (§2.3) ─────────────────────────────────────────────────────────────

describe('domainValues', () => {
  const book = makeBook();

  it('country → enabled codes only, labelled with the country name when known', () => {
    expect(domainValues('country', book, CHARACTERS)).toEqual([
      { value: 'VN', label: 'Vietnam' },
      { value: 'US', label: 'United States' },
    ]);
  });

  it('religion → enabled names only, value === label', () => {
    expect(domainValues('religion', book, CHARACTERS)).toEqual([
      { value: 'Buddhism', label: 'Buddhism' },
    ]);
  });

  it('<char>.gender → the character-form vocabulary (4 values, SSOT)', () => {
    const out = domainValues('miu.gender', book, CHARACTERS);
    expect(out.map((o) => o.value)).toEqual(['male', 'female', 'non-binary', 'other']);
    expect(out).toHaveLength(GENDER_OPTIONS.length);
  });

  // Day-one dangling guard (README §2.3 ⚡): whatever ItemSlotModal can SEED as the item's
  // default must be inside the domain, or the item's own default value opens as dangling.
  it('<char>.gender → appends the book-config seed when it is outside the vocab', () => {
    const out = domainValues('sun.gender', book, CHARACTERS);
    expect(out.map((o) => o.value)).toEqual([
      'male', 'female', 'non-binary', 'other', 'unspecified',
    ]);
  });

  it('<char>.gender → appends a free-text snapshot gender, deduped against the vocab', () => {
    const out = domainValues('lan.gender', book, CHARACTERS);
    // 'Nữ' appears ONCE even though it is both the book seed and the snapshot value.
    expect(out.map((o) => o.value)).toEqual(['male', 'female', 'non-binary', 'other', 'Nữ']);
    // A snapshot gender already in the vocab adds nothing.
    expect(domainValues('miu.gender', book, CHARACTERS)).toHaveLength(GENDER_OPTIONS.length);
  });

  it('<char>.age → inclusive integer range from the config bounds', () => {
    expect(domainValues('miu.age', book, CHARACTERS).map((o) => o.value)).toEqual([
      '3', '4', '5', '6',
    ]);
  });

  it('photo key → only the enabled modes, in original/real/styled order', () => {
    expect(domainValues('photo_1', book, CHARACTERS).map((o) => o.value)).toEqual([
      'original',
      'real',
    ]);
  });

  it('returns [] for disabled axes, disabled photo keys and unknown keys', () => {
    expect(domainValues('bo.gender', book, CHARACTERS)).toEqual([]);
    expect(domainValues('bo.age', book, CHARACTERS)).toEqual([]);
    expect(domainValues('photo_2', book, CHARACTERS)).toEqual([]);
    expect(domainValues('nope', book, CHARACTERS)).toEqual([]);
    expect(domainValues('ghost.age', book, CHARACTERS)).toEqual([]);
  });

  it('returns [] when the book has no parametric_slot at all', () => {
    expect(domainValues('country', null, CHARACTERS)).toEqual([]);
    expect(domainValues('country', {} as Book, CHARACTERS)).toEqual([]);
  });
});

// ── Rows + default (§2.3 / §4.3) ──────────────────────────────────────────────

describe('resolveDefaultValue', () => {
  it('returns the single flagged entry', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: false, illustrations: [] },
      { value: 'US', is_default: true, illustrations: [] },
    ]);
    expect(resolveDefaultValue(slot)).toBe('US');
  });

  it('falls back to the FIRST entry when nothing is flagged', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: false, illustrations: [] },
      { value: 'US', is_default: false, illustrations: [] },
    ]);
    expect(resolveDefaultValue(slot)).toBe('VN');
  });

  it('takes the first flagged one when several claim default', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: true, illustrations: [] },
      { value: 'US', is_default: true, illustrations: [] },
    ]);
    expect(resolveDefaultValue(slot)).toBe('VN');
  });

  it('returns null when there are no entries', () => {
    expect(resolveDefaultValue(makeSlot('country', []))).toBeNull();
  });
});

describe('mergeRows', () => {
  const domain = [
    { value: 'VN', label: 'Vietnam' },
    { value: 'US', label: 'United States' },
  ];

  it('keeps domain order, counts versions and marks the default', () => {
    const values = [
      { value: 'US', is_default: true, illustrations: [illustration('a'), illustration('b')] },
    ];
    expect(mergeRows(domain, values, 'US')).toEqual([
      { value: 'VN', label: 'Vietnam', isDangling: false, count: 0, isDefault: false },
      { value: 'US', label: 'United States', isDangling: false, count: 2, isDefault: true },
    ]);
  });

  it('appends values missing from the domain LAST, flagged dangling', () => {
    const values = [
      { value: 'KR', is_default: false, illustrations: [illustration('a')] },
      { value: 'VN', is_default: true, illustrations: [] },
    ];
    const rows = mergeRows(domain, values, 'VN');
    expect(rows.map((r) => r.value)).toEqual(['VN', 'US', 'KR']);
    expect(rows[2]).toEqual({
      value: 'KR',
      label: 'KR',
      isDangling: true,
      count: 1,
      isDefault: false,
    });
  });

  it('renders every stored value as dangling when the domain is empty', () => {
    const values = [{ value: 'VN', is_default: true, illustrations: [] }];
    const rows = mergeRows([], values, 'VN');
    expect(rows).toHaveLength(1);
    expect(rows[0].isDangling).toBe(true);
    expect(rows[0].isDefault).toBe(true);
  });
});

// ── Labels (§4.2 + 01 §4.3) ───────────────────────────────────────────────────

describe('formatControlKey', () => {
  it('formats shared axes', () => {
    expect(formatControlKey('country', CHARACTERS)).toEqual({
      label: 'Shared · country',
      isDangling: false,
    });
    expect(formatControlKey('religion', CHARACTERS).label).toBe('Shared · religion');
  });

  it('uses the character name, flagging a character missing from the snapshot', () => {
    expect(formatControlKey('miu.age', CHARACTERS)).toEqual({
      label: 'Miu Cat · age',
      isDangling: false,
    });
    expect(formatControlKey('ghost.gender', CHARACTERS)).toEqual({
      label: 'ghost · gender',
      isDangling: true,
    });
  });

  it('formats photo keys', () => {
    expect(formatControlKey('photo_2', CHARACTERS).label).toBe('Photo · photo_2');
  });
});

describe('labelFor', () => {
  it('adds the unit for age and the country name for country', () => {
    expect(labelFor('miu.age', '5')).toBe('5 tuổi');
    expect(labelFor('country', 'VN')).toBe('Vietnam');
  });
  it('returns undefined when the raw value already reads fine', () => {
    expect(labelFor('miu.gender', 'female')).toBeUndefined();
    expect(labelFor('religion', 'Buddhism')).toBeUndefined();
    expect(labelFor('photo_1', 'original')).toBeUndefined();
  });
});

describe('axisFromKey', () => {
  it('maps shared + character axes', () => {
    expect(axisFromKey('country', CHARACTERS)).toEqual({ axisKind: 'country' });
    expect(axisFromKey('religion', CHARACTERS)).toEqual({ axisKind: 'religion' });
    expect(axisFromKey('miu.gender', CHARACTERS)).toEqual({
      axisKind: 'character',
      axisName: 'gender',
      characterName: 'Miu Cat',
    });
  });
  it('omits characterName for a dangling character', () => {
    expect(axisFromKey('ghost.age', CHARACTERS)).toEqual({
      axisKind: 'character',
      axisName: 'age',
    });
  });
  it('returns null for a photo axis (not generatable)', () => {
    expect(axisFromKey('photo_1', CHARACTERS)).toBeNull();
  });
});

// ── Immutable mutations (§2.5) ────────────────────────────────────────────────

describe('slot mutations', () => {
  it('withValueEntry creates lazily and makes the FIRST entry default', () => {
    const empty = makeSlot('country', []);
    const first = withValueEntry(empty, 'VN');
    expect(first.values).toEqual([{ value: 'VN', is_default: true, illustrations: [] }]);
    const second = withValueEntry(first, 'US');
    expect(second.values[1]).toEqual({ value: 'US', is_default: false, illustrations: [] });
    // existing value → same reference (caller can skip the write)
    expect(withValueEntry(second, 'VN')).toBe(second);
    // originals untouched
    expect(empty.values).toHaveLength(0);
  });

  it('withPrependedIllustration puts the new version first and deselects the rest', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: true, illustrations: [illustration('old', true)] },
    ]);
    const next = withPrependedIllustration(slot, 'VN', illustration('new'));
    expect(next.values[0].illustrations.map((i) => i.media_url)).toEqual(['new', 'old']);
    expect(next.values[0].illustrations.map((i) => i.is_selected)).toEqual([true, false]);
  });

  it('withPrependedIllustration creates the entry when missing', () => {
    const next = withPrependedIllustration(makeSlot('country', []), 'VN', illustration('a'));
    expect(next.values[0]).toMatchObject({ value: 'VN', is_default: true });
    expect(next.values[0].illustrations).toHaveLength(1);
  });

  it('withSelectedIllustration moves is_selected by index', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: true, illustrations: [illustration('a', true), illustration('b')] },
    ]);
    const next = withSelectedIllustration(slot, 'VN', 1);
    expect(next.values[0].illustrations.map((i) => i.is_selected)).toEqual([false, true]);
  });

  it('withoutIllustration promotes the new first version when the selected one is deleted', () => {
    const slot = makeSlot('country', [
      {
        value: 'VN',
        is_default: true,
        illustrations: [illustration('a', true), illustration('b'), illustration('c')],
      },
    ]);
    const next = withoutIllustration(slot, 'VN', 0);
    expect(next.values[0].illustrations.map((i) => i.media_url)).toEqual(['b', 'c']);
    expect(next.values[0].illustrations[0].is_selected).toBe(true);
  });

  it('withoutIllustration on the last version leaves an empty (but present) entry', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: true, illustrations: [illustration('a', true)] },
    ]);
    const next = withoutIllustration(slot, 'VN', 0);
    expect(next.values).toHaveLength(1);
    expect(next.values[0].illustrations).toEqual([]);
  });

  it('withDefaultValue moves the flag and creates the entry when needed', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: true, illustrations: [] },
      { value: 'US', is_default: false, illustrations: [] },
    ]);
    expect(withDefaultValue(slot, 'US').values.map((v) => v.is_default)).toEqual([false, true]);
    const created = withDefaultValue(slot, 'JP');
    expect(created.values).toHaveLength(3);
    expect(created.values.filter((v) => v.is_default).map((v) => v.value)).toEqual(['JP']);
  });

  it('withClearedIllustrations keeps the entry (is_default + position preserved)', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: true, illustrations: [illustration('a', true)] },
      { value: 'US', is_default: false, illustrations: [illustration('b')] },
    ]);
    const next = withClearedIllustrations(slot, 'VN');
    expect(next.values[0]).toEqual({ value: 'VN', is_default: true, illustrations: [] });
    expect(next.values[1].illustrations).toHaveLength(1);
  });

  it('mapValue is a no-op (same reference) for an unknown value', () => {
    const slot = makeSlot('country', [{ value: 'VN', is_default: true, illustrations: [] }]);
    expect(mapValue(slot, 'ZZ', (e) => e)).toBe(slot);
  });

  it('countIllustrations sums across values', () => {
    const slot = makeSlot('country', [
      { value: 'VN', is_default: true, illustrations: [illustration('a'), illustration('b')] },
      { value: 'US', is_default: false, illustrations: [illustration('c')] },
    ]);
    expect(countIllustrations(slot)).toBe(3);
  });
});

// ── Payload (01 §4.3) ─────────────────────────────────────────────────────────

describe('buildParametricPayload', () => {
  const base = {
    characters: CHARACTERS,
    sourceImageUrl: 'https://cdn.test/src.png',
    sourceValue: '3',
    targetValue: '6',
  };

  it('maps a character age axis with labels and the fixed image size', () => {
    const payload = buildParametricPayload({
      ...base,
      slot: makeSlot('miu.age', []),
      attribution: { snapshotId: 'snap-1' },
      saveResourcePath: 'table:snapshots/id:snap-1/col:illustration/...',
    });
    expect(payload).toEqual({
      axisKind: 'character',
      axisName: 'age',
      characterName: 'Miu Cat',
      sourceImageUrl: 'https://cdn.test/src.png',
      sourceValue: '3',
      targetValue: '6',
      sourceValueLabel: '3 tuổi',
      targetValueLabel: '6 tuổi',
      imageSize: '2K',
      snapshotId: 'snap-1',
      saveResource: {
        type: 'image_version',
        action: 'create',
        path: 'table:snapshots/id:snap-1/col:illustration/...',
      },
    });
  });

  it('never sends aspectRatio and omits empty optionals', () => {
    const payload = buildParametricPayload({
      ...base,
      slot: makeSlot('religion', []),
      sourceValue: 'Buddhism',
      targetValue: 'Islam',
      prompt: '   ',
      referenceImages: [],
    });
    expect(payload).not.toBeNull();
    expect(Object.keys(payload as object)).not.toContain('aspectRatio');
    expect(payload).not.toHaveProperty('prompt');
    expect(payload).not.toHaveProperty('referenceImages');
    expect(payload).not.toHaveProperty('sourceValueLabel');
    expect(payload).not.toHaveProperty('saveResource');
  });

  // Both attribution ids may travel; the BE discriminates (remix_id wins) — parity upscale.
  it('keeps a trimmed prompt + reference images and forwards attribution', () => {
    const payload = buildParametricPayload({
      ...base,
      slot: makeSlot('country', []),
      sourceValue: 'VN',
      targetValue: 'US',
      prompt: '  keep the hat  ',
      referenceImages: [{ base64Data: 'AAA', mimeType: 'image/png' }],
      attribution: { snapshotId: 'snap-1', remixId: 'remix-1' },
    });
    expect(payload?.prompt).toBe('keep the hat');
    expect(payload?.referenceImages).toHaveLength(1);
    expect(payload?.remixId).toBe('remix-1');
    expect(payload?.sourceValueLabel).toBe('Vietnam');
    expect(payload?.targetValueLabel).toBe('United States');
  });

  it('returns null for a photo axis (generation unsupported)', () => {
    expect(
      buildParametricPayload({ ...base, slot: makeSlot('photo_1', []) }),
    ).toBeNull();
  });
});
