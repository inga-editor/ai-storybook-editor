import { describe, it, expect } from 'vitest';
import {
  parseWorkbook,
  parseBaseEntities,
  normalizeRow,
  validateBaseImport,
  normalizeSheetName,
  buildSheetNameIndex,
  validateCharacterKeyRoles,
  resolveImportCommit,
  describeImportReplacement,
  type BaseImportParse,
  type BaseSheetRow,
  type ImportIssues,
} from './parse-base-entities';
import type { SketchEntity } from '@/types/sketch';

// Import XLSX for building test fixtures
import * as XLSX from 'xlsx';

/** Header row shared by every character/prop/alter tab fixture. */
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
    const row = normalizeRow({ character: 'hero', number: 123 });
    expect(row.number).toBe('123');
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
    const entities = parseBaseEntities(rows, 'character');
    expect(entities.map((e) => e.key)).toEqual(['hero', 'villain', 'ghostly']);
    expect(entities[0].variants).toHaveLength(2);
    expect(entities[0].variants[0]).toMatchObject({ key: 'base', visual_design: 'mighty' });
    expect(entities[0].variants[1]).toMatchObject({ key: 'wounded', visual_design: 'hurt' });
  });

  it('maps 4 columns to their own variant fields (description ≠ visual_design)', () => {
    const entities = parseBaseEntities(rows, 'character');
    const heroBase = entities[0].variants[0];
    expect(heroBase.description).toBe('a warrior');
    expect(heroBase.height).toBe(110); // "1.1m" → cm number
    expect(heroBase.visual_design).toBe('mighty');
    expect(heroBase.art_language).toBe('epic');
  });

  it('height parses to a cm NUMBER — range takes the max', () => {
    const entities = parseBaseEntities(rows, 'character');
    expect(entities[1].variants[0].height).toBe(30); // villain "20-30cm" → max
  });

  it('height that is not measurable → null (variant still imported)', () => {
    const entities = parseBaseEntities(rows, 'character');
    const ghostly = entities[2];
    expect(ghostly.variants[0].height).toBeNull(); // "tall"
    expect(ghostly.variants).toHaveLength(1); // kept, not dropped
  });

  it('coerces missing text fields to empty string (height → null)', () => {
    const entities = parseBaseEntities(rows, 'character');
    const heroWounded = entities[0].variants[1];
    expect(heroWounded.description).toBe('');
    expect(heroWounded.height).toBeNull();
    expect(heroWounded.art_language).toBe('');
  });

  it('skips rows with empty key column', () => {
    const entities = parseBaseEntities(rows, 'character');
    expect(entities.length).toBe(3); // hero + villain + ghostly, keyless ghost row skipped
  });

  it('returns [] for empty rows', () => {
    expect(parseBaseEntities([], 'character')).toEqual([]);
  });
});

describe('parseWorkbook (integration with XLSX)', () => {
  function buildTestWorkbook(): ArrayBuffer {
    // Create a minimal 2-sheet workbook: Characters + Props
    // Headers must match COL constants exactly (will be lowercased by normalizeRow)
    const charRows = [
      ['Character', 'Variant', 'Description', 'Height', 'Visual_Design', 'Art_Language'],
      ['hero', 'base', 'a warrior', '1.1m', 'mighty', 'epic'],
      ['hero', 'wounded', '', '', 'hurt', ''],
      ['villain', 'base', '', '110cm', 'evil', 'dark'],
    ];
    const propRows = [
      ['Prop', 'Variant', 'Description', 'Height', 'Visual_Design', 'Art_Language'],
      ['sword', 'base', 'a blade', '', 'sharp', 'combat'],
      ['shield', 'base', '', '20-30cm', 'protective', 'defense'],
    ];

    const wsChar = XLSX.utils.aoa_to_sheet(charRows);
    const wsProp = XLSX.utils.aoa_to_sheet(propRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsChar, 'Characters');
    XLSX.utils.book_append_sheet(wb, wsProp, 'Props');

    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  }

  it('parses 2-sheet workbook → characters + props with 4 fields each', () => {
    const buffer = buildTestWorkbook();
    const parsed = parseWorkbook(buffer, XLSX);

    expect(parsed.result.characters).toHaveLength(2); // hero, villain
    expect(parsed.result.props).toHaveLength(2); // sword, shield

    const heroBase = parsed.result.characters[0].variants[0];
    expect(heroBase).toMatchObject({
      key: 'base',
      description: 'a warrior',
      height: 110, // "1.1m" → m ×100
      visual_design: 'mighty',
      art_language: 'epic',
    });

    const swordBase = parsed.result.props[0].variants[0];
    expect(swordBase).toMatchObject({
      key: 'base',
      description: 'a blade',
      height: null, // empty cell
      visual_design: 'sharp',
      art_language: 'combat',
    });

    expect(parsed.issues.errors).toHaveLength(0);
  });

  it('height column → cm number: "1.1m"→110, "110cm"→110, "20-30cm"→30 (max)', () => {
    const buffer = buildTestWorkbook();
    const parsed = parseWorkbook(buffer, XLSX);

    expect(parsed.result.characters[0].variants[0].height).toBe(110); // hero base "1.1m"
    expect(parsed.result.characters[1].variants[0].height).toBe(110); // villain base "110cm"
    expect(parsed.result.props[1].variants[0].height).toBe(30); // shield base "20-30cm"
  });

  it('empty cell → empty string (height → null, no warning)', () => {
    const buffer = buildTestWorkbook();
    const parsed = parseWorkbook(buffer, XLSX);

    const heroWounded = parsed.result.characters[0].variants[1];
    expect(heroWounded.description).toBe('');
    expect(heroWounded.height).toBeNull();
    expect(heroWounded.art_language).toBe('');
    expect(parsed.issues.warnings.some((w) => w.includes('height'))).toBe(false);
  });

  it('unparseable height → null + warning (variant still imported)', () => {
    const charRows = [
      ['Character', 'Variant', 'Description', 'Height', 'Visual_Design', 'Art_Language'],
      ['hero', 'base', 'a warrior', 'tall', 'mighty', 'epic'],
    ];
    const propRows = [['Prop', 'Variant', 'Description', 'Height', 'Visual_Design', 'Art_Language']];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(charRows), 'Characters');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(propRows), 'Props');
    const parsed = parseWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), XLSX);

    expect(parsed.result.characters[0].variants[0].height).toBeNull();
    expect(parsed.issues.errors).toHaveLength(0); // advisory only — import proceeds
    expect(parsed.issues.warnings.some((w) => w.includes('height "tall"'))).toBe(true);
  });

  it('missing Props sheet → error in issues', () => {
    // Build workbook with only Characters sheet
    const charRows = [
      ['Character', 'Variant', 'Description', 'Height', 'Visual_Design', 'Art_Language'],
      ['hero', 'base', 'a warrior', 'tall', 'mighty', 'epic'],
    ];
    const wsChar = XLSX.utils.aoa_to_sheet(charRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsChar, 'Characters');
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

    const parsed = parseWorkbook(buffer, XLSX);

    expect(parsed.issues.errors.length).toBeGreaterThan(0);
    expect((parsed.issues.errors as string[]).some((e) => e.includes('Props'))).toBe(true);
  });

  it('missing required column (Variant) → error', () => {
    // Build workbook missing the Variant column
    const charRows = [
      ['Character', 'Description', 'Height', 'Visual_Design'], // no Variant
      ['hero', 'a warrior', 'tall', 'mighty'],
    ];
    const propRows = [
      ['Prop', 'Description', 'Height', 'Visual_Design'],
      ['sword', 'a blade', '', 'sharp'],
    ];

    const wsChar = XLSX.utils.aoa_to_sheet(charRows);
    const wsProp = XLSX.utils.aoa_to_sheet(propRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsChar, 'Characters');
    XLSX.utils.book_append_sheet(wb, wsProp, 'Props');
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

    const parsed = parseWorkbook(buffer, XLSX);

    expect(parsed.issues.errors.length).toBeGreaterThan(0);
    expect((parsed.issues.errors as string[]).some((e) => e.includes('variant'))).toBe(true);
  });
});

describe('validateBaseImport', () => {
  it('flags duplicate variant key within an entity as error', () => {
    const rows: BaseSheetRow[] = [
      { character: 'hero', variant: 'base', description: 'v1', height: '', visual_design: '', art_language: '' },
      { character: 'hero', variant: 'base', description: 'v2', height: '', visual_design: '', art_language: '' },
    ];
    const entities = parseBaseEntities(rows, 'character');
    const issues: ImportIssues = { errors: [], warnings: [] };

    validateBaseImport(entities, rows, 'characters', 'character', new Map(), issues);

    expect((issues.errors as string[]).some((e) => e.includes('trùng'))).toBe(true);
  });

  it('warns when there is not exactly one base variant', () => {
    const rows: BaseSheetRow[] = [
      { character: 'hero', variant: 'wounded', description: '', height: '', visual_design: '', art_language: '' },
    ];
    const entities = parseBaseEntities(rows, 'character');
    const issues: ImportIssues = { errors: [], warnings: [] };

    validateBaseImport(entities, rows, 'characters', 'character', new Map(), issues);

    expect((issues.warnings as string[]).some((w) => w.includes('base'))).toBe(true);
  });

  it('warns on inline @ref that does not resolve', () => {
    const rows: BaseSheetRow[] = [
      { character: 'hero', variant: 'base', description: 'next to @unknown/base', height: '', visual_design: '', art_language: '' },
    ];
    const entities = parseBaseEntities(rows, 'character');
    const issues = { errors: [], warnings: [] };
    const knownKeys = new Map(); // empty = no known entities

    validateBaseImport(entities, rows, 'characters', 'character', knownKeys, issues);

    expect((issues.warnings as string[]).some((w) => w.includes('@unknown/base'))).toBe(true);
  });

  it('does NOT warn on inline @ref that resolves within the same kind', () => {
    const rows: BaseSheetRow[] = [
      { character: 'hero', variant: 'base', description: 'plain', height: '', visual_design: '', art_language: '' },
      { character: 'hero', variant: 'wounded', description: 'like @hero/base but hurt', height: '', visual_design: '', art_language: '' },
    ];
    const entities = parseBaseEntities(rows, 'character');
    const issues = { errors: [], warnings: [] };
    const knownKeys = new Map([['hero', entities[0]]]);

    validateBaseImport(entities, rows, 'characters', 'character', knownKeys, issues);

    expect((issues.warnings as string[]).some((w) => w.includes('@hero/base'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚡2026-07-28 Phase 08 — the OPTIONAL `Alter Characters` tab.
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeSheetName / buildSheetNameIndex', () => {
  it('trims + lowercases', () => {
    expect(normalizeSheetName('  Alter Characters ')).toBe('alter characters');
    expect(normalizeSheetName('ALTER CHARACTERS')).toBe('alter characters');
  });

  it('indexes tab names by normalized form, keeping the original for display', () => {
    const index = buildSheetNameIndex(['Book', ' Alter Characters ', 'Props']);
    expect(index.get('alter characters')).toBe(' Alter Characters ');
    expect(index.get('props')).toBe('Props');
    expect(index.get('characters')).toBeUndefined();
  });

  it('first tab wins when two names collide after normalize', () => {
    const index = buildSheetNameIndex(['Characters', 'characters ']);
    expect(index.get('characters')).toBe('Characters');
  });

  it('the losing tab is SURFACED as a user-visible warning, not just logged', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    buildSheetNameIndex(['Alter Characters', 'alter characters'], issues);
    expect(issues.warnings).toHaveLength(1);
    expect(issues.warnings[0]).toContain('alter characters'); // names the tab that was dropped
    expect(issues.errors).toEqual([]); // warning, not blocking — the first tab still imports
  });

  it('no collision → no warning', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    buildSheetNameIndex(['Characters', 'Props', 'Alter Characters'], issues);
    expect(issues.warnings).toEqual([]);
  });
});

describe('parseWorkbook — Alter Characters tab', () => {
  const charRows = [
    HEADER('Character'),
    ['hero', 'base', 'a warrior', '110cm', 'mighty', 'epic'],
    ['villain', 'base', '', '', 'evil', 'dark'],
  ];
  const propRows = [HEADER('Prop'), ['sword', 'base', 'a blade', '', 'sharp', 'combat']];
  const alterRows = [
    HEADER('Character'), // key column is `character`, NOT `alter_character`
    ['miu', 'base', 'a cat', '30cm', 'fluffy', 'soft'],
    ['miu', 'hero', '', '', 'caped', ''],
    ['kiki', 'base', '', '', 'small', ''],
  ];

  it('alter rows land in characters[] with actor_role 1, AFTER the story cast', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Alter Characters', alterRows], ['Props', propRows]]),
      XLSX,
    );

    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.result.characters.map((e) => e.key)).toEqual(['hero', 'villain', 'miu', 'kiki']);
    expect(parsed.result.characters.map((e) => e.actor_role)).toEqual([undefined, undefined, 1, 1]);
    // no third array is created
    expect(Object.keys(parsed.result).sort()).toEqual(['characters', 'props']);
    expect(parsed.result.props).toHaveLength(1);
  });

  it('does NOT stamp actor_role 0 on the primary tab (absent ⇒ 0)', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Props', propRows], ['Alter Characters', alterRows]]),
      XLSX,
    );
    expect('actor_role' in parsed.result.characters[0]).toBe(false);
  });

  it('reuses the same parser: alter variants get the same 4-column mapping', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Props', propRows], ['Alter Characters', alterRows]]),
      XLSX,
    );
    const miu = parsed.result.characters.find((e) => e.key === 'miu')!;
    expect(miu.variants).toHaveLength(2);
    expect(miu.variants[0]).toMatchObject({
      key: 'base',
      description: 'a cat',
      height: 30,
      visual_design: 'fluffy',
      art_language: 'soft',
    });
    expect(miu.variants[1]).toMatchObject({ key: 'hero', visual_design: 'caped' });
  });

  it.each(['alter characters', 'ALTER CHARACTERS', ' Alter Characters '])(
    'matches the tab name normalized: %s',
    (tabName) => {
      const parsed = parseWorkbook(
        workbookOf([['Characters', charRows], ['Props', propRows], [tabName, alterRows]]),
        XLSX,
      );
      expect(parsed.sheetsPresent.alter_characters).toBe(true);
      expect(parsed.result.characters.filter((e) => e.actor_role === 1)).toHaveLength(2);
    },
  );

  it('required tabs are matched normalized too (one rule for all three)', () => {
    const parsed = parseWorkbook(workbookOf([['characters', charRows], [' PROPS', propRows]]), XLSX);
    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.result.characters).toHaveLength(2);
    expect(parsed.result.props).toHaveLength(1);
  });

  it('absent alter tab → NO error, NO warning issue, result unchanged (regression)', () => {
    const parsed = parseWorkbook(workbookOf([['Characters', charRows], ['Props', propRows]]), XLSX);

    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.issues.warnings.some((w) => w.toLowerCase().includes('alter'))).toBe(false);
    expect(parsed.result.characters.map((e) => e.key)).toEqual(['hero', 'villain']);
    expect(parsed.result.characters.every((e) => e.actor_role === undefined)).toBe(true);
    expect(parsed.sheetsPresent).toEqual({ characters: true, props: true, alter_characters: false });
  });

  it('alter tab PRESENT but data-empty → an explicit empty alter cast (not "absent")', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Props', propRows], ['Alter Characters', [HEADER('Character')]]]),
      XLSX,
    );
    expect(parsed.issues.errors).toEqual([]);
    expect(parsed.sheetsPresent.alter_characters).toBe(true);
    expect(parsed.result.characters.filter((e) => e.actor_role === 1)).toHaveLength(0);
  });

  it('alter tab present but missing the variant column → blocking error (not silently skipped)', () => {
    const broken = [['Character', 'Description'], ['miu', 'a cat']];
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Props', propRows], ['Alter Characters', broken]]),
      XLSX,
    );
    expect(parsed.issues.errors.some((e) => e.includes('Alter Characters') && e.includes('thiếu cột bắt buộc'))).toBe(
      true,
    );
    // A MALFORMED tab must not read as "the workbook specified an empty alter cast" — that flag
    // drives a destructive replace, so it fails safe towards preserving the existing alters.
    expect(parsed.sheetsPresent.alter_characters).toBe(false);
  });

  it('a NEAR-MISS tab name (AlterCharacters, no space) is reported instead of silently skipped', () => {
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Props', propRows], ['AlterCharacters', alterRows]]),
      XLSX,
    );
    expect(parsed.issues.errors).toEqual([]); // still not blocking — the tab is optional
    expect(parsed.sheetsPresent.alter_characters).toBe(false);
    expect(parsed.issues.warnings.some((w) => w.includes('AlterCharacters') && w.includes('Alter Characters'))).toBe(
      true,
    );
  });

  it('no near-miss tab → absent alter tab stays completely quiet (the normal case)', () => {
    const parsed = parseWorkbook(workbookOf([['Characters', charRows], ['Props', propRows]]), XLSX);
    expect(parsed.issues.warnings.some((w) => w.includes('Alter Characters'))).toBe(false);
  });

  it('missing REQUIRED tab is still a blocking error', () => {
    const parsed = parseWorkbook(workbookOf([['Characters', charRows], ['Alter Characters', alterRows]]), XLSX);
    expect(parsed.issues.errors.some((e) => e.includes('Props'))).toBe(true);
  });

  it('a key used by BOTH tabs is a BLOCKING error, listing the key', () => {
    const collide = [HEADER('Character'), ['hero', 'base', '', '', 'shadow twin', '']];
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Props', propRows], ['Alter Characters', collide]]),
      XLSX,
    );
    expect(parsed.issues.errors.some((e) => e.includes('trùng giữa 2 tab') && e.includes('hero'))).toBe(true);
  });

  it('cross-tab @ref resolves against an alter entity (shared key namespace, no 2nd pass)', () => {
    const refRows = [HEADER('Character'), ['hero', 'base', 'travels with @miu/base', '', '', '']];
    const parsed = parseWorkbook(
      workbookOf([['Characters', refRows], ['Props', propRows], ['Alter Characters', alterRows]]),
      XLSX,
    );
    expect(parsed.issues.warnings.some((w) => w.includes('@miu/base'))).toBe(false);
    // and an unknown ref still warns, so the assertion above is not vacuous
    const bad = [HEADER('Character'), ['hero', 'base', 'travels with @nobody/base', '', '', '']];
    const parsed2 = parseWorkbook(
      workbookOf([['Characters', bad], ['Props', propRows], ['Alter Characters', alterRows]]),
      XLSX,
    );
    expect(parsed2.issues.warnings.some((w) => w.includes('@nobody/base'))).toBe(true);
  });

  it('alter entities are validated as their OWN group (missing base variant warns per entity)', () => {
    const noBase = [HEADER('Character'), ['miu', 'hero', '', '', '', '']];
    const parsed = parseWorkbook(
      workbookOf([['Characters', charRows], ['Props', propRows], ['Alter Characters', noBase]]),
      XLSX,
    );
    expect(parsed.issues.warnings.some((w) => w.includes('"miu"') && w.includes('base'))).toBe(true);
  });
});

describe('validateCharacterKeyRoles', () => {
  const entity = (key: string, actorRole?: 0 | 1): SketchEntity =>
    actorRole === undefined ? { key, variants: [] } : { key, actor_role: actorRole, variants: [] };

  it('same key under two roles → blocking error', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateCharacterKeyRoles([entity('miu'), entity('miu', 1)], issues);
    expect(issues.errors).toHaveLength(1);
    expect(issues.errors[0]).toContain('miu');
    expect(issues.warnings).toEqual([]); // error, never a warning
  });

  it('collision is case-insensitive (@ref resolution lowercases keys too)', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateCharacterKeyRoles([entity('Miu'), entity('miu', 1)], issues);
    expect(issues.errors).toHaveLength(1);
  });

  it('explicit actor_role 0 counts as the story cast', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateCharacterKeyRoles([entity('miu', 0), entity('miu', 1)], issues);
    expect(issues.errors).toHaveLength(1);
  });

  it('lists every colliding key once', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateCharacterKeyRoles([entity('miu'), entity('miu', 1), entity('kiki'), entity('kiki', 1)], issues);
    expect(issues.errors).toHaveLength(1);
    expect(issues.errors[0]).toContain('miu');
    expect(issues.errors[0]).toContain('kiki');
  });

  it('caps the listed keys so the actionable instruction survives in the toast', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    const many = Array.from({ length: 14 }, (_, i) => `k${i}`).flatMap((k) => [entity(k), entity(k, 1)]);
    validateCharacterKeyRoles(many, issues);
    expect(issues.errors[0]).toContain('và 4 key khác');
    expect(issues.errors[0]).toContain('Mỗi key phải là duy nhất'); // instruction not pushed off the end
    expect(issues.errors[0]).not.toContain('"k13"');
  });

  it('does NOT flag keys colliding under the SAME role (pre-existing, would reject files that import today)', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateCharacterKeyRoles([entity('Hero'), entity('hero')], issues);
    expect(issues.errors).toEqual([]);
  });

  it('no collision → no error', () => {
    const issues: ImportIssues = { errors: [], warnings: [] };
    validateCharacterKeyRoles([entity('hero'), entity('miu', 1)], issues);
    expect(issues.errors).toEqual([]);
  });
});

describe('resolveImportCommit (whole-replace vs preserve)', () => {
  const story = (key: string): SketchEntity => ({ key, variants: [] });
  const alter = (key: string): SketchEntity => ({ key, actor_role: 1, variants: [] });
  const parse = (characters: SketchEntity[], alterPresent: boolean): BaseImportParse => ({
    result: { characters, props: [] },
    issues: { errors: [], warnings: [] },
    sheetsPresent: { characters: true, props: true, alter_characters: alterPresent },
  });

  it('alter tab PRESENT → whole-replace (the workbook is authoritative, alters included)', () => {
    const out = resolveImportCommit(parse([story('hero'), alter('kiki')], true), [alter('miu')]);
    expect(out.characters.map((e) => e.key)).toEqual(['hero', 'kiki']); // existing `miu` intentionally gone
  });

  it('alter tab PRESENT but empty → clears the alter cast (explicit empty)', () => {
    const out = resolveImportCommit(parse([story('hero')], true), [alter('miu'), alter('kiki')]);
    expect(out.characters.map((e) => e.key)).toEqual(['hero']);
  });

  it('alter tab ABSENT → story cast replaced, existing alter cast PRESERVED', () => {
    const out = resolveImportCommit(parse([story('hero')], false), [story('old'), alter('miu'), alter('kiki')]);
    expect(out.characters.map((e) => e.key)).toEqual(['hero', 'miu', 'kiki']); // `old` story entity replaced
    expect(out.characters.map((e) => e.actor_role)).toEqual([undefined, 1, 1]);
  });

  it('alter tab ABSENT with nothing to preserve → the parsed story cast, unchanged', () => {
    const p = parse([story('hero')], false);
    expect(resolveImportCommit(p, [story('old')]).characters).toEqual(p.result.characters);
  });

  it('preserved alter whose key the import re-used as a story character is DROPPED (no ambiguity)', () => {
    const out = resolveImportCommit(parse([story('miu')], false), [alter('miu'), alter('kiki')]);
    expect(out.characters.map((e) => e.key)).toEqual(['miu', 'kiki']);
    expect(out.characters[0].actor_role).toBeUndefined(); // the imported story `miu` wins
    expect(out.characters.filter((e) => e.key === 'miu')).toHaveLength(1);
  });

  it('the drop is case-insensitive, matching the uniqueness check', () => {
    const out = resolveImportCommit(parse([story('MIU')], false), [alter('miu')]);
    expect(out.characters.map((e) => e.key)).toEqual(['MIU']);
  });

  it('props pass through untouched on both branches', () => {
    const withProps = (alterPresent: boolean): BaseImportParse => {
      const p = parse([story('hero')], alterPresent);
      p.result.props = [{ key: 'sword', variants: [] }];
      return p;
    };
    expect(resolveImportCommit(withProps(true), [alter('miu')]).props.map((e) => e.key)).toEqual(['sword']);
    expect(resolveImportCommit(withProps(false), [alter('miu')]).props.map((e) => e.key)).toEqual(['sword']);
  });

  it('never mutates the store array it was handed (frozen array AND frozen entities)', () => {
    const existing = Object.freeze([Object.freeze(alter('miu')), Object.freeze(story('old'))]) as SketchEntity[];
    const out = resolveImportCommit(parse([story('hero')], false), existing);
    expect(existing.map((e) => e.key)).toEqual(['miu', 'old']);
    expect(existing[0].actor_role).toBe(1);
    expect(out.characters).not.toBe(existing);
  });
});

describe('describeImportReplacement (replace-confirm copy)', () => {
  const story = (key: string): SketchEntity => ({ key, variants: [] });
  const alter = (key: string): SketchEntity => ({ key, actor_role: 1, variants: [] });
  const parse = (characters: SketchEntity[], alterPresent: boolean): BaseImportParse => ({
    result: { characters, props: [{ key: 'sword', variants: [] }] },
    issues: { errors: [], warnings: [] },
    sheetsPresent: { characters: true, props: true, alter_characters: alterPresent },
  });

  it('alter tab PRESENT → the copy states the alter cast is replaced too, with its own count', () => {
    const copy = describeImportReplacement(parse([story('hero'), alter('miu'), alter('kiki')], true));
    expect(copy).toContain('alter character');
    expect(copy).toContain('2 alter characters');
    expect(copy).toContain('1 character'); // story count EXCLUDES the alters
    expect(copy).not.toContain('are kept');
  });

  it('alter tab ABSENT → the copy promises the alter cast is KEPT, never destroyed', () => {
    const copy = describeImportReplacement(parse([story('hero'), story('villain')], false));
    expect(copy).toContain('kept');
    expect(copy).toContain('Alter Characters');
    expect(copy).toContain('2 characters');
  });

  it('the story count never silently includes alters (the old bug)', () => {
    const copy = describeImportReplacement(parse([story('hero'), alter('miu')], true));
    expect(copy).toContain('1 character and 1 prop');
  });
});
