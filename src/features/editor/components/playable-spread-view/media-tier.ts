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

export type DeviceTier = 'mobile' | 'web' | 'ipad'; // pixel order: mobile 1080 < web 1920 < ipad 2360

// Thresholds = midpoints between tier widths (1080 / 1920 / 2360).
const MOBILE_MAX_PHYSICAL_WIDTH = 1400;
const WEB_MAX_PHYSICAL_WIDTH = 2100;
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

/** Detect tier from viewport × DPR (fallback when the host doesn't specify). */
export function detectDeviceTier(): DeviceTier {
  if (typeof screen === 'undefined') return 'web'; // SSR / test env
  const dpr = Math.min(
    typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
    DEVICE_PIXEL_RATIO_CAP,
  );
  const physicalW = Math.max(screen.width, screen.height) * dpr;
  if (physicalW <= MOBILE_MAX_PHYSICAL_WIDTH) return 'mobile';
  if (physicalW <= WEB_MAX_PHYSICAL_WIDTH) return 'web';
  return 'ipad';
}
