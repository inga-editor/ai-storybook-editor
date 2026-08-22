// edit-image-modal-utils.ts — Pure helpers for the EditImageModal shell, kept separate
// from the component for unit testing (react-refresh/only-export-components) and DRY.
// "version" is purely a UI label over the canonical `Illustration` entry (design §2.2 —
// NO new data type); these helpers operate on `Illustration[]` directly.

import type { Illustration } from '@/types/prop-types';
import type { ReferenceImage } from '@/types/remix';
import type { UpscaleModel, UpscaleImagePayload } from '@/apis/image-api';
import type { ExpandDirection, OutpaintImageParams } from '@/apis/retouch-api';
import { createLogger } from '@/utils/logger';
import {
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/constants/aspect-ratio-constants';
import {
  UPSCALE_MODEL_CAPS,
  REGION_MAX_DECODED_BYTES,
  OUTPAINT_IMAGE_SIZE,
  INPAINT_PROV_MAX_HOPS,
} from './edit-image-modal-constants';
import { type Stroke, paintStrokesOnCtx } from './erase-stroke-engine';

const log = createLogger('Editor', 'EditImageModalUtils');

/** Carries the API failure's errorCode/httpStatus through a thrown Error so the shell's
 *  catch can map it via `mapEditError` (single mapping surface). Tabs throw this for API
 *  failures; client-side issues (e.g. canvas CORS taint) throw a plain Error. */
export class EditApiError extends Error {
  readonly errorCode?: string;
  readonly httpStatus?: number;

  constructor(message: string, opts?: { errorCode?: string; httpStatus?: number }) {
    super(message);
    this.name = 'EditApiError';
    this.errorCode = opts?.errorCode;
    this.httpStatus = opts?.httpStatus;
  }
}

/** ISO-8601 timestamp for new version entries. Isolated so tests can spy if needed. */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Display-only fallback version when `illustrations[]` is empty (sketch-phase image with
 *  only `media_url`). NOT written to the store on open (design §2.4 override — Validation
 *  S1); the first commit persists a real version. `type='created'` (no edit provenance). */
export function versionFromMediaUrl(mediaUrl: string): Illustration {
  return {
    media_url: mediaUrl,
    created_time: nowISO(),
    is_selected: true,
    type: 'created',
  };
}

/** Single writer of `illustrations[]` (design §2.2). Prepends the committed result as a
 *  new selected `type='edited'` entry carrying `original_url` (the immediate-prior source
 *  → feeds Compare), and deselects every existing entry. Returns a fresh array; the shell
 *  hands it to `onUpdateIllustrations` (parent persists). */
export function prependVersion(
  versions: Illustration[],
  mediaUrl: string,
  originalUrl: string,
  aiRequestId?: string,
): Illustration[] {
  const newEntry: Illustration = {
    type: 'edited',
    original_url: originalUrl,
    media_url: mediaUrl,
    created_time: nowISO(),
    is_selected: true,
    // Provenance soft ref → ai_service_logs.id (absent for erasor upload / remove-bg).
    ...(aiRequestId ? { ai_request_id: aiRequestId } : {}),
  };
  return [newEntry, ...versions.map((v) => ({ ...v, is_selected: false }))];
}

/** Maps a thrown commit error → user-facing toast message (design 01/03 §3 error tables).
 *  Prefers the typed `EditApiError.errorCode`; falls back to CORS detection on plain
 *  Errors, then the raw message, then a generic message. Never surfaces internals.
 *  ⚡ Tab-aware (Validation S1): `opts.actionLabel` (e.g. 'Remove background' / 'Upscale') is
 *  threaded by the shell so the generic REPLICATE_ERROR/TIMEOUT wording names the active tool;
 *  no-arg default = 'Xử lý ảnh'. Shared across all tabs (single mapping surface). */
export function mapEditError(err: unknown, opts?: { actionLabel?: string }): string {
  const code = err instanceof EditApiError ? err.errorCode : undefined;
  if (code) {
    switch (code) {
      case 'UNSUPPORTED_MODEL':
        return 'Model không hỗ trợ.';
      case 'IMAGE_FETCH_ERROR':
        return 'Không tải được ảnh nguồn.';
      case 'INPUT_TOO_LARGE_FOR_MODEL':
        return 'Ảnh quá lớn để upscale — giảm scale hoặc chọn ảnh nhỏ hơn.';
      case 'IMAGE_TOO_SMALL_FOR_MODEL':
        return 'Ảnh quá nhỏ cho model này (tối thiểu 256px mỗi chiều) — chọn model khác hoặc ảnh lớn hơn.';
      case 'OUTPUT_FETCH_ERROR':
        return 'Ảnh kết quả quá lớn — giảm scale.';
      case 'REPLICATE_RATE_LIMIT':
      case 'GEMINI_RATE_LIMIT':
        return 'Đang quá tải, thử lại sau ít giây.';
      case 'REPLICATE_ERROR':
      case 'TIMEOUT':
      case 'NO_IMAGE_RESPONSE':
      case 'GEMINI_ERROR':
        return `${opts?.actionLabel ?? 'Xử lý ảnh'} thất bại, vui lòng thử lại.`;
      case 'SSRF_BLOCKED':
        return 'URL ảnh không hợp lệ.';
      case 'CONNECTION_ERROR':
        return 'Mất kết nối tới máy chủ — vui lòng thử lại.';
      // ── Inpaint / edit-object-image (Gemini) codes (04-inpaint-tab.md §3) ──
      case 'SAFETY_FILTER_BLOCKED':
        return 'Nội dung prompt/ảnh vi phạm policy.';
      case 'REGION_ASPECT_MISMATCH':
        return 'Tỷ lệ vùng khoanh không khớp ảnh nguồn.';
      case 'REGION_TOO_LARGE':
        return 'Ảnh quá lớn để inpaint — chọn version nhỏ hơn.';
      case 'VALIDATION_ERROR':
        return 'Ảnh vùng khoanh không hợp lệ.';
      // ── flux-fill-pro binary-mask codes (design §3 — defensive: FE gates strokes + sets kind) ──
      case 'REGION_REQUIRED':
        return 'Model này cần khoanh vùng — hãy tô vùng cần sửa.';
      case 'MASK_SIZE_MISMATCH':
        return 'Kích thước vùng mask không khớp ảnh nguồn.';
      case 'REGION_KIND_MISMATCH':
        return 'Loại vùng khoanh không phù hợp với model.';
      case 'STORAGE_UPLOAD_ERROR':
        return 'Lưu ảnh thất bại, vui lòng thử lại.';
      // ── Outpaint / outpaint-image source-decode failure (05-outpaint-tab.md §3) ──
      case 'DECODE_ERROR':
        return 'Ảnh nguồn lỗi, không đọc được kích thước.';
      // Map INTERNAL_ERROR to the generic line explicitly so a raw server message never leaks.
      case 'INTERNAL_ERROR':
        return 'Đã có lỗi xảy ra, vui lòng thử lại.';
      default:
        break;
    }
  }
  if (err instanceof Error) {
    if (/tainted|CORS/i.test(err.message)) {
      return 'Không export được ảnh (CORS) — kiểm tra cấu hình CORS của bucket.';
    }
    if (err.message) return err.message;
  }
  return 'Đã có lỗi xảy ra, vui lòng thử lại.';
}

/** Watercolor grain options the upscale commit always sends (Phase 04). `seed` is NOT exposed
 *  in the UI → omitted → API default. The toggle's `enabled:false` turns grain off, but the FE
 *  NEVER omits the object (API omit=off; we send explicit so the contract is unambiguous). */
export interface UpscaleGrainOptions {
  enabled: boolean;
  amp: number;
  blur: number;
}

/** Pure payload shaper for the upscale commit (Validation S1 — unit-tested in isolation).
 *  ⚡ faceEnhance is sent EXPLICITLY (even false) for models that support it, so the API's
 *  default-TRUE never silently overrides a user OFF. recraft (no face-enhance field) →
 *  `params: {}` to avoid the per-model allowlist clamp (03 §3). `grain` is sent as a TOP-LEVEL
 *  explicit object on EVERY call — model-agnostic, never gated by caps (Phase 04). */
export function buildUpscalePayload(
  model: UpscaleModel,
  scale: number,
  faceEnhance: boolean,
  imageUrl: string,
  grain: UpscaleGrainOptions,
): UpscaleImagePayload {
  const caps = UPSCALE_MODEL_CAPS[model];
  const params = caps.supportsFaceEnhance ? { faceEnhance } : {};
  return { imageUrl, scale, modelParams: { model, params }, grain };
}

// ── Outpaint helpers (05-outpaint-tab.md §2/§5) ───────────────────────────────

/** Per-direction edge flags — FE mirror of the backend edge map (design §2). 1 = that edge
 *  expands by `expandRatio`. Used by BOTH the dashed preview frame AND the Compare overlay so
 *  the two never disagree (single geometry source). */
export const DIRECTION_EDGES: Record<ExpandDirection, { t: 0 | 1; r: 0 | 1; b: 0 | 1; l: 0 | 1 }> = {
  all: { t: 1, r: 1, b: 1, l: 1 },
  top: { t: 1, r: 0, b: 0, l: 0 },
  bottom: { t: 0, r: 0, b: 1, l: 0 },
  left: { t: 0, r: 0, b: 0, l: 1 },
  right: { t: 0, r: 1, b: 0, l: 0 },
  horizontal: { t: 0, r: 1, b: 0, l: 1 },
  vertical: { t: 1, r: 0, b: 1, l: 0 },
};

/** Dashed preview-frame inset (design §5.2). `box` = the scaled image box (display px @ zoom —
 *  the canvas owns it). The frame grows OUTWARD from the image on the selected edges, so the
 *  left/top offsets are negative. `expandX = r·box.w` per horizontal edge, `expandY = r·box.h`
 *  per vertical edge (per-edge percent of the ORIGINAL box — matches the backend geometry).
 *  ratio=0 → `{ left:0, top:0, width:box.w, height:box.h }` (frame coincides with the image). */
export function outpaintFrameInset(
  box: { w: number; h: number },
  direction: ExpandDirection,
  ratioPct: number,
): { left: number; top: number; width: number; height: number } {
  const r = ratioPct / 100;
  const s = DIRECTION_EDGES[direction];
  const ex = r * box.w;
  const ey = r * box.h;
  // Guard on the flag AND a non-zero expand so an unexpanded (or ratio-0) edge is a clean +0,
  // never IEEE -0 (`-ex * s.l` / `-0` would leak into style objects + break toEqual).
  return {
    left: s.l && ex ? -ex : 0,
    top: s.t && ey ? -ey : 0,
    width: box.w + ex * (s.l + s.r),
    height: box.h + ey * (s.t + s.b),
  };
}

/** Pure payload shaper for the outpaint commit (parity buildUpscalePayload — unit-tested in
 *  isolation). `imageSize` is sent explicit; `prompt` is trimmed and OMITTED when empty (server
 *  fills its own continuation prompt); `modelParams` carries model-only (omit `params` → server
 *  temperature default). */
export function buildOutpaintPayload(
  model: string,
  direction: ExpandDirection,
  ratioPct: number,
  prompt: string,
  imageUrl: string,
): OutpaintImageParams {
  const payload: OutpaintImageParams = {
    imageUrl,
    expandRatio: ratioPct,
    direction,
    imageSize: OUTPAINT_IMAGE_SIZE,
    modelParams: { model },
  };
  const trimmed = prompt.trim();
  if (trimmed) payload.prompt = trimmed;
  return payload;
}

// ── Inpaint helpers (04-inpaint-tab.md §6) ────────────────────────────────────

/** Picks the aspect-ratio enum closest to the source ratio — FE mirror of the backend
 *  `nearest_aspect_ratio` so a sent `regionAnnotation` never trips the server's
 *  REGION_ASPECT_MISMATCH guard. argmin of relative error `|opt.numeric − src| / src` over
 *  ASPECT_RATIOS (the single ratio table — DRY). Degenerate height → DEFAULT_ASPECT_RATIO. */
export function nearestAspectRatio(naturalW: number, naturalH: number): AspectRatio {
  if (naturalH <= 0 || naturalW <= 0) return DEFAULT_ASPECT_RATIO;
  const src = naturalW / naturalH;
  let best = ASPECT_RATIOS[0];
  let bestErr = Infinity;
  for (const opt of ASPECT_RATIOS) {
    const err = Math.abs(opt.numeric - src) / src;
    if (err < bestErr) {
      bestErr = err;
      best = opt;
    }
  }
  return best.value;
}

/** Pre-flight size guard (Inpaint commit): true when the composite PNG would exceed the API
 *  decoded-byte cap, so the shell aborts BEFORE the call (no 400 round-trip). A base64 string
 *  decodes to ~`length * 0.75` bytes. */
export function exceedsRegionSizeCap(base64: string): boolean {
  return base64.length * 0.75 > REGION_MAX_DECODED_BYTES;
}

/** Composite source + translucent set-of-mark at natural resolution → PNG base64 WITHOUT the
 *  `data:` prefix (the `regionAnnotation.base64Data` the API wants). The mark is rendered to an
 *  OFFSCREEN canvas at FULL alpha then drawn once with `globalAlpha = markAlpha`, so overlapping
 *  strokes don't darken-stack (≠ eraser's direct destination-out). `brushScale` rescales the
 *  display-px brush radius up to natural-res. Throws if the source taints the canvas (CORS) —
 *  the message carries "tainted/CORS" so mapEditError surfaces the right toast.
 *  Manual-smoke only (jsdom has no real 2d context). */
export function compositeMark(
  sourceImg: HTMLImageElement,
  strokes: Stroke[],
  markColor: string,
  markAlpha: number,
  naturalW: number,
  naturalH: number,
  displayW: number,
  displayH: number,
): string {
  const base = document.createElement('canvas');
  base.width = naturalW;
  base.height = naturalH;
  const baseCtx = base.getContext('2d');
  if (!baseCtx) throw new Error('Could not get 2D context');
  baseCtx.drawImage(sourceImg, 0, 0, naturalW, naturalH);

  const mark = document.createElement('canvas');
  mark.width = naturalW;
  mark.height = naturalH;
  const markCtx = mark.getContext('2d');
  if (!markCtx) throw new Error('Could not get 2D context');

  // Force mark color + paint mode regardless of stroke provenance (compositeMark owns the look).
  const markStrokes: Stroke[] = strokes.map((s) => ({ ...s, color: markColor, mode: 'paint' }));
  const brushScale = (naturalW / displayW + naturalH / displayH) / 2;
  paintStrokesOnCtx(markCtx, markStrokes, null, naturalW, naturalH, brushScale, true);

  baseCtx.globalAlpha = markAlpha;
  baseCtx.drawImage(mark, 0, 0);
  baseCtx.globalAlpha = 1;

  // toDataURL throws on a CORS-tainted canvas — surfaced by mapEditError's CORS branch.
  const dataUrl = base.toDataURL('image/png');
  return dataUrl.split(',')[1] ?? '';
}

/** Flood-fill the enclosed interior of a stroke outline in-place → a solid binary mask.
 *  `data` is RGBA (from `getImageData`); a pixel is a STROKE when its red channel > 127 (the fg
 *  color is white). Marks every NON-stroke pixel reachable from the canvas border ("outside") via
 *  4-connectivity, then rewrites the buffer to a HARD binary: outside → pure `bg` (black, keep),
 *  everything else (the strokes AND the interior they enclose) → pure `fg` (white, inpaint). An open
 *  scribble that encloses nothing keeps just its footprint; a closed loop fills its interior — which
 *  is what "khoanh vùng" means (the whole area inside the loop is edited). A gap in the outline lets
 *  the flood leak in (interior won't fill) — same limitation as any lasso mask; a thick brush seals it.
 *  Exported PURE (no canvas) so the fill logic is unit-testable without a real 2d context. */
export function fillEnclosedMask(data: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const isStroke = (i: number): boolean => data[i * 4] > 127;
  const seed = (i: number): void => {
    if (!outside[i] && !isStroke(i)) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x); // top row
    seed((h - 1) * w + x); // bottom row
  }
  for (let y = 0; y < h; y++) {
    seed(y * w); // left col
    seed(y * w + (w - 1)); // right col
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const v = outside[i] ? 0 : 255; // outside → black (keep); enclosed+stroke → white (inpaint)
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
}

/** Natural-res binary mask for flux-fill-pro: fill the whole canvas with `bgColor` (black = KEEP)
 *  then paint strokes in `fgColor` (white), FLOOD-FILL the enclosed interior (so a traced loop masks
 *  its whole inside, not just the outline — `fillEnclosedMask`), and emit a HARD binary PNG base64
 *  WITHOUT the `data:` prefix. NO source blit — the mask is content-independent, so it also never
 *  CORS-taints the canvas (toDataURL can't throw). `brushScale` rescales the display-px brush radius
 *  up to natural-res (same as compositeMark). Manual-smoke only (jsdom has no real 2d context). */
export function compositeMask(
  strokes: Stroke[],
  bgColor: string,
  fgColor: string,
  naturalW: number,
  naturalH: number,
  displayW: number,
  displayH: number,
): string {
  const c = document.createElement('canvas');
  c.width = naturalW;
  c.height = naturalH;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, naturalW, naturalH);

  // Force fg color + paint mode regardless of stroke provenance (mask owns the look). White at
  // FULL alpha (no globalAlpha reduction) → an opaque outline before the enclosed-region fill.
  // ⚠️ clearFirst=FALSE: paint white strokes ON TOP of the black fillRect above (unlike compositeMark,
  // which paints onto a SEPARATE offscreen canvas). Passing true would clearRect the black background
  // away → a transparent-bg PNG, breaking the "black = KEEP" binary-mask contract.
  const maskStrokes: Stroke[] = strokes.map((s) => ({ ...s, color: fgColor, mode: 'paint' }));
  const brushScale = (naturalW / displayW + naturalH / displayH) / 2;
  paintStrokesOnCtx(ctx, maskStrokes, null, naturalW, naturalH, brushScale, false);

  // Fill the interior enclosed by the strokes → the whole "khoanh vùng" region becomes inpaint-white.
  const img = ctx.getImageData(0, 0, naturalW, naturalH);
  fillEnclosedMask(img.data, naturalW, naturalH);
  ctx.putImageData(img, 0, 0);

  const dataUrl = c.toDataURL('image/png');
  return dataUrl.split(',')[1] ?? '';
}

// ── Inpaint reference images (04-inpaint-tab.md §8.1/§8.3/§8.4) ────────────────

/** Accepted MIME whitelist for a reference image (picked provenance ref OR upload) — mirrors the
 *  picker's upload gate AND the edit-object-image contract. Exported so `urlToBase64` and the
 *  picker validate against ONE list (DRY). */
export const ACCEPTED_REF_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Decoded-byte cap for a reference image (mirror the API 10MB cap). */
export const MAX_REF_BYTES = 10 * 1024 * 1024;

/** One pickable reference image = one entry of `data.images[]` from the provenance API
 *  (⚡2026-07-25 redesign — was a parent-resolved prop-variant). `index` is 1-based within the
 *  original call's `ref_files[]` and drives the CLIENT-ONLY `Ảnh #k` label; `url` is a public
 *  Storage URL (`storybook-assets/ai-logs/{sha256}.{ext}`) fetched → base64 on pick. The optional
 *  fields can legitimately be absent (a ref logged verbatim from a source URL). */
export interface ReferenceImageCandidate {
  index: number;
  url: string;
  mimeType?: string;
  bytes?: number;
  sha256?: string;
}

/** A picked reference-image item held in the picker state. Widens the canonical `ReferenceImage`
 *  ({ label, base64Data, mimeType }) with optional picker metadata — every added field is optional,
 *  so the existing `useReferenceImagePicker` consumers (which read only the 3 base fields) are
 *  unaffected (widen-safe). */
export interface PickedReferenceImage extends ReferenceImage {
  /** 'upload:<uuid>' (upload) | 'prov:<aiRequestId>:<index>' (picked) — the dedupe key. */
  id?: string;
  /** Chip <img> src — upload: data-URI; picked: candidate.url (public Storage URL). */
  thumbUrl?: string;
  /** Kept for type compatibility with upstream `ReferenceImage` consumers. ⚡2026-07-25: the Inpaint
   *  tab NEVER sets it — a provenance ref only carries a POSITIONAL label of the OLD call, which
   *  would mis-align the new call's image map (design §8.1). */
  description?: string;
  source?: 'upload' | 'provenance';
}

/** Result of `resolveAiRequestId`. `fromAncestor` = the id came from a PARENT version (walked the
 *  `original_url` chain) → the picker captions "(từ bản gốc)". */
export interface ResolvedAiRequestId {
  id: string | null;
  fromAncestor: boolean;
}

/** Resolve the `ai_request_id` that owns `version`'s provenance (design §8.3) — PURE, no I/O.
 *  `version.ai_request_id` is absent for anything that is not the direct output of an AI call
 *  (upload, Erasor commit, CV crop, legacy entry), so we walk the `original_url` chain backwards to
 *  the nearest ancestor that HAS one: an erased/cropped derivative still borrows the refs of the
 *  AI-gen image it descends from. Bounded by `INPAINT_PROV_MAX_HOPS` + a visited-set (cyclic or
 *  absurdly long chain → treated as "no provenance", never a hang). */
export function resolveAiRequestId(
  version: Illustration | null,
  versions: Illustration[],
): ResolvedAiRequestId {
  if (!version) return { id: null, fromAncestor: false };

  const seen = new Set<string>();
  let cur: Illustration | undefined = version;
  let hops = 0;

  while (cur && hops < INPAINT_PROV_MAX_HOPS) {
    if (cur.ai_request_id) return { id: cur.ai_request_id, fromAncestor: hops > 0 };
    if (!cur.original_url || seen.has(cur.original_url)) {
      log.debug('resolveAiRequestId', 'chain ended', {
        hops,
        reason: cur.original_url ? 'cycle' : 'chain-root',
      });
      return { id: null, fromAncestor: false };
    }
    seen.add(cur.original_url);
    // Explicit annotation: the closure below feeds `cur`, so an inferred type here would be
    // circular (TS7022).
    const parentUrl: string = cur.original_url;
    cur = versions.find((v) => v.media_url === parentUrl);
    hops++;
  }

  log.debug('resolveAiRequestId', 'no provenance in chain', {
    hops,
    reason: hops >= INPAINT_PROV_MAX_HOPS ? 'hop-cap' : 'dangling-parent',
  });
  return { id: null, fromAncestor: false };
}

/** Fetch a Storage URL → base64 (WITHOUT the `data:` prefix) + its MIME, so a picked prop-variant
 *  reaches the same `{ base64Data, mimeType }` shape as an uploaded file (single API contract).
 *  Validates the MIME whitelist + the 10MB size cap BEFORE the (memory-heavy) base64 conversion.
 *  Throws a plain Error ('REF_FETCH_FAILED' | 'REF_UNSUPPORTED_TYPE' | 'REF_TOO_LARGE' | 'REF_READ_FAILED'); the
 *  caller (onPick) maps it to a generic toast and never blocks the commit.
 *
 *  Uses `fetch().blob()` (design §8.3 — preserves the original MIME, no PNG re-encode). This CORS
 *  path is already proven on the same Storage bucket by `uploadEphemeralToStorage` (extract modal).
 *  Contingency if a future bucket blocks fetch-CORS: swap the body for `<img crossOrigin="anonymous">`
 *  + `canvas.toDataURL('image/png')` (same signature; forces mimeType='image/png'). Manual-smoke
 *  only (jsdom has no real network). */
export async function urlToBase64(url: string): Promise<{ base64Data: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('REF_FETCH_FAILED');
  const blob = await res.blob();
  if (!(ACCEPTED_REF_TYPES as readonly string[]).includes(blob.type)) {
    log.warn('urlToBase64', 'unsupported reference mime', { mimeType: blob.type });
    throw new Error('REF_UNSUPPORTED_TYPE');
  }
  if (blob.size > MAX_REF_BYTES) {
    log.warn('urlToBase64', 'reference exceeds size cap', { size: blob.size });
    throw new Error('REF_TOO_LARGE');
  }
  const dataUrl = await blobToDataUrl(blob);
  return { base64Data: dataUrl.split(',')[1] ?? '', mimeType: blob.type };
}

/** Read a Blob → data URL (FileReader). Split out so `urlToBase64` stays flat + so a test can
 *  reach the reject path without a real network. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('REF_READ_FAILED'));
    reader.readAsDataURL(blob);
  });
}

// NOTE: the design §2.5 ⚡I editable-focus guard for the `c`/`C` Compare hotkey is NOT
// implemented here — the ILS `onHotkey(key)` signature carries no event target, and the
// InteractionLayerProvider already suppresses non-Escape hotkeys while an editable element
// is focused. So no `isEditableTarget` helper is needed.
