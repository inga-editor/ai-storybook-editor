// spread-types.ts - Shared domain types used across canvas and playable spread views
// Centralized from components/shared/types.ts

import type { BranchSetting } from './illustration-types';
import type { Illustration } from './prop-types';
// `editor.ts` imports only `@/types/human` (which imports nothing) → no cycle.
import type { CastingActorType } from './editor';

// === Unified Item Type (canvas + playable merged) ===
export type ItemType =
  | "image"
  | "textbox"
  | "raw_image"
  | "raw_textbox"
  | "shape"
  | "video"
  | "auto_pic"
  | "audio"
  | "auto_audio"
  | "quiz"
  | "composite";

// === Composite (edition-aware wrapper) ===
// See snapshot/illustration-structure.md#composites
export type EditionTag = 'classic' | 'dynamic' | 'interactive';
export type CompositeVariantSourceType = 'image' | 'auto_pic';

/** Reference to a sub-item (image | auto_pic) within the same spread.
 *  `id` is FK → `spread.images[].id` or `spread.auto_pics[].id` (discriminator: `type`).
 *  Per composite: 1 edition slot → exactly 1 variant entry. */
export interface CompositeVariant {
  id: string;
  type: CompositeVariantSourceType;
  edition: EditionTag;
}

/** Edition-aware wrapper grouping 2..3 sub-items. Player runtime resolves the
 *  active variant by `book.edition`. Composite itself is NOT a render layer —
 *  it's purely logical state living in `spread.composites[]`. */
export interface SpreadComposite {
  id: string;
  title: string;
  'z-index': number;
  editor_visible?: boolean;  // default true
  player_visible?: boolean;  // default true
  variants: CompositeVariant[];  // 2..3 entries (1 per edition slot)
}

// === Geometry Types ===
export interface Point {
  x: number;
  y: number;
}

export interface Geometry {
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  w: number; // percentage 0-100
  h: number; // percentage 0-100
  /** Rotation in degrees clockwise around bbox center. Range raw [-360, 360], UI wraps to [-180, 180]. Default 0. */
  rotation?: number;
}

// === Tags (subject identity for layers) ===
// Replaces legacy (type, name, state/variant) triplet on 5 layer types
// (images, videos, audios, auto_pics, auto_audios).
// See snapshot/illustration-structure.md#tags-spec
export type SpreadTagType = 'character' | 'prop' | 'other';

/** Fixed object_key values when type='other'. UI renders these in the "Others" group. */
export type SpreadTagOtherKey = 'background' | 'foreground' | 'vfx';

/** Soft-FK link from a layer to a subject (character/prop) or a role tag (other).
 *  - type='character' | 'prop': object_key → characters[].key | props[].key; variant_key → entity.variants[].key
 *  - type='other': object_key ∈ SpreadTagOtherKey; variant_key is null (no variants for role tags) */
export interface SpreadTag {
  type: SpreadTagType;
  object_key: string;
  variant_key: string | null;
}

// === Typography ===
export interface Typography {
  size?: number;
  weight?: number;
  style?: "normal" | "italic";
  family?: string;
  color?: string;
  lineHeight?: number;
  letterSpacing?: number;
  decoration?: "none" | "underline" | "line-through";
  textAlign?: "left" | "center" | "right";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
}

// === Shape Fill & Outline ===
export interface ShapeFill {
  is_filled: boolean;
  color: string;
  opacity: number;
}

export interface ShapeOutline {
  color: string;
  width: number;
  radius: number;
  type: 0 | 1 | 2; // 0=solid, 1=dashed, 2=dotted
}

// === Spread Shape ===
export interface SpreadShape {
  id: string;
  type: "rectangle";
  title?: string;
  geometry: Geometry;
  fill: ShapeFill;
  outline: ShapeOutline;
  // Retouch only
  "z-index"?: number;
  player_visible?: boolean;
  editor_visible?: boolean;
}

// === Spread Video ===
export interface SpreadVideo {
  id: string;
  title?: string;
  geometry: Geometry;
  "z-index": number;
  player_visible: boolean;
  editor_visible: boolean;
  /** **Scene lineage** — see `SpreadImage.original_image_id`. Currently always absent in practice:
   *  videos only spawn blank from "Add element" (L4). Kept for future derived paths. */
  original_image_id?: string;
  tags?: SpreadTag[];
  media_url?: string;
}

/** Infinite-loop animated media layer. Shape identical to SpreadVideo — differentiated by
 *  runtime rendering contract (no play/pause UI, auto-loop forever).
 *  See snapshot/illustration-structure.md#auto_pics */
export interface SpreadAutoPic {
  id: string;
  title?: string;
  geometry: Geometry;
  "z-index": number;
  player_visible: boolean;
  editor_visible: boolean;
  /** **Scene lineage** — see `SpreadImage.original_image_id`. Same situation as `SpreadVideo`:
   *  always absent today (blank "Add element" spawn only, L4). */
  original_image_id?: string;
  tags?: SpreadTag[];
  media_url?: string; // .webp (animated) | .webm (loop=true) | .lottie | .riv
  /** dotLottie v2 renderer hints — absent means use library defaults */
  lottie?: {
    theme?: string;         // dotLottie v2 theme id
    state_machine?: string; // state machine id; absent → default animation
    speed?: number;         // default 1
  };
  /** Rive renderer hints — absent means use library defaults */
  rive?: {
    artboard?: string;      // default: file's default artboard
    animation?: string;     // default: 'Idle' or first linear animation
    state_machine?: string; // mutually exclusive with animation; wins if both present
    fit?: 'contain' | 'cover' | 'fill' | 'fitWidth' | 'fitHeight' | 'none' | 'scaleDown'; // default: 'contain'
  };
}

// === Spread Audio ===
export interface SpreadAudio {
  id: string;
  title?: string;
  description?: string;
  geometry: Geometry;
  "z-index": number;
  player_visible: boolean;
  editor_visible: boolean;
  tags?: SpreadTag[];
  media_url?: string;
  media_length?: number; // duration in milliseconds, populated on pick/upload
}

/** Auto-audio: tự phát + loop, hidden trong player UI. Schema mirrors SpreadAudio
 *  ngoại trừ player_visible locked false và KHÔNG có media_length.
 *  See snapshot/illustration-structure.md#auto_audios */
export interface SpreadAutoAudio {
  id: string;
  title?: string;
  description?: string;
  geometry: { x: number; y: number };  // 2D — icon position, identical to SpreadAudio
  "z-index": number;
  player_visible: false;                // literal false, locked by validator
  editor_visible: boolean;
  tags?: SpreadTag[];
  media_url?: string;
  // KHÔNG có media_length — runtime đo HTMLAudioElement.duration nếu cần sync
}

// === Quiz v2 — see 11-quiz-slice.md. Breaking change [2026-04-11]. ===

// Quiz type discriminator
export const QUIZ_TYPE = {
  SINGLE_SELECT: 0,
  MATCHING: 1,
  SEQUENCE: 2,
  DRAG_DROP: 3,
  HOTSPOT: 4,
} as const;
export type QuizType = typeof QUIZ_TYPE[keyof typeof QUIZ_TYPE];

// answer_setting — flat union, consumer đọc subset theo `type`
export interface QuizAnswerSetting {
  has_correct_answer: boolean;
  shuffle: boolean;
  layout?: 0 | 1 | 2;                                    // type 0
  relation?: '1:1' | '1:n' | 'n:1';                       // type 1
  arrow?: 'none' | 'right' | 'left' | 'bidirectional';    // type 1
  is_cycle?: boolean;                                     // type 2
  snap_target?: 0 | 1;                                    // type 3
  snap_type?: 0 | 1;                                      // type 3
  replace_previous?: boolean;                             // type 3
  limit_responses?: boolean;                              // type 4
  before_replay?: 0 | 1;                                  // type 3, 4
}

// quiz_container — outer frame config
export interface QuizContainer {
  question_audio_auto_play: boolean;
  background: { is_filled: boolean; color?: string; image_url?: string };
  skip: { allow: boolean; delay: number };
  replay: { allow: boolean; count: number };
}

// item_container — per-role style
export type ItemContainerRole = 'default' | 'source' | 'target';

export interface ItemContainerStyle {
  display: { image: boolean; audio: boolean; text: boolean };
  background: { is_filled: boolean; color: string };
  border: { is_filled: boolean; color: string };
  text: { size: number; color: string; align: 'left' | 'center' | 'right' };
  w: number;
  h: number;
}

// type 0, 2, 3, 4 → { default }
// type 1         → { source; target }
export type ItemContainer = Partial<Record<ItemContainerRole, ItemContainerStyle>>;

// elements.items
export interface QuizItemContent {
  text?: string;
  audio_url?: string;
}

export interface QuizItem {
  id: string;
  name: string;                              // reference @character/@prop key
  variant?: string;
  geometry: { x: number; y: number };         // % relative on quiz canvas (NOT Geometry)
  image_url?: string;
  is_correct?: boolean;                       // type 0 only
  type?: 'source' | 'target';                  // type 1 only
  order?: number | null;                      // type 2 only — null = distractor
  drop_target_id?: string;                    // type 3 only — FK → target_zones[].id
  [languageKey: string]:
    | QuizItemContent
    | string
    | number
    | boolean
    | { x: number; y: number }
    | null
    | undefined;
}

export interface QuizPair {
  source_id: string;                          // FK → items[].id (type = 'source')
  target_id: string;                          // FK → items[].id (type = 'target')
}

export interface QuizTargetZone {
  id: string;
  name: string;
  type: 0 | 1 | 2;                             // 0=rectangle | 1=oval | 2=triangle
  geometry: Geometry;
  background?: boolean;                        // type 3 only
  background_color?: string;                   // type 3 only
  border?: boolean;                            // type 3 only
  border_color?: string;                       // type 3 only
}

export interface QuizDecorImage {
  name: string;
  image_url: string;
  geometry: Geometry;
}

export interface QuizElements {
  items?: QuizItem[];                          // types 0, 1, 2, 3
  pairs?: QuizPair[];                          // type 1
  target_zones?: QuizTargetZone[];             // types 3, 4
  images?: QuizDecorImage[];                   // types 3, 4
}

// Quiz-level localized content (question + audio)
export interface SpreadQuizLocalized {
  question: string;
  audio_url?: string;
}

// === Spread Quiz (v2) ===
export interface SpreadQuiz {
  id: string;
  title: string;                               // editor-only plain string (NOT localized)
  type: QuizType;                              // immutable after create
  geometry: Geometry;
  "z-index": number;
  player_visible: boolean;
  editor_visible: boolean;
  answer_setting: QuizAnswerSetting;
  quiz_container: QuizContainer;
  item_container: ItemContainer;
  elements: QuizElements;
  [languageKey: string]:
    | SpreadQuizLocalized
    | QuizType
    | Geometry
    | QuizAnswerSetting
    | QuizContainer
    | ItemContainer
    | QuizElements
    | string
    | number
    | boolean
    | undefined;
}

// === Page Types ===
export interface PageData {
  number: string | number;
  type: "normal_page" | "front_matter" | "back_matter" | "dedication";
  layout: string | null;
  background: {
    color: string;
    texture: string | null;
  };
}

// === Image Annotation (Objects space — enhance-annotation flow) ===
// Per-image annotation describing the dynamic state (pose/action/expression) of
// tagged subjects in the scene. Generated via multimodal enhance-annotation API,
// later cloned into remix crop-sheet swap prompts. Additive JSONB [2026-05-27].
// Extensible object — preserve future fields when persisting (currently only
// `description`: plain text, single-lang; empty string = cleared).
export interface SpreadImageAnnotation {
  description?: string;
}

// === Item-level slots (parametric / casting) ===
// Shape: snapshot/illustration-structure.md#parametric_slot-spec / #casting_slot-spec.
// Book-level config lives in `books.parametric_slot` / `books.casting_slot`
// (BookParametricSlot / BookCastingSlot in types/editor.ts); these item-level
// shapes hold the per-item media variants that vary along ONE configured axis.
// Mutual exclusion: an item carries at most one of the two (spec has no pipeline
// for the 2-dimensional product); resolve order prefers casting_slot.

/** One value of the controlling axis + the media generated for it.
 *  `value` is a soft ref into `book.parametric_slot` (dangling → fallback default). */
export interface ItemParametricSlotValue {
  value: string;
  is_default: boolean; // exactly one entry true
  illustrations: Illustration[];
}

/** Item-level parametric slot — item keeps several media versions keyed by the
 *  value of one axis of `book.parametric_slot`. */
export interface ItemParametricSlot {
  /** 'country' | 'religion' | '<char_key>.gender' | '<char_key>.age' | '<photo_key>' */
  key: string;
  values: ItemParametricSlotValue[];
}

/** One actor casted for the item's actant, with the media rendered for them.
 *  `media_url` is a FLAT direct URL (no Illustration Entry, no history) —
 *  deliberate divergence from parametric_slot, see #casting_slot-spec §Divergence. */
export interface ItemCastingSlotActor {
  id: string; // snapshot characters[].key (actor_type 1) | props[].key (actor_type 2)
  actor_type: CastingActorType; // 1 = character, 2 = prop
  media_url: string;
  is_default: boolean; // exactly one entry true
}

/** Item-level casting slot — item renders exactly ONE actant; one media per actor. */
export interface ItemCastingSlot {
  /** soft FK → book.casting_slot.casting_axes[].actants[].id (uuid unique per book,
   *  so the axis id is derived by lookup and never stored here). */
  actant_id: string;
  actors: ItemCastingSlotActor[];
}

// === Spread Item Types ===
export interface SpreadImage {
  id: string;
  title?: string;
  geometry: Geometry;
  stage_variant?: string;
  art_note?: string;
  visual_description?: string;
  image_references?: Array<{ title: string; media_url: string }>;

  // Sketch images (step 2) - direct URL, no illustration variants
  media_url?: string;

  // Illustration images (step 3) - multiple variants, one selected.
  // Provenance fields (type/original_url) added 2026-06-18 — see Illustration.
  illustrations?: Illustration[];
  final_hires_media_url?: string;

  // Retouch-specific optional fields
  "z-index"?: number;
  player_visible?: boolean;
  editor_visible?: boolean;
  aspect_ratio?: string;
  /** **Scene lineage** — id of the `raw_images[]` entry (= the SCENE) this item derives from.
   *  Flat: always the ROOT raw image, never an intermediate clone. Absent = unknown/standalone
   *  scene (valid, not an error). Soft ref — may dangle; never treat as an FK.
   *  Invariants L1–L9: `ai-storybook-design/snapshot/illustration-structure.md#scene-lineage-original_image_id` */
  original_image_id?: string;
  tags?: SpreadTag[];

  // Objects space — batch image annotation (enhance-annotation flow).
  // Additive optional → non-breaking. See SpreadImageAnnotation.
  annotation?: SpreadImageAnnotation;

  // Item-level slots (additive optional → non-breaking). MUTUALLY EXCLUSIVE —
  // at most one is set; ItemSlotModal is the single enforcement point.
  // Presence MUST be tested truthily (`!!item.casting_slot`), never with
  // `'casting_slot' in item` — the write path sets the unused key to `undefined`.
  parametric_slot?: ItemParametricSlot;
  casting_slot?: ItemCastingSlot;
}

export interface SpreadTextbox {
  id: string;
  title?: string;
  [languageKey: string]: SpreadTextboxContent | string | boolean | number | undefined;
  // Retouch only
  "z-index"?: number;
  player_visible?: boolean;
  editor_visible?: boolean;
}

// === Textbox Audio (retouch phase TTS) — chunks-based shape ===
// Shape: ai-storybook-design/snapshot/illustration-structure.md#textboxes
// DB Changelog: ai-storybook-design/DB-CHANGELOG.md §4 (2026-04-28) — BREAKING.
// Old `script`/`settings`/`media` shape dropped; `style_exaggeration`
// renamed `exaggeration`; `speaker_boost`/`seed`/`model` removed;
// per-chunk `voice_id` + `results[]`.

/** Per-word timing within a chunk result. `text` = word glyph,
 *  charStart/charEnd = offset into chunk.script so UI can highlight ranges. */
export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
}

/** Raw ElevenLabs alignment. Persisted verbatim for forward compat. */
export interface RawAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
  [key: string]: unknown;
}

/** A generated audio version for a chunk. Append-only — exactly one with
 *  `is_selected: true` when results[] is non-empty. */
export interface TextboxAudioResult {
  url: string;
  word_timings: WordTiming[];
  raw_alignment: RawAlignment;
  created_time: string;
  is_selected: boolean;
}

/** Single voice + script chunk inside a textbox. Multi-speaker dialog uses
 *  multiple chunks (one voice per chunk).
 *  DB-CHANGELOG 2026-04-29: split sync flag → `script_synced` (script/voice
 *  changes) + `params_synced` (inference param changes).
 *  DB-CHANGELOG 2026-05-14: add optional `reader_key` — preserves author
 *  intent (narrator vs character key) across voice reassignment / lossy
 *  reverse lookup. `voice_id` remains authoritative for TTS. */
export interface TextboxAudioChunk {
  voice_id: string;
  /** Reader key that authored this line (`narrator` | `character_*`). Optional —
   *  written by enhance-narration flow, cleared when user explicitly reassigns
   *  voice via picker. Readers fall back to `voiceToReader[voice_id]` when absent. */
  reader_key?: string;
  script: string;
  stability: number;        // 0..1
  similarity: number;       // 0..1
  exaggeration: number;     // 0..1 (maps to API `style`; renamed from style_exaggeration per DB-CHANGELOG §4 2026-04-28)
  speed: number;            // 0.7..1.2
  script_synced: boolean;   // narrowed: flips false on script/voice change
  params_synced: boolean;   // flips false on inference param change (speed/stability/similarity/exaggeration)
  results: TextboxAudioResult[];
}

/** Top-level textbox audio: rollups + ordered chunks.
 *  DB-CHANGELOG 2026-04-29: rollup `script_synced` → `is_sync`
 *  (BREAKING). Derived as `chunks.every(c => c.script_synced && c.params_synced)`. */
export interface TextboxAudio {
  is_sync: boolean;
  combined_audio_url: string | null;
  word_timings: WordTiming[];
  chunks: TextboxAudioChunk[];
}

export interface SpreadTextboxContent {
  text: string;
  geometry: Geometry;
  typography: Typography;
  audio?: TextboxAudio; // retouch phase only
}

export interface SpreadAnimation {
  order: number;
  type: 0 | 1; // 0=story timeline, 1=object interactive
  group?: string;
  target: {
    id: string; // 'spread' literal when target.type='spread' (Camera Zoom 19 sentinel)
    type: "textbox" | "image" | "video" | "auto_pic" | "audio" | "shape" | "quiz" | "composite" | "spread";
  };
  trigger_type: "on_click" | "on_next" | "with_previous" | "after_previous";
  click_loop?: number;
  must_complete?: boolean;
  effect: {
    type: number;
    geometry?: Geometry;
    delay?: number;
    duration?: number;
    loop?: number;
    amount?: number;
    direction?: "left" | "right" | "up" | "down";
    payload?: {
      ease_time?: number; // Camera (18, 19) — ms, default 500
    };
  };
}

// === Base Spread Interface ===
export interface BaseSpread {
  id: string;
  pages: PageData[];

  // Raw layers (illustration phase — editor-only, player_visible always false)
  raw_images?: SpreadImage[];
  raw_textboxes?: SpreadTextbox[];

  // Playable layers (retouch phase — player + editor visible)
  images: SpreadImage[];
  textboxes: SpreadTextbox[];
  shapes?: SpreadShape[];
  videos?: SpreadVideo[];
  auto_pics?: SpreadAutoPic[];
  auto_audios?: SpreadAutoAudio[];
  audios?: SpreadAudio[];
  quizzes?: SpreadQuiz[];
  composites?: SpreadComposite[];
  animations?: SpreadAnimation[];

  manuscript?: string;
  tiny_sketch_media_url?: string;
  branch_setting?: BranchSetting;
  next_spread_id?: string | null;
}
