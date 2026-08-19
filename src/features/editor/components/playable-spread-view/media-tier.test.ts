// media-tier.test.ts — unit tests for the ADR-057 tier util module.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  withTier,
  setActiveMediaTier,
  getActiveMediaTier,
  applyMediaTier,
  detectDeviceTier,
} from './media-tier';

afterEach(() => {
  setActiveMediaTier(null);
  vi.unstubAllGlobals();
});

describe('withTier', () => {
  it('appends ?tier= to a plain URL', () => {
    expect(withTier('https://x.test/a.webp', 'web')).toBe('https://x.test/a.webp?tier=web');
  });

  it('appends &tier= when the URL already has a query', () => {
    expect(withTier('https://x.test/a.webp?x=1', 'mobile')).toBe('https://x.test/a.webp?x=1&tier=mobile');
  });

  it('returns the URL unchanged for null/undefined tier', () => {
    expect(withTier('https://x.test/a.webp', null)).toBe('https://x.test/a.webp');
    expect(withTier('https://x.test/a.webp', undefined)).toBe('https://x.test/a.webp');
  });
});

describe('active tier singleton', () => {
  it('defaults to null → applyMediaTier passthrough', () => {
    expect(getActiveMediaTier()).toBeNull();
    expect(applyMediaTier('https://x.test/a.webm')).toBe('https://x.test/a.webm');
  });

  it('set → applyMediaTier appends; reset → passthrough again', () => {
    setActiveMediaTier('ipad');
    expect(getActiveMediaTier()).toBe('ipad');
    expect(applyMediaTier('https://x.test/a.webm')).toBe('https://x.test/a.webm?tier=ipad');
    setActiveMediaTier(null);
    expect(applyMediaTier('https://x.test/a.webm')).toBe('https://x.test/a.webm');
  });
});

describe('detectDeviceTier', () => {
  function stubViewport(innerWidth: unknown, innerHeight: unknown, dpr: number) {
    vi.stubGlobal('innerWidth', innerWidth);
    vi.stubGlobal('innerHeight', innerHeight);
    vi.stubGlobal('devicePixelRatio', dpr);
  }

  it('<1800 physical → mobile (boundary 1799)', () => {
    stubViewport(1799, 800, 1);
    expect(detectDeviceTier()).toBe('mobile');
  });

  it('1800 physical → web (boundary is strict <, largest phones step up to web)', () => {
    stubViewport(1800, 1080, 1);
    expect(detectDeviceTier()).toBe('web');
  });

  it('<2560 physical → web (boundary 2559)', () => {
    stubViewport(2559, 1080, 1);
    expect(detectDeviceTier()).toBe('web');
  });

  it('2560 physical → ipad (boundary is strict <, QHD/iPad Pro 13" is ipad)', () => {
    stubViewport(2560, 1640, 1);
    expect(detectDeviceTier()).toBe('ipad');
  });

  it('caps DPR at 2', () => {
    stubViewport(1000, 600, 3); // 1000 × 2 = 2000 → web (not 3000 → ipad)
    expect(detectDeviceTier()).toBe('web');
  });

  it('uses the larger viewport dimension (orientation-independent)', () => {
    stubViewport(800, 1600, 1); // portrait → uses the 1600 long edge, not 800
    expect(detectDeviceTier()).toBe('mobile');
  });

  it('defaults to web when the viewport is unavailable (SSR/NaN guard)', () => {
    stubViewport(undefined, undefined, 1); // max(undefined,undefined)*dpr = NaN → web
    expect(detectDeviceTier()).toBe('web');
  });
});
