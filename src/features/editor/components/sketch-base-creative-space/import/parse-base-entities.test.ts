// parse-base-entities.test.ts — ⚡REV 2026-08-21 group-based Excel import. Tab discovery is by name
// rule (contains `character` / `prop`); each matched tab is one group keyed by
// `normalizeGroupKey(tabName)`; every entity carries `group`; no `actor_role`. ≥1 character tab AND
// ≥1 prop tab required; key unique across all tabs of a kind.

import { describe, it, expect } from 'vitest';
import {
  parseWorkbook,
  parseBaseEntities,
  normalizeRow,
  validateBaseImport,
  validateEntityKeyUniqueness,
  describeImportReplacement,
  type BaseImportParse,
  type BaseSheetRow,
  type ImportIssues,
} from './parse-base-entities';
import type { BaseGroup, SketchEntity } from '@/types/sketch';

import * as XLSX from 'xlsx';

/** Header row shared by every character/prop tab fixture. */
const HEADER = (keyCol: string) => [keyCol, 'Variant', 'Description', 'Height', 'Visual_Design', 'Art_Language'];

/** Build a workbook from `[sheetName, aoaRows][]` (order = tab order in the file). */
function workbookOf(sheets: Array<[string, unknown[][]]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

describe('normalizeRow', () => {
  it('lowercases+trims keys and coerces values to trimmed strings', () => {
    const row = normalizeRow({ ' Character ': '  hero ', Variant: 'base', Height: ' tall ' });
    expect(row).toEqual({ character: 'hero', variant: 'base', height: 'tall' });
  });

  it('coerces null/undefined cells to empty string', () => {
    expect(normalizeRow({ character: null, variant: undefined, height: '' })).toEqual({
      character: '',
      variant: '',
      height: '',
    });
  });

  it('coerces numeric cell values to strings', () => {
    expect(normalizeRow({ character: 'hero', number: 123 }).number).toBe('123');
  });
});

describe('parseBaseEntities', () => {
  const rows: BaseSheetRow[] = [
    { character: 'hero', variant: 'base', description: 'a warrior', height: '1.1m', visual_design: 'mighty', art_language: 'epic' },
    { character: 'hero', variant: 'wounded', description: '', height: '', visual_design: 'hurt', art_language: '' },
    { character: 'villain', variant: 'base', description: '', height: '20-30cm', visual_design: 'evil', art_language: 'dark' },
    { character: 'ghostly', variant: 'base', description: '', height: 'tall', visual_design: '', art_language: '' },
    { character: '', variant: 'ghost', description: 'no key', height: '', visual_design: '', art_language: '' },
  ];

  it('groups rows by key column, first-seen order, one variant per row', () => {
    const entities = parseBaseEntities(rows, 'character', 'character_1');
    expect(entities.map((e) => e.key)).toEqual(['hero', 'villain', 'ghostly']);
    expect(entities[0].variants).toHaveLength(2);
    expect(entities[0].variants[0]).toMatchObject({ key: 'base', visual_design: 'mighty' });
  });

  it('stamps the group key on every entity and NO actor_role', () => {
    const entities = parseBaseEntities(rows, 'character', 'alter_characters');
    expect(entities.every((e) => e.group === 'alter_characters')).toBe(true);
    expect(entities.every((e) => !('actor_role' in e))).toBe(true);
  });

  it('maps 4 columns to their own variant fields (description ≠ visual_design)', () => {
    const heroBase = parseBaseEntities(rows, 'character', 'g')[0].variants[0];
    expect(heroBase).toMatchObject({ description: 'a warrior', height: 110, visual_design: 'mighty', art_language: 'epic' });
  });

  it('height parses to a cm NUMBER — range takes the max, unmeasurable → null (variant kept)', () => {
    const entities = parseBaseEntities(rows, 'character', 'g');
    expect(entities[1].variants[0].height).toBe(30); // "20-30cm" → max
    expect(entities[2].variants[0].height).toBeNull(); // "tall"
    expect(entities[2].variants).toHaveLength(1);
  });

  it('skips rows with empty key column; [] for empty input', () => {
    expect(parseBaseEntities(rows, 'character', 'g')).toHaveLength(3);
    expect(parseBaseEntities([], 'character', 'g')).toEqual([]);
  });
});

describe('parseWorkbook — tab-name discovery', () => {
  const charRows = [HEADER('Character'), ['hero', 'base', 'a warrior', '110cm', 'mighty', 'epic'], ['villain', 'base', '', '', 'evil', 'dark']];
  const propRows = [HEADER('Prop'), ['sword', 'base', 'a blade', '', 'sharp', 'combat']];
  const alterRows = [HEADER('Character'), ['miu', 'base', 'a cat', '30cm', 'fluffy', 'soft'], ['kiki', 'base', '', '', 'small', '']];

  it('discovers a character + prop group; skips Book/Storyboard/Flow/Stages/lang tabs', () => {
    const parsed = parseWorkbook(
      workbookOf([
        ['Book', [['x']]],
        ['Storyboard', [['x']]],
        ['Flow', [['x']]],
        ['Characters', charRows],
        ['Props', propRows],
        ['Stages', [['x']]],
        ['vi_VN', [['x']]],
        ['en_US', [['x']]],
      ]),
      XLSX,
    );
    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.tabs).toEqual(['Characters', 'Props']);
    expect(parsed.result.sheetGroups).toEqual<BaseGroup[]>([
      { group_key: 'characters', kind: 'characters', name: 'Characters' },
      { group_key: 'props', kind: 'props', name: 'Props' },
    ]);
    expect(parsed.result.characters.map((e) => e.group)).toEqual(['characters', 'characters']);
    expect(parsed.result.props.map((e) => e.group)).toEqual(['props']);
  });

  it('an "Alter Characters" tab is just another character group (key alter_characters, no actor_role)', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Alter Characters', alterRows], ['Props', propRows]]),
      XLSX,
    );
    expect(parsed.issues.errors).toEqual([]);
    // Two character groups (characters + alter_characters) + one prop group.
    expect(parsed.result.sheetGroups.map((g) => g.group_key)).toEqual(['characters', 'alter_characters', 'props']);
    expect(parsed.result.characters.map((e) => e.key)).toEqual(['hero', 'villain', 'miu', 'kiki']);
    expect(parsed.result.characters.map((e) => e.group)).toEqual(['characters', 'characters', 'alter_characters', 'alter_characters']);
    expect(parsed.result.characters.every((e) => !('actor_role' in e))).toBe(true);
  });

  it('real sketch.xlsx tab layout → 2 character groups (characters + alter_characters) + 1 prop group', () => {
    // Mirrors the verified real fixture tab order: Book, Storyboard, Flow, Characters,
    // Alter Characters, Props, Stages, vi_VN, en_US.
    const parsed = parseWorkbook(
      workbookOf([
        ['Book', [['x']]],
        ['Storyboard', [['x']]],
        ['Flow', [['x']]],
        ['Characters', charRows],
        ['Alter Characters', alterRows],
        ['Props', propRows],
        ['Stages', [['x']]],
        ['vi_VN', [['x']]],
        ['en_US', [['x']]],
      ]),
      XLSX,
    );
    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.result.sheetGroups).toEqual<BaseGroup[]>([
      { group_key: 'characters', kind: 'characters', name: 'Characters' },
      { group_key: 'alter_characters', kind: 'characters', name: 'Alter Characters' },
      { group_key: 'props', kind: 'props', name: 'Props' },
    ]);
  });

  it('normalizeGroupKey("Characters") === "characters" (a valid group key, distinct from legacy character_sheet)', () => {
    const parsed = parseWorkbook(workbookOf([['Characters', charRows], ['Props', propRows]]), XLSX);
    expect(parsed.result.sheetGroups[0].group_key).toBe('characters');
  });

  it('a tab matching BOTH rules ("Character Props") is ambiguous → blocking error', () => {
    const parsed = parseWorkbook(workbookOf([['Character Props', charRows], ['Props', propRows]]), XLSX);
    expect(parsed.issues.errors.some((e) => e.includes('khớp cả Character lẫn Prop'))).toBe(true);
  });

  it('two tabs that normalize to the same group key → blocking error', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['characters ', alterRows], ['Props', propRows]]),
      XLSX,
    );
    expect(parsed.issues.errors.some((e) => e.includes('group key "characters"'))).toBe(true);
  });

  it('missing a whole kind → error for that kind', () => {
    const noProp = parseWorkbook(workbookOf([['Characters', charRows]]), XLSX);
    expect(noProp.issues.errors.some((e) => e.includes('tab Prop'))).toBe(true);
    const noChar = parseWorkbook(workbookOf([['Props', propRows]]), XLSX);
    expect(noChar.issues.errors.some((e) => e.includes('tab Character'))).toBe(true);
  });

  it('a key reused across two tabs of the SAME kind → blocking error listing the key', () => {
    const dupHero = [HEADER('Character'), ['hero', 'base', '', '', 'twin', '']];
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Alter Characters', dupHero], ['Props', propRows]]),
      XLSX,
    );
    expect(parsed.issues.errors.some((e) => e.includes('trùng giữa các tab') && e.includes('hero'))).toBe(true);
  });

  it('the SAME key in a character group AND a prop group is allowed (separate collections)', () => {
    const propHero = [HEADER('Prop'), ['hero', 'base', '', '', 'shield', '']];
    const parsed = parseWorkbook(workbookOf([['Characters', charRows], ['Props', propHero]]), XLSX);
    expect(parsed.issues.errors).toEqual([]);
  });

  it('an empty (header-only) matching tab still produces a sheetGroups entry (reset on commit)', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Extra Characters', [HEADER('Character')]], ['Props', propRows]]),
      XLSX,
    );
    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.result.sheetGroups.map((g) => g.group_key)).toEqual(['characters', 'extra_characters', 'props']);
    expect(parsed.result.characters.filter((e) => e.group === 'extra_characters')).toHaveLength(0);
  });

  it('height column → cm number: "1.1m"→110, "110cm"→110, "20-30cm"→30 (max)', () => {
    const rows = [HEADER('Character'), ['a', 'base', '', '1.1m', '', ''], ['b', 'base', '', '110cm', '', ''], ['c', 'base', '', '20-30cm', '', '']];
    const parsed = parseWorkbook(workbookOf([['Characters', rows], ['Props', propRows]]), XLSX);
    expect(parsed.result.characters.map((e) => e.variants[0].height)).toEqual([110, 110, 30]);
  });

  it('unparseable height → null + warning (variant still imported, not blocking)', () => {
    const rows = [HEADER('Character'), ['hero', 'base', '', 'tall', '', '']];
    const parsed = parseWorkbook(workbookOf([['Characters', rows], ['Props', propRows]]), XLSX);
    expect(parsed.result.characters[0].variants[0].height).toBeNull();
    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.issues.warnings.some((w) => w.includes('height "tall"'))).toBe(true);
  });

  it('missing the required Variant column → blocking error', () => {
    const broken = [['Character', 'Description'], ['hero', 'a warrior']];
    const parsed = parseWorkbook(workbookOf([['Characters', broken], ['Props', propRows]]), XLSX);
    expect(parsed.issues.errors.some((e) => e.includes('variant'))).toBe(true);
  });

  it('cross-group @ref resolves against another group; an unknown ref warns', () => {
    const refRows = [HEADER('Character'), ['hero', 'base', 'travels with @miu/base', '', '', '']];
    const ok = parseWorkbook(
      workbookOf([['Characters', refRows], ['Alter Characters', alterRows], ['Props', propRows]]),
      XLSX,
    );
    expect(ok.issues.warnings.some((w) => w.includes('@miu/base'))).toBe(false);

    const badRows = [HEADER('Character'), ['hero', 'base', 'travels with @nobody/base', '', '', '']];
    const bad = parseWorkbook(workbookOf([['Characters', badRows], ['Props', propRows]]), XLSX);
    expect(bad.issues.warnings.some((w) => w.includes('@nobody/base'))).toBe(true);
  });
});

describe('validateBaseImport', () => {
  it('flags duplicate variant key within an entity as error', () => {
    const rows: BaseSheetRow[] = [
      { character: 'hero', variant: 'base', description: 'v1', height: '', visual_design: '', art_language: '' },
      { character: 'hero', variant: 'base', description: 'v2', height: '', visual_design: '', art_language: '' },
    ];
    const entities = parseBaseEntities(rows, 'character', 'g');
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateBaseImport(entities, rows, 'Characters', 'character', new Map(), issues);
    expect(issues.errors.some((e) => e.includes('trùng'))).toBe(true);
  });

  it('warns when there is not exactly one base variant', () => {
    const rows: BaseSheetRow[] = [{ character: 'hero', variant: 'wounded', description: '', height: '', visual_design: '', art_language: '' }];
    const entities = parseBaseEntities(rows, 'character', 'g');
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateBaseImport(entities, rows, 'Characters', 'character', new Map(), issues);
    expect(issues.warnings.some((w) => w.includes('base'))).toBe(true);
  });
});

describe('validateEntityKeyUniqueness', () => {
  const e = (key: string, group: string): SketchEntity => ({ key, group, variants: [] });

  it('same key across two groups of a kind → one blocking error listing the key', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateEntityKeyUniqueness([e('miu', 'characters'), e('miu', 'alter_characters')], 'characters', issues);
    expect(issues.errors).toHaveLength(1);
    expect(issues.errors[0]).toContain('miu');
    expect(issues.warnings).toEqual([]);
  });

  it('collision is case-insensitive', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateEntityKeyUniqueness([e('Miu', 'a'), e('miu', 'b')], 'characters', issues);
    expect(issues.errors).toHaveLength(1);
  });

  it('no collision → no error', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateEntityKeyUniqueness([e('hero', 'a'), e('miu', 'b')], 'characters', issues);
    expect(issues.errors).toEqual([]);
  });
});

describe('describeImportReplacement (replace-confirm copy)', () => {
  const parse = (chars: number, props: number, groups: number): BaseImportParse => ({
    result: {
      characters: Array.from({ length: chars }, (_, i) => ({ key: `c${i}`, group: 'g', variants: [] })),
      props: Array.from({ length: props }, (_, i) => ({ key: `p${i}`, group: 'g', variants: [] })),
      sheetGroups: Array.from({ length: groups }, (_, i) => ({ group_key: `g${i}`, kind: 'characters' as const, name: `G${i}` })),
    },
    issues: { errors: [], warnings: [] },
    tabs: Array.from({ length: groups }, (_, i) => `G${i}`),
  });

  it('names the whole-replace, the delete-missing, and the sheet reset', () => {
    const copy = describeImportReplacement(parse(3, 2, 3));
    expect(copy).toContain('replaces all base entities');
    expect(copy).toContain('deletes groups missing from the file');
    expect(copy).toContain('resets base sheets (generated images + locked style)');
    expect(copy).toContain('3 characters');
    expect(copy).toContain('2 props');
    expect(copy).toContain('3 groups');
  });

  it('singularizes counts', () => {
    const copy = describeImportReplacement(parse(1, 1, 1));
    expect(copy).toContain('1 character and 1 prop');
    expect(copy).toContain('1 group');
  });
});
