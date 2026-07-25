// build-snapshot-from-parsed.ts — Intermediate parse model → typed SKETCH snapshot
// (design 07-01 §3/§4). Pure & strongly typed; no DB. Builds the full top-level entity
// catalog (characters/props/stages) + a sketch projection of it, and delegates spread
// building to the SHARED new-template parser (`sketch-spread-excel.ts`).
//
// Illustration raw layers / Flow ordering / branch_setting / sections / script docs were
// removed — sketch carries none of those.

import { newUuid } from '@/utils/uuid';
import { createLogger } from '@/utils/logger';
import { parseHeightCm } from '@/utils/parse-height-cm';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { Stage } from '@/types/stage-types';
import type { Sketch, SketchEntity, SketchStage } from '@/types/sketch';
import type { ParsedEntityRow, ImportModalMeta } from './import-script-types';
import type { ImportedWorkbook } from './parse-excel-workbook';
import { buildSketchSpreadsFromWorkbook } from './sketch-spread-excel';
import type { ImportIssues, SketchImportBook } from './sketch-spread-excel.types';

const log = createLogger('Books', 'BuildSnapshot');

/** book.step for an imported sketch book (design 07-01 §7; was 2 = illustration). */
export const BOOK_STEP_SKETCH = 1;

/** Final assembled sketch snapshot payload (subset written by createImportedBook). */
export interface ImportedSketchSnapshot {
  sketch: Sketch;
  characters: Character[];
  props: Prop[];
  stages: Stage[];
}

// ── String helpers ────────────────────────────────────────────────────────────

/** 'house_night' → 'House Night'. */
export function titlecase(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Entity mappers ────────────────────────────────────────────────────────────

const emptyAppearance = () => ({ height: 0, hair: '', eyes: '', face: '', build: '' });
const emptyBasicInfo = () => ({ description: '', gender: '', age: '', category_id: '', role: '' });
const emptyPersonality = () => ({
  core_essence: '',
  flaws: '',
  emotions: '',
  reactions: '',
  desires: '',
  likes: '',
  fears: '',
  contradictions: '',
});
const emptyTemporal = () => ({ era: '', season: '', weather: '', time_of_day: '' });
const emptySensory = () => ({ atmosphere: '', soundscape: '', lighting: '', color_palette: '' });
const emptyEmotional = () => ({ mood: '' });

const variantType = (variantKey: string): 0 | 1 => (variantKey === 'base' ? 0 : 1);

/** Excel "height" text → cm NUMBER (shared `parseHeightCm` — same helper the per-space
 *  re-import uses, so both paths land on the exact same value). A non-empty cell that yields
 *  nothing measurable only drops the height (the variant is still imported).
 *
 *  PURE (no logging): every row passes through here TWICE — once for the catalog
 *  (`buildCharacters`) and once for the sketch projection (`projectSketchEntities`) — so the
 *  unparseable-cell report is raised exactly once per row by `collectHeightWarnings` instead. */
function heightCm(row: ParsedEntityRow): number | null {
  return parseHeightCm(row.height);
}

/**
 * ONE warning per row whose `height` cell has content but nothing measurable — the height is
 * dropped and the variant still imports. Mirrors the base-space importer's validate pass
 * (`parse-base-entities.ts::validateBaseImport`) so the user learns the value was lost instead of
 * only seeing it in the console. Char/prop only (the Stages sheet has no `height`).
 */
function collectHeightWarnings(rows: ParsedEntityRow[], issues: ImportIssues): void {
  for (const row of rows) {
    if (!row.height || parseHeightCm(row.height) !== null) continue;
    log.warn('collectHeightWarnings', 'height cell unparseable → dropped', {
      entityType: row.entity_type,
      key: row.key,
      variantKey: row.variant_key,
    });
    issues.warnings.push(
      `Dòng "${row.key}" (${row.entity_type}) variant "${row.variant_key}": height "${row.height}" không parse được → bỏ trống.`,
    );
  }
}

/** Group rows by entity key, preserving first-appearance order. */
function groupByKey(rows: ParsedEntityRow[]): Map<string, ParsedEntityRow[]> {
  const groups = new Map<string, ParsedEntityRow[]>();
  for (const row of rows) {
    if (!groups.has(row.key)) groups.set(row.key, []);
    groups.get(row.key)!.push(row);
  }
  return groups;
}

export function buildCharacters(rows: ParsedEntityRow[]): Character[] {
  return Array.from(groupByKey(rows).entries()).map(([key, group], order) => ({
    order,
    name: titlecase(key),
    key,
    basic_info: emptyBasicInfo(),
    personality: emptyPersonality(),
    variants: group.map((row) => ({
      name: titlecase(row.variant_key),
      key: row.variant_key,
      type: variantType(row.variant_key),
      // Catalog appearance carries the imported height in cm. NOTE the deliberate encoding split
      // for an unknown/unparseable height: the catalog uses 0 (`Character.appearance.height` is a
      // non-nullable number — 0 is the schema default the entity spaces already treat as "not
      // set"), while the sketch projection below uses null (`SketchEntityVariant.height` is
      // `number | null`, and the sketch ruler distinguishes "no height yet" from a real 0).
      // Unifying would mean widening the catalog type, which the character-space appearance
      // form/consumers read as a plain number — out of scope here.
      appearance: { ...emptyAppearance(), height: heightCm(row) ?? 0 },
      visual_description: row.description,
      illustrations: [],
      image_references: [],
    })),
    voice_setting: null,
  }));
}

export function buildProps(rows: ParsedEntityRow[]): Prop[] {
  return Array.from(groupByKey(rows).entries()).map(([key, group], order) => ({
    order,
    name: titlecase(key),
    key,
    category_id: '',
    type: 'narrative' as const,
    variants: group.map((row) => ({
      name: titlecase(row.variant_key),
      key: row.variant_key,
      type: variantType(row.variant_key),
      visual_description: row.description,
      illustrations: [],
      image_references: [],
    })),
    sounds: [],
  }));
}

export function buildStages(rows: ParsedEntityRow[]): Stage[] {
  return Array.from(groupByKey(rows).entries()).map(([key, group], order) => ({
    order,
    name: titlecase(key),
    key,
    location_id: '',
    variants: group.map((row) => ({
      name: titlecase(row.variant_key),
      key: row.variant_key,
      type: variantType(row.variant_key),
      visual_description: row.description,
      temporal: emptyTemporal(),
      sensory: emptySensory(),
      emotional: emptyEmotional(),
      illustrations: [],
      image_references: [],
    })),
    sounds: [],
  }));
}

// ── Sketch entity projection ────────────────────────────────────────────────────

/** Entity rows → thin sketch projection (design 07-01 §4.3): key + variant text fields
 *  (imagery lives on the base workspace + per-variant, empty until first generate).
 *  ⚡ 2026-07-20: projected straight from the PARSED ROWS, not from the full catalog — each
 *  Excel column maps to its own variant field (`description` is NOT reused as `visual_design`,
 *  `art_language` is a real column) and the catalog type has no slot for `art_language`. */
export function projectSketchEntities(rows: ParsedEntityRow[]): SketchEntity[] {
  return Array.from(groupByKey(rows).entries()).map(([key, group]) => ({
    key,
    variants: group.map((row) => ({
      key: row.variant_key,
      description: row.description,
      height: heightCm(row),
      visual_design: row.visual_design,
      art_language: row.art_language,
    })),
  }));
}

/** Stage projection — 2026-07-18 stage model: per-stage style workspace (`base.styles: []`) +
 *  flat 2-cell variant imagery (empty until first generate). Text mapping mirrors
 *  projectSketchEntities; stages carry NO height (the Stages sheet has no such column). */
export function projectSketchStages(rows: ParsedEntityRow[]): SketchStage[] {
  return Array.from(groupByKey(rows).entries()).map(([key, group]) => ({
    key,
    base: { styles: [] },
    variants: group.map((row) => ({
      key: row.variant_key,
      description: row.description,
      visual_design: row.visual_design,
      art_language: row.art_language,
      illustrations: [],
      crops: [],
    })),
  }));
}

// ── Assemble ──────────────────────────────────────────────────────────────────

/**
 * Compose the sketch snapshot: shared spread parser (spreads) + full entity catalog +
 * sketch projection. Book import carries no per-language typography (modal collects none)
 * → the shared parser falls back to defaults for textbox color/font. Returns the snapshot
 * plus the spread-parse issues (surfaced by validation before any write).
 */
export function assembleSketchSnapshot(
  parsed: ImportedWorkbook,
  meta: ImportModalMeta,
): { snapshot: ImportedSketchSnapshot; issues: ImportIssues } {
  const book: SketchImportBook = { original_language: meta.original_language, typography: null };
  const { spreads, issues } = buildSketchSpreadsFromWorkbook(parsed.spreadsSource, book);

  // Entity-sheet advisories (missing sheet / missing columns) join the SAME issues channel the
  // spread parser fills → validation → the modal warning block (no second channel).
  issues.errors.push(...parsed.issues.errors);
  issues.warnings.push(...parsed.issues.warnings);

  // Height advisories — raised ONCE per row here (the builders below parse the same cell twice).
  collectHeightWarnings(parsed.characters, issues);
  collectHeightWarnings(parsed.props, issues);

  const characters = buildCharacters(parsed.characters);
  const props = buildProps(parsed.props);
  const stages = buildStages(parsed.stages);

  const sketch: Sketch = {
    id: newUuid(),
    base: { character_sheet: { styles: [] }, prop_sheet: { styles: [] } },
    characters: projectSketchEntities(parsed.characters),
    props: projectSketchEntities(parsed.props),
    stages: projectSketchStages(parsed.stages),
    spreads,
    lineups: [], // no tabs at import — the Lineup space materializes on first save
  };

  log.info('assembleSketchSnapshot', 'done', {
    spreadCount: spreads.length,
    characterCount: characters.length,
    propCount: props.length,
    stageCount: stages.length,
    warningCount: issues.warnings.length,
    errorCount: issues.errors.length,
  });

  return { snapshot: { sketch, characters, props, stages }, issues };
}
