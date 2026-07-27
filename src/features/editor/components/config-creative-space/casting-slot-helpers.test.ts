// casting-slot-helpers.test.ts — Unit tests for the pure casting-slot helpers:
// normalizeCastingSlot tolerance branches (§4.4), buildActorOptions, resolve /
// lookup, mintActantName, and the immutable mutations incl. cascade purge.
// vitest only — NO node builtins (tsc -b type-checks with vite/client types).

import { describe, it, expect } from 'vitest';
import {
  ACTANT_NAME_FALLBACK_PREFIX,
  DEFAULT_CASTING_SLOT,
  addAxis,
  addPreset,
  applyAxisDraft,
  buildActorOptions,
  deleteAxis,
  deletePreset,
  findActorOption,
  findAssignment,
  mintActantName,
  normalizeCastingSlot,
  purgeActorFromCastingSlot,
  renamePreset,
  resolveDefaultPreset,
  resolveSelectedAxis,
  resolveSelectedPreset,
  setDefaultPreset,
  upsertAssignment,
  type ActorOption,
} from './casting-slot-helpers';
import type { BookCastingSlot } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';

// ── Fixtures (inline — no fs, no JSON import) ─────────────────────────────────

function slotFixture(): BookCastingSlot {
  return {
    casting_axes: [
      {
        id: 'axis-1',
        name: 'User',
        actants: [
          { id: 'act-1', name: 'User 1' },
          { id: 'act-2', name: 'User 2' },
        ],
        presets: [
          {
            id: 'preset-1',
            name: 'Default',
            is_default: true,
            actants: [{ actant_id: 'act-1', actor_id: 'emma', actor_type: 1 }],
          },
          {
            id: 'preset-2',
            name: 'Alt',
            is_default: false,
            actants: [
              { actant_id: 'act-1', actor_id: 'emma', actor_type: 1 },
              { actant_id: 'act-2', actor_id: 'red_bow', actor_type: 2 },
            ],
          },
        ],
      },
      {
        id: 'axis-2',
        name: 'Pet',
        actants: [{ id: 'act-9', name: 'Pet 1' }],
        presets: [
          {
            id: 'preset-9',
            name: 'P',
            is_default: true,
            actants: [{ actant_id: 'act-9', actor_id: 'emma', actor_type: 1 }],
          },
        ],
      },
    ],
  };
}

const char = (key: string, name: string) => ({ key, name }) as Character;
const prop = (key: string, name: string) => ({ key, name }) as Prop;

// ── normalizeCastingSlot ──────────────────────────────────────────────────────

describe('normalizeCastingSlot', () => {
  it('falls back to the empty default for unusable roots', () => {
    for (const raw of [null, undefined, {}, 42, 'x', [], { casting_axes: 'nope' }]) {
      expect(normalizeCastingSlot(raw)).toEqual(DEFAULT_CASTING_SLOT);
    }
  });

  it('returns a fresh object, never the shared DEFAULT constant', () => {
    const a = normalizeCastingSlot(null);
    a.casting_axes.push({ id: 'x', name: '', actants: [], presets: [] });
    expect(DEFAULT_CASTING_SLOT.casting_axes).toHaveLength(0);
  });

  it('round-trips a valid slot unchanged (idempotent)', () => {
    const src = slotFixture();
    const once = normalizeCastingSlot(src);
    expect(once).toEqual(src);
    expect(normalizeCastingSlot(once)).toEqual(once);
  });

  it('drops axes without a usable id', () => {
    const out = normalizeCastingSlot({
      casting_axes: [{ name: 'no id' }, { id: '', name: 'blank' }, null, 'str', { id: 'ok', name: 'k' }],
    });
    expect(out.casting_axes.map((a) => a.id)).toEqual(['ok']);
  });

  it('keeps the first of duplicate axis ids', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        { id: 'a', name: 'first', actants: [], presets: [] },
        { id: 'a', name: 'second', actants: [], presets: [] },
      ],
    });
    expect(out.casting_axes).toHaveLength(1);
    expect(out.casting_axes[0].name).toBe('first');
  });

  it('keeps the first of duplicate actant ids', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        {
          id: 'a',
          name: 'x',
          actants: [
            { id: 'k', name: 'first' },
            { id: 'k', name: 'second' },
          ],
          presets: [],
        },
      ],
    });
    expect(out.casting_axes[0].actants).toEqual([{ id: 'k', name: 'first' }]);
  });

  it('keeps the first of duplicate preset ids', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        {
          id: 'a',
          name: 'x',
          actants: [],
          presets: [
            { id: 'p', name: 'first', is_default: true, actants: [] },
            { id: 'p', name: 'second', is_default: false, actants: [] },
          ],
        },
      ],
    });
    expect(out.casting_axes[0].presets).toHaveLength(1);
    expect(out.casting_axes[0].presets[0].name).toBe('first');
  });

  it('drops assignments whose actant_id is orphaned', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        {
          id: 'a',
          name: 'x',
          actants: [{ id: 'act-1', name: 'r' }],
          presets: [
            {
              id: 'p',
              name: 'P',
              is_default: true,
              actants: [
                { actant_id: 'act-1', actor_id: 'emma', actor_type: 1 },
                { actant_id: 'ghost', actor_id: 'emma', actor_type: 1 },
              ],
            },
          ],
        },
      ],
    });
    expect(out.casting_axes[0].presets[0].actants).toEqual([
      { actant_id: 'act-1', actor_id: 'emma', actor_type: 1 },
    ]);
  });

  it('keeps the first assignment when one actant appears twice in a preset', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        {
          id: 'a',
          name: 'x',
          actants: [{ id: 'act-1', name: 'r' }],
          presets: [
            {
              id: 'p',
              name: 'P',
              is_default: true,
              actants: [
                { actant_id: 'act-1', actor_id: 'emma', actor_type: 1 },
                { actant_id: 'act-1', actor_id: 'liam', actor_type: 1 },
              ],
            },
          ],
        },
      ],
    });
    expect(out.casting_axes[0].presets[0].actants).toEqual([
      { actant_id: 'act-1', actor_id: 'emma', actor_type: 1 },
    ]);
  });

  it('drops assignments with an out-of-range actor_type or blank actor_id', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        {
          id: 'a',
          name: 'x',
          actants: [
            { id: 'act-1', name: 'r' },
            { id: 'act-2', name: 's' },
            { id: 'act-3', name: 't' },
          ],
          presets: [
            {
              id: 'p',
              name: 'P',
              is_default: true,
              actants: [
                { actant_id: 'act-1', actor_id: 'emma', actor_type: 3 },
                { actant_id: 'act-2', actor_id: '', actor_type: 1 },
                { actant_id: 'act-3', actor_id: 'ok', actor_type: 2 },
              ],
            },
          ],
        },
      ],
    });
    expect(out.casting_axes[0].presets[0].actants).toEqual([
      { actant_id: 'act-3', actor_id: 'ok', actor_type: 2 },
    ]);
  });

  it('promotes presets[0] when no preset carries is_default', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        {
          id: 'a',
          name: 'x',
          actants: [],
          presets: [
            { id: 'p1', name: 'A', is_default: false, actants: [] },
            { id: 'p2', name: 'B', is_default: false, actants: [] },
          ],
        },
      ],
    });
    expect(out.casting_axes[0].presets.map((p) => p.is_default)).toEqual([true, false]);
  });

  it('keeps only the first is_default when several are true', () => {
    const out = normalizeCastingSlot({
      casting_axes: [
        {
          id: 'a',
          name: 'x',
          actants: [],
          presets: [
            { id: 'p1', name: 'A', is_default: false, actants: [] },
            { id: 'p2', name: 'B', is_default: true, actants: [] },
            { id: 'p3', name: 'C', is_default: true, actants: [] },
          ],
        },
      ],
    });
    expect(out.casting_axes[0].presets.map((p) => p.is_default)).toEqual([false, true, false]);
  });

  it('handles an axis with zero presets and coerces missing names', () => {
    const out = normalizeCastingSlot({ casting_axes: [{ id: 'a', actants: [{ id: 'k' }] }] });
    expect(out.casting_axes[0]).toEqual({
      id: 'a',
      name: '',
      actants: [{ id: 'k', name: '' }],
      presets: [],
    });
  });
});

// ── buildActorOptions ─────────────────────────────────────────────────────────

describe('buildActorOptions', () => {
  it('maps characters then props with the right actor_type and group', () => {
    const out = buildActorOptions([char('emma', 'Emma')], [prop('bow', 'Red Bow')]);
    expect(out).toEqual([
      { actor_id: 'emma', actor_type: 1, label: 'Emma', group: 'characters' },
      { actor_id: 'bow', actor_type: 2, label: 'Red Bow', group: 'props' },
    ]);
  });

  it('dedupes duplicate keys within a group (first wins)', () => {
    const out = buildActorOptions([char('emma', 'Emma'), char('emma', 'Emma 2')], []);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Emma');
  });

  it('does NOT dedupe across groups — a character and a prop may share a key', () => {
    const out = buildActorOptions([char('star', 'Star')], [prop('star', 'Star Prop')]);
    expect(out.map((o) => o.actor_type)).toEqual([1, 2]);
  });

  it('falls back to the key when the name is blank', () => {
    const out = buildActorOptions([char('emma', '   ')], []);
    expect(out[0].label).toBe('emma');
  });

  it('returns an empty list for an empty snapshot', () => {
    expect(buildActorOptions([], [])).toEqual([]);
  });
});

// ── resolve / lookup ──────────────────────────────────────────────────────────

describe('resolve + lookup', () => {
  const slot = slotFixture();

  it('resolveSelectedAxis falls back to the first axis on a stale id', () => {
    expect(resolveSelectedAxis(slot.casting_axes, 'axis-2')?.id).toBe('axis-2');
    expect(resolveSelectedAxis(slot.casting_axes, 'gone')?.id).toBe('axis-1');
    expect(resolveSelectedAxis(slot.casting_axes, null)?.id).toBe('axis-1');
    expect(resolveSelectedAxis([], null)).toBeNull();
  });

  it('resolveDefaultPreset picks the flagged preset', () => {
    expect(resolveDefaultPreset(slot.casting_axes[0])?.id).toBe('preset-1');
    expect(resolveDefaultPreset(null)).toBeNull();
  });

  it('resolveSelectedPreset falls back to the default on a stale id', () => {
    expect(resolveSelectedPreset(slot.casting_axes[0], 'preset-2')?.id).toBe('preset-2');
    expect(resolveSelectedPreset(slot.casting_axes[0], 'gone')?.id).toBe('preset-1');
  });

  it('findAssignment / findActorOption resolve a bound actor', () => {
    const preset = slot.casting_axes[0].presets[1];
    const asg = findAssignment(preset, 'act-2');
    expect(asg?.actor_id).toBe('red_bow');
    const options: ActorOption[] = [
      { actor_id: 'red_bow', actor_type: 2, label: 'Red Bow', group: 'props' },
    ];
    expect(findActorOption(options, asg)?.label).toBe('Red Bow');
    expect(findAssignment(preset, 'ghost')).toBeNull();
    expect(findActorOption(options, null)).toBeNull();
  });

  it('findActorOption returns null (dangling) when only the type differs', () => {
    const options: ActorOption[] = [
      { actor_id: 'star', actor_type: 1, label: 'Star', group: 'characters' },
    ];
    expect(findActorOption(options, { actant_id: 'a', actor_id: 'star', actor_type: 2 })).toBeNull();
  });
});

// ── mintActantName ────────────────────────────────────────────────────────────

describe('mintActantName', () => {
  it('uses the axis draft name with N = count + 1', () => {
    expect(mintActantName('User', 0)).toBe('User 1');
    expect(mintActantName('User', 1)).toBe('User 2');
    expect(mintActantName('User', 2)).toBe('User 3');
  });

  it('falls back to the prefix for blank / whitespace-only axis names', () => {
    expect(mintActantName('', 0)).toBe(`${ACTANT_NAME_FALLBACK_PREFIX}_1`);
    expect(mintActantName('   ', 0)).toBe(`${ACTANT_NAME_FALLBACK_PREFIX}_1`);
    expect(mintActantName('\t\n', 1)).toBe(`${ACTANT_NAME_FALLBACK_PREFIX}_2`);
  });

  it('preserves the casing the user typed and trims edges', () => {
    expect(mintActantName('  mAiN cAsT  ', 3)).toBe('mAiN cAsT 4');
  });
});

// ── mutations ─────────────────────────────────────────────────────────────────

describe('mutations', () => {
  it('addAxis appends an axis with no presets and returns its id', () => {
    const slot = slotFixture();
    const { next, axisId } = addAxis(slot, { name: 'New', actants: [{ id: 'a1', name: 'r' }] });
    expect(next.casting_axes).toHaveLength(3);
    const created = next.casting_axes[2];
    expect(created.id).toBe(axisId);
    expect(created.presets).toEqual([]);
    expect(slot.casting_axes).toHaveLength(2);
  });

  it('applyAxisDraft cascade-purges assignments of removed actants', () => {
    const slot = slotFixture();
    const { next, removedActantCount } = applyAxisDraft(slot, 'axis-1', {
      name: 'User',
      actants: [{ id: 'act-1', name: 'User 1' }],
    });
    expect(removedActantCount).toBe(1);
    const axis = next.casting_axes[0];
    expect(axis.actants).toHaveLength(1);
    expect(axis.presets[1].actants.map((a) => a.actant_id)).toEqual(['act-1']);
    // Untouched axis keeps its identity.
    expect(next.casting_axes[1]).toBe(slot.casting_axes[1]);
  });

  it('applyAxisDraft renaming an actant keeps its id, so assignments survive', () => {
    const slot = slotFixture();
    const { next, removedActantCount } = applyAxisDraft(slot, 'axis-1', {
      name: 'Hero',
      actants: [
        { id: 'act-1', name: 'Protagonist' },
        { id: 'act-2', name: 'Sidekick' },
      ],
    });
    expect(removedActantCount).toBe(0);
    expect(next.casting_axes[0].name).toBe('Hero');
    expect(next.casting_axes[0].presets[1].actants).toHaveLength(2);
  });

  it('applyAxisDraft on a missing axis is a no-op', () => {
    const slot = slotFixture();
    const { next, removedActantCount } = applyAxisDraft(slot, 'nope', { name: 'x', actants: [] });
    expect(next).toBe(slot);
    expect(removedActantCount).toBe(0);
  });

  it('deleteAxis removes the axis with its presets', () => {
    const slot = slotFixture();
    expect(deleteAxis(slot, 'axis-1').casting_axes.map((a) => a.id)).toEqual(['axis-2']);
    expect(slot.casting_axes).toHaveLength(2);
  });

  it('addPreset flags the first preset of an axis as default, later ones not', () => {
    const empty: BookCastingSlot = {
      casting_axes: [{ id: 'a', name: 'A', actants: [], presets: [] }],
    };
    const first = addPreset(empty, 'a', 'P1');
    expect(first.next.casting_axes[0].presets[0].is_default).toBe(true);
    const second = addPreset(first.next, 'a', 'P2');
    expect(second.next.casting_axes[0].presets.map((p) => p.is_default)).toEqual([true, false]);
    expect(second.next.casting_axes[0].presets[1].actants).toEqual([]);
  });

  it('renamePreset touches only the target preset', () => {
    const slot = slotFixture();
    const next = renamePreset(slot, 'axis-1', 'preset-2', 'Renamed');
    expect(next.casting_axes[0].presets.map((p) => p.name)).toEqual(['Default', 'Renamed']);
  });

  it('deletePreset promotes the first survivor when the default is removed', () => {
    const slot = slotFixture();
    const next = deletePreset(slot, 'axis-1', 'preset-1');
    expect(next.casting_axes[0].presets).toHaveLength(1);
    expect(next.casting_axes[0].presets[0].is_default).toBe(true);
  });

  it('deletePreset on the last preset leaves an empty array', () => {
    const next = deletePreset(deletePreset(slotFixture(), 'axis-1', 'preset-1'), 'axis-1', 'preset-2');
    expect(next.casting_axes[0].presets).toEqual([]);
  });

  it('setDefaultPreset is radio-scoped to its own axis', () => {
    const slot = slotFixture();
    const next = setDefaultPreset(slot, 'axis-1', 'preset-2');
    expect(next.casting_axes[0].presets.map((p) => p.is_default)).toEqual([false, true]);
    expect(next.casting_axes[1].presets[0].is_default).toBe(true);
    expect(setDefaultPreset(next, 'axis-1', 'preset-2')).toEqual(next);
  });

  it('upsertAssignment adds, overwrites in place, and removes on null', () => {
    const slot = slotFixture();
    const liam: ActorOption = {
      actor_id: 'liam',
      actor_type: 1,
      label: 'Liam',
      group: 'characters',
    };
    const added = upsertAssignment(slot, 'axis-1', 'preset-1', 'act-2', liam);
    expect(added.casting_axes[0].presets[0].actants).toHaveLength(2);

    const overwritten = upsertAssignment(added, 'axis-1', 'preset-1', 'act-1', liam);
    const list = overwritten.casting_axes[0].presets[0].actants;
    expect(list[0]).toEqual({ actant_id: 'act-1', actor_id: 'liam', actor_type: 1 });
    expect(list).toHaveLength(2); // position preserved, no duplicate appended

    const cleared = upsertAssignment(overwritten, 'axis-1', 'preset-1', 'act-1', null);
    expect(cleared.casting_axes[0].presets[0].actants.map((a) => a.actant_id)).toEqual(['act-2']);
  });

  it('upsertAssignment allows one actor on several roles of one preset', () => {
    const emma: ActorOption = {
      actor_id: 'emma',
      actor_type: 1,
      label: 'Emma',
      group: 'characters',
    };
    const next = upsertAssignment(slotFixture(), 'axis-1', 'preset-1', 'act-2', emma);
    expect(next.casting_axes[0].presets[0].actants.map((a) => a.actor_id)).toEqual(['emma', 'emma']);
  });

  it('purgeActorFromCastingSlot removes across every axis and preset', () => {
    const slot = slotFixture();
    const { next, changed, removedCount } = purgeActorFromCastingSlot(slot, 1, 'emma');
    expect(changed).toBe(true);
    expect(removedCount).toBe(3);
    expect(next.casting_axes[0].presets[0].actants).toEqual([]);
    expect(next.casting_axes[0].presets[1].actants.map((a) => a.actor_id)).toEqual(['red_bow']);
    expect(next.casting_axes[1].presets[0].actants).toEqual([]);
  });

  it('purgeActorFromCastingSlot is a no-op when nothing matches', () => {
    const slot = slotFixture();
    const { next, changed, removedCount } = purgeActorFromCastingSlot(slot, 2, 'emma');
    expect(changed).toBe(false);
    expect(removedCount).toBe(0);
    expect(next).toBe(slot);
  });

  it('mutations never mutate their input slot', () => {
    const slot = slotFixture();
    const snapshot = JSON.stringify(slot);
    const opt: ActorOption = { actor_id: 'x', actor_type: 1, label: 'X', group: 'characters' };
    addAxis(slot, { name: 'n', actants: [] });
    applyAxisDraft(slot, 'axis-1', { name: 'n', actants: [] });
    deleteAxis(slot, 'axis-1');
    addPreset(slot, 'axis-1', 'p');
    renamePreset(slot, 'axis-1', 'preset-1', 'r');
    deletePreset(slot, 'axis-1', 'preset-1');
    setDefaultPreset(slot, 'axis-1', 'preset-2');
    upsertAssignment(slot, 'axis-1', 'preset-1', 'act-2', opt);
    purgeActorFromCastingSlot(slot, 1, 'emma');
    expect(JSON.stringify(slot)).toBe(snapshot);
  });
});
