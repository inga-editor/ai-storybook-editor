// Sketch snapshot types — new pipeline-step-1 data model (design commit 3847f27,
// snapshot/structure.md#sketch-structure). Restructures the legacy
// dummy/character_sheets/prop_sheets shape into { characters, props, stages, spreads }.
//
// SCOPE: types + an empty-default field + load-time guard only (no CRUD this phase).
// Creative spaces are still "coming soon"; full slice + UI deferred.
import type { Geometry, Typography } from './spread-types';
// Canonical illustration entry + style reference are REUSED from prop-types (single source);
// base sheets, crops and per-variant imagery all share the edit-image-modal Illustration shape.
import type { Illustration, IllustrationType, ImageReference } from './prop-types';

export type SketchEntityKind = 'characters' | 'props' | 'stages';
/** Base sheet workspace covers character + prop only (stage generates directly, no base sheet). */
export type BaseKind = 'characters' | 'props';
export type SketchPageType = 'left' | 'right' | 'full';

// ── Variant crop (positional — NO key; 2026-07-14) ───────────────────────────
// One cell cut from the currently-selected raw sheet. Element order = read order of cells 1..4
// (template_cell_boxes(4)). At most 1 is_selected across the 4 (the locked cell = official image).
export interface SketchVariantCrop {
  is_selected: boolean;                          // cell locked as the variant's official image — ≤1/4 true (0 = none yet)
  illustrations: Illustration[];                 // this cell's edit versions, canonical, edit-able; non-empty → exactly 1 is_selected
}

// char/prop variant: 4 text field + optional raw_sheet imagery (raw sheet + positional crops[]).
// (⚡ 2026-07-18: stages no longer use this shape — see SketchStageVariant below.)
export interface SketchVariant {
  key: string;                                   // variant key (base, hero); ref = @{entity.key}/{key}
  description: string;                           // ⚡ replaces the legacy visual_description (Excel "description")
  height?: number | null;                       // ⚡ cm (number, 2026-07-17) — char/prop only (Excel "height" parsed via parseHeightCm)
  visual_design: string;                        // Excel "visual_design"
  art_language: string;                         // Excel "art_language"
  // ⚡ 2026-07-14: the single `crop` field is GONE; crops[] now live INSIDE raw_sheet.
  raw_sheet?: {
    illustrations: Illustration[];               // raw 21:9 sheet versions (CUT SOURCE, not displayed). variant 'base': empty/absent (raw lives only in base workspace)
    crops: SketchVariantCrop[];                  // 4 positional cells cut from the selected sheet. variant 'base': 1 crop cloned from base.{kind}_sheet.styles[selected].crops[key], is_selected=true
  };
}

// key matches the top-level snapshot entity key. (per-entity media_url REMOVED — imagery lives on base + per-variant)
// char/prop only — stages carry their own SketchStage shape (2026-07-18 BREAKING rework).
export interface SketchEntity {
  key: string;
  variants: SketchVariant[];
}

// ── Stage (per-stage style workspace + 2-cell sheets — DB-CHANGELOG 2026-07-18, BREAKING) ────
// Each stage owns a PRIVATE style workspace (`base.styles[]` — no shared stage_sheet) plus flat
// per-variant imagery. Every sheet (base style attempt AND variant) is 21:9 with EXACTLY 2 cells
// = 2 different takes on the same stage → cut into 2 positional crops → the user locks 1 of 2.

/** One positional cell cut from a 2-cell stage sheet — same shape as the char/prop variant cell
 *  ({is_selected, illustrations}), just 2 cells per sheet instead of 4. */
export type SketchStageCrop = SketchVariantCrop;

/** One art-style attempt of a stage (stages[].base.styles[i]). */
export interface SketchStageStyle {
  style_prompt: string;
  is_selected: boolean;                          // locked style — ≤1 true per stage (radio after the first lock)
  image_references: ImageReference[];            // STYLE refs of this attempt (from the chosen art style)
  illustrations: Illustration[];                 // 2-cell sheet versions (canonical, edit-able); non-empty → exactly 1 is_selected
  crops: SketchStageCrop[];                      // 2 positional cells cut from the selected sheet; ≤1 is_selected
}

export interface SketchStageVariant {
  key: string;                                   // 'base' | non-base (e.g. 'storm')
  description: string;                           // Excel seed — NOT editable in the stage space
  visual_design: string;                         // drives generate (API 11 base / 12 variant)
  art_language: string;                          // drives generate — ⚡ stage has NO height
  illustrations: Illustration[];                 // 2-cell sheet versions anchored on the locked base (non-base); base: [] (raw lives only in base.styles)
  crops: SketchStageCrop[];                      // 2 positional (non-base); base: 1 clone crop is_selected (uniform read-path)
}

export interface SketchStage {
  key: string;                                   // sketch.stages[].key (e.g. 'house_night')
  base: { styles: SketchStageStyle[] };          // per-stage style workspace
  variants: SketchStageVariant[];
}

/** Selection target inside the stage space — a base style attempt OR a non-base variant. */
export type StageSelection =
  | { stageKey: string; target: 'base'; styleIndex: number }
  | { stageKey: string; target: 'variant'; variantKey: string }; // variantKey ≠ 'base'

/** Lightweight reference to a non-base variant (variantKey ≠ 'base'). Lets the variant creative
 *  space enumerate variants across a kind without holding whole entity refs (reused by phase-05). */
export interface VariantRef {
  kind: BaseKind;
  entityKey: string;
  variantKey: string;
}

/** Flat projection of ONE variant (base INCLUDED) for the Lineup space — the locked crop image +
 *  its real-world height, i.e. everything needed to place it on the shared ruler. Lives here (next
 *  to VariantRef) because BOTH the store selector (`useSketchLineupEntries`) and the space consume
 *  it — a feature-owned type would invert the store → feature dependency. */
export interface LineupEntry {
  kind: BaseKind;
  entityKey: string;
  variantKey: string; // 'base' INCLUDED (unlike VariantRef consumers)
  /** "{kind}:@{entityKey}/{variantKey}" — unique id (key of checkedRefs). The kind prefix is
   *  REQUIRED: entity keys are only unique WITHIN a kind, so character `armor/base` and prop
   *  `armor/base` must not collide (2026-07-25 — multi-tab persist). */
  ref: string;
  imageUrl: string | null; // effective locked crop; null = no crop locked yet
  heightCm: number | null; // variants[].height (cm); null = not set yet
}

// ── Lineup tabs (PERSISTED — sketch.lineups[], rtype 12 collab node, 2026-07-25) ─────────────
// Multi-tab lineup config: each tab is a named selection of variants across BOTH kinds.
// snake_case = snapshot JSONB contract (snapshot/structure.md §sketch lineups[]).

/** One checked variant inside a tab. Kind prefix disambiguates entity keys across kinds. */
export interface SketchLineupEntry {
  kind: BaseKind;
  entity_key: string;
  variant_key: string; // 'base' INCLUDED
}

export interface SketchLineupTab {
  id: string; // UUID — the tab's real identity; rename NEVER changes it
  name: string; // 1..60 chars, NOT unique across tabs
  /** Membership only, persisted in APPEND order — carries NO display semantics: the canvas
   *  renders checked entries in SIDEBAR order (Validation S1 2026-07-25, diverges from design
   *  commit 0635ee5's check-order). Dangling entries (entity/variant deleted elsewhere) are
   *  KEPT here and skipped at render (manual cleanup via the "Dọn" chip). */
  entries: SketchLineupEntry[];
}

// ── Base workspace (generate raw sheets in bulk + crop per entity) ────────────
export interface SketchBaseCrop {
  key: string;                                   // entity key — exactly 1 crop / base entity
  illustrations: Illustration[];                 // crop versions, canonical, edit-able
}

export interface SketchBaseStyle {
  style_prompt: string;                          // style description for this generate attempt
  is_selected: boolean;                          // locked style — across non-empty styles at most 1 true/sheet
  image_references: ImageReference[];            // style reference images
  illustrations: Illustration[];                 // RAW sheet versions (1 sheet = ALL base entities), canonical, edit-able
  crops: SketchBaseCrop[];                       // per-entity crops lifted out of the raw sheet
}

export interface SketchBaseSheet {
  styles: SketchBaseStyle[];                     // each element = one art-style attempt (parallel, pick one to lock)
}

export interface SketchBase {
  character_sheet: SketchBaseSheet;              // all base characters
  prop_sheet: SketchBaseSheet;                   // all base props — no stage_sheet
}

/** Projection of the 'base' variant text (EditBaseEntityModal + crop labels). */
export interface BaseEntityText {
  key: string;
  description: string;                           // import-only
  height: number | null;                        // ⚡ cm (number, 2026-07-17) — import-only (char/prop); null = chưa có / parse fail
  visual_design: string;                        // editable
  art_language: string;                         // editable
}

/** Sheet accessor for a base kind (single source — reused by slice + selectors). */
export function sheetOf(base: SketchBase, kind: BaseKind): SketchBaseSheet {
  return kind === 'characters' ? base.character_sheet : base.prop_sheet;
}

/** 7 fields, 1-1 with the real Storyboard template rows (2026-07-20). `action` merges the
 *  `Diễn biến` + `Character` rows; `light_tone` = `Light & tone`, `art_language` = `Art
 *  language`. Old keys (light_color/art_concept/space_time/animation/sound/layers/
 *  interactive_intent/negative_space) are gone — stale values in existing snapshots are
 *  ignored (no migration, no read-time fallback). */
export interface ArtDirection {
  stage: string;
  setting: string;
  composition: string;
  action: string;
  camera: string;
  light_tone: string;
  art_language: string;
}

export interface SketchPage {
  type: SketchPageType;
  art_direction: ArtDirection;
}

// Per-language textbox content (the value stored under each language-code key).
export interface SketchTextboxContent {
  text: string;
  geometry: Geometry;
  typography: Typography;
}

// Per-language textbox content keyed by language code; `id` is the only literal string key.
// The union with `string` is what the `id` slot occupies — narrow with the guards below
// before treating an indexed value as content (validation decision: cast-in-place, no refactor).
export interface SketchTextbox {
  id: string;
  [languageKey: string]: SketchTextboxContent | string;
}

// Guard: an indexed SketchTextbox value is language content (object) vs the literal `id` (string).
export function isSketchTextboxContent(
  value: SketchTextboxContent | string | undefined,
): value is SketchTextboxContent {
  return typeof value === 'object' && value !== null;
}

// Accessor: the content entry for a language, or undefined (absent / the `id` slot).
export function getSketchTextboxContent(
  textbox: SketchTextbox,
  languageKey: string,
): SketchTextboxContent | undefined {
  const value = textbox[languageKey];
  return isSketchTextboxContent(value) ? value : undefined;
}

// Versioned PER-PAGE sketch image (mirrors the illustration `illustrations[]` model).
// A spread holds 1..2 images — one per page, keyed by the unique `type`: either a single
// 'full' backdrop, or a 'left' + 'right' pair. Each image accumulates generate versions,
// newest prepended, exactly one `is_selected`. Empty (`images: []`) until first generate.
export interface SketchSpreadIllustration {
  media_url: string;
  created_time: string; // ISO-8601
  is_selected: boolean;
  /** ⚡ Provenance discriminator — DB already stores sketch `illustrations[]` as the FULL
   *  Illustration Entry (DB-CHANGELOG 2026-07-23), so the FE type must not be narrower.
   *  Absent = legacy / raw generate output (`coerceIllustrationType` reads it as 'created'). */
  type?: IllustrationType;
  /** Pre-edit source URL — set ⇔ type='edited'. Feeds the Compare toggle + the §8.3
   *  reverse-lookup chain (edit-image-modal `resolveAiRequestId`). Provenance-only. */
  original_url?: string;
  /** Provenance soft ref → ai_service_logs.id (cost attribution). Set for AI-generated pages;
   *  absent = NULL (legacy/uploaded). Dangling-tolerant (id may precede the log row insert). */
  ai_request_id?: string;
}

export interface SketchSpreadImage {
  id: string; // UUID — stable key for ID-based reads
  type: SketchPageType; // page this image backs; UNIQUE within images[] (identity key)
  illustrations: SketchSpreadIllustration[]; // prepend-versioned; non-empty → exactly one is_selected
}

export interface SketchSpread {
  id: string;
  images: SketchSpreadImage[]; // 1..2 per-page images keyed by `type`; [] until generated
  pages: SketchPage[];
  textboxes: SketchTextbox[];
}

/**
 * Synthesized per-page placement (canvas %). Page images carry no stored geometry — the
 * dedicated SketchSpreadCanvas derives each one from its `type`: 'full' spans the sheet;
 * 'left'/'right' split at the 50% spine. Exported here (single source) so the slice and the
 * canvas stay DRY.
 */
export const SKETCH_PAGE_GEOMETRY: Record<SketchPageType, Geometry> = {
  full: { x: 0, y: 0, w: 100, h: 100 },
  left: { x: 0, y: 0, w: 50, h: 100 },
  right: { x: 50, y: 0, w: 50, h: 100 },
};

/**
 * Effective url for a SINGLE page of a spread, resolved by page `type`
 * (selected version → newest → null). null when that page has no image yet.
 * Used by the dedicated SketchSpreadCanvas to place each per-page backdrop.
 */
export function getSketchSpreadPageImageUrl(
  spread: SketchSpread,
  pageType: SketchPageType,
): string | null {
  const illustrations = spread.images.find((im) => im.type === pageType)?.illustrations ?? [];
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? null;
}

/**
 * Thumbnail URL for a sketch spread: the effective url of the FIRST page image (doc order),
 * else null. Used by the sidebar thumbnail (one representative page per spread).
 */
export function getSketchSpreadEffectiveUrl(spread: SketchSpread): string | null {
  const illustrations = spread.images[0]?.illustrations ?? [];
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? null;
}

// ── Stage effective read-path (pure — single source for slice, job slice, UI gates) ──────────

/** Selected version's url → newest (index 0) → null. The canonical illustrations[] read-path. */
export function effectiveIllustrationUrl(illustrations: Illustration[]): string | null {
  return (
    illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? null
  );
}

/** Locked cell's effective url out of a 2-cell crops[] — null when no cell is locked yet. */
export function effectiveStageCropUrl(crops: SketchStageCrop[]): string | null {
  const crop = crops.find((c) => c.is_selected);
  return crop ? effectiveIllustrationUrl(crop.illustrations) : null;
}

/**
 * Effective LOCKED base image of a stage: `styles[].find(is_selected)` → its locked crop → that
 * crop's effective illustration. ANY broken link → null = base not locked yet (BLOCKS variant
 * generate — mirror API 12 BASE_NOT_READY).
 */
export function effectiveStageBaseUrl(stage: SketchStage): string | null {
  const style = stage.base.styles.find((s) => s.is_selected);
  if (!style) return null;
  return effectiveStageCropUrl(style.crops);
}

/** Effective official image of a stage variant (base INCLUDED — its single clone crop travels
 *  the same path). null = no cell locked yet. */
export function effectiveStageVariantUrl(variant: SketchStageVariant): string | null {
  return effectiveStageCropUrl(variant.crops);
}

export interface Sketch {
  id: string | null;
  base: SketchBase;                             // ⚡ NEW — base sheet workspace (char + prop)
  characters: SketchEntity[];
  props: SketchEntity[];
  stages: SketchStage[];                        // ⚡ 2026-07-18 — per-stage style workspace + 2-cell variant sheets
  spreads: SketchSpread[];
  lineups: SketchLineupTab[];                   // ⚡ 2026-07-25 — lineup tabs (rtype 12 collab node); [] until first save
}
