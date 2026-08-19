// media-tier.ts — Device-tier media rendition resolve (ADR-057).
//
// URL data in snapshot/payload never changes — consumers append `?tier=` at the
// point of consumption (element src / preloader) via `applyMediaTier`. The
// storage-service nginx resolves the sibling rendition and falls back to the
// nearest larger variant, then the original, so appending is always safe.
//
// Module-level singleton (no React context): same pattern as the player core
// stores — one player per JS context — and it keeps the tier readable from
// non-React utils (preload collector) without prop-drilling through the
// Editable* leaves. MediaTierHost owns the set/cleanup lifecycle.
//
// Design source: ai-storybook-design/component/editor-page/shared/playable-spread-view/03-16-media-tier-resolve.md

export type DeviceTier = 'mobile' | 'web' | 'ipad'; // pixel order: mobile 1760 < web 2240 < ipad 2656

// Boundaries = the fleet gap between device classes (NOT midpoints between tier
// widths): a desktop FHD viewport (1920) is 'web', an iPad Air (2360) is 'ipad'.
// Strict `<` — the boundary value itself belongs to the larger tier.
const WEB_MIN_PHYSICAL_WIDTH = 1920;
const IPAD_MIN_PHYSICAL_WIDTH = 2360;
// DPR cap — beyond 2x the rendition gain is invisible (ADR-057 tier basis).
const DEVICE_PIXEL_RATIO_CAP = 2;

/** Pure — append ?tier= to a URL. Nullish tier → url unchanged. */
export function withTier(url: string, tier: DeviceTier | null | undefined): string {
  if (tier == null) return url;
  return url + (url.includes('?') ? '&' : '?') + 'tier=' + tier;
}

let activeTier: DeviceTier | null = null;

export function setActiveMediaTier(tier: DeviceTier | null): void {
  activeTier = tier;
}

export function getActiveMediaTier(): DeviceTier | null {
  return activeTier;
}

/** Choke-point helper for render/preload call sites. */
export function applyMediaTier(url: string): string {
  return withTier(url, activeTier);
}

/** Detect tier from viewport × DPR (fallback when the host doesn't specify).
 * Measures `window.innerWidth/innerHeight` (the actual layout box — correct for
 * iframe embeds and resized windows) rather than `screen.*` (the whole display). */
export function detectDeviceTier(): DeviceTier {
  if (typeof window === 'undefined') return 'web'; // SSR / test env
  const dpr = Math.min(
    typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
    DEVICE_PIXEL_RATIO_CAP,
  );
  const physicalW = Math.max(window.innerWidth, window.innerHeight) * dpr;
  // Non-finite (missing/NaN viewport) → 'web', the SSR default — never let NaN
  // fall through the strict `<` checks into the heaviest 'ipad' tier.
  if (!Number.isFinite(physicalW)) return 'web';
  if (physicalW < WEB_MIN_PHYSICAL_WIDTH) return 'mobile';
  if (physicalW < IPAD_MIN_PHYSICAL_WIDTH) return 'web';
  return 'ipad';
}
