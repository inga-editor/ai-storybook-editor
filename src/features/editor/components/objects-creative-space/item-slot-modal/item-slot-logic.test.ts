// item-slot-logic.test.ts — Pure unit tests for item slot logic:
// parseAgeSeed, buildParametricOptions, deriveParametricDefaultValue,
// resolveDefaultActor, buildParametricSeed, buildCastingSeed, buildSlotPatch,
// resolveSlotBlockers, describeItemSlot. No React, no store, no imports from
// node:* (type-check build uses vite/client types only).

import { describe, it, expect } from 'vitest';
import {
  parseAgeSeed,
  buildParametricOptions,
  deriveParametricDefaultValue,
  buildParametricSeed,
  buildCastingSeed,
  buildSlotPatch,
  resolveSlotBlockers,
  describeItemSlot,
  resolveDefaultActor,
  PHOTO_ORIGINAL_VALUE,
  SLOT_BLOCKER_CODES,
  type SlotPatchInput,
  type SlotBlockerInput,
} from './item-slot-logic';
import type { Book, BookParametricSlot, BookCastingSlot, CastingAxis } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { SpreadImage } from '@/types/spread-types';

// ── Factories ──────────────────────────────────────────────────────────────

const makeCharacter = (
  key: string,
  overrides?: Partial<Character>,
): Character =>
  ({
    id: `char_${key}`,
    name: `Character ${key}`,
    key,
    order: 0,
    variants: [{ key: 'base' }],
    basic_info: { age: '5 tuổi', gender: 'female', description: '', category_id: '', role: '' },
    ...overrides,
  }) as unknown as Character;

const makeBook = (overrides?: Partial<Book>): Book =>
  ({
    id: 'book_1',
    title: 'Test Book',
    characters: [],
    parametric_slot: null,
    casting_slot: null,
    ...overrides,
  }) as unknown as Book;

const makeImage = (overrides?: Partial<SpreadImage>): SpreadImage =>
  ({
    id: 'img_1',
    geometry: { x: 0, y: 0, w: 100, h: 100 },
    media_url: 'https://example.test/image.png',
    ...overrides,
  }) as unknown as SpreadImage;

const makeParametricSlot = (overrides?: Partial<BookParametricSlot>): BookParametricSlot =>
  ({
    characters: [],
    photos: [],
    country: { is_enabled: false, values: [] },
    religion: { is_enabled: false, values: [] },
    ...overrides,
  }) as unknown as BookParametricSlot;

const makeCastingSlot = (overrides?: Partial<BookCastingSlot>): BookCastingSlot =>
  ({
    casting_axes: [],
    ...overrides,
  }) as unknown as BookCastingSlot;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('parseAgeSeed', () => {
  it('extracts first number and clamps to range', () => {
    expect(parseAgeSeed('3 tuổi', 0, 15)).toBe('3');
  });

  it('clamps upper when above max', () => {
    expect(parseAgeSeed('khoảng 20', 0, 15)).toBe('15');
  });

  it('falls back to min when non-numeric', () => {
    expect(parseAgeSeed('nhỏ', 0, 15)).toBe('0');
  });

  it('falls back to min when empty or undefined', () => {
    expect(parseAgeSeed('', 0, 15)).toBe('0');
    expect(parseAgeSeed(undefined, 0, 15)).toBe('0');
  });

  it('extracts first number from range like "5-7 tuổi"', () => {
    expect(parseAgeSeed('5-7 tuổi', 0, 15)).toBe('5');
  });

  it('clamps lower when below min', () => {
    expect(parseAgeSeed('1', 3, 10)).toBe('3');
  });
});

describe('buildParametricOptions', () => {
  it('character with gender + age_min/max → 2 options', () => {
    const slot = makeParametricSlot({
      characters: [{ key: 'char_a', name: null, gender: 'male', age_min: 5, age_max: 12 }],
    });
    const chars = [makeCharacter('char_a', { name: 'Alice' })];
    const groups = buildParametricOptions(slot, chars);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('character');
    expect(groups[0].header).toBe('Alice');
    expect(groups[0].options).toEqual([
      { key: 'char_a.gender', label: 'gender' },
      { key: 'char_a.age', label: 'age' },
    ]);
  });

  it('character with only age_min/max → only age option', () => {
    const slot = makeParametricSlot({
      characters: [{ key: 'char_b', name: null, gender: null, age_min: 5, age_max: 12 }],
    });
    const chars = [makeCharacter('char_b', { name: 'Bob' })];
    const groups = buildParametricOptions(slot, chars);

    expect(groups[0].options).toHaveLength(1);
    expect(groups[0].options[0].key).toBe('char_b.age');
  });

  it('character with only name (no gender/age) → no group', () => {
    const slot = makeParametricSlot({
      characters: [{ key: 'char_c', name: null, gender: null, age_min: null, age_max: null }],
    });
    const chars = [makeCharacter('char_c')];
    const groups = buildParametricOptions(slot, chars);

    expect(groups).toHaveLength(0);
  });

  it('photos with is_enabled: true only', () => {
    const slot = makeParametricSlot({
      photos: [
        { key: 'portrait', is_enabled: true, original: false, real: false, styled: false },
        { key: 'thumbnail', is_enabled: false, original: false, real: false, styled: false },
      ],
    });
    const groups = buildParametricOptions(slot, []);

    const photoGroup = groups.find((g) => g.kind === 'photo');
    expect(photoGroup?.options).toEqual([{ key: 'portrait', label: 'portrait' }]);
  });

  it('shared group filters enabled countries/religions', () => {
    const slot = makeParametricSlot({
      country: {
        is_enabled: true,
        values: [{ code: 'VN', is_enabled: true }],
      },
      religion: {
        is_enabled: false,
        values: [],
      },
    });
    const groups = buildParametricOptions(slot, []);

    const shared = groups.find((g) => g.kind === 'shared');
    expect(shared?.options).toEqual([{ key: 'country', label: 'country' }]);
  });

  it('dangling character → isDangling: true, header falls back to key', () => {
    const slot = makeParametricSlot({
      characters: [{ key: 'missing_char', name: null, gender: 'male', age_min: 5, age_max: 12 }],
    });
    const groups = buildParametricOptions(slot, []);

    expect(groups[0].isDangling).toBe(true);
    expect(groups[0].header).toBe('missing_char');
  });

  it('null slot → empty array', () => {
    expect(buildParametricOptions(null, [])).toEqual([]);
  });

  it('does NOT emit zodiac (regression guard)', () => {
    const slot = makeParametricSlot({
      characters: [{ key: 'char_a', name: null, gender: 'male', age_min: 5, age_max: 12 }],
    });
    const groups = buildParametricOptions(slot, []);
    const allKeys = groups.flatMap((g) => g.options.map((o) => o.key));

    expect(allKeys).not.toContain('zodiac');
  });
});

describe('deriveParametricDefaultValue', () => {
  it('country → first enabled value code', () => {
    const slot = makeParametricSlot({
      country: {
        is_enabled: true,
        values: [
          { code: 'VN', is_enabled: true },
          { code: 'US', is_enabled: false },
        ],
      },
    });
    expect(deriveParametricDefaultValue('country', slot, [])).toBe('VN');
  });

  it('country → null when no enabled value', () => {
    const slot = makeParametricSlot({
      country: {
        is_enabled: true,
        values: [{ code: 'VN', is_enabled: false }],
      },
    });
    expect(deriveParametricDefaultValue('country', slot, [])).toBeNull();
  });

  it('religion → first enabled value name', () => {
    const slot = makeParametricSlot({
      religion: {
        is_enabled: true,
        values: [
          { name: 'Buddhism', is_enabled: true },
          { name: 'Islam', is_enabled: false },
        ],
      },
    });
    expect(deriveParametricDefaultValue('religion', slot, [])).toBe('Buddhism');
  });

  it('character.gender → snapshot first, book config fallback', () => {
    const slot = makeParametricSlot({
      characters: [{ key: 'alice', name: null, gender: 'from_book', age_min: null, age_max: null }],
    });
    const chars = [makeCharacter('alice', { basic_info: { gender: 'from_snapshot', age: '', description: '', category_id: '', role: '' } })];
    expect(deriveParametricDefaultValue('alice.gender', slot, chars)).toBe('from_snapshot');

    // Fallback to book when snapshot empty
    const charsEmpty = [makeCharacter('alice', { basic_info: { gender: '', age: '', description: '', category_id: '', role: '' } })];
    expect(deriveParametricDefaultValue('alice.gender', slot, charsEmpty)).toBe('from_book');
  });

  it('character.age → parseAgeSeed via snapshot, respects age_min/max', () => {
    const slot = makeParametricSlot({
      characters: [{ key: 'alice', name: null, gender: null, age_min: 5, age_max: 12 }],
    });
    const chars = [makeCharacter('alice', { basic_info: { age: '8 tuổi', gender: '', description: '', category_id: '', role: '' } })];
    expect(deriveParametricDefaultValue('alice.age', slot, chars)).toBe('8');
  });

  it('photo → PHOTO_ORIGINAL_VALUE when original: true', () => {
    const slot = makeParametricSlot({
      photos: [{ key: 'portrait', original: true, is_enabled: true, real: false, styled: false }],
    });
    expect(deriveParametricDefaultValue('portrait', slot, [])).toBe(PHOTO_ORIGINAL_VALUE);
  });

  it('unknown key → null', () => {
    expect(deriveParametricDefaultValue('unknown_key', null, [])).toBeNull();
  });
});

describe('resolveDefaultActor', () => {
  it('preset with is_default carries cast actant → return actor id + type', () => {
    const slot = makeCastingSlot({
      casting_axes: [
        {
          id: 'axis_1',
          name: 'Sibling',
          actants: [{ id: 'sibling_1', name: 'Sister' }],
          presets: [
            {
              id: 'preset_def',
              name: 'Default',
              is_default: true,
              actants: [
                {
                  actant_id: 'sibling_1',
                  actor_id: 'char_alice',
                  actor_type: 1,
                },
              ],
            },
          ],
        },
      ],
    });
    const result = resolveDefaultActor(slot, 'axis_1', 'sibling_1', undefined);
    expect(result).toEqual({ id: 'char_alice', actor_type: 1 });
  });

  it('no preset cast → falls back to first character/prop tag', () => {
    const slot = makeCastingSlot({
      casting_axes: [
        {
          id: 'axis_1',
          name: 'Sibling',
          actants: [{ id: 'sibling_1', name: 'Sister' }],
          presets: [
            {
              id: 'preset_1',
              name: 'Empty',
              is_default: false,
              actants: [],
            },
          ],
        },
      ],
    });
    const tags = [
      { type: 'character' as const, object_key: 'char_bob', variant_key: 'base' },
    ];
    const result = resolveDefaultActor(slot, 'axis_1', 'sibling_1', tags);
    expect(result).toEqual({ id: 'char_bob', actor_type: 1 });
  });

  it('prop tag → actor_type 2', () => {
    const tags = [{ type: 'prop' as const, object_key: 'prop_ball', variant_key: 'base' }];
    const result = resolveDefaultActor(null, 'axis_1', 'actant_1', tags);
    expect(result).toEqual({ id: 'prop_ball', actor_type: 2 });
  });

  it('only other tag → null', () => {
    const tags = [{ type: 'other' as const, object_key: 'bg', variant_key: null }];
    expect(resolveDefaultActor(null, 'axis_1', 'actant_1', tags)).toBeNull();
  });

  it('no preset + no usable tag → null', () => {
    expect(resolveDefaultActor(null, 'axis_1', 'actant_1', [])).toBeNull();
  });

  it('missing axisId or actantId → null', () => {
    expect(resolveDefaultActor(null, null, 'actant_1', [])).toBeNull();
    expect(resolveDefaultActor(null, 'axis_1', null, [])).toBeNull();
  });
});

describe('buildParametricSeed', () => {
  it('item with illustrations: selected entry → preserves type + original_url + ai_request_id', () => {
    const img = makeImage({
      illustrations: [
        {
          type: 'edited',
          media_url: 'https://example.test/v1.png',
          created_time: '2026-07-27T00:00:00Z',
          is_selected: false,
        },
        {
          type: 'edited',
          media_url: 'https://example.test/v2.png',
          created_time: '2026-07-27T00:00:01Z',
          original_url: 'https://example.test/orig.png',
          ai_request_id: 'req_123',
          is_selected: true,
        },
      ],
    });

    const seed = buildParametricSeed(img, 'char_a.gender', 'male');

    expect(seed.key).toBe('char_a.gender');
    expect(seed.values).toHaveLength(1);
    expect(seed.values[0].value).toBe('male');
    expect(seed.values[0].is_default).toBe(true);
    expect(seed.values[0].illustrations).toHaveLength(1);
    expect(seed.values[0].illustrations[0].type).toBe('edited');
    expect(seed.values[0].illustrations[0].original_url).toBe('https://example.test/orig.png');
    expect(seed.values[0].illustrations[0].ai_request_id).toBe('req_123');
    // No effectiveUrl passed ⇒ keeps the cloned entry's own media_url.
    expect(seed.values[0].illustrations[0].media_url).toBe('https://example.test/v2.png');
  });

  it('item with illustrations + effectiveUrl: keeps provenance AND takes the hires url', () => {
    const img = makeImage({
      illustrations: [
        {
          type: 'edited',
          media_url: 'https://example.test/v1.png',
          created_time: '2026-07-27T00:00:01Z',
          original_url: 'https://example.test/orig.png',
          ai_request_id: 'req_123',
          is_selected: true,
        },
      ],
    });

    // effectiveUrl mirrors resolveEffectiveImageUrl → final_hires_media_url wins.
    const seed = buildParametricSeed(img, 'char_a.gender', 'male', 'https://example.test/hires.png');

    const entry = seed.values[0].illustrations[0];
    expect(entry.media_url).toBe('https://example.test/hires.png');
    expect(entry.type).toBe('edited');
    expect(entry.original_url).toBe('https://example.test/orig.png');
    expect(entry.ai_request_id).toBe('req_123');
    expect(entry.is_selected).toBe(true);
  });

  it('item no illustrations → creates fresh entry with type: created', () => {
    const img = makeImage({
      media_url: 'https://example.test/image.png',
      illustrations: undefined,
    });

    const seed = buildParametricSeed(img, 'country', 'VN');

    expect(seed.values[0].illustrations[0].type).toBe('created');
    expect(seed.values[0].illustrations[0].media_url).toBe('https://example.test/image.png');
    expect(seed.values[0].illustrations[0].created_time).toMatch(/^\d{4}-\d{2}-\d{2}/); // ISO
  });

  it('accepts optional effectiveUrl to override item media', () => {
    const img = makeImage({ media_url: 'https://example.test/old.png' });
    const seed = buildParametricSeed(img, 'key', 'value', 'https://example.test/new.png');

    expect(seed.values[0].illustrations[0].media_url).toBe('https://example.test/new.png');
  });
});

describe('buildCastingSeed', () => {
  it('creates flat slot with single actor + is_default: true', () => {
    const seed = buildCastingSeed('sibling_1', { id: 'char_alice', actor_type: 1 }, 'https://example.test/img.png');

    expect(seed.actant_id).toBe('sibling_1');
    expect(seed.actors).toHaveLength(1);
    expect(seed.actors[0]).toEqual({
      id: 'char_alice',
      actor_type: 1,
      media_url: 'https://example.test/img.png',
      is_default: true,
    });
  });

  it('preserves actor_type correctly', () => {
    const seed = buildCastingSeed('prop_1', { id: 'prop_ball', actor_type: 2 }, 'https://example.test/p.png');
    expect(seed.actors[0].actor_type).toBe(2);
  });
});

describe('buildSlotPatch', () => {
  it('parametric path: patch.casting_slot === undefined with key in object', () => {
    const input: SlotPatchInput = {
      slotType: 'parametric',
      item: makeImage(),
      controlKey: 'char_a.gender',
      derivedDefaultValue: 'male',
      actantId: null,
      seedActor: null,
      effectiveUrl: 'https://example.test/img.png',
    };

    const patch = buildSlotPatch(input);

    expect(patch).not.toBeNull();
    expect(patch?.parametric_slot).toBeDefined();
    expect('casting_slot' in patch!).toBe(true);
    expect(patch?.casting_slot).toBeUndefined();
  });

  it('casting path: patch.parametric_slot === undefined with key in object', () => {
    const input: SlotPatchInput = {
      slotType: 'casting',
      item: makeImage(),
      controlKey: null,
      derivedDefaultValue: null,
      actantId: 'sibling_1',
      seedActor: { id: 'char_alice', actor_type: 1 },
      effectiveUrl: 'https://example.test/img.png',
    };

    const patch = buildSlotPatch(input);

    expect(patch).not.toBeNull();
    expect(patch?.casting_slot).toBeDefined();
    expect('parametric_slot' in patch!).toBe(true);
    expect(patch?.parametric_slot).toBeUndefined();
  });

  it('parametric: null when missing controlKey or derivedDefaultValue', () => {
    const input: SlotPatchInput = {
      slotType: 'parametric',
      item: makeImage(),
      controlKey: null,
      derivedDefaultValue: 'value',
      actantId: null,
      seedActor: null,
      effectiveUrl: 'https://example.test/img.png',
    };

    expect(buildSlotPatch(input)).toBeNull();
  });

  it('casting: null when missing actantId, seedActor, or effectiveUrl', () => {
    const input: SlotPatchInput = {
      slotType: 'casting',
      item: makeImage(),
      controlKey: null,
      derivedDefaultValue: null,
      actantId: null,
      seedActor: { id: 'alice', actor_type: 1 },
      effectiveUrl: 'https://example.test/img.png',
    };

    expect(buildSlotPatch(input)).toBeNull();
  });
});

describe('resolveSlotBlockers', () => {
  const baseInput = (overrides?: Partial<SlotBlockerInput>): SlotBlockerInput => ({
    slotType: 'parametric',
    isSpreadEditable: true,
    effectiveUrl: 'https://example.test/img.png',
    parametricGroups: [],
    controlKey: null,
    derivedDefaultValue: null,
    castingAxes: [],
    axisId: null,
    actantId: null,
    seedActor: null,
    ...overrides,
  });

  it('SPREAD_NOT_EDITABLE when isSpreadEditable: false', () => {
    const blockers = resolveSlotBlockers(
      baseInput({
        isSpreadEditable: false,
        parametricGroups: [{ kind: 'character' as const, groupKey: 'a', header: 'A', isDangling: false, options: [{ key: 'a.gender', label: 'gender' }] }],
        controlKey: 'a.gender',
        derivedDefaultValue: 'male',
      }),
    );

    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.SPREAD_NOT_EDITABLE)).toBe(true);
  });

  it('SPREAD_NOT_EDITABLE has priority: appears first even with NO_MEDIA', () => {
    const blockers = resolveSlotBlockers(
      baseInput({
        isSpreadEditable: false,
        effectiveUrl: undefined,
      }),
    );

    expect(blockers[0].code).toBe(SLOT_BLOCKER_CODES.SPREAD_NOT_EDITABLE);
  });

  it('NO_MEDIA when effectiveUrl missing', () => {
    const blockers = resolveSlotBlockers(baseInput({ effectiveUrl: undefined }));
    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.NO_MEDIA)).toBe(true);
  });

  it('NO_PARAM_AXIS when parametricGroups empty', () => {
    const blockers = resolveSlotBlockers(baseInput({ slotType: 'parametric', parametricGroups: [] }));
    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.NO_PARAM_AXIS)).toBe(true);
  });

  it('NO_KEY_SELECTED when controlKey null', () => {
    const blockers = resolveSlotBlockers(
      baseInput({
        slotType: 'parametric',
        parametricGroups: [
          { kind: 'character' as const, groupKey: 'a', header: 'A', isDangling: false, options: [{ key: 'a.gender', label: 'gender' }] },
        ],
        controlKey: null,
      }),
    );
    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.NO_KEY_SELECTED)).toBe(true);
  });

  it('NO_AXIS_VALUE when derivedDefaultValue null (even with controlKey)', () => {
    const blockers = resolveSlotBlockers(
      baseInput({
        slotType: 'parametric',
        parametricGroups: [
          { kind: 'character' as const, groupKey: 'a', header: 'A', isDangling: false, options: [{ key: 'a.gender', label: 'gender' }] },
        ],
        controlKey: 'a.gender',
        derivedDefaultValue: null,
      }),
    );
    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.NO_AXIS_VALUE)).toBe(true);
  });

  it('casting: NO_CASTING_AXIS when castingAxes empty', () => {
    const blockers = resolveSlotBlockers(baseInput({ slotType: 'casting', castingAxes: [] }));
    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.NO_CASTING_AXIS)).toBe(true);
  });

  it('casting: NO_ACTANT_SELECTED when axisId or actantId missing', () => {
    const blockers = resolveSlotBlockers(
      baseInput({
        slotType: 'casting',
        castingAxes: [{ id: 'axis_1', name: 'Axis', actants: [], presets: [] }],
        axisId: null,
        actantId: 'actant_1',
      }),
    );
    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.NO_ACTANT_SELECTED)).toBe(true);
  });

  it('casting: NO_DEFAULT_ACTOR when seedActor null (even with axisId + actantId)', () => {
    const blockers = resolveSlotBlockers(
      baseInput({
        slotType: 'casting',
        castingAxes: [{ id: 'axis_1', name: 'Axis', actants: [{ id: 'actant_1', name: 'Actant' }], presets: [] }],
        axisId: 'axis_1',
        actantId: 'actant_1',
        seedActor: null,
      }),
    );
    expect(blockers.some((b) => b.code === SLOT_BLOCKER_CODES.NO_DEFAULT_ACTOR)).toBe(true);
  });

  it('all conditions met → blockers empty array', () => {
    const blockers = resolveSlotBlockers(
      baseInput({
        slotType: 'parametric',
        isSpreadEditable: true,
        effectiveUrl: 'https://example.test/img.png',
        parametricGroups: [
          { kind: 'character' as const, groupKey: 'a', header: 'A', isDangling: false, options: [{ key: 'a.gender', label: 'gender' }] },
        ],
        controlKey: 'a.gender',
        derivedDefaultValue: 'male',
      }),
    );

    expect(blockers).toHaveLength(0);
  });
});

describe('describeItemSlot', () => {
  it('item with only parametric_slot → type: parametric, count = values.length', () => {
    const img = makeImage({
      parametric_slot: {
        key: 'char_a.gender',
        values: [{ value: 'male', is_default: true, illustrations: [] }],
      },
    });
    const book = makeBook({
      parametric_slot: makeParametricSlot({
        characters: [{ key: 'char_a', name: null, gender: 'male', age_min: 5, age_max: 12 }],
      }),
    });
    const chars = [makeCharacter('char_a', { name: 'Alice' })];

    const desc = describeItemSlot(img, book, chars);

    expect(desc?.type).toBe('parametric');
    expect(desc?.count).toBe(1);
    expect(desc?.isDangling).toBe(false);
    expect(desc?.hasBothFields).toBe(false);
  });

  it('item with only casting_slot → type: casting, count = actors.length', () => {
    const img = makeImage({
      casting_slot: {
        actant_id: 'sibling_1',
        actors: [{ id: 'char_alice', actor_type: 1 as const, media_url: '', is_default: true }],
      },
    });
    const book = makeBook({
      casting_slot: makeCastingSlot({
        casting_axes: [
          {
            id: 'axis_1',
            name: 'Sibling',
            actants: [{ id: 'sibling_1', name: 'Sister' }],
            presets: [],
          } as unknown as CastingAxis,
        ],
      }),
    });

    const desc = describeItemSlot(img, book, []);

    expect(desc?.type).toBe('casting');
    expect(desc?.count).toBe(1);
    expect(desc?.isDangling).toBe(false);
  });

  it('item with both fields → type: casting, hasBothFields: true', () => {
    const img = makeImage({
      parametric_slot: {
        key: 'char_a.gender',
        values: [{ value: 'male', is_default: true, illustrations: [] }],
      },
      casting_slot: {
        actant_id: 'sibling_1',
        actors: [{ id: 'char_alice', actor_type: 1 as const, media_url: '', is_default: true }],
      },
    });

    const desc = describeItemSlot(img, null, []);

    expect(desc?.type).toBe('casting');
    expect(desc?.hasBothFields).toBe(true);
  });

  it('dangling parametric key → isDangling: true', () => {
    const img = makeImage({
      parametric_slot: {
        key: 'missing.gender',
        values: [{ value: 'male', is_default: true, illustrations: [] }],
      },
    });
    const book = makeBook({
      parametric_slot: makeParametricSlot({
        characters: [{ key: 'char_a', name: null, gender: 'male', age_min: 5, age_max: 12 }],
      }),
    });

    const desc = describeItemSlot(img, book, []);

    expect(desc?.isDangling).toBe(true);
  });

  it('item without slots → null', () => {
    const img = makeImage({ parametric_slot: undefined, casting_slot: undefined });
    expect(describeItemSlot(img, null, [])).toBeNull();
  });
});
