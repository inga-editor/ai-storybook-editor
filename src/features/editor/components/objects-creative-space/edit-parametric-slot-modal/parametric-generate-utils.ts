// parametric-generate-utils.ts — PURE helpers owned by the Visuals tab: the source-image
// resolve chain (01-visuals-tab.md §4.1), the API/save error → toast maps (§5) and the
// upload constants. No React, no I/O, no throw — unit-tested in parametric-generate-utils.test.ts.
//
// Kept OUT of parametric-slot-utils.ts purely for the 500-LOC budget (that module is at 437);
// the split is by concern too: `parametric-slot-utils` answers "what values / what payload",
// this one answers "which image do we transform, and what do we tell the user when it fails".

import type { Illustration } from '@/types/prop-types';
import type { ItemParametricSlot, SpreadImage } from '@/types/spread-types';
import { resolveEffectiveImageUrl } from '@/features/editor/components/shared-components/resolve-effective-image-url';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ParametricGenerateUtils');

// ── Upload / reference constants (§3.2 + §4.2) ────────────────────────────────

/** Combined reference-image cap of the generate popover (upload + provenance) — parity inpaint. */
export const PARAMETRIC_REF_MAX = 5;
/** Free-text extra instruction cap (the MAIN instruction lives in the server-side system prompt). */
export const PARAMETRIC_PROMPT_MAX = 1000;
export const PARAMETRIC_UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp';
export const PARAMETRIC_UPLOAD_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];
export const PARAMETRIC_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// ── Source-image resolve chain (§4.1) ─────────────────────────────────────────

/** Which rung of the chain produced the source image — logged at `debug`, shown in no UI. */
export type ParametricSourceStep = 1 | 2 | 3 | 4;

export interface ParametricSourceResolution {
  url: string;
  /** `sourceValue` sent to the API. Step 3 ⇒ equals the target value (a regenerate — allowed). */
  sourceValue: string;
  step: ParametricSourceStep;
  /** The Illustration the URL came from — carries `ai_request_id` for the provenance ref grid.
   *  null on step 4 (the item's own media has no version identity). */
  version: Illustration | null;
}

export interface ResolveParametricSourceArgs {
  slot: ItemParametricSlot;
  /** Value flagged `is_default` (chain rungs 1-2). */
  defaultValue: string | null;
  /** Value currently being worked on = the generate TARGET (chain rung 3). */
  selectedValue: string;
  item: SpreadImage;
}

/**
 * Resolve the "ảnh gốc" the variant is generated FROM (§4.1). Read-only/auto — v1 exposes no
 * picker, so that every value of one item descends from the same base and the whole set stacks.
 *
 * 1. default value's selected version   ← preferred: the canonical look of this item
 * 2. default value's first version
 * 3. THIS value's own selected version  ← regenerate (sourceValue === targetValue)
 * 4. the item's effective media         ← what the slot was seeded from (item-slot-seed.ts)
 * null ⇒ nothing to transform → the caller disables Generate + tooltips "Item chưa có ảnh gốc".
 */
export function resolveParametricSource({
  slot,
  defaultValue,
  selectedValue,
  item,
}: ResolveParametricSourceArgs): ParametricSourceResolution | null {
  if (defaultValue) {
    const defaultEntry = slot.values.find((v) => v.value === defaultValue);
    const picked = defaultEntry?.illustrations.find((i) => i.is_selected);
    if (picked?.media_url) {
      return { url: picked.media_url, sourceValue: defaultValue, step: 1, version: picked };
    }
    const first = defaultEntry?.illustrations[0];
    if (first?.media_url) {
      return { url: first.media_url, sourceValue: defaultValue, step: 2, version: first };
    }
  }

  if (selectedValue) {
    const own = slot.values.find((v) => v.value === selectedValue);
    const picked = own?.illustrations.find((i) => i.is_selected);
    if (picked?.media_url) {
      return { url: picked.media_url, sourceValue: selectedValue, step: 3, version: picked };
    }
  }

  const fallback = resolveEffectiveImageUrl(item);
  if (fallback) {
    // The item's plain media IS what the default value was seeded from, so it is attributed to
    // the default value when there is one (never to an unrelated target value).
    return {
      url: fallback,
      sourceValue: defaultValue ?? selectedValue,
      step: 4,
      version: null,
    };
  }

  log.debug('resolveParametricSource', 'no source image anywhere in the chain', {
    key: slot.key,
    selectedValue,
    valueCount: slot.values.length,
  });
  return null;
}

// ── Error maps (§5) ───────────────────────────────────────────────────────────

/** Request-level failure codes → user copy. Anything unmapped falls through to the status map. */
const API_ERROR_MESSAGE: Record<string, string> = {
  SAFETY_FILTER_BLOCKED: 'Nội dung bị chặn bởi bộ lọc an toàn — sửa chỉ dẫn rồi thử lại',
  // Only reachable on a wiring bug (the UI disables Generate for photo axes) — logged as `error`.
  UNSUPPORTED_AXIS: 'Loại param này không hỗ trợ sinh ảnh',
  IMAGE_FETCH_ERROR: 'Không tải được ảnh gốc',
  SSRF_BLOCKED: 'Không tải được ảnh gốc',
  GEMINI_RATE_LIMIT: 'Hệ thống đang bận, thử lại sau ít phút',
  NO_IMAGE_RESPONSE: 'Sinh ảnh thất bại, thử lại',
  GEMINI_ERROR: 'Sinh ảnh thất bại, thử lại',
  // Client-side classifications from image-api-client.ts (no server envelope).
  TIMEOUT: 'Yêu cầu quá thời gian — thử lại',
  CONNECTION_ERROR: 'Không kết nối được máy chủ — kiểm tra mạng rồi thử lại',
};

/** Fallback when the failure carried no envelope code (bare 429 / HTML 502 / proxy error). */
const HTTP_STATUS_MESSAGE: Record<number, string> = {
  429: 'Hệ thống đang bận, thử lại sau ít phút',
  502: 'Sinh ảnh thất bại, thử lại',
  503: 'Sinh ảnh thất bại, thử lại',
  504: 'Yêu cầu quá thời gian — thử lại',
};

export const PARAMETRIC_GENERIC_ERROR = 'Sinh ảnh thất bại, thử lại';
/** Step-1 (anchor persist) failure — the API is NEVER called, so no AI budget is burnt. */
export const PARAMETRIC_ENSURE_ENTRY_ERROR = 'Không lưu được giá trị mới, thử lại';
export const PARAMETRIC_UPLOAD_REJECTED = 'Chỉ nhận PNG/JPEG/WebP ≤10MB';
export const PARAMETRIC_UPLOAD_FAILED = 'Tải ảnh lên thất bại, thử lại';

/**
 * Map a failed `callGenerateParametricVariant` result (or a thrown error) to ONE toast line.
 * Accepts `unknown` so the same helper serves the `if (!res.success)` branch and the `catch`.
 */
export function mapParametricError(err: unknown): string {
  if (err && typeof err === 'object') {
    const candidate = err as { errorCode?: unknown; httpStatus?: unknown };
    const code = typeof candidate.errorCode === 'string' ? candidate.errorCode : undefined;
    if (code && API_ERROR_MESSAGE[code]) return API_ERROR_MESSAGE[code];
    const status = typeof candidate.httpStatus === 'number' ? candidate.httpStatus : undefined;
    if (status !== undefined && HTTP_STATUS_MESSAGE[status]) return HTTP_STATUS_MESSAGE[status];
  }
  return PARAMETRIC_GENERIC_ERROR;
}

/**
 * Map the SOFT-FAIL `data.saveError` (image generated + stored, DB write did not land) to a
 * warning line. Never rolls anything back — the client-side prepend already happened and the
 * next collab save persists it.
 *
 * ⚠ The BE shared lib emits `SAVE_RESOURCE_ANCHOR_NOT_FOUND`; the design doc's error table
 * says `ANCHOR_NOT_FOUND`. The long form is authoritative (verified against the emitting lib);
 * the short one is kept as a cheap defensive alias.
 */
const SAVE_ERROR_MESSAGE: Record<string, string> = {
  STALE_SNAPSHOT_VERSION: 'Bản snapshot đã đổi — hãy lưu lại',
  SAVE_RESOURCE_ANCHOR_NOT_FOUND: 'Ảnh đã sinh nhưng chưa lưu tự động — hãy lưu lại',
  ANCHOR_NOT_FOUND: 'Ảnh đã sinh nhưng chưa lưu tự động — hãy lưu lại',
  SAVE_RESOURCE_INVALID_PATH: 'Ảnh đã sinh nhưng chưa lưu tự động — hãy lưu lại',
};

export const PARAMETRIC_SAVE_SOFT_FAIL = 'Ảnh đã sinh nhưng chưa lưu tự động';

export function mapParametricSaveError(saveError?: string): string {
  if (saveError && SAVE_ERROR_MESSAGE[saveError]) return SAVE_ERROR_MESSAGE[saveError];
  return PARAMETRIC_SAVE_SOFT_FAIL;
}

// ── Upload path ───────────────────────────────────────────────────────────────

/** Storage-safe segment for a value (`Nữ` / `VN` / `5` / `real`). Everything outside
 *  `[a-z0-9]` collapses to `-`; an empty result degrades to `value` so the upload path never
 *  ends in a bare slash. Lossy on purpose — the path is a storage folder, not an identifier
 *  (the authoritative value lives in `values[].value`). */
export function slugifyParametricValue(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'value';
}
