// swap-modal-constants.ts — Constants for SwapCropSheetModal (design §2.2 + §4.12).
// Kept in a dedicated module so header / sidebar / stage sub-components can share
// the same option lists and numeric ranges without re-importing the modal root.

import type { SwapModelParams } from '@/types/remix';

/** Entity kind discriminator — mirrors the inline union used across the
 *  remix types (`'character' | 'prop' | 'mix'`). Declared here so modal
 *  sub-components share one named alias. */
export type RemixEntityType = 'character' | 'prop' | 'mix';

/** AI swap model options (right sidebar, group 'swap'). ⚡2026-06-13 Gemini-only:
 *  v1 dispatch supports only nano-banana-pro; non-Gemini models are registered
 *  NOT_SUPPORTED backend (→422 UNSUPPORTED_MODEL), so we do not list dead
 *  options in the UI. Re-add (gpt-image-2 / seedream) when a provider adapter
 *  ships. */
export const SWAP_MODEL_OPTIONS = ['google/nano-banana-pro'] as const;

/** AI remove-background model options (right sidebar, tab Remove BG —
 *  ⚡2026-06-12 placeholder, job 09 takes no `model_params` v1). */
export const RMBG_MODEL_OPTIONS = [
  'bria/remove-background',
  '851-labs/background-remover',
] as const;

/** AI upscale model options (right sidebar — job 10 `model_params.model`).
 *  `xinntao/realesrgan` (Anime variant) is listed FIRST and is the default —
 *  matches the 2026-06-29 BE group-default flip. */
export const UPSCALE_MODEL_OPTIONS = [
  'xinntao/realesrgan',
  'nightmareai/real-esrgan',
  'recraft-ai/recraft-crisp-upscale',
  'alexgenovese/upscaler',
] as const;

/** Watercolor grain post-process knobs (right sidebar, group 'upscale' →
 *  TOP-LEVEL job-10 body `grain`, NOT `model_params`). ⚡2026-06-29.
 *  MODEL-AGNOSTIC: grain runs AFTER upscale on ALL 4 models, so — unlike Noise
 *  (`modelSupportsNoise`) — these controls are NEVER gated by the picked model;
 *  amp/blur only grey out when the toggle is off. Server clamps amp→0..50,
 *  blur→0..5 (phase 03 normalize) — FE bounds are UX only. `seed` is omitted by
 *  the modal (backend default + per-crop offset). Declared BEFORE
 *  DEFAULT_SWAP_PARAMS (which seeds from it) to avoid a const TDZ. */
export const GRAIN = {
  enabledDefault: true,
  amp: { min: 0, max: 50, step: 1, default: 9 },
  blur: { min: 0, max: 5, step: 0.1, default: 0.8 },
} as const;

/** Default right-sidebar params — re-applied on every modal open (ephemeral).
 *  ⚡2026-06-12: per-tab groups (swap / rmbg / upscale + noise); `scale`
 *  removed — job 10 derives PRINT 300 DPI from the layer geometry itself.
 *  ⚡2026-06-29: grain knobs (group 'upscale'); default toggle ON. */
export const DEFAULT_SWAP_PARAMS: SwapModelParams = {
  swapModel: 'google/nano-banana-pro',
  swapTemperature: 0.25,
  rmbgModel: 'bria/remove-background',
  upscaleModel: 'xinntao/realesrgan',
  noise: 1.5,
  grainEnabled: GRAIN.enabledDefault,
  grainAmp: GRAIN.amp.default,
  grainBlur: GRAIN.blur.default,
};

/** Zoom slider range — applied as the stage canvas-inner `width/height`
 *  (not `transform: scale()`, so `scrollWidth/Height` stay accurate for
 *  fit + anchor scrolling). `min` is 10 so a large sheet (e.g. 3000×1285)
 *  can fit-to-canvas inside a narrow viewport (design 05-03 §4.2/§4.6). */
export const ZOOM = { min: 10, max: 400, step: 5, default: 100 } as const;

/** Temperature stepper range (right sidebar, group 'swap' — Gemini
 *  `generationConfig.temperature`). ⚡2026-06-13 WIRED: one shared stepper for
 *  Sprites + Crops; forwarded as `model_params.params.temperature`. Backend
 *  clamps to [0,2]. Default 0.25 (modal always sends the stepper value; a job's
 *  historical 0.4 default only applies on direct API calls that omit
 *  `model_params`). */
export const TEMPERATURE = { min: 0, max: 2, step: 0.05, default: 0.25 } as const;

/** Noise stepper range (right sidebar, group 'upscale' — denoise strength).
 *  ⚡2026-06-13 WIRED → `model_params.params.noise`. Only models exposing a
 *  denoise input consume it (see `modelSupportsNoise`); real-esrgan /
 *  recraft-crisp-upscale ignore it — backend drops the key as defense. */
export const NOISE = { min: 0, max: 10, step: 0.1, default: 1.5 } as const;

/** Upscale models exposing a denoise input (job 10 registry §96-102). The Noise
 *  stepper is disabled + tooltipped when the picked model isn't here:
 *  `xinntao/realesrgan` (Anime variant — no noise input),
 *  `nightmareai/real-esrgan` (no noise input) and
 *  `recraft-ai/recraft-crisp-upscale` (fixed crispness) all ignore noise; only
 *  `alexgenovese/upscaler` exposes denoise. Backend drops the key as defense
 *  even if sent. KISS: a Set, not a per-model object. */
const UPSCALE_MODELS_WITH_NOISE = new Set<string>(['alexgenovese/upscaler']);

export function modelSupportsNoise(upscaleModel: string): boolean {
  return UPSCALE_MODELS_WITH_NOISE.has(upscaleModel);
}

/** Each batch must keep at least this many crop sheets. */
export const SHEET_MIN = 1;

/** A remix must keep at least this many batches — ⚡2026-06-12 CHỈ stage
 *  `'mixes'` (auto-seeded); rmbgs/upscales allow 0 batches (empty-state CTA). */
export const BATCH_MIN = 1;

/** A remix must keep at least this many sprites (Variants tab). */
export const SPRITE_MIN = 1;

/** Display label for a sprite row + its confirm-dialog / take-back-overlay
 *  name. The Variants tab renders sprites as "Batch N" for UI parity with the
 *  stage `BATCHES` sidebars — the underlying data model stays `sprite`. Derived
 *  from `order` (not the persisted `name`, which seeds as "Sprite N"), so old
 *  and new rows render identically with no data migration. */
export const spriteBatchLabel = (order: number): string => `Batch ${order + 1}`;

/** Composer parity — colours mirror `DEFAULT_FRAME_*` in
 *  `ai-storybook-python-api/src/models/requests/build_crop_sheet.py`. The
 *  client-side preview (`ComposedCropSheet`) reproduces the PNG the Python
 *  composer bakes: `gutterColor` fills the canvas (so transparent crop areas
 *  read as that colour, not a checkerboard), `cellStrokeColor` strokes each
 *  cell's outer bbox. FE does NOT send a `frame` payload, so these colours are
 *  the live contract — keep in sync if the API defaults change.
 *
 *  Stroke width: the composer draws `cellStrokeWidthSheetPx` in SHEET pixels.
 *  The preview canvas is scaled by `zoomLevel/100`, so the parity CSS width is
 *  `cellStrokeWidthSheetPx × zoomLevel/100` (see `resolveStrokePx`). Clamped to
 *  `[cellStrokeMinPx, cellStrokeMaxPx]` so it stays visible at low zoom and
 *  never dominates at high zoom. */
export const COMPOSER_FRAME = {
  // 2026-05-29: flipped magenta (#FF00FF) → white, parity with backend
  // DEFAULT_FRAME_GUTTER_COLOR. Cell delineation now relies on the black stroke.
  gutterColor: '#FFFFFF',
  cellStrokeColor: '#000000',
  cellStrokeWidthSheetPx: 4,
  cellStrokeMinPx: 1,
  cellStrokeMaxPx: 4,
} as const;

/** Maps a zoom % to the parity stroke width in CSS px (clamped). Single source
 *  for both the border width and the wrapper inflate offset. */
export function resolveStrokePx(zoomLevel: number): number {
  const scaled = (COMPOSER_FRAME.cellStrokeWidthSheetPx * zoomLevel) / 100;
  return Math.max(
    COMPOSER_FRAME.cellStrokeMinPx,
    Math.min(COMPOSER_FRAME.cellStrokeMaxPx, scaled),
  );
}

// ── Layout constants (design §4.12) ──────────────────────────────────────────
export const HEADER_HEIGHT_PX = 49;
export const LEFT_SIDEBAR_WIDTH_PX = 300;
export const RIGHT_SIDEBAR_WIDTH_PX = 320;

// ── Dark theme tokens (design §4.12 + remix.html mockup ref) ─────────────────

/** Dark palette tokens for SwapCropSheetModal (design §4.12 + remix.html ref).
 *  Applied as CSS variables on the modal root element; child components read
 *  via Tailwind arbitrary values e.g. `bg-[var(--swap-modal-surface)]`.
 *  Typed as `Record<string, string>` (React's `CSSProperties` doesn't allow
 *  `--*` custom-property keys; cast at the consumer when spreading into `style`). */
export const SWAP_MODAL_TOKENS = {
  '--swap-modal-backdrop': 'rgba(8, 10, 18, 0.96)',
  '--swap-modal-bg': '#0a0d18',
  '--swap-modal-surface': 'rgba(255, 255, 255, 0.03)',
  '--swap-modal-surface-hover': 'rgba(255, 255, 255, 0.06)',
  '--swap-modal-surface-hover-strong': 'rgba(255, 255, 255, 0.14)',
  '--swap-modal-selection': 'rgba(59, 108, 246, 0.18)',
  '--swap-modal-border': 'rgba(255, 255, 255, 0.08)',
  '--swap-modal-border-strong': 'rgba(255, 255, 255, 0.18)',
  '--swap-modal-text-primary': '#ffffff',
  '--swap-modal-text-secondary': 'rgba(255, 255, 255, 0.7)',
  '--swap-modal-text-muted': 'rgba(255, 255, 255, 0.55)',
  '--swap-modal-accent': '#3b6cf6',
  '--swap-modal-accent-hover': '#2f5ce0',
  '--swap-modal-accent-soft': 'rgba(59, 108, 246, 0.12)',
  '--swap-modal-card-bg': '#14171f',
  '--swap-modal-canvas-bg': '#0c0f16',
  '--swap-modal-sheet-frame-bg': '#ffffff', // sheet frame still white (pop on dark canvas)
} as const satisfies Record<string, string>;

/** Z-index layering — swap modal vs Variants overlay (design §4.12).
 *  `confirmDialog` must sit ABOVE `swapModal`: the shared AlertDialog ships at
 *  z-50, which the full-screen swapModal (4000) would otherwise occlude — the
 *  relayout-confirm popup mounts but is painted behind the modal (invisible). */
export const Z_INDEX = {
  swapModal: 4000,
  /** Destructive confirm AlertDialog (relayout + crop-preset delete). Bumped 4100→4200
   *  so it paints ABOVE the per-box preset Select dropdown (selectDropdown 4100) when a
   *  confirm is raised over a box-overlay tab — single source for every consumer. */
  confirmDialog: 4200,
  /** Read-only remix-settings review dialog (Sprites tab header) — same layer
   *  constraint as confirmDialog: must paint ABOVE the full-screen swap modal. */
  reviewModal: 4100,
  /** Parameter-sidebar Select dropdowns. Radix popper copies the content's
   *  computed z-index onto its portal wrapper; shadcn ships SelectContent at
   *  z-50, which the full-screen swapModal (4000) occludes — the dropdown opens
   *  but paints behind the modal (invisible/unselectable). Must clear swapModal. */
  selectDropdown: 4100,
  /** Radix Tooltip content. Shared shadcn `TooltipContent` ships at z-50, which
   *  the full-screen swapModal (4000) occludes — the tooltip mounts on hover but
   *  paints behind the modal (invisible). Every in-modal tooltip (per-row action,
   *  add-batch/sprite, Compare) must clear swapModal. ⚡2026-06-26. */
  tooltip: 4100,
  variantsModal: 5000,
} as const;

/** Icon SVG path for [▣] (variants visual) button — from remix.html mockup.
 *  Inlined inside <svg> in Phase 04 sidebar rewrite (KISS — no extra file). */
export const VARIANT_ICON_PATH =
  'M3 3 H21 V21 H3 Z M12 3 V21 M12 8 H17 M12 12 H17 M12 16 H17';
