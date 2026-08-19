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
  function stubScreen(width: number, height: number, dpr: number) {
    vi.stubGlobal('screen', { width, height } as Screen);
    vi.stubGlobal('devicePixelRatio', dpr);
  }

  it('≤1400 physical → mobile', () => {
    stubScreen(390, 844, 1); // 844 physical
    expect(detectDeviceTier()).toBe('mobile');
  });

  it('≤2100 physical → web', () => {
    stubScreen(1920, 1080, 1); // 1920 physical
    expect(detectDeviceTier()).toBe('web');
  });

  it('>2100 physical → ipad', () => {
    stubScreen(1366, 1024, 2); // 2732 physical
    expect(detectDeviceTier()).toBe('ipad');
  });

  it('caps DPR at 2', () => {
    stubScreen(390, 844, 3); // 844 × 2 = 1688 → web (not 2532 → ipad)
    expect(detectDeviceTier()).toBe('web');
  });

  it('uses the larger screen dimension (orientation-independent)', () => {
    stubScreen(844, 390, 1); // landscape phone → still 844
    expect(detectDeviceTier()).toBe('mobile');
  });

  it('defaults to web when screen is unavailable (SSR/test env)', () => {
    vi.stubGlobal('screen', undefined);
    expect(detectDeviceTier()).toBe('web');
  });
});
