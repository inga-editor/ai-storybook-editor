// media-quality.test.ts — unit tests for the ADR-057 quality util module.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  withQuality,
  setActiveMediaQuality,
  getActiveMediaQuality,
  applyMediaQuality,
  detectMediaQuality,
} from './media-quality';

afterEach(() => {
  setActiveMediaQuality(null);
  vi.unstubAllGlobals();
});

describe('withQuality', () => {
  it('appends ?quality= to a plain URL', () => {
    expect(withQuality('https://x.test/a.webp', 2240)).toBe('https://x.test/a.webp?quality=2240');
  });

  it('appends &quality= when the URL already has a query', () => {
    expect(withQuality('https://x.test/a.webp?x=1', 1600)).toBe('https://x.test/a.webp?x=1&quality=1600');
  });

  it('returns the URL unchanged for null/undefined quality', () => {
    expect(withQuality('https://x.test/a.webp', null)).toBe('https://x.test/a.webp');
    expect(withQuality('https://x.test/a.webp', undefined)).toBe('https://x.test/a.webp');
  });
});

describe('active quality singleton', () => {
  it('defaults to null → applyMediaQuality passthrough', () => {
    expect(getActiveMediaQuality()).toBeNull();
    expect(applyMediaQuality('https://x.test/a.webm')).toBe('https://x.test/a.webm');
  });

  it('set → applyMediaQuality appends; reset → passthrough again', () => {
    setActiveMediaQuality(2752);
    expect(getActiveMediaQuality()).toBe(2752);
    expect(applyMediaQuality('https://x.test/a.webm')).toBe('https://x.test/a.webm?quality=2752');
    setActiveMediaQuality(null);
    expect(applyMediaQuality('https://x.test/a.webm')).toBe('https://x.test/a.webm');
  });
});

describe('detectMediaQuality', () => {
  function stubViewport(innerWidth: unknown, innerHeight: unknown, dpr: number) {
    vi.stubGlobal('innerWidth', innerWidth);
    vi.stubGlobal('innerHeight', innerHeight);
    vi.stubGlobal('devicePixelRatio', dpr);
  }

  it('<1800 physical → 1600 (boundary 1799)', () => {
    stubViewport(1799, 800, 1);
    expect(detectMediaQuality()).toBe(1600);
  });

  it('1800 physical → 2240 (ladder floor is inclusive, largest phones step up)', () => {
    stubViewport(1800, 1080, 1);
    expect(detectMediaQuality()).toBe(2240);
  });

  it('<2560 physical → 2240 (boundary 2559)', () => {
    stubViewport(2559, 1080, 1);
    expect(detectMediaQuality()).toBe(2240);
  });

  it('2560 physical → 2752 (ladder floor is inclusive, QHD/iPad Pro 13")', () => {
    stubViewport(2560, 1640, 1);
    expect(detectMediaQuality()).toBe(2752);
  });

  it('caps DPR at 2', () => {
    stubViewport(1000, 600, 3); // 1000 × 2 = 2000 → 2240 (not 3000 → 2752)
    expect(detectMediaQuality()).toBe(2240);
  });

  it('uses the larger viewport dimension (orientation-independent)', () => {
    stubViewport(800, 1600, 1); // portrait → uses the 1600 long edge, not 800
    expect(detectMediaQuality()).toBe(1600);
  });

  it('defaults to 2240 when the viewport is unavailable (SSR/NaN guard)', () => {
    stubViewport(undefined, undefined, 1); // max(undefined,undefined)*dpr = NaN → 2240
    expect(detectMediaQuality()).toBe(2240);
  });
});
