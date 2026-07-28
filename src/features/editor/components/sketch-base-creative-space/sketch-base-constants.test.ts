// sketch-base-constants.test.ts — pins the sidebar group config + auto-select priority.
// ⚡2026-07-28: a THIRD group (Alter Character) was added LAST. Its position is load-bearing —
// `pickFirstAvailable` derives its order from KIND_GROUPS, so promoting alter would make a book
// with alter styles open on the alter sheet instead of the story cast.

import { describe, it, expect } from 'vitest';
import type { SketchBaseStyle } from '@/types/sketch';
import { BASE_SHEET_ID, KIND_ENTITY_SOURCE } from '@/types/sketch';
import { KIND_GROUPS, emptyEntitiesHint, nounForKind, pickFirstAvailable } from './sketch-base-constants';
import { IMPORT_SHEETS } from './import/parse-base-entities.constants';

const style = (isSelected = false): SketchBaseStyle => ({
  style_prompt: 's',
  is_selected: isSelected,
  image_references: [],
  illustrations: [],
  crops: [],
});

const byKind = (
  characters: SketchBaseStyle[] = [],
  props: SketchBaseStyle[] = [],
  alter_characters: SketchBaseStyle[] = [],
) => ({ characters, props, alter_characters });

describe('KIND_GROUPS', () => {
  it('renders exactly three groups in the fixed order character → prop → alter (alter LAST)', () => {
    expect(KIND_GROUPS.map((g) => g.kind)).toEqual(['characters', 'props', 'alter_characters']);
  });

  it('every group is addressable — each kind has a sheet node and an entity source', () => {
    for (const g of KIND_GROUPS) {
      expect(BASE_SHEET_ID[g.kind]).toBeTruthy();
      expect(KIND_ENTITY_SOURCE[g.kind].collection).toBeTruthy();
    }
  });

  it('the alter group labels itself as its own thing (never reuses the Prop copy)', () => {
    const alter = KIND_GROUPS.find((g) => g.kind === 'alter_characters')!;
    expect(alter.title).toBe('Alter Character');
    expect(alter.noun).toBe('alter character');
    expect(alter.sheetName).toBe('Alter Characters');
    expect(nounForKind('alter_characters')).toBe('alter character');
  });
});

describe('emptyEntitiesHint', () => {
  it('names the Excel tab for a kind the importer actually reads', () => {
    const chars = KIND_GROUPS.find((g) => g.kind === 'characters')!;
    expect(emptyEntitiesHint(chars)).toContain('Characters');
    expect(emptyEntitiesHint(chars)).toContain('character');
  });

  it('became actionable for alter characters once the importer read that tab (Phase 08)', () => {
    // The gate is DERIVED from IMPORT_SHEETS: before Phase 08 this hint deliberately promised
    // nothing (telling a user to import a tab the parser skips is a worse dead-end than silence).
    // Adding the tab to IMPORT_SHEETS flipped it with no edit in sketch-base-constants.ts.
    const alter = KIND_GROUPS.find((g) => g.kind === 'alter_characters')!;
    const hint = emptyEntitiesHint(alter);
    expect(hint).toContain('alter character');
    expect(hint).toContain('import');
    expect(hint).toContain('Alter Characters'); // the exact tab name the parser matches
  });

  it('the hinted tab name matches the name the importer looks for', () => {
    // KIND_GROUPS.sheetName (display) and IMPORT_SHEETS.sheet (lookup) are separate constants —
    // a drift would send the user to a tab the parser does not read.
    for (const group of KIND_GROUPS) {
      const cfg = IMPORT_SHEETS.find((s) => s.kind === group.kind);
      if (cfg) expect(group.sheetName).toBe(cfg.sheet);
    }
  });
});

describe('pickFirstAvailable', () => {
  it('nothing generated anywhere → null', () => {
    expect(pickFirstAvailable(byKind())).toBeNull();
  });

  it('prefers a LOCKED character style over any earlier index', () => {
    expect(pickFirstAvailable(byKind([style(), style(true)]))).toEqual({ kind: 'characters', index: 1 });
  });

  it('falls back to characters[0] when nothing is locked', () => {
    expect(pickFirstAvailable(byKind([style(), style()]))).toEqual({ kind: 'characters', index: 0 });
  });

  it('empty character sheet → props next', () => {
    expect(pickFirstAvailable(byKind([], [style(), style(true)]))).toEqual({ kind: 'props', index: 1 });
  });

  it('only the alter sheet has styles → selects it (the group is reachable, not stranded)', () => {
    expect(pickFirstAvailable(byKind([], [], [style(), style(true)]))).toEqual({
      kind: 'alter_characters',
      index: 1,
    });
  });

  it('alter NEVER outranks the story cast — a locked alter style loses to an unlocked character one', () => {
    expect(pickFirstAvailable(byKind([style()], [], [style(true)]))).toEqual({ kind: 'characters', index: 0 });
  });

  it('alter loses to props too (it is last in the order, not second)', () => {
    expect(pickFirstAvailable(byKind([], [style()], [style(true)]))).toEqual({ kind: 'props', index: 0 });
  });
});
