// parametric-generate-utils.test.ts — Unit tests for the Visuals-tab pure helpers: the
// source-image resolve chain (4 rungs + null), the API/save error maps and the upload slug.
// vitest only — NO node builtins (test files type-check with vite/client types).

import { describe, it, expect } from 'vitest';
import type { Illustration } from '@/types/prop-types';
import type { ItemParametricSlot, SpreadImage } from '@/types/spread-types';
import {
  PARAMETRIC_GENERIC_ERROR,
  PARAMETRIC_SAVE_SOFT_FAIL,
  mapParametricError,
  mapParametricSaveError,
  resolveParametricSource,
  slugifyParametricValue,
} from './parametric-generate-utils';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ver(url: string, isSelected = false, aiRequestId?: string): Illustration {
  return {
    media_url: url,
    created_time: '2026-07-28T00:00:00.000Z',
    is_selected: isSelected,
    ...(aiRequestId ? { ai_request_id: aiRequestId } : {}),
  };
}

function slot(values: ItemParametricSlot['values']): ItemParametricSlot {
  return { key: 'miu.age', values };
}

/** Minimal SpreadImage — only the fields `resolveEffectiveImageUrl` reads matter here. */
function image(overrides: Partial<SpreadImage> = {}): SpreadImage {
  return { id: 'img-1', ...overrides } as SpreadImage;
}

// ── Resolve chain (01 §4.1) ───────────────────────────────────────────────────

describe('resolveParametricSource', () => {
  it('step 1 — the default value selected version wins over everything else', () => {
    const result = resolveParametricSource({
      slot: slot([
        {
          value: '3',
          is_default: true,
          illustrations: [ver('https://cdn/first.png'), ver('https://cdn/picked.png', true, 'ai-1')],
        },
        { value: '6', is_default: false, illustrations: [ver('https://cdn/own.png', true)] },
      ]),
      defaultValue: '3',
      selectedValue: '6',
      item: image({ media_url: 'https://cdn/item.png' }),
    });
    expect(result).toMatchObject({
      url: 'https://cdn/picked.png',
      sourceValue: '3',
      step: 1,
    });
    expect(result?.version?.ai_request_id).toBe('ai-1');
  });

  it('step 2 — falls back to the default value first version when none is selected', () => {
    const result = resolveParametricSource({
      slot: slot([
        {
          value: '3',
          is_default: true,
          illustrations: [ver('https://cdn/first.png'), ver('https://cdn/second.png')],
        },
      ]),
      defaultValue: '3',
      selectedValue: '6',
      item: image({ media_url: 'https://cdn/item.png' }),
    });
    expect(result).toMatchObject({ url: 'https://cdn/first.png', sourceValue: '3', step: 2 });
  });

  // sourceValue === targetValue is a REGENERATE — allowed (§4.1 note), never blocked.
  it('step 3 — uses the value own selected version when the default has no image', () => {
    const result = resolveParametricSource({
      slot: slot([
        { value: '3', is_default: true, illustrations: [] },
        { value: '6', is_default: false, illustrations: [ver('https://cdn/own.png', true)] },
      ]),
      defaultValue: '3',
      selectedValue: '6',
      item: image({ media_url: 'https://cdn/item.png' }),
    });
    expect(result).toMatchObject({ url: 'https://cdn/own.png', sourceValue: '6', step: 3 });
  });

  it('step 4 — falls back to the item effective url, attributed to the default value', () => {
    const result = resolveParametricSource({
      slot: slot([{ value: '3', is_default: true, illustrations: [] }]),
      defaultValue: '3',
      selectedValue: '6',
      item: image({
        media_url: 'https://cdn/sketch.png',
        final_hires_media_url: 'https://cdn/hires.png',
      }),
    });
    expect(result).toMatchObject({ url: 'https://cdn/hires.png', sourceValue: '3', step: 4 });
    expect(result?.version).toBeNull();
  });

  it('step 4 — attributes to the selected value when the slot has no default at all', () => {
    const result = resolveParametricSource({
      slot: slot([]),
      defaultValue: null,
      selectedValue: '6',
      item: image({ media_url: 'https://cdn/item.png' }),
    });
    expect(result).toMatchObject({ url: 'https://cdn/item.png', sourceValue: '6', step: 4 });
  });

  it('returns null when nothing in the chain has an image (Generate must disable)', () => {
    const result = resolveParametricSource({
      slot: slot([{ value: '3', is_default: true, illustrations: [] }]),
      defaultValue: '3',
      selectedValue: '6',
      item: image(),
    });
    expect(result).toBeNull();
  });
});

// ── Error maps (01 §5) ────────────────────────────────────────────────────────

describe('mapParametricError', () => {
  it.each([
    ['SAFETY_FILTER_BLOCKED', 'Nội dung bị chặn bởi bộ lọc an toàn — sửa chỉ dẫn rồi thử lại'],
    ['UNSUPPORTED_AXIS', 'Loại param này không hỗ trợ sinh ảnh'],
    ['IMAGE_FETCH_ERROR', 'Không tải được ảnh gốc'],
    ['SSRF_BLOCKED', 'Không tải được ảnh gốc'],
    ['GEMINI_RATE_LIMIT', 'Hệ thống đang bận, thử lại sau ít phút'],
    ['NO_IMAGE_RESPONSE', 'Sinh ảnh thất bại, thử lại'],
    ['GEMINI_ERROR', 'Sinh ảnh thất bại, thử lại'],
  ])('maps %s', (errorCode, expected) => {
    expect(mapParametricError({ success: false, errorCode, httpStatus: 400 })).toBe(expected);
  });

  it('falls back to the http status when the envelope carried no code', () => {
    expect(mapParametricError({ success: false, httpStatus: 429 })).toBe(
      'Hệ thống đang bận, thử lại sau ít phút',
    );
    expect(mapParametricError({ success: false, httpStatus: 502 })).toBe(
      'Sinh ảnh thất bại, thử lại',
    );
  });

  it('degrades to the generic line for a thrown Error / unknown shape', () => {
    expect(mapParametricError(new Error('boom'))).toBe(PARAMETRIC_GENERIC_ERROR);
    expect(mapParametricError(null)).toBe(PARAMETRIC_GENERIC_ERROR);
    expect(mapParametricError({ success: false, errorCode: 'SOMETHING_NEW' })).toBe(
      PARAMETRIC_GENERIC_ERROR,
    );
  });
});

describe('mapParametricSaveError', () => {
  it('maps the stale-snapshot soft-fail', () => {
    expect(mapParametricSaveError('STALE_SNAPSHOT_VERSION')).toBe(
      'Bản snapshot đã đổi — hãy lưu lại',
    );
  });

  // ⚠ The BE lib emits the LONG form; the design doc's table says the short one. Both map.
  it('maps both anchor-missing spellings', () => {
    const expected = 'Ảnh đã sinh nhưng chưa lưu tự động — hãy lưu lại';
    expect(mapParametricSaveError('SAVE_RESOURCE_ANCHOR_NOT_FOUND')).toBe(expected);
    expect(mapParametricSaveError('ANCHOR_NOT_FOUND')).toBe(expected);
  });

  it('degrades to the generic soft-fail line', () => {
    expect(mapParametricSaveError(undefined)).toBe(PARAMETRIC_SAVE_SOFT_FAIL);
    expect(mapParametricSaveError('WHATEVER')).toBe(PARAMETRIC_SAVE_SOFT_FAIL);
  });
});

// ── Upload path ───────────────────────────────────────────────────────────────

describe('slugifyParametricValue', () => {
  it('normalizes a value into a storage-safe segment', () => {
    expect(slugifyParametricValue('VN')).toBe('vn');
    expect(slugifyParametricValue('5')).toBe('5');
    expect(slugifyParametricValue('non-binary')).toBe('non-binary');
    expect(slugifyParametricValue('  Cao Đài / Hoà Hảo ')).toBe('cao-i-ho-h-o');
  });

  it('never returns an empty segment', () => {
    expect(slugifyParametricValue('///')).toBe('value');
    expect(slugifyParametricValue('')).toBe('value');
  });
});
