// sketch-manuscript-fixture.ts — In-repo fixture mirroring the NEW template
// (`dummy.xlsx`, design 07-01 §8 / 04). Sheet matrices are plain JS arrays (the shape
// `sheet_to_json(header:1)` yields) so transforms test without binary/SheetJS.
//
// Storyboard: 3 SPREAD blocks × 8 mapped rows + the ignored `Choice` row — SPREAD 1 (DPS, left only), SPREAD 2
// (two-page, clean geo for assertions), SPREAD 3 (two-page WITH branch D/E data that must
// be dropped). Language tabs vi_VN + en_US carry per-language Lời văn + Textbox geometry.
// Entities: 7 characters / 6 props / 8 stages (stage keys cover art_direction.stage refs).

import { parseEntitySheet } from '../../parse-excel-workbook';
import { assembleSketchSnapshot } from '../../build-snapshot-from-parsed';
import type { ImportModalMeta } from '../../import-script-types';
import type { ImportedWorkbook } from '../../parse-excel-workbook';
import type { SheetMatrix, SketchImportWorkbook } from '../../sketch-spread-excel.types';

// 0=label, 1=B(TRÁI/left), 2=C(PHẢI/right), 3=D(nhánh-trái), 4=E(nhánh-phải).
export const AD_LABELS = [
  'Diễn biến', 'Stage', 'Camera', 'Composition', 'Setting', 'Character',
  'Light & tone', 'Art language',
] as const;

/** Branch-nav row — present in the REAL template, mapped to no field. Kept in the fixture
 *  so the "no warnings" assertion pins it as KNOWN: drop it from KNOWN_STORYBOARD_LABELS
 *  and every real import gains one `nhãn dòng lạ "Choice"` warning per spread. */
export const CHOICE_LABEL = 'Choice';

const STAGE_OF: Record<number, string> = { 1: '@house_night/base', 2: '@bedroom/base', 3: '@bedroom/base' };

function fill(label: string, n: number, sideTag: string): string {
  if (label === 'Stage') return STAGE_OF[n] ?? '@bedroom/base';
  return `${label} ${n} ${sideTag}`;
}

/** One Storyboard block: `SPREAD N …` header + 8 labeled rows + the ignored `Choice` row.
 *  `sides` = which columns carry content (1=left, 2=right, 3/4=branch D/E — included only
 *  to prove they're dropped). */
function sbBlock(n: number, opts: { dps?: boolean; branch?: boolean } = {}): SheetMatrix {
  const header = `SPREAD ${n}${opts.dps ? ' — TRANG ĐÔI' : ''}`;
  const rows: SheetMatrix = [[header, '', '', '', '']];
  for (const label of [...AD_LABELS, CHOICE_LABEL]) {
    const row: (string)[] = [label, '', '', '', ''];
    row[1] = fill(label, n, 'TRÁI');
    if (!opts.dps) row[2] = fill(label, n, 'PHẢI');
    if (opts.branch) {
      row[3] = fill(label, n, 'NHÁNH-TRÁI');
      row[4] = fill(label, n, 'NHÁNH-PHẢI');
    }
    rows.push(row);
  }
  return rows;
}

export const STORYBOARD_MATRIX: SheetMatrix = [
  ['', 'TRỤC CHÍNH — TRÁI (lẻ)', 'TRỤC CHÍNH — PHẢI (chẵn)', 'NHÁNH 1 — TRÁI', 'NHÁNH 1 — PHẢI'],
  ...sbBlock(1, { dps: true }),
  ...sbBlock(2),
  ...sbBlock(3, { branch: true }),
];

// ── Language tabs ───────────────────────────────────────────────────────────

// Per-language, per-spread, per-side geometry (matches dummy.xlsx SPREAD 2).
const VI_GEO: Record<number, { left: string; right?: string }> = {
  1: { left: 'x=4% y=12% w=16% h=76% font_size=22' },
  2: { left: 'x=80% y=10% w=16% h=78% font_size=22', right: 'x=2% y=10% w=16% h=78% font_size=22' },
  3: { left: 'x=2% y=10% w=16% h=78% font_size=22', right: 'x=80% y=10% w=16% h=78% font_size=22' },
};
const EN_GEO: Record<number, { left: string; right?: string }> = {
  1: { left: 'x=4% y=76% w=40% h=18% font_size=24' },
  2: { left: 'x=6% y=74% w=70% h=22% font_size=24', right: 'x=4% y=74% w=70% h=22% font_size=24' },
  3: { left: 'x=4% y=74% w=70% h=22% font_size=24', right: 'x=6% y=74% w=70% h=22% font_size=24' },
};

function langBlock(
  n: number,
  dps: boolean,
  loiLabel: string,
  langTag: string,
  geo: { left: string; right?: string },
): SheetMatrix {
  const header = `SPREAD ${n}${dps ? ' — TRANG ĐÔI' : ''}`;
  const loi: string[] = [loiLabel, `${langTag} ${n} TRÁI`, '', '', ''];
  const tb: string[] = ['Textbox', geo.left, '', '', ''];
  if (!dps) {
    loi[2] = `${langTag} ${n} PHẢI`;
    tb[2] = geo.right ?? '';
  }
  return [[header, '', '', '', ''], loi, tb];
}

export const VI_VN_MATRIX: SheetMatrix = [
  ['', 'TRỤC CHÍNH — TRÁI (lẻ)', 'TRỤC CHÍNH — PHẢI (chẵn)', '', ''],
  ...langBlock(1, true, 'Lời văn [luc-bat] PA1', 'VI', VI_GEO[1]),
  ...langBlock(2, false, 'Lời văn [luc-bat] PA1', 'VI', VI_GEO[2]),
  ...langBlock(3, false, 'Lời văn [luc-bat] PA1', 'VI', VI_GEO[3]),
];

export const EN_US_MATRIX: SheetMatrix = [
  ['', 'TRỤC CHÍNH — TRÁI (lẻ)', 'TRỤC CHÍNH — PHẢI (chẵn)', '', ''],
  ...langBlock(1, true, 'Lời văn [couplets·anapestic] PA1', 'EN', EN_GEO[1]),
  ...langBlock(2, false, 'Lời văn [couplets·anapestic] PA1', 'EN', EN_GEO[2]),
  ...langBlock(3, false, 'Lời văn [couplets·anapestic] PA1', 'EN', EN_GEO[3]),
];

// ── Entity sheets (read BY HEADER NAME — Stages has no `height`, so column indices shift) ──
// char/prop: id | ref | <entity> | variant | description | height | visual_design | art_language
// stage:     id | ref | stage    | variant | description |          visual_design | art_language

const entityHeader = (key: string): string[] => [
  'id',
  'ref',
  key,
  'variant',
  'description',
  ...(key === 'stage' ? [] : ['height']),
  'visual_design',
  'art_language',
];

function entityRow(key: string, variant: string, idx: number, isStage: boolean): string[] {
  return [
    `id-${idx}`,
    `@${key}/${variant}`,
    key,
    variant,
    `Mô tả ${key} ${variant}`,
    ...(isStage ? [] : ['110cm']),
    `Visual ${key} ${variant}`,
    `Art ${key} ${variant}`,
  ];
}

function buildEntitySheet(header: string[], spec: Array<[string, string[]]>): SheetMatrix {
  const rows: SheetMatrix = [header];
  const isStage = header[2] === 'stage';
  let i = 0;
  for (const [key, variants] of spec) for (const v of variants) rows.push(entityRow(key, v, i++, isStage));
  return rows;
}

// 7 characters (15 rows)
export const CHARACTERS_ROWS: SheetMatrix = buildEntitySheet(entityHeader('character'), [
  ['kid', ['base', 'hero']],
  ['daddy', ['base', 'fairy']],
  ['mommy', ['base', 'fairy', 'captive']],
  ['demon', ['base', 'god']],
  ['crane', ['base', 'animal']],
  ['granny', ['base', 'old']],
  ['fox', ['base', 'spirit']],
]);

// 6 props (7 rows)
export const PROPS_ROWS: SheetMatrix = buildEntitySheet(entityHeader('prop'), [
  ['armor', ['base', 'glow']],
  ['sword', ['base']],
  ['crystal', ['base']],
  ['lantern', ['base']],
  ['book', ['base']],
  ['bell', ['base']],
]);

// 8 stages (8 rows) — includes house_night + bedroom for art_direction.stage resolution.
export const STAGES_ROWS: SheetMatrix = buildEntitySheet(entityHeader('stage'), [
  ['house_night', ['base']],
  ['bedroom', ['base']],
  ['castle', ['base']],
  ['forest', ['base']],
  ['village', ['base']],
  ['river', ['base']],
  ['sky', ['base']],
  ['garden', ['base']],
]);

export const MODAL_META: ImportModalMeta = {
  title: 'Quỷ Màn Đêm',
  format_id: 'fmt-1',
  dimension: 1,
  target_audience: 1,
  artstyle_id: null,
  sketchstyle_id: null,
  original_language: 'vi_VN',
  project_id: 'proj-1',
  is_international: true,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a SketchImportWorkbook adapter from a name → matrix map (fake SheetJS). */
export function makeSketchWorkbook(sheets: Record<string, SheetMatrix>): SketchImportWorkbook {
  return {
    SheetNames: Object.keys(sheets),
    sheetMatrix: (name) => sheets[name] ?? null,
  };
}

/** The full fixture workbook as the sketch parser consumes it (all sheets present). */
export const FIXTURE_SHEETS: Record<string, SheetMatrix> = {
  Storyboard: STORYBOARD_MATRIX,
  vi_VN: VI_VN_MATRIX,
  en_US: EN_US_MATRIX,
};

/** Run the entity parse + wrap the sheets → the ImportedWorkbook the book import uses. */
export function buildFixtureWorkbook(): ImportedWorkbook {
  return {
    spreadsSource: makeSketchWorkbook(FIXTURE_SHEETS),
    characters: parseEntitySheet(CHARACTERS_ROWS, 'character').rows,
    props: parseEntitySheet(PROPS_ROWS, 'prop').rows,
    stages: parseEntitySheet(STAGES_ROWS, 'stage').rows,
    issues: { errors: [], warnings: [] },
  };
}

/** Assembled sketch snapshot from the fixture (default meta). */
export function buildFixtureSketchSnapshot() {
  return assembleSketchSnapshot(buildFixtureWorkbook(), MODAL_META);
}
