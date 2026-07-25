// edit-image-modal-constants.ts — Shared types, edit-tool registry, model/option lists,
// and re-exported layout tokens for the full-screen "Editing Image" workspace
// (design edit-image-modal/README.md §2.2/§2.6). Consolidates the old EditImageModal
// (prompt+removeBg) + EraseImageModal (paint). Layout/theme/z-index are REUSED from the
// swap modal (design §2.6 "reuse swap shell"); this module only carries edit-specific
// types + option lists + numeric ranges.

import { Brush, Maximize, Expand, CircleSlash, Type, ImageOff, Eraser } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { UpscaleModel } from '@/apis/image-api';
import type { ExpandDirection } from '@/apis/retouch-api';

// Re-export so the upscale tab can pull the model union from this constants surface
// (mirror RmbgModel locality), while image-api stays the single allowlist source.
export type { UpscaleModel };

// Re-export the shell layout tokens / z-index / sidebar dims from the swap modal (single
// source — design §2.6). Children import these from HERE so the modal has one constants
// surface, not two import paths (mirror extract-image-modal-constants).
export {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
  HEADER_HEIGHT_PX,
  LEFT_SIDEBAR_WIDTH_PX,
  RIGHT_SIDEBAR_WIDTH_PX,
} from '../../remix-creative-space/swap-crop-sheet-modal/swap-modal-constants';

// ── Shared types (README §2.2) ───────────────────────────────────────────────

/** AI-usage attribution threaded from the mount site → tab commit → callXxx.
 *  Book-edit context sets `snapshotId`; remix context sets `remixId` (discriminator —
 *  wins over snapshotId). EditImageModal mounts in BOTH; the mount picks the field. */
export interface EditImageAttribution {
  snapshotId?: string;
  remixId?: string;
}

/** Result of a tab commit: the new permanent Storage URL + optional AI-usage provenance
 *  (soft ref → ai_service_logs.id). Set by the AI tabs that surface it (inpaint / outpaint /
 *  remove-text / upscale / remove-bg); absent for erasor (plain upload). The shell persists
 *  `aiRequestId` onto the new `edited` Illustration entry (prependVersion). */
export interface EditCommitResult {
  imageUrl: string;
  aiRequestId?: string;
}

/** Edit-tool discriminator. Scope is driven by the `enabled` flag in EDIT_TOOLS below;
 *  `remove_object` is the only deferred slot (rendered disabled with a "Coming soon"
 *  tooltip). `remove_text` is in scope — see 06-remove-text-tab.md. Key order + labels
 *  mirror the mock #edit-fs-tabs (left → right). */
export type EditToolKey =
  | 'inpaint'
  | 'outpaint'
  | 'upscale'
  | 'remove_object'
  | 'remove_text'
  | 'remove_background'
  | 'erasor';

/** Canvas interaction model per tool: `preview` = static <img>; `paint` = interactive
 *  eraser canvas. Compare overrides both to a before/after slider (derived, not a tool). */
export type EditCanvasMode = 'preview' | 'paint';

/** Per-tool metadata. `commit` + `ParamsPanel` (+ `CanvasLayer` for paint) live in the tab
 *  files (remove-bg-tab / eraser-tab); the root only consumes this contract to render the
 *  tab bar + dispatch. */
export interface EditToolContract {
  key: EditToolKey;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  canvasMode: EditCanvasMode;
}

// ── Tool registry (README §2.2 — order + labels match mock #edit-fs-tabs) ──────
export const EDIT_TOOLS: EditToolContract[] = [
  { key: 'inpaint', label: 'Inpaint', icon: Brush, enabled: true, canvasMode: 'paint' },
  { key: 'outpaint', label: 'Outpaint', icon: Maximize, enabled: true, canvasMode: 'preview' },
  { key: 'upscale', label: 'Upscale', icon: Expand, enabled: true, canvasMode: 'preview' },
  { key: 'remove_object', label: 'Remove Object', icon: CircleSlash, enabled: false, canvasMode: 'paint' },
  { key: 'remove_text', label: 'Remove Text', icon: Type, enabled: true, canvasMode: 'preview' },
  { key: 'remove_background', label: 'Remove BG', icon: ImageOff, enabled: true, canvasMode: 'preview' },
  { key: 'erasor', label: 'Erasor', icon: Eraser, enabled: true, canvasMode: 'paint' },
];

/** Default landing tool when `initialTool` is not supplied (README §2.2). Inpaint is now in
 *  scope + leftmost (mock default) → landing = `'inpaint'` (Validation S1 — accepted blast
 *  radius: every consumer opens into Inpaint). */
export const DEFAULT_EDIT_TOOL: EditToolKey = 'inpaint';

/** Per-tool `[+]` button hint (aria-label + tooltip) — README §3.2. */
export const COMMIT_HINTS: Partial<Record<EditToolKey, string>> = {
  inpaint: 'Run inpaint',
  outpaint: 'Run outpaint',
  remove_background: 'Run remove background',
  remove_text: 'Run remove text',
  upscale: 'Run upscale',
  erasor: 'Save erased version',
};

// ── Inpaint tab (04-inpaint-tab.md §2) ───────────────────────────────────────
/** Model allowlist (group `edit-object` — v1 Gemini-only; out-of-allowlist → 422
 *  UNSUPPORTED_MODEL). Select renders even at 1 option (ready for allowlist growth). */
export const INPAINT_MODEL_OPTIONS = ['google/nano-banana-pro'] as const;
export type InpaintModel = (typeof INPAINT_MODEL_OPTIONS)[number];
export const INPAINT_DEFAULT_MODEL: InpaintModel = 'google/nano-banana-pro';
/** Mark = set-of-mark soft hint (NOT a binary mask). Translucent so the model still "sees"
 *  the content under the mark — bright accent so the marked region stands out. */
export const INPAINT_MARK_COLOR = '#3b6cf6';
export const INPAINT_MARK_ALPHA = 0.5;
/** Fixed API image size — NOT exposed (mock has no control). */
export const INPAINT_IMAGE_SIZE = '2K';
/** Prompt textarea maxLength — API rejects > 2000 chars. */
export const INPAINT_PROMPT_MAX = 2000;
/** Client pre-flight cap: composite PNG decoded bytes must stay ≤ this (mirrors API 10MB cap)
 *  → abort BEFORE the call (no 400 round-trip). `base64.length * 0.75` ≈ decoded bytes. */
export const REGION_MAX_DECODED_BYTES = 10 * 1024 * 1024;
/** Reference-image cap (04-inpaint-tab.md §8) — picked provenance refs + uploads GỘP into ONE list;
 *  = the edit-object-image `referenceImages` max. */
export const INPAINT_REF_MAX = 5;
/** Hop cap when walking the `original_url` chain backwards looking for an ancestor's
 *  `ai_request_id` (04-inpaint-tab.md §8.3). Bounds a long/legacy edit chain; combined with the
 *  visited-set it also stops a cyclic chain. */
export const INPAINT_PROV_MAX_HOPS = 8;

// ── Outpaint tab (05-outpaint-tab.md §2) ─────────────────────────────────────
// Re-export the API direction enum so the tab + helpers pull it from this constants surface
// (single type source — mirror UpscaleModel locality). Type-only → no runtime import cycle.
export type { ExpandDirection } from '@/apis/retouch-api';

/** Model allowlist (group `outpaint` — v1 Gemini-only; out-of-allowlist → 422 UNSUPPORTED_MODEL).
 *  Select renders even at 1 option (ready for allowlist growth). */
export const OUTPAINT_MODEL_OPTIONS = ['google/nano-banana-pro'] as const;
export type OutpaintModel = (typeof OUTPAINT_MODEL_OPTIONS)[number];
export const OUTPAINT_DEFAULT_MODEL: OutpaintModel = 'google/nano-banana-pro';
/** Fixed API image size — sent explicit (parity inpaint), not exposed as a control. */
export const OUTPAINT_IMAGE_SIZE = '2K' as const;
/** Dashed preview-frame stroke + faint fill (indigo accent — design §5.2). */
export const OUTPAINT_FRAME_COLOR = 'rgba(99,102,241,0.95)';
export const OUTPAINT_FRAME_FILL = 'rgba(99,102,241,0.06)';
/** Per-edge expand percent. default 0 → `[+]` disabled until the user expands (canCommit gate). */
export const OUTPAINT_RATIO = { min: 0, max: 100, step: 1, default: 0 } as const;
/** Above this per-edge ratio the model must invent > half a frame → soft quality hint (API §96). */
export const OUTPAINT_RATIO_SOFT_MAX = 50;
/** Prompt textarea maxLength — API rejects > 2000 chars. */
export const OUTPAINT_PROMPT_MAX = 2000;
/** Direction dropdown — `value` matches the API enum 1:1 (no mapping layer). */
export const EXPAND_DIRECTION_OPTIONS: ReadonlyArray<{ value: ExpandDirection; label: string }> = [
  { value: 'all', label: 'All sides' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' },
];

// ── Remove BG tab (01-remove-bg-tab.md §2) ───────────────────────────────────

/** Replicate rmbg model allowlist (mock dropdown + API §model + swap RMBG_MODEL_OPTIONS).
 *  FE default matches API default (`bria`); FE still sends explicit `model` on every call. */
export type RmbgModel = '851-labs/background-remover' | 'bria/remove-background';
export const RMBG_MODEL_OPTIONS: readonly RmbgModel[] = [
  'bria/remove-background',
  '851-labs/background-remover',
];
export const DEFAULT_RMBG_MODEL: RmbgModel = 'bria/remove-background';

/** Output background mode. Only `transparent`/`color` reach the API; `blur`/`overlay`
 *  are deferred (rendered disabled — API 04-image-remove-bg has no support yet). */
export type OutputBgMode = 'transparent' | 'color' | 'blur' | 'overlay';
export const DEFAULT_OUTPUT_BG: OutputBgMode = 'transparent';
export const DEFAULT_OUTPUT_COLOR = '#FFFFFF';

// ── Remove Text tab (06-remove-text-tab.md §2) ───────────────────────────────

/** Replicate text-removal model allowlist (group `remove-text` — v1 single entry). Select
 *  renders even at 1 option (ready for allowlist growth). FE default matches API default;
 *  FE still sends explicit `model` on every call (flat, NOT nested modelParams). */
export const REMOVE_TEXT_MODEL_OPTIONS = ['flux-kontext-apps/text-removal'] as const;
export type RemoveTextModel = (typeof REMOVE_TEXT_MODEL_OPTIONS)[number];
export const DEFAULT_REMOVE_TEXT_MODEL: RemoveTextModel = 'flux-kontext-apps/text-removal';

// ── Upscale tab (03-upscale-tab.md §2) ───────────────────────────────────────

/** Replicate upscale model allowlist (mock dropdown + API §Multi-model group `upscale`).
 *  `xinntao/realesrgan` (Anime variant) is listed FIRST and is the default — matches the
 *  2026-06-29 BE group-default flip (sync /api/image/upscale-image + remix job 10). */
export const UPSCALE_MODEL_OPTIONS: readonly UpscaleModel[] = [
  'xinntao/realesrgan',
  'nightmareai/real-esrgan',
  'recraft-ai/recraft-crisp-upscale',
  'alexgenovese/upscaler',
];
export const DEFAULT_UPSCALE_MODEL: UpscaleModel = 'xinntao/realesrgan';

/** Scale stepper: int 1..8, default 2 (mock). API accepts float (0,10] — UI restricts to integer. */
export const SCALE = { min: 1, max: 8, step: 1, default: 2 } as const;

/** ⚡ UI default OFF (false) — diverges from API default TRUE. FE sends faceEnhance EXPLICITLY
 *  (even false) for scalable models so the API default never silently flips it on (03 §5). */
export const DEFAULT_FACE_ENHANCE = false;

/** Watercolor monochrome grain post-process (applied AFTER upscale — Phase 04 spec). Default
 *  toggle ON. KHÁC Scale/FaceEnhance: grain is MODEL-AGNOSTIC — NOT gated by UPSCALE_MODEL_CAPS,
 *  always enabled for every model (incl. recraft). The AMP/BLUR steppers are greyed (disabled,
 *  NOT hidden) only when the Grain toggle itself is OFF. */
export const DEFAULT_GRAIN_ENABLED = true;
/** AMP stepper: int 0..50, default 9 (mock). BE rejects out-of-range with 400 — stepper min/max
 *  is UX, not the security boundary. `seed` NOT exposed → API default. */
export const GRAIN_AMP = { min: 0, max: 50, step: 1, default: 9 } as const;
/** BLUR stepper: float 0..5 step 0.1, default 0.8 (mock). */
export const GRAIN_BLUR = { min: 0, max: 5, step: 0.1, default: 0.8 } as const;

/** Per-model capability gate. `recraft` is fixed-ratio native passthrough → scale has no effect
 *  AND it has no face-enhance field → both controls disabled (03 §4). Switching model keeps the
 *  scale/faceEnhance state, only the disabled flag changes. */
export interface UpscaleModelCaps {
  supportsScale: boolean;
  supportsFaceEnhance: boolean;
}
export const UPSCALE_MODEL_CAPS: Record<UpscaleModel, UpscaleModelCaps> = {
  // xinntao = Anime variant: scale IS honoured, but Face Enhance (GFPGAN) is a no-op on the
  // anime path → toggle disabled (still shown + tooltipped, never hidden). No noise input either.
  'xinntao/realesrgan': { supportsScale: true, supportsFaceEnhance: false },
  'nightmareai/real-esrgan': { supportsScale: true, supportsFaceEnhance: true },
  'alexgenovese/upscaler': { supportsScale: true, supportsFaceEnhance: true },
  'recraft-ai/recraft-crisp-upscale': { supportsScale: false, supportsFaceEnhance: false },
};

// ── Eraser tab (02-eraser-tab.md §2) ─────────────────────────────────────────
export const BRUSH = { min: 1, max: 100, step: 1, default: 30 } as const;
/** Inpaint reuses BRUSH min/max/step but defaults smaller (10px) — finer marks for
 *  targeted region painting vs the eraser's broader strokes. */
export const INPAINT_BRUSH_DEFAULT = 10;
export const DEFAULT_ERASER_COLOR = '#FFFFFF';
/** Strokes count at which Reset asks for confirmation (mirror erase-modal cũ). */
export const RESET_CONFIRM_THRESHOLD = 3;

// ── Canvas zoom (README §2.6 ⚡H) ─────────────────────────────────────────────
/** Stage zoom range — applied as CSS width/height scale on the canvas content (NOT
 *  `transform: scale`, see README §2.6 revision 2026-06-22). Eraser canvas pixel buffer
 *  stays at fitSize; CSS width/height is scaled; cursor coords × zoom/100. */
export const ZOOM = { min: 50, max: 400, step: 5, default: 100 } as const;

// ── Swap-modal-themed outline button class ───────────────────────────────────
/** Classes for shadcn `<Button variant="outline">` inside the swap-modal dark theme.
 *  Default `bg-background` + inherited foreground is unreadable against the modal's
 *  forced-dark surface (text-on-light or light-on-light depending on app theme). Override
 *  with swap-modal CSS variables. Used by Eraser History buttons + RemoveBG dropdown. */
export const SWAP_MODAL_OUTLINE_BUTTON_CLASS =
  'bg-[var(--swap-modal-surface-hover)] border-[var(--swap-modal-border-strong)] text-[var(--swap-modal-text-primary)] hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] focus-visible:ring-[var(--swap-modal-accent)]';
