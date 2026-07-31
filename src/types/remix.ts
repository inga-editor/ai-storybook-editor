// remix.ts — Domain types for Remix feature (DB row + ephemeral inject job state)
// DB row JSONB structure: snapshot illustration/characters/props snapshot + remix_config + mixes.

import type { BaseSpread, SpreadTag } from './spread-types';
import type { IllustrationData, Section } from './illustration-types';
import type { Character, CharacterVariant } from './character-types';
import type { Prop, PropVariant, Crop } from './prop-types';

// Re-export SpreadTag so swap-modal consumers have a single import point.
export type { SpreadTag } from './spread-types';
import type { RemixLanguageCode, Distribution } from './editor';
import type { Human, TraitType } from './human';

// Re-export book-level remix entries so consumers have a single import point.
export type {
  BookRemix,
  RemixLanguageEntry,
  RemixVoiceEntry,
  RemixTraitEntry,
  RemixCharacterEntry,
  RemixPropEntry,
  RemixToggleEntry,
  RemixStory,
  RemixMemoryPhotoEntry,
  RemixMemories,
  RemixLanguageCode,
  CharacterRemixType,
} from './editor';

// ── RemixCropSheet (batch-level) ─────────────────────────────────────────────
// Crop sheet carried by a batch (RemixMix). Adds `swap_results[]` to record
// AI-driven swap output and `crops[]` (CropEntry — multi-subject tags).

// ── Swap modal tabs (pipeline 2026-06-12) ────────────────────────────────────
/** Top-level tab of SwapCropSheetModal — 4-tab pipeline (Sprites › Crops ›
 *  Remove BG › Upscale). Tab ids are stable and ≠ display labels; `'lotties'`
 *  removed 2026-06-12 (Lottie swap deferred to its own modal). */
export type RemixModalTab = 'variants' | 'batches' | 'rmbg' | 'upscale';

/** The 3 crop-pipeline stage columns on the remixes row (⚡2026-06-12) —
 *  matches the DB JSONB column names: swap → remove-bg → upscale. */
export type StageKind = 'mixes' | 'rmbgs' | 'upscales';

/** StageKind → background-job phase + enqueue endpoint segment
 *  (`POST /api/jobs/remix/{id}/{segment}` — jobs 05/09/10). Store-facing
 *  mapping; UI config (labels, compose modes) lives in the modal's
 *  `stage-tab-config.ts`. */
export const STAGE_JOB_CONFIG = {
  mixes: { phase: 'remix_mix_swap', endpointSegment: 'mix-swap' },
  rmbgs: { phase: 'remix_rmbg', endpointSegment: 'rmbg' },
  upscales: { phase: 'remix_upscale', endpointSegment: 'upscale' },
} as const satisfies Record<
  StageKind,
  { phase: RemixJobPhase; endpointSegment: string }
>;

/** Pipeline predecessor per stage — the stage whose FINALS feed this stage's
 *  Import (rmbgs ← mixes, upscales ← rmbgs). */
export const PREV_STAGE: Record<'rmbgs' | 'upscales', StageKind> = {
  rmbgs: 'mixes',
  upscales: 'rmbgs',
};

/** Per-crop output piece of a stage job (⚡LEAN 2026-06-12 — jobs 05/09/10).
 *  `geometry`/`tags[]` dropped: readers join `original_crops[]` of the SAME
 *  sheet by `(spread_id, id)` — the join key is invariant across the pipeline.
 *  `media_url` per stage: mixes = swapped cut (native dim); rmbgs = RGBA piece;
 *  upscales = print-dim piece.
 *
 *  `is_final` = winner mutex PER-STAGE (per `(spread_id, id)` within ONE stage
 *  column; ⚡2026-06-12 semantics: finals mixes feed rmbgs, finals rmbgs feed
 *  upscales, finals upscales = the Inject Phase 3 source). ONLY valid when the
 *  parent `swap_results.is_selected=true`. Ownership matrix R1–R5 applies
 *  per-stage (R1/R2/R4 backend, R3 FE orphan reconcile, R5 user take-back). */
export interface SwapResultCrop {
  spread_id: string;
  id: string;
  media_url: string;
  is_final?: boolean;
}

// ── Shared crop-sheet skeleton (Validation S1 — DRY base) ────────────────────
// `mixes[]` (Batches) and `sprites[]` (Variants) carry structurally identical
// sheet/swap-result skeletons; only the crop entry shape differs (multi-subject
// `CropEntry` vs single-subject `SpriteCrop`). The generic base lets us change
// the `is_final` / sheet shape in ONE place. `RemixCropSheet`/`SwapResult` below
// are the mix specializations (shape byte-compatible with the pre-refactor
// interfaces — purely additive generic, no runtime change).
export interface SwapResultBase<TSwapCrop> {
  /** ⚡2026-06-12 nullable per stage: mixes = real Gemini sheet; rmbgs =
   *  persisted RGBA sheet; upscales = NULL (per-crop job — UI composes the
   *  AFTER view on demand from `crops[]`). */
  media_url: string | null;
  created_time: string;
  is_selected: boolean;
  crops: TSwapCrop[];
}

export interface CropSheetBase<TCrop, TSwapCrop> {
  title: string;
  /** Sheet frame size (px) — computed by crop-sheet-layout-engine. Additive
   *  JSONB field (DB-CHANGELOG 2026-05-19), no migration needed. */
  sheet_geometry: { width: number; height: number };
  /** @deprecated build API removed (2026-05-19) — usually empty ''. Kept for
   *  backward-compat; client now composes the sheet from crops + sheet_geometry. */
  image_url: string;
  swap_results: SwapResultBase<TSwapCrop>[];
  /** ⚡RENAME 2026-06-12 (was `crops[]`) — the stage's INPUT crops, single
   *  source of geometry + tags. `swap_results[].crops[]` stays named `crops`. */
  original_crops: TCrop[];
}

/** Mix swap-result (rev2 — re-cut output, backend deferred). FE v1 does not
 *  consume `crops[]`, only `media_url`. = `SwapResultBase<SwapResultCrop>`. */
export type SwapResult = SwapResultBase<SwapResultCrop>;

/** Re-export of crop entry shape from prop-types for consumer convenience. */
export type RemixCrop = Crop;

/** Crop entry stored on a stage batch crop sheet (⚡LEAN 2026-06-12). 5 fields
 *  only — `layer_kind`/`spread_number`/`aspect_ratio`/`name`/`annotation`
 *  dropped (no consumer; annotation resolves at runtime from
 *  `illustration.spreads[].images[].annotation` by `(spread_id, id)`).
 *  Affinity primary subject = `tags[0].object_key`; `geometry` is the engine
 *  OUTPUT (px, sheet-relative). `media_url` per stage: mixes = source layer
 *  crop; rmbgs = swapped piece (finals mixes); upscales = RGBA piece (finals
 *  rmbgs) — both at native dim. */
export interface CropEntry {
  spread_id: string;
  id: string;
  media_url: string;
  tags: SpreadTag[];
  geometry: { x: number; y: number; w: number; h: number };
}

/** Crop sheet carried by a batch (RemixMix). rev2 — crops carry multi-subject
 *  `tags[]` (CropEntry). = `CropSheetBase<CropEntry, SwapResultCrop>`. */
export type RemixCropSheet = CropSheetBase<CropEntry, SwapResultCrop>;

// ── Cloned entity snapshots (DB JSONB columns) ───────────────────────────────
// Mirror snapshot Character/Prop shape but replace `crop_sheets` with the
// remix variant carrying `swap_results`. Prop also drops `sounds` (not used).

/** Character variant extended for remix. The optional `visual_swap_url` mirrors
 *  the (now dead) DB column kept for back-compat with existing rows. */
export type RemixCharacterVariant = CharacterVariant & {
  /** @deprecated — DB dead column, stop populating; reference resolves from
   *  sprite finals (`resolveSpriteFinals` → `useRemixVariants.visualSwapUrl`). */
  visual_swap_url?: string | null;
};

/** Prop variant extended for remix — mirrors `RemixCharacterVariant` so the
 *  cloned prop variants match the DB schema. */
export type RemixPropVariant = PropVariant & {
  /** @deprecated — DB dead column, stop populating; reference resolves from
   *  sprite finals (`resolveSpriteFinals` → `useRemixVariants.visualSwapUrl`). */
  visual_swap_url?: string | null;
};

export type RemixCharacter = Omit<Character, 'variants'> & {
  variants: RemixCharacterVariant[];
};

export type RemixProp = Omit<Prop, 'sounds' | 'variants'> & {
  variants: RemixPropVariant[];
};

/** Batch entry (rev2) — a swap-config group of crop sheets. Identity = `id`
 *  (uuid). Crops carry multi-subject `tags[]`; the legacy `keys[]` lineup is
 *  gone. Was named "mix"; persisted column is still `mixes[]`. */
export interface RemixMix {
  id: string;
  order: number;
  /** Display name e.g. "Batch 1". */
  name: string;
  crop_sheets: RemixCropSheet[];
}

/** ⚡2026-06-12 — DB row shape shared by ALL 3 stage columns
 *  (`mixes[]`/`rmbgs[]`/`upscales[]`). Same shape as the historical mix entry. */
export type RemixStageBatchRow = RemixMix;

// ── Sprite plane (Variants tab — sprite-swap batch model) ────────────────────
// Mirror of the mix plane on the `remixes.sprites[]` column, but single-subject:
// each crop is ONE character/prop variant artwork (not a multi-subject spread
// crop). Used by the redesigned Variants tab (batch sprite-swap, api/jobs/02).
// cellKey = `${type}/${object_key}/${variant_key}`.

/** Pre-swap crop on a sprite sheet — one variant's ORIGINAL artwork.
 *  `media_url` is the source variant illustration (never `visual_swap_url` —
 *  avoids re-swap compounding). `geometry` is the engine OUTPUT (px,
 *  sheet-relative). */
export interface SpriteCrop {
  type: 'character' | 'prop';
  object_key: string;
  variant_key: string;
  media_url: string;
  geometry: { x: number; y: number; w: number; h: number };
}

/** Re-cut crop produced by the sprite-swap job (api/jobs/02). Cross-sprite
 *  winner mutex: per `(type, object_key, variant_key)`, EXACTLY 1 crop has
 *  `is_final=true` across all sprites at steady state (mirror SwapResultCrop —
 *  see ownership matrix R1/R3/R5). ONLY valid when parent
 *  `swap_results.is_selected=true`. */
export interface SwapResultSpriteCrop {
  type: 'character' | 'prop';
  object_key: string;
  variant_key: string;
  geometry: { x: number; y: number; w: number; h: number };
  media_url: string;
  is_final?: boolean;
}

/** Crop sheet carried by a sprite. = `CropSheetBase<SpriteCrop, SwapResultSpriteCrop>`. */
export type RemixSpriteCropSheet = CropSheetBase<SpriteCrop, SwapResultSpriteCrop>;

/** Persisted `remixes.sprites[]` entry — mirror `RemixMix` on the sprite plane.
 *  Identity = `id` (uuid). NO derived `swapTask` (that's the projection below). */
export interface RemixSpriteEntry {
  id: string;
  order: number;
  /** Display name e.g. "Sprite 1". */
  name: string;
  crop_sheets: RemixSpriteCropSheet[];
}

/** Sprite-level swap task progress (mirror BatchSwapTaskStatus, sprite-scoped). */
export type SpriteSwapTaskStatus =
  | { state: 'idle' }
  | { state: 'running'; current: number; total: number }
  | { state: 'error'; message: string; failedSheets: number };

/** Variants-tab projection of one `remixes.sprites[]` entry + its derived swap
 *  task (mirror RemixBatch). `swapTask` is DERIVED from `jobs[]` — NOT persisted. */
export interface RemixSprite {
  id: string;
  order: number;
  name: string;
  crop_sheets: RemixSpriteCropSheet[];
  swapTask: SpriteSwapTaskStatus;
}

/** Args for the sprite-level swap enqueue (api/jobs/02). `params` (swap group)
 *  WIRED → `buildModelParams('sprites', params)` → body `model_params`
 *  (swapModel + swapTemperature); backend allowlists/clamps per model. */
export interface StartSpriteSwapParams {
  remixId: string;
  spriteId: string;
  /** WIRED → buildModelParams('sprites', params) → body model_params. */
  params: SwapModelParams;
  /** When true (default), clear + re-swap every sheet of the sprite (api/jobs/02). */
  forceResweep?: boolean;
}

// ── Swap defect detection (Check — api/jobs/11 sprite + 12 mix) ──────────────
// Advisory/ephemeral overlay: bấm Check trên 1 scope (sprite HOẶC batch mix) →
// background job (`remix_detect_defects` sprite / `remix_detect_mix_defects` mix)
// soi MỌI sheet đã swap → trả `defectsBySheet` qua `background_jobs.result`
// (KHÔNG persist vào `remixes`). FE vẽ vòng tròn/oval (`DefectOverlay`) đè vùng
// swap nghi lỗi trên canvas AFTER. Generic 2 plane (chốt user 2026-06-27).
// Spec: api/remix/06+07 (core) + api/jobs/11+12 (job) + design 05-15.

/** Detect plane — the ONLY parametrize axis between the 3 Check flows (sprite
 *  tab Variants, mix tab Crops, rmbg tab Remove BG). Resolves the
 *  scope-key/endpoint/job-type via {@link DETECT_JOB_CONFIG}. */
export type DetectPlane = 'sprite' | 'mix' | 'rmbg';

/** Defect taxonomy — SPRITE core (06 §Result). Dev type-hint ONLY; the shared
 *  `SwapDefect.category` is kept LOOSE (`string`) so the overlay stays
 *  plane-agnostic (it renders `category·message` as text, never branches on the
 *  enum). `low` severity/color is the default when severity/category undefined. */
export type SwapDefectCategory =
  | 'identity_mismatch'
  | 'trait_leak'
  | 'cross_contamination'
  | 'pose_or_composition'
  | 'art_style_break'
  | 'ordinal_altered'
  | 'cell_structure'
  | 'artifact'
  | 'not_swapped'
  | 'other';

/** Defect taxonomy — MIX core (07 §Result). Dev type-hint ONLY (see
 *  {@link SwapDefectCategory}); adds the multi-subject crop categories. */
export type MixDefectCategory =
  | SwapDefectCategory
  | 'unrelated_object_changed';

/** One suspected swap-defect region on a swapped sheet (coords px on
 *  `swappedDimensions`). `box` present → render ellipse (hugs elongated areas);
 *  else `center` + `radius` → circle. `category` is LOOSE (`string`) — sprite
 *  ({@link SwapDefectCategory}) | mix ({@link MixDefectCategory}); a tooltip
 *  label only, never a render branch. `message` is vi user copy — NEVER pushed
 *  to logger/analytics (PII §10). */
export interface SwapDefect {
  center: { x: number; y: number };
  radius: number;
  box?: { x: number; y: number; w: number; h: number };
  category?: string;
  severity?: 'low' | 'medium' | 'high';
  message?: string;
  confidence?: number;
  cell?: number;
  object_key?: string;
}

/** Per-sheet detect result = `background_jobs.result.defectsBySheet[]`
 *  (api/jobs/11 sprite = 12 mix — same shape). `swappedDimensions` is the
 *  COORDINATE ORIGIN for the sheet's defects (= `sheet_geometry`, the recompose
 *  result pixel size). `truncated` → core capped at `max_defects` (30)
 *  most-severe per sheet. `hasOldVariantSheet` is mix-only observability meta —
 *  it does NOT affect render. */
export interface DefectSheetResult {
  sheet_index: number;
  defects: SwapDefect[];
  swappedDimensions: { width: number; height: number };
  defectCount: number;
  truncated?: boolean;
  hasOldVariantSheet?: boolean;
}

/** Sprite-level detect task — DERIVED from `jobs[]` (mirror SpriteSwapTaskStatus).
 *  `done` carries the skip/error counters so the sidebar badge can summarize a
 *  clean vs partial run. */
export type DetectTaskStatus =
  | { state: 'idle' }
  | { state: 'running'; current: number; total: number }
  | { state: 'done'; skippedSheets: number; errorCount: number }
  | { state: 'error'; message: string };

/** Plane → background-job phase + enqueue endpoint segment + scope-key (the ONLY
 *  per-plane differences). `POST /api/jobs/remix/{id}/{endpointSegment}` with
 *  body `{[scopeKey]: scopeId, …}`. Store-facing (mirrors `STAGE_JOB_CONFIG`);
 *  UI extras (coreDoc) live in the modal's `detect-plane-config.ts`. The 3
 *  job-types are SEPARATE dedup families → sprite-check + mix-check + rmbg-check
 *  run in parallel.
 *
 *  `carriesSwapContext` — whether the BE enqueue model accepts the display-only
 *  `swap_model`/`swap_temperature` fields. sprite (job 11) + mix (job 12) do;
 *  rmbg (job 13) does NOT (no swap identity → `extra="forbid"` rejects them →
 *  400 VALIDATION_ERROR). The client gates those fields per-plane on this flag. */
export const DETECT_JOB_CONFIG = {
  sprite: {
    phase: 'remix_detect_defects',
    endpointSegment: 'detect-sprite-defects',
    scopeKey: 'sprite_id',
    carriesSwapContext: true,
  },
  mix: {
    phase: 'remix_detect_mix_defects',
    endpointSegment: 'detect-mix-defects',
    scopeKey: 'batch_id',
    carriesSwapContext: true,
  },
  // ⚡2026-06-28 — rmbg plane (Remove BG tab, api/jobs/13). Same batch scope as
  // mix; defects drawn over the RGBA checkerboard AFTER view (core 08). rmbg does
  // NOT swap an identity → its enqueue model forbids swap_model/swap_temperature.
  rmbg: {
    phase: 'remix_detect_rmbg_defects',
    endpointSegment: 'detect-rmbg-defects',
    scopeKey: 'batch_id',
    carriesSwapContext: false,
  },
} as const satisfies Record<
  DetectPlane,
  {
    phase: RemixJobPhase;
    endpointSegment: string;
    scopeKey: 'sprite_id' | 'batch_id';
    carriesSwapContext: boolean;
  }
>;

/** Args for the generic detect enqueue (api/jobs/11 sprite | 12 mix). `scopeId`
 *  = sprite_id (sprite) | batch_id (mix). `params` supplies the swap-model
 *  context (`swap_model`/`swap_temperature`) the core re-uses to read the swap
 *  intent; mirror `StartSpriteSwapParams`. */
export interface StartDetectJobParams {
  plane: DetectPlane;
  remixId: string;
  scopeId: string;
  params: SwapModelParams;
}

// ── Spread (display-only subset of BaseSpread) ───────────────────────────────
// Drop editor-only fields. We intentionally keep this as a Pick so the existing
// CanvasSpreadView<RemixSpread> generic continues to type-check.

export type RemixSpread = Omit<
  BaseSpread,
  'raw_images' | 'raw_textboxes' | 'manuscript' | 'tiny_sketch_media_url'
>;

/** One image layer inside a remix spread (`remix.illustration.spreads[].images[]`).
 *  Structurally identical to the editor `SpreadImage` (the `images` field is kept by the
 *  `RemixSpread` Pick) — aliased so granular-patch call sites read in the remix domain. */
export type RemixSpreadImage = RemixSpread['images'][number];

export interface RemixIllustration {
  spreads: RemixSpread[];
  /** @deprecated Reshape 2026-07-31 — remix is linear (branch resolve-at-create);
   *  the clone pipeline emits `[]`. Optional so consumers must tolerate absence
   *  (read via `?? []`). Legacy rows may still carry populated sections. */
  sections?: Section[];
}

// ── Inject (Phase 3 — client-side finalize) ──────────────────────────────────
// Inject resolves the winning is_final crops, mutates illustration.spreads[]
// .images[] (set final_hires_media_url + collapse illustrations[]), and persists
// the full illustration column in ONE Supabase UPDATE. No background job.
// Spec: api/remix/inject.md (commit 5229b1d — client-side finalize).

/** Result of a successful `injectFinalCrops` call.
 *  - appliedCount  = layers that received a swapped final_hires_media_url
 *  - collapsedCount = layers whose illustrations[] were slimmed to 1 element
 *  - spreadCount   = number of spreads scanned */
export interface InjectResult {
  appliedCount: number;
  collapsedCount: number;
  spreadCount: number;
}

/** Local UI state of the Inject button (held in RemixAccordionItem, not store). */
export type InjectUiState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; appliedCount: number; injectedAt: string }
  | { state: 'error'; message: string };

// ── Remix config (user-driven picks) ─────────────────────────────────────────

/** Per-trait toggle inside a character choice. 5 entries (TRAIT_TYPES), cloned
 *  from the book character's trait gate; order is display-only (keyed by type). */
export interface RemixTraitChoice {
  type: TraitType;
  is_enabled: boolean;
}

export interface RemixCharacterChoice {
  key: string;
  human_id: string | null;
  visual: string | null;
  /** 5 trait toggles; only enabled traits (with a human description) are sent
   *  to the swap endpoint. */
  traits: RemixTraitChoice[];
  /** Base-variant swapped appearance staged in the create modal. Copied into
   *  the cloned variant `visual_swap_url` at create time. */
  base_image_url: string | null;
  is_enabled: boolean;
}

export interface RemixPropChoice {
  key: string;
  prop_id: string | null;
  visual: string | null;
  is_enabled: boolean;
}

/** Voice collection entry — replaces the legacy singular `narrator` + per-character
 *  `voice_id`. key = 'narrator' (literal) | <character.key>. `name` is materialized
 *  from book.voices[] for fallback render; narrator name is user-editable. */
export interface RemixVoiceChoice {
  key: string;
  name: string;
  voice_id: string | null;
  is_enabled: boolean;
}

export interface RemixLanguageChoice {
  name: string;
  code: RemixLanguageCode | string;
  is_enabled: boolean;
}

// ── Story config (frozen choices — reshape 2026-07-31) ───────────────────────
// `story` materializes at create: `presets[]` drive casting materialization +
// effective cast; `branches[]` linearize the spread path (remix has no
// branching). Both are soft refs — `presets` → book.casting_slot, `branches` →
// snapshot.illustration.

/** Radio style của Memories — UI: 'real' = "Real Style", 'styled' = "Animated Style". */
export type MemoryStyle = 'real' | 'styled';

/** 1 entry / casting axis — frozen tại create. Soft ref → book.casting_slot. */
export interface RemixPresetChoice {
  axis_id: string;
  preset_id: string;
}

/** 1 entry / branch spread — section của nhánh đã chọn. Soft ref → snapshot.illustration. */
export interface RemixBranchChoice {
  spread_id: string;
  section_id: string;
}

export interface RemixStoryConfig {
  presets: RemixPresetChoice[];
  branches: RemixBranchChoice[];
}

export interface RemixMemoryPhotoChoice {
  key: string; // soft ref → book.parametric_slot.photos[].key
  is_enabled: boolean;
  media_url: string | null; // upload flow TBD — luôn null đợt này
}

export interface RemixMemoriesConfig {
  is_enabled: boolean; // master toggle "Use real photos"
  style: MemoryStyle; // global per-remix, default 'styled'
  photos: RemixMemoryPhotoChoice[];
}

export interface RemixConfig {
  story: RemixStoryConfig;
  characters: RemixCharacterChoice[];
  memories: RemixMemoriesConfig;
  voices: RemixVoiceChoice[];
  languages: RemixLanguageChoice[];
  /** @deprecated Reshape 2026-07-31 — writer không emit; chỉ để đọc rows cũ.
   *  Consumers MUST read via `?? []`. */
  props?: RemixPropChoice[];
}

// ── Modal-local option / preview types (ephemeral — never persisted) ─────────

/** Per-character live-swap preview state held by the modal (not in RemixConfig). */
export interface SwapPreviewState {
  status: 'idle' | 'loading' | 'done' | 'error';
  beforeUrl: string | null;
  afterUrl: string | null;
  errorMessage?: string;
}

export interface HumanOption {
  id: string;
  name: string;
  thumbnail_url?: string;
}

export interface VisualOption {
  value: string;
  label: string;
  thumbnail_url?: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  language?: string;
}

// ── Lookup options (Story tab — derived from snapshot.illustration) ──────────
// Ephemeral read-model built by `useBranchSpreadOptions` (Phase 02). One entry
// per spread carrying a `branch_setting`; `branches[]` are that spread's choices.

export interface BranchSpreadBranchOption {
  section_id: string;
  title: string;
  is_default: boolean;
}

export interface BranchSpreadOption {
  spread_id: string;
  spread_number: string; // pages[0].number — label "SPREAD {n}"
  title: string; // câu hỏi rẽ nhánh
  branches: BranchSpreadBranchOption[];
}

/** Default name for a freshly created remix (create-only modal). */
export const REMIX_NAME_DEFAULT = 'New Remix';

// ── Top-level DB row ─────────────────────────────────────────────────────────

export interface Remix {
  id: string;
  snapshot_id: string;
  name: string;
  remix_config: RemixConfig;
  illustration: RemixIllustration;
  characters: RemixCharacter[];
  props: RemixProp[];
  mixes: RemixMix[];
  /** ⚡NEW 2026-06-12 — stage 2 (remove-bg) batches. Same row shape as
   *  `mixes[]`; `original_crops[]` = finals of `mixes[]` (Import,
   *  copy-on-build snapshot). Reader coalesces undefined → []. */
  rmbgs: RemixStageBatchRow[];
  /** ⚡NEW 2026-06-12 — stage 3 (upscale) batches; `original_crops[]` = finals
   *  of `rmbgs[]`. Finals of THIS column are the Inject Phase 3 source. */
  upscales: RemixStageBatchRow[];
  /** Sprite plane (Variants tab — sprite-swap batch model). Additive JSONB
   *  column (DB-CHANGELOG 2026-06-08). Reader coalesces undefined → []. */
  sprites: RemixSpriteEntry[];
  /** Export-artifact state (additive, optional). Same shape as Book.distribution.
   *  Reader coalesces null/undefined → DEFAULT (coalesceDistribution). */
  distribution?: Distribution | null;
  created_at: string;
  updated_at: string;
}

/** Shape used when INSERTing into Supabase (omits server-managed cols). */
export type InsertableRemixRow = Omit<Remix, 'id' | 'created_at' | 'updated_at'>;

/** Shape returned by Supabase select — id/created_at/updated_at + JSONB columns. */
export interface RemixRow {
  id: string;
  snapshot_id: string;
  name: string;
  remix_config: RemixConfig;
  illustration: IllustrationData; // raw JSONB — caller narrows to RemixIllustration on read
  characters: RemixCharacter[];
  props: RemixProp[];
  mixes: RemixMix[];
  /** Stage 2/3 pipeline columns — additive JSONB (DB-CHANGELOG 2026-06-12);
   *  legacy rows omit them, reader coalesces undefined → []. */
  rmbgs?: RemixStageBatchRow[];
  upscales?: RemixStageBatchRow[];
  /** Sprite plane — additive JSONB column. Optional on the raw row (legacy rows
   *  omit it); reader coalesces undefined → [] on mapping. */
  sprites?: RemixSpriteEntry[];
  distribution?: Distribution | null;
  created_at: string;
  updated_at: string;
}

// ── Remix Job (DB row parity — Phase 2 background_jobs) ─────────────────────
// Aligned 1:1 với public.background_jobs DB enum (queued|running|completed|
// failed|cancelled). `partial` is a derived UI state (status='completed' AND
// result.errors.length > 0). Spec: ai-storybook-design/component/stores/remix-store.md §2.

// `remix_mix_swap` = batch-level swap (api/jobs/05) — the live swap phase.
// NOTE: `image` phase removed (2026-05-30) — Inject is now a synchronous
// client-side finalize (no background job). See InjectResult / injectFinalCrops.
// NOTE: `character_swap` phase removed (2026-06-08) — job type
// `remix_character_swap` (api/jobs/04) deleted server-side, superseded by the
// `remix_mix_swap` batch model. The old synchronous create-modal visual swap
// (POST /api/remix/swap-character-visual) was also removed; appearance swap is
// now exclusively the async sprite-swap job below.
// `remix_sprite_swap` = sprite-level swap (api/jobs/02) — Variants tab batch
// sprite-swap. Independent of `remix_mix_swap` (disjoint dedup key).
// `remix_rmbg` / `remix_upscale` = stage 2/3 pipeline jobs (api/jobs/09 + 10,
// ⚡2026-06-12). Dedup is PER-TYPE + the 3 stage JSONB columns are disjoint →
// the 3 stage jobs can run concurrently without blocking each other.
// `remix_detect_defects` = sprite-level swap-defect detection (api/jobs/11 —
// Variants tab Check). `remix_detect_mix_defects` = mix/batch-level detection
// (api/jobs/12 — Crops tab Check). `remix_detect_rmbg_defects` = rmbg/batch-level
// detection (api/jobs/13 — Remove BG tab Check; ⚡2026-06-28). All 3 are
// independent of swap jobs AND of each other (disjoint dedup keys —
// sprite/mix/rmbg-check run in parallel); advisory result lives in
// `background_jobs.result.defectsBySheet` (NOT persisted to `remixes`). Keep in
// lockstep with REMIX_SWAP_TYPES + JOB_TYPE_TO_PHASE + DETECT_JOB_CONFIG.
export type RemixJobPhase =
  | 'audio'
  | 'remix_mix_swap'
  | 'remix_sprite_swap'
  | 'remix_rmbg'
  | 'remix_upscale'
  | 'remix_detect_defects'
  | 'remix_detect_mix_defects'
  | 'remix_detect_rmbg_defects';

export type RemixJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RemixJobError {
  // Audio: 'narrate-script' | 'combine-audio-chunks' | 'persist' | 'internal'
  // Character swap (api/jobs/04): 'compose' | 'swap' | 'persist' | 'resolve' | 'internal'
  stage: string;
  spreadId?: string;
  textboxId?: string;
  languageKey?: string;
  chunkIndex?: number;
  entityKey?: string;
  message: string;
}

export type RemixJobStepDetail =
  | 'pending'
  | 'running'
  | 'done'
  | { state: 'failed'; stage: string; message: string; failed_textbox_ids?: string[] };

export interface RemixJobResult {
  errors: RemixJobError[];
  updated_spreads?: number;
  failed_spreads?: number;
  total_chunks_regenerated?: number;
  total_textboxes_recombined?: number;
  // Character swap (api/jobs/04 §Result) — per-sheet counters.
  character_key?: string;
  swapped_sheets?: number;
  skipped_sheets?: number;
  failed_sheets?: number;
  variants_processed?: number;
  // Swap-defect detection (api/jobs/11 §Result) — advisory per-sheet defects.
  // `skipped_sheets` (above) reused; `errors[]` reused for partial-sheet errors.
  defectsBySheet?: DefectSheetResult[];
  [k: string]: unknown;
}

export interface RemixJob {
  id: string;
  remixId: string;
  phase: RemixJobPhase;
  triggeredBy: 'auto-create' | 'user';
  status: RemixJobStatus;
  /** Mirrors `params.character_key` when present. Lets selectors fold the swap
   *  lineage by character (see slice-helpers.ts). Undefined for audio jobs. */
  characterKey?: string;
  /** Set for stage jobs (`remix_mix_swap`/`remix_rmbg`/`remix_upscale`) —
   *  mirrors `params.batch_id`. Lets selectors match the running job to its
   *  batch per stage. Undefined otherwise. */
  batchId?: string;
  /** Set for `remix_sprite_swap` jobs only — mirrors `params.sprite_id`. Lets
   *  selectors match the running swap to its sprite. Undefined otherwise. */
  spriteId?: string;
  currentStep: number;
  totalSteps: number;
  stepDetails?: { spreads: Record<string, RemixJobStepDetail> };
  result?: RemixJobResult;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** 3-shape result returned by startAudioJob/startMixSwap.
 *  Spec: api/jobs/01 §Result + api/jobs/05 §Result. `characterKey` is set only
 *  on cross-type dedup against an ALREADY-active character-swap job (may differ
 *  from the requested key — see api/jobs/05 §cross-type dedup). */
export type EnqueueRemixJobOutcome =
  | { kind: 'enqueued'; jobId: string; totalSteps: number; chunksToRegen?: number; textboxesToRecombine?: number; characterKey?: string }
  | { kind: 'deduped';  jobId: string; status: 'queued' | 'running'; characterKey?: string }
  | { kind: 'skipped';  reason: string };

/** 7-state discriminated union driving AudioJobBadge component render. */
export type AudioJobBadgeState =
  | { kind: 'hidden' }
  | { kind: 'queued';     jobId: string }
  | { kind: 'running';    jobId: string; current: number; total: number }
  | { kind: 'cancelling'; jobId: string }
  | { kind: 'cancelled';  jobId: string; completedAt: string }
  | { kind: 'partial';    jobId: string; errorCount: number; completedAt: string }
  | { kind: 'failed';     jobId: string; message: string };

/** Raw shape of public.background_jobs row returned by Supabase select + realtime payload. */
export interface BackgroundJobRow {
  id: string;
  type:
    | 'remix_audio_swap'
    | 'remix_image_swap'
    | 'remix_mix_swap'
    | 'remix_sprite_swap'
    | 'remix_rmbg'
    | 'remix_upscale'
    | 'remix_detect_defects'
    | string;
  user_id: string;
  book_id: string | null;
  status: RemixJobStatus;
  cancel_requested: boolean;
  total_steps: number;
  current_step: number;
  step_details: RemixJob['stepDetails'];
  params: {
    remix_id: string;
    triggered_by?: 'auto-create' | 'user';
    /** Present on swap-job rows that carry a single character key. */
    character_key?: string;
    /** Present on `remix_mix_swap` rows — the swapped batch id (api/jobs/05). */
    batch_id?: string;
    /** Present on `remix_sprite_swap` rows — the swapped sprite id (api/jobs/02). */
    sprite_id?: string;
    [k: string]: unknown;
  };
  result: RemixJobResult | null;
  created_at: string;
  updated_at: string;
}

/** Hardcoded chunk-concurrency cap sent to backend on every enqueue.
 *  Guards ElevenLabs 5 req/s; backend may clamp further. */
export const CLIENT_AUDIO_CHUNK_CAP = 2 as const;

/** Discriminated union of remote events applied by `applyServerEvent`. */
export type RemixServerEvent =
  | { type: 'created'; remix: Remix }
  | { type: 'updated'; id: string; patch: Partial<Remix> }
  | { type: 'deleted'; id: string }
  | { type: 'job_upsert'; row: BackgroundJobRow }
  | { type: 'job_delete'; id: string };

// ── Filter state (sidebar popover) ───────────────────────────────────────────
// Empty arrays = no filter (all checked semantic — see Phase 06).

export interface RemixFilterState {
  characterKeys: string[];
  propKeys: string[];
}

// ── Sidebar callback target ──────────────────────────────────────────────────

export interface SwapCropSheetTarget {
  remixId: string;
  type: 'character' | 'prop' | 'mix';
  key: string;
}


// === rev2 projections (Variants / Batches tabs) ==============================

/** A single variant node for the Variants tab. `visualSwapUrl` is the persisted
 *  per-variant swap result (Generate action); `isBase` marks the type=0 variant. */
export interface RemixVariantNode {
  variantKey: string;
  name: string;
  illustrationUrl: string | null;
  visualSwapUrl: string | null;
  isBase: boolean;
}

/** A character/prop entity projection for the Variants tab. */
export interface RemixVariantEntity {
  type: 'character' | 'prop';
  key: string;
  name: string;
  variants: RemixVariantNode[];
}

/** Batch-level swap task progress (rev2 — mirrors SwapTaskStatus but batch-scoped). */
export type BatchSwapTaskStatus =
  | { state: 'idle' }
  | { state: 'running'; current: number; total: number }
  | { state: 'error'; message: string; failedSheets: number };

/** Stage-tab projection of one `remix[stage][]` entry + its derived job task
 *  (⚡2026-06-12 — renamed from `RemixBatch`, generic across the 3 stages). */
export interface RemixStageBatch {
  id: string;
  order: number;
  name: string;
  crop_sheets: RemixCropSheet[];
  swapTask: BatchSwapTaskStatus;
}

/** Historical name (stage `'mixes'`) — pure TYPE alias, NOT a store-API alias. */
export type RemixBatch = RemixStageBatch;

/** Variant-qualified lineup tokens of a batch — `${object_key}/${variant_key}`
 *  per distinct subject tag across all sheets. Replaces the legacy `mixes[].keys[]`
 *  identity (now derived from crop tags, not persisted). */
export function batchLineupTokens(batch: RemixStageBatch): string[] {
  const tokens = new Set<string>();
  for (const sheet of batch.crop_sheets) {
    // Defensive `?? []` — stale pre-rename rows degrade to empty, not crash.
    for (const crop of sheet.original_crops ?? []) {
      for (const tag of crop.tags) {
        tokens.add(`${tag.object_key}/${tag.variant_key}`);
      }
    }
  }
  return [...tokens];
}

// === Entity swap (modal-driven, per-key) — SwapCropSheetModal ================
// Swap runs over every crop sheet of one entity key. `current`/`total` track
// loop progress; `failedSheets` counts sheets that errored in a partial run.

export type SwapTaskStatus =
  | { state: 'idle' }
  | { state: 'running'; current: number; total: number }
  | { state: 'error'; message: string; failedSheets: number };

/** Reference image for refine — canonical shape shared with
 *  `useReferenceImagePicker` (which re-exports this type). */
export interface ReferenceImage {
  label: string;
  base64Data: string;
  mimeType: string;
}

/** Right-sidebar AI model params — per-tab groups (⚡2026-06-12: swap / rmbg /
 *  upscale + Noise; `scale` dropped — job 10 derives PRINT 300 DPI itself).
 *  ⚡2026-06-13 WIRED → `buildModelParams(stage, params)` → job body
 *  `model_params` (§4.6); the API allowlists/clamps/maps per model. The `swap`
 *  group (Sprites + Crops) shares one `swapTemperature` stepper. */
export interface SwapModelParams {
  swapModel: string;
  /** Gemini `generationConfig.temperature` — shared by Sprites + Crops (group
   *  'swap'); forwarded as `model_params.params.temperature`. Backend clamps. */
  swapTemperature: number;
  rmbgModel: string;
  upscaleModel: string;
  noise: number; // 0..10 step 0.1 — upscale denoise (group 'upscale')
  /** ⚡2026-06-29 Watercolor grain post-process (group 'upscale'). Forwarded as
   *  the TOP-LEVEL job-10 body field `grain` (sibling of `model_params`, NOT
   *  nested). MODEL-AGNOSTIC: applies after upscale on ALL 4 models — unlike
   *  `noise`, the controls are NEVER gated by the picked model. Default ON. */
  grainEnabled: boolean;
  grainAmp: number; // 0..50 step 1 — grain amplitude (top-level grain.amp)
  grainBlur: number; // 0..5 step 0.1 — grain blur radius (top-level grain.blur)
}

/** Args for the stage-job enqueue (⚡2026-06-12 generic — jobs 05/09/10,
 *  replaces StartMixSwapParams; validation S1 no alias). `params` WIRED →
 *  `buildModelParams(stage, params)` → body `model_params` (§4.6). */
export interface StartStageJobParams {
  remixId: string;
  stage: StageKind;
  batchId: string;
  /** WIRED → buildModelParams(stage, params) → body model_params. */
  params: SwapModelParams;
  /** When true (default), clear + re-run every sheet of the batch; false is
   *  idempotent — backend skips sheets already carrying a result. */
  forceResweep?: boolean;
}

// ── Text Swap Engine (Phase 1) ───────────────────────────────────────────────
// Sync client-side swap of `character.name` → `humans.display_name[lang]` over
// remix illustration textbox text + audio chunk scripts. Pure function, no I/O.
// Spec: ai-storybook-design/component/stores/remix-store.md §10.

/** Warning kinds emitted during swap-map build / apply. 5 kinds —
 *  `short_source_name` dropped per Validation Session 1 (CJK 2-char names valid). */
export type TextSwapWarningKind =
  | 'no_human_picked'
  | 'stale_human_fk'
  | 'missing_display_name'
  | 'no_op_swap'
  | 'empty_source_name';

export interface TextSwapWarning {
  kind: TextSwapWarningKind;
  characterKey?: string;
  language?: string;
  source?: string;
  target?: string;
}

export interface TextSwapInput {
  illustration: RemixIllustration;
  remixCharacters: RemixCharacter[];
  configCharacters: RemixCharacterChoice[];
  enabledLanguages: string[];
  humans: Record<string, Human>;
}

export interface TextSwapResult {
  illustration: RemixIllustration;
  warnings: TextSwapWarning[];
  matchCount: number;
  chunksMarkedUnsynced: number;
}
