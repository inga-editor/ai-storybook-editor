// extract-lottie-modal-constants.ts — Constants surface for the standalone Extract-Lottie
// modal (design component/editor-page/shared/extract-lottie-modal/README §2.6). Single source:
// shell layout tokens + z-index come from the swap-crop-sheet modal; the Edit tab reuses the
// Inpaint constants verbatim (NO redefinition). Local constants own the segment/part/lottie surface.

// ── Re-export shell layout tokens / z (parity Edit/Extract modal) ────────────
export {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
} from '../../remix-creative-space/swap-crop-sheet-modal/swap-modal-constants';

// ── Re-export inpaint/eraser constants reused by the Edit + Eraser tabs (single source) ──
export {
  INPAINT_MODEL_OPTIONS,
  INPAINT_DEFAULT_MODEL,
  INPAINT_MARK_COLOR,
  INPAINT_MARK_ALPHA,
  INPAINT_IMAGE_SIZE,
  INPAINT_REF_MAX,
  REGION_MAX_DECODED_BYTES,
  BRUSH,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
} from '../edit-image-modal/edit-image-modal-constants';

// ── Segment (Parts tab) ──────────────────────────────────────────────────────
/** SAM3-only per retouch/02 (nano-banana segment superseded). Single entry → no model picker
 *  choice, but kept as an array for parity with the other modals' model-option surfaces. */
export const SEGMENT_MODEL_OPTIONS = ['mattsays/sam3-image'] as const;
export const SEGMENT_PROMPT_MAX = 500;

// ── Part bbox / aspect ───────────────────────────────────────────────────────
export const PART_ASPECT_RATIOS = ['Free', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const;
/** Minimum bbox dimension (% of original) — resize handles clamp to this. */
export const PART_BBOX_MIN_PCT = 5;
/** Starting rectangle for a hand-drawn manual crop (centered, 40% of the original) — the user
 *  then moves/resizes it before pressing Crop. */
export const MANUAL_DEFAULT_BBOX = { x: 30, y: 30, w: 40, h: 40 } as const;

/** Source-image opacity while an image part (normal/manual) is selected — dims the original so the
 *  selected part's box/asset stands out. Null parts don't dim (they carry no asset to highlight). */
export const SOURCE_DIM_OPACITY = 0.3;

// ── Pivot tab ────────────────────────────────────────────────────────────────
export const PIVOT_STEP = 0.1;

// ── Edit tab ─────────────────────────────────────────────────────────────────
export const DEFAULT_BRUSH_SIZE = 30;
/** Frame drawn around the active part's region while editing so the user sees which part is
 *  selected. Mirrors the Parts-tab active-box highlight (part-box-overlay: white border + accent
 *  glow) for a consistent "this is the selected part" affordance across tabs. */
export const ACTIVE_PART_FRAME_BORDER = '2px solid #ffffff';
export const ACTIVE_PART_FRAME_SHADOW = '0 0 0 1px #3b6cf6, 0 0 10px #3b6cf666';
/** Accent used for the active-part name badge (Parts/Pivot box + Edit frame). */
export const PART_BADGE_ACCENT = '#3b6cf6';

// ── Layout (design README §2.6) ──────────────────────────────────────────────
export const LOTTIE_MODAL_LAYOUT = {
  leftSidebar: 300,
  rightSidebar: 320,
  topbarH: 49,
  stageHeaderH: 49,
  zoomMin: 50,
  zoomMax: 400,
  zoomStep: 5,
  zoomDefault: 100,
  pivotDotPx: 16,
  pivotDotColor: '#f59e0b',
} as const;

// ── Storage folder + .lottie build constants ─────────────────────────────────
export const LOTTIE_PARTS_FOLDER = 'lottie-parts';
/** Placeholder timing for the static rig — user animates externally after download. */
export const LOTTIE_FR = 30;
export const LOTTIE_OP = 90; // 3s @ 30fps
export const LOTTIE_BODYMOVIN_VERSION = '5.7.0';
/** Informational — mirrors the auto-pic upload media cap (validation lives in use-auto-pic-upload). */
export const AUTOPIC_MEDIA_CAP_BYTES = 5 * 1024 * 1024;

// ── Draft persistence (localStorage) ─────────────────────────────────────────
export const LOTTIE_DRAFT_KEY_PREFIX = 'extract-lottie-draft:';
export const LOTTIE_DRAFT_DEBOUNCE_MS = 500;

// ── Mode tabs (design README §2.1) ───────────────────────────────────────────
export const LOTTIE_MODE_TABS = [
  { key: 'parts', label: 'Parts' },
  { key: 'pivot', label: 'Pivot Point' },
  { key: 'edit', label: 'Edit' },
  { key: 'eraser', label: 'Eraser' },
  { key: 'view', label: 'View' },
] as const;
