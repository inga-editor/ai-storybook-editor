// extract-image-modal-constants.ts — Shared types, tab registry, model/layer constants,
// and re-exported layout tokens for the full-screen "Extracting Image" workspace
// (design extract-image-modal/README.md §2.2/§2.6). Consolidates SegmentLayerModal +
// SplitImageModal. Layout/theme/z-index are REUSED from the swap modal (design §2.6);
// this module only carries extract-specific types + option lists + numeric ranges.

import { Tag, Type, Crop, Box, Layers, Image as ImageIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ASPECT_RATIOS, type AspectRatio } from '@/constants/aspect-ratio-constants';
import type { DetectTag } from '@/apis/retouch-api';
import type { CropPreset } from '@/types/editor';

// Re-export so Objects-tab consumers have one constants surface.
export type { DetectTag };
// CropPreset SSOT lives in types/editor (next to Book). Re-export so Crops-tab
// consumers keep one constants surface (import direction stays feature→types).
export type { CropPreset };

// Re-export the shell layout tokens / z-index / sidebar dims from the swap modal (single
// source — design §2.6 "reuse swap shell"). Children import these from HERE so the modal
// has one constants surface, not two import paths.
export {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  HEADER_HEIGHT_PX,
  LEFT_SIDEBAR_WIDTH_PX,
  RIGHT_SIDEBAR_WIDTH_PX,
} from '../../remix-creative-space/swap-crop-sheet-modal/swap-modal-constants';

// ── Shared types (README §2.2) ───────────────────────────────────────────────

/** Tab discriminator. `segment` + `layering` are in scope; the rest are deferred
 *  registry slots (rendered disabled with a "Coming soon" tooltip). */
export type ExtractTabKey =
  | 'segment'
  | 'layering'
  | 'get_object'
  | 'get_text'
  | 'crop'
  | 'background';

/** How a fresh run merges into the tab's grid — segment accumulates, layering replaces. */
export type ExtractRunMode = 'append' | 'replace';

// ── Objects-tab box types (03-objects-tab.md §2) ─────────────────────────────

/** Provenance of a crop box: manual `[+]` vs AI `Detect`. */
export type ObjectBoxSource = 'manual' | 'detected';

/** Per-box ratio selector value. `'Free'` = resize with no aspect lock; otherwise one
 *  of the 10 shared aspect ratios (single source: aspect-ratio-constants). */
export type ObjectRatio = 'Free' | AspectRatio;

/** One interactive crop box on the source canvas (geometry in % 0-100 — matches
 *  crop-object-image + SpreadImage). `detected`-only fields carry to spawn. */
export interface ObjectBox {
  id: string;
  x: number; y: number; w: number; h: number; // % (0-100), top-left + size
  ratio: ObjectRatio;
  source: ObjectBoxSource;
  color: string;  // OBJECT_BOX_COLORS[idx % n] — border + badge + swatch
  label: string;  // badge — manual: "Object {n}"; detected: humanized tag
  // ⚡ detected-only metadata (carry to spawn; does NOT affect crop pixels):
  tag?: DetectTag;
  object?: string;        // "@key/variant" mention (audit)
  apiRatio?: AspectRatio; // server clamp ratio (07) — default `ratio` for detected box
  confidence?: number;
}

/** One ephemeral, pre-commit result. Unifies the old `SegmentResult` (1/run) and
 *  `SplitLayerResult` (N/run). `media_url` is the API ephemeral URL until commit swaps
 *  in the uploaded Storage publicUrl. */
export interface ExtractResult {
  id: string;
  media_url: string;
  sourceTab: ExtractTabKey;
  title: string;
  /** ⚡ AI provenance — soft ref → ai_service_logs.id (cost attribution). Set ONLY by the AI
   *  extract tabs that generate new pixels: Layers (N results share ONE id — 1 call = 1 id) +
   *  Background. Absent for CV crop results (Objects/Crops) — they carry no AI provenance.
   *  Threaded into the spawned illustration entry's `ai_request_id` by buildExtractImages. */
  aiRequestId?: string;
  meta?: {
    prompt?: string;
    coverageRatio?: number;
    layerIndex?: number;
    // ⚡ Objects tab — geometry-positioned spawn (% 0-100) + carried detect metadata.
    geometry?: { x: number; y: number; w: number; h: number };
    ratio?: string;
    tag?: DetectTag;
    boxIndex?: number;
    // ⚡ Background tab — media_url is already a permanent Storage URL (API passthrough),
    // so commit skips the ephemeral re-upload; removedCount mirrors API meta.removedCount.
    permanent?: boolean;
    removedCount?: number;
  };
}

/** Per-tab metadata. `runExtract` + `ParamsPanel` live in the tab files (segment-tab /
 *  layers-tab); the root only consumes this contract to render the tab bar + dispatch. */
export interface ExtractTabContract {
  key: ExtractTabKey;
  label: string;
  icon: LucideIcon;
  runMode: ExtractRunMode;
  enabled: boolean;
  /** Canvas interaction model — default `result-grid` (Segment/Layers); Objects = `box-overlay`. */
  interactionMode?: 'result-grid' | 'box-overlay';
  /** Result canvas render — default `image` (single <img>); Background = `compare` (before/after slider). */
  resultPreview?: 'image' | 'compare';
  /** ⭐ Extract commit path — default `upload-ephemeral`; Objects = `crop-on-extract`;
   *  Background = `passthrough` (API returns a permanent URL → no re-upload);
   *  Texts = `spawn-textbox` (client-side only — spawn raw_textboxes, no upload/API). */
  commitMode?: 'upload-ephemeral' | 'crop-on-extract' | 'passthrough' | 'spawn-textbox';
  /** Right Params sidebar — default true (model/threshold controls). Crops = false
   *  (no model → root hides the sidebar so the canvas spans full width). */
  hasParams?: boolean;
  /** Box-overlay `[+]` add-manual-box affordance — default true (Objects). Crops keeps its own
   *  `[+]`; Texts = false (Detect-only, no manual box → root renders no `[+]`). */
  manualAdd?: boolean;
}

/** One spread image offered as a "remove from scene" target in the Background tab.
 *  `media_url` is the effective (resolved) URL; `id` keys the chip + de-dups + excludes source. */
export interface BackgroundRemoveCandidate {
  id: string;                       // SpreadImage id (key + de-dup, excludes the source image)
  media_url: string;                // effective URL (resolveEffectiveImageUrl)
  title?: string;
  type?: 'character' | 'prop';
}

// ── Tab registry (README §2.2 — order + labels match mock #ex-fs-tabs) ────────
export const EXTRACT_TABS: ExtractTabContract[] = [
  { key: 'get_object', label: 'Objects', icon: Tag, runMode: 'replace', enabled: true, interactionMode: 'box-overlay', commitMode: 'crop-on-extract' },
  { key: 'get_text', label: 'Texts', icon: Type, runMode: 'replace', enabled: true, interactionMode: 'box-overlay', commitMode: 'spawn-textbox', manualAdd: false },
  { key: 'crop', label: 'Crops', icon: Crop, runMode: 'replace', enabled: true, interactionMode: 'box-overlay', commitMode: 'crop-on-extract', hasParams: false },
  { key: 'segment', label: 'Segments', icon: Box, runMode: 'append', enabled: true },
  { key: 'layering', label: 'Layers', icon: Layers, runMode: 'replace', enabled: true },
  { key: 'background', label: 'Background', icon: ImageIcon, runMode: 'append', enabled: true, resultPreview: 'compare', commitMode: 'passthrough' },
];

/** Default tab when `initialTab` is not supplied (README §2.2). Objects is the landing tab. */
export const DEFAULT_EXTRACT_TAB: ExtractTabKey = 'get_object';

// ── Segments tab (01-segment-tab.md §2) ──────────────────────────────────────
// ⚡v1 single SAM3 dispatch; `threshold` not exposed (API default 0.5 — YAGNI).
export const SEGMENT_MODEL_OPTIONS = ['mattsays/sam3-image'] as const;
export const DEFAULT_SEGMENT_MODEL = 'mattsays/sam3-image';

// ── Layers tab (02-layers-tab.md §2) ─────────────────────────────────────────
// ⚡v1 single Qwen dispatch; `description`/`seed` not exposed (API defaults).
export const LAYERS_MODEL_OPTIONS = ['qwen/qwen-image-layered'] as const;
export const DEFAULT_LAYERS_MODEL = 'qwen/qwen-image-layered';
export const LAYER_COUNT_MIN = 2;
export const LAYER_COUNT_MAX = 8; // API cap (01-layering-image) — NOT 10, see 02-layers-tab §7.
export const LAYER_COUNT_DEFAULT = 3;

// ── Objects tab (03-objects-tab.md §2) ───────────────────────────────────────
// Detect model — allowlist group `detect-objects` (07 §Notes, v1 Gemini-only).
// ⚠️ Mock UI ghi 'google/gemini-3-flash' = SAI. API default = 'google/gemini-3.5-flash'.
export const BOUNDING_MODEL_OPTIONS = ['google/gemini-3.5-flash'] as const;
export const DEFAULT_BOUNDING_MODEL = 'google/gemini-3.5-flash';

/** Per-box ratio options — `'Free'` + the 10 shared ratios (DRY: single source). */
export const OBJECT_RATIOS: readonly ObjectRatio[] = ['Free', ...ASPECT_RATIOS.map((r) => r.value)];

/** Stable distinct colors for box border + badge + sidebar swatch (cycled by index). */
export const OBJECT_BOX_COLORS = ['#3b6cf6', '#f59e0b', '#22c55e', '#ef4444', '#a855f7', '#14b8a6'] as const;

export const OBJECT_DEFAULT_BOX_SIZE_PERCENT = 30; // manual [+] box edge, % of canvas
export const OBJECT_MIN_BOX_SIZE_PERCENT = 1;      // guard: < 1% → degenerate (anti EMPTY_CROP_RESULT)
export const CROP_BATCH_SIZE = 3;                  // crop-object-image cap = 1..3 box/call → chunk

// ── Crops tab (05-crops-tab.md §2) ───────────────────────────────────────────
// Frame-based crop boxes (NO AI/Detect, NO tag) with book-level reusable presets
// (books.crop_presets[]). Reuses the Objects box-overlay shell + crop-object-image
// commit; the dropdown selects a CropPreset instead of an aspect ratio.

/** One interactive crop box on the source canvas (geometry % 0-100). `presetId`
 *  links to a `crop_presets[]` entry (null = Custom/free) — drives Save-upsert,
 *  the dropdown current value, and the dirty `*` marker. */
export interface CropBox {
  id: string;
  x: number; y: number; w: number; h: number; // % (0-100), top-left + size
  title: string;             // sidebar label + spawned title; manual = "Custom {n}"
  presetId: string | null;   // crop_presets[].id this box was applied from (null = Custom)
}

/** First dropdown option = free-form (no geometry constraint). */
export const CUSTOM_PRESET_LABEL = 'Custom';
export const CROP_DEFAULT_BOX_INSET_PERCENT = 10; // [+] box margin per edge, % of canvas → 80×80
export const CROP_MIN_BOX_SIZE_PERCENT = 1;      // guard degenerate (anti EMPTY_CROP_RESULT)

// ── Background tab (04-background-tab.md §2 / api/retouch/08-generate-background) ──
// ⚡v1 single Gemini dispatch (nano-banana-pro); aspectRatio/imageSize auto-derived (omit).
export const BACKGROUND_MODEL_OPTIONS = ['google/nano-banana-pro'] as const;
export const DEFAULT_BACKGROUND_MODEL = 'google/nano-banana-pro';
export const REMOVE_OBJECTS_MIN = 1;   // API requires ≥1 object to remove
export const REMOVE_OBJECTS_MAX = 16;  // API cap (08 §Parameters) — seed/add clamp here
export const BACKGROUND_PROMPT_MAX = 2000;

// ── Texts tab (06-texts-tab.md §2 / api/retouch/11-detect-texts) ─────────────
// OCR Detect (Gemini) → numbered select-only boxes → ⭐ Extract spawns raw_textboxes[] into the
// current spread (client-side, NO API). Font size is NOT inferred from box height — spawned
// textboxes use the book typography default (Validation S1); user adjusts per-box later.

/** ⭐ Extract commit result of the Texts tab (client-side spawn, no API/upload). Minimal by
 *  design — NO `fontSize` (typography comes from the book default at spawn, Validation S1). */
export interface ExtractedTextbox {
  content: string;
  /** % 0-100 relative to the SOURCE image (already ÷100 from basis 10000). */
  geometry: { x: number; y: number; w: number; h: number };
}

/** One detected text region on the source canvas (select-only — geometry is immutable). Mirrors
 *  ObjectBox for the shared overlay but carries an ordinal `index` badge instead of a ratio. */
export interface TextBox {
  id: string;
  index: number;   // 1-based ordinal → numbered badge (no re-number on delete)
  content: string;
  x: number; y: number; w: number; h: number; // % 0-100 (÷100 from basis 10000)
  color: string;   // TEXT_BOX_COLORS[idx % n] — border + badge
  confidence?: number;
}

// OCR model — allowlist group `detect-texts` (11 §Notes, v1 Gemini-only). Same default as Objects.
export const OCR_MODEL_OPTIONS = ['google/gemini-3.5-flash'] as const;
export const DEFAULT_OCR_MODEL = 'google/gemini-3.5-flash';

/** Stable distinct colors for text box border + numbered badge (cycled by index). */
export const TEXT_BOX_COLORS = ['#3b6cf6', '#f59e0b', '#22c55e', '#ef4444', '#a855f7', '#14b8a6'] as const;
// ⚡ NO font-size constants — spawned textboxes use book typography default (Phase 05); the
//    box-height→font heuristic was dropped (Validation S1).
