// sketch-base-constants.test.ts — pins the group-based auto-select + the empty-group hint.
// ⚡REV 2026-08-21: the sidebar is N DYNAMIC groups (no fixed KIND_GROUPS). `pickFirstAvailable`
// walks the groups in the order the selector already sorted them (character groups before prop
// groups), so a book that only has prop styles still lands on one, but a prop group never steals
// the default view from a character group that has a style.

import { describe, it, expect } from 'vitest';
import type { BaseGroup, SketchBaseStyle } from '@/types/sketch';
import {
  EMPTY_GROUP_HINT,
  nounForKind,
  pickFirstAvailable,
} from './sketch-base-constants';

const style = (isSelected = false): SketchBaseStyle => ({
  style_prompt: 's',
  is_selected: isSelected,
  image_references: [],
  illustrations: [],
  crops: [],
});

const G = (group_key: string, kind: 'characters' | 'props', name = group_key): BaseGroup => ({
  group_key,
  kind,
  name,
});

// The selector hands groups pre-sorted: character groups first, prop groups last.
const CHAR = G('character_sheet', 'characters', 'Character');
const ALTER = G('alter_character_sheet', 'characters', 'Alter Characters');
const PROP = G('prop_sheet', 'props', 'Prop');

describe('nounForKind', () => {
  it('names the two real kinds', () => {
    expect(nounForKind('characters')).toBe('character');
    expect(nounForKind('props')).toBe('prop');
  });
});

describe('EMPTY_GROUP_HINT', () => {
  it('states the orphan-group cause without naming a kind', () => {
    expect(EMPTY_GROUP_HINT).toContain('No entity');
  });
});

describe('pickFirstAvailable', () => {
  it('nothing generated anywhere → null', () => {
    expect(pickFirstAvailable([CHAR, PROP], {})).toBeNull();
  });

  it('prefers a LOCKED style over any earlier index in the same group', () => {
    expect(
      pickFirstAvailable([CHAR], { character_sheet: [style(), style(true)] }),
    ).toEqual({ group: 'character_sheet', index: 1 });
  });

  it('falls back to styles[0] when nothing is locked', () => {
    expect(pickFirstAvailable([CHAR], { character_sheet: [style(), style()] })).toEqual({
      group: 'character_sheet',
      index: 0,
    });
  });

  it('empty first group → the next group with a style', () => {
    expect(
      pickFirstAvailable([CHAR, PROP], { character_sheet: [], prop_sheet: [style(), style(true)] }),
    ).toEqual({ group: 'prop_sheet', index: 1 });
  });

  it('only a later group has styles → selects it (the group is reachable, not stranded)', () => {
    expect(
      pickFirstAvailable([CHAR, ALTER, PROP], { alter_character_sheet: [style(), style(true)] }),
    ).toEqual({ group: 'alter_character_sheet', index: 1 });
  });

  it('walks in the given order — the first group with a style wins over a later locked one', () => {
    expect(
      pickFirstAvailable([CHAR, PROP], { character_sheet: [style()], prop_sheet: [style(true)] }),
    ).toEqual({ group: 'character_sheet', index: 0 });
  });

  it('a group missing from the styles map is treated as empty (union group, no sheet node yet)', () => {
    // `alter_character_sheet` has entities but no base node → no styles entry → skipped, not a crash.
    expect(
      pickFirstAvailable([ALTER, PROP], { prop_sheet: [style()] }),
    ).toEqual({ group: 'prop_sheet', index: 0 });
  });
});
