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

/**
 * ⚡REV 2026-08-21 — the kind of ONE base sheet group: `characters` | `props` (stage generates
 * directly, no base sheet). Replaces the old 3-value `BaseKind` enum (`alter_characters` is gone —
 * every character is a plain character group now). `SheetKind` is self-describing on each base
 * node (`base[group].kind`) so readers never guess a kind from the key. `BaseEntityCollection`
 * kept as an alias for the many existing import sites.
 */
export type SheetKind = 'characters' | 'props';
export type BaseEntityCollection = SheetKind;

/**
 * ⚡REV 2026-08-21 — SSOT descriptor for one base sheet group. Every space (base / variants /
 * lineup) + the base-generate job slice import THIS, never redefine it.
 *   - `group_key`: normalized Excel-tab key (see `normalizeGroupKey`); addresses `base[group_key]`.
 *   - `kind`: whether the group holds characters or props.
 *   - `name`: the original tab display name.
 */
export interface BaseGroup {
  group_key: string;
  kind: SheetKind;
  name: string;
  /** Excel tab position (0-based). Absent for legacy nodes / entity-only groups → sorted last. */
  order?: number;
}

export type SketchPageType = 'left' | 'right' | 'full';

/**
 * Normalize an Excel tab name → a `sketch.base` group key: trim → lowercase → every run of
 * non-alphanumerics → `_` → strip leading/trailing `_`.
 *   "Character 1"      → "character_1"
 *   "Alter Characters" → "alter_characters"
 *   "Props 2"          → "props_2"
 * (Two tabs that normalize to the same key are an import conflict — rejected upstream.)
 */
export function normalizeGroupKey(tabName: string): string {
  return tabName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Derive a group's `SheetKind` from its key when a base node carries no self-describing `kind`
 * (legacy books, or an entity group with no base sheet yet). Mirrors the BE plan: a key mentioning
 * "prop" is a prop group, everything else is a character group (`character_sheet`,
 * `alter_character_sheet`, and any new character group all resolve to `characters`).
 */
export function deriveSheetKindFromKey(key: string): SheetKind {
  return key.includes('prop') ? 'props' : 'characters';
}

/**
 * The group an entity belongs to. ⚡REV 2026-08-21 — `entity.group` is authoritative; when absent
 * (pre-group book, NO migration) it is derived (structure.md §Legacy tolerance):
 *   - prop           → `prop_sheet`
 *   - character      → `alter_character_sheet` when the legacy `actor_role === 1`, else `character_sheet`
 * ⚠️ This is the ONLY place `actor_role` is read anywhere in the store.
 */
export function resolveEntityGroup(
  entity: { group?: string; actor_role?: 0 | 1 },
  kind: SheetKind,
): string {
  if (entity.group) return entity.group;
  if (kind === 'characters') {
    return entity.actor_role === 1 ? 'alter_character_sheet' : 'character_sheet';
  }
  return 'prop_sheet';
}

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
  /** ⚡REV 2026-08-21 — normalized group key → `base[group]` (char/prop; stages have none). Set at
   *  import from the tab name. Absent (pre-group book) → `resolveEntityGroup` fallback derives it. */
  group?: string;
  /** ⚠️ LEGACY — pre-group alter flag. Read ONLY by `resolveEntityGroup` when `group` is absent;
   *  never written. @deprecated */
  actor_role?: 0 | 1;
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
  /** ⚡REV 2026-08-21 — the entity's base group (`base[group]`). */
  group: string;
  kind: SheetKind;
  entityKey: string;
  variantKey: string;
}

/** Flat projection of ONE variant (base INCLUDED) for the Lineup space — the locked crop image +
 *  its real-world height, i.e. everything needed to place it on the shared ruler. Lives here (next
 *  to VariantRef) because BOTH the store selector (`useSketchLineupEntries`) and the space consume
 *  it — a feature-owned type would invert the store → feature dependency. */
export interface LineupEntry {
  kind: SheetKind;
  entityKey: string;
  variantKey: string; // 'base' INCLUDED (unlike VariantRef consumers)
  /** "{persistKind}:@{entityKey}/{variantKey}" — unique id (key of checkedRefs). The prefix is
   *  REQUIRED: entity keys are only unique WITHIN a collection, so character `armor/base` and prop
   *  `armor/base` must not collide (2026-07-25 — multi-tab persist).
   *
   *  ⚡2026-07-28: the prefix is the PERSIST kind, not `kind` — an alter row mints
   *  `characters:@…` so a view row and its persisted entry always resolve to the SAME string.
   *  ALWAYS mint it with {@link lineupEntryRef}; never interpolate `kind` by hand. */
  ref: string;
  imageUrl: string | null; // effective locked crop; null = no crop locked yet
  heightCm: number | null; // variants[].height (cm); null = not set yet
}

// ── Lineup tabs (PERSISTED — sketch.lineups[], rtype 12 collab node, 2026-07-25) ─────────────
// Multi-tab lineup config: each tab is a named selection of variants across BOTH kinds.
// snake_case = snapshot JSONB contract (snapshot/structure.md §sketch lineups[]).

/** One checked variant inside a tab. Kind prefix disambiguates entity keys across kinds. */
export interface SketchLineupEntry {
  /** ⚡ The PERSIST vocabulary is the 2 real collections (NOT `BaseKind`): an alter is stored as
   *  `characters` and re-split by `actor_role` at read time. Mint with `lineupPersistKind`. */
  kind: BaseEntityCollection;
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
  /** ⚡REV 2026-08-21 — self-describing group kind (authz gate rtype 11). Optional AT REST: legacy
   *  nodes have none (derived via `deriveSheetKindFromKey` on read); the write paths fill it. */
  kind?: SheetKind;
  /** ⚡REV 2026-08-21 — the Excel tab display name. Optional at rest (legacy → shown from the key);
   *  filled on write. */
  name?: string;
  /** Excel tab position (0-based) — the sidebar's stable sort key. Object key insertion order is
   *  LOST across the jsonb persist round-trip (Postgres re-sorts keys by length/bytewise), so the
   *  display order MUST ride an explicit scalar. Optional at rest (legacy nodes → sorted last). */
  order?: number;
  styles: SketchBaseStyle[];                     // each element = one art-style attempt (parallel, pick one to lock)
}

/**
 * ⚡REV 2026-08-21 — base workspace = a DYNAMIC map keyed by group key (one sheet node per
 * character/prop group). Legacy keys `character_sheet` / `prop_sheet` / `alter_character_sheet` are
 * valid group keys under the new scheme (no migration). NEVER whitelist the keys — every key is a
 * valid group (the normalize whitelist footgun, ADR-047 class bug).
 */
export type SketchBase = Record<string, SketchBaseSheet>;

// ── Lineup wire vocabulary (UI knows 3 kinds · the snapshot stores 2) ─────────────────────────
// The rtype-12 `sketch.lineups[].entries[].kind` vocabulary is the two REAL collections
// (`LINEUP_ENTRY_KINDS`, sketch-coerce-helpers) — anything else is coerced away on load, i.e.
// writing `alter_characters` there is SILENT DATA LOSS. The two helpers below are the ONE seam
// where a UI `BaseKind` is narrowed to that vocabulary; both the selector that mints view rows
// and `toTabEntry`/`refOf` (lineup-constants) go through them, so the two can never drift.

/** ⚡REV 2026-08-21 — the lineup persist vocabulary is now exactly `SheetKind` (identity). Kept for
 *  the existing import sites. @deprecated pass a `SheetKind` straight to `lineupEntryRef`. */
export function lineupPersistKind(kind: SheetKind): BaseEntityCollection {
  return kind;
}

/** Canonical lineup ref (identity of a row AND of its persisted entry). Entity keys are unique
 *  within a collection, so the `SheetKind` prefix keeps a character `armor/base` from colliding
 *  with a prop `armor/base`. */
export function lineupEntryRef(kind: SheetKind, entityKey: string, variantKey: string): string {
  return `${kind}:@${entityKey}/${variantKey}`;
}

/** Projection of the 'base' variant text (EditBaseEntityModal + crop labels). */
export interface BaseEntityText {
  key: string;
  description: string;                           // import-only
  height: number | null;                        // ⚡ cm (number, 2026-07-17) — import-only (char/prop); null = chưa có / parse fail
  visual_design: string;                        // editable
  art_language: string;                         // editable
}

/** ⚡REV 2026-08-21 — sheet accessor by GROUP KEY (single source — reused by slice + selectors +
 *  save policy). Returns `undefined` when the group has no base node yet (the write paths seed it). */
export function sheetOf(base: SketchBase, groupKey: string): SketchBaseSheet | undefined {
  return base[groupKey];
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

/** A confirmed base group's raw sheet, surfaced as a MANDATORY style-anchor reference. */
export interface SketchBaseAnchorRef {
  groupKey: string;
  name: string;    // the group's tab display name (for the tile label)
  mediaUrl: string; // effective raw-sheet illustration of the locked style
}

/**
 * First base GROUP (in `buildBaseGroups` order — characters before props, then by Excel `order`)
 * whose LOCKED style has a usable raw-sheet illustration → returned as a style anchor. Injected as a
 * mandatory reference when generating a LATER group's (or a stage's) base sheet so the established
 * aesthetic can't drift across groups. `excludeGroupKey` skips self-anchoring the group currently
 * being (re)generated. Returns null when no earlier group is confirmed yet.
 */
export function firstConfirmedBaseAnchor(
  groups: BaseGroup[],
  base: SketchBase,
  excludeGroupKey?: string,
): SketchBaseAnchorRef | null {
  for (const g of groups) {
    if (g.group_key === excludeGroupKey) continue;
    const style = sheetOf(base, g.group_key)?.styles.find((st) => st.is_selected);
    if (!style) continue;
    const url = effectiveIllustrationUrl(style.illustrations);
    if (url) return { groupKey: g.group_key, name: g.name, mediaUrl: url };
  }
  return null;
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
