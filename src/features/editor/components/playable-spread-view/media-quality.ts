// media-quality.ts — Media rendition resolve by numeric quality width (ADR-057).
//
// URL data in snapshot/payload never changes — consumers append `?quality=` at
// the point of consumption (element src / preloader) via `applyMediaQuality`.
// The storage-service nginx resolves the sibling rendition and falls back to the
// nearest larger variant, then the original, so appending is always safe.
//
// Module-level singleton (no React context): same pattern as the player core
// stores — one player per JS context — and it keeps the quality readable from
// non-React utils (preload collector) without prop-drilling through the
// Editable* leaves. MediaQualityHost owns the set/cleanup lifecycle.
//
// Design source: ai-storybook-design/component/editor-page/shared/playable-spread-view/03-16-media-quality-resolve.md

/** Numeric convert-width in px (1600 / 2240 / 2752). */
export type MediaQuality = number;

/**
 * Detect ladder (SSOT) — each rung maps a physical-width floor to the quality
 * width served. Boundaries = the fleet gap between device classes (NOT midpoints
 * between quality widths): a desktop FHD viewport (1920) → 2240, an iPad Pro 13"
 * (2752) → 2752; the largest phones (1800–1912) intentionally step up to 2240.
 * `min` is inclusive-floor with strict-greater walk — the boundary value itself
 * belongs to the higher rung. Ascending by `min`; walk high→low.
 */
export const MEDIA_QUALITY_LADDER: ReadonlyArray<{ quality: MediaQuality; min: number }> = [
  { quality: 1600, min: 0 },
  { quality: 2240, min: 1800 },
  { quality: 2752, min: 2560 },
];

// DPR cap — beyond 2x the rendition gain is invisible (ADR-057 quality basis).
const DEVICE_PIXEL_RATIO_CAP = 2;
// SSR / non-finite default — the mid rung (matches editor Preview surface).
const DEFAULT_QUALITY: MediaQuality = 2240;

/** Pure — append ?quality= to a URL. Nullish quality → url unchanged. */
export function withQuality(url: string, quality: MediaQuality | null | undefined): string {
  if (quality == null) return url;
  return url + (url.includes('?') ? '&' : '?') + 'quality=' + quality;
}

let activeQuality: MediaQuality | null = null;

export function setActiveMediaQuality(quality: MediaQuality | null): void {
  activeQuality = quality;
}

export function getActiveMediaQuality(): MediaQuality | null {
  return activeQuality;
}

/** Choke-point helper for render/preload call sites. */
export function applyMediaQuality(url: string): string {
  return withQuality(url, activeQuality);
}

/** Detect quality from viewport × DPR (fallback when the host doesn't specify).
 * Measures `window.innerWidth/innerHeight` (the actual layout box — correct for
 * iframe embeds and resized windows) rather than `screen.*` (the whole display). */
export function detectMediaQuality(): MediaQuality {
  if (typeof window === 'undefined') return DEFAULT_QUALITY; // SSR / test env
  const dpr = Math.min(
    typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
    DEVICE_PIXEL_RATIO_CAP,
  );
  const physicalW = Math.max(window.innerWidth, window.innerHeight) * dpr;
  // Non-finite (missing/NaN viewport) → the SSR default — never let NaN fall
  // through the ladder walk into the heaviest rung.
  if (!Number.isFinite(physicalW)) return DEFAULT_QUALITY;
  // Walk high→low: first rung whose floor the width clears wins.
  for (let i = MEDIA_QUALITY_LADDER.length - 1; i >= 0; i--) {
    if (physicalW >= MEDIA_QUALITY_LADDER[i].min) return MEDIA_QUALITY_LADDER[i].quality;
  }
  return DEFAULT_QUALITY;
}
