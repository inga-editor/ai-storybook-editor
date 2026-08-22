// edit-image-modal-utils.test.ts — Unit tests for the EditImageModal pure helpers
// (prependVersion / mapEditError / versionFromMediaUrl). Canvas + pointer logic is
// manual-smoke only (jsdom has no real 2d context).

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Illustration } from '@/types/prop-types';

// Mock the stroke engine so compositeMask can be asserted without a real 2d context (jsdom has
// none). paintStrokesOnCtx becomes a spy; every other export (Stroke, norm) is kept actual.
vi.mock('./erase-stroke-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./erase-stroke-engine')>();
  return { ...actual, paintStrokesOnCtx: vi.fn() };
});

import {
  EditApiError,
  prependVersion,
  versionFromMediaUrl,
  mapEditError,
  buildUpscalePayload,
  nearestAspectRatio,
  exceedsRegionSizeCap,
  compositeMask,
  fillEnclosedMask,
  DIRECTION_EDGES,
  outpaintFrameInset,
  buildOutpaintPayload,
  resolveAiRequestId,
  urlToBase64,
  MAX_REF_BYTES,
} from './edit-image-modal-utils';
import { paintStrokesOnCtx, type Stroke } from './erase-stroke-engine';
import { INPAINT_PROV_MAX_HOPS, REGION_MAX_DECODED_BYTES } from './edit-image-modal-constants';

const baseVersions: Illustration[] = [
  { media_url: 'https://cdn/a.png', created_time: '2026-01-01T00:00:00.000Z', is_selected: true, type: 'created' },
  { media_url: 'https://cdn/b.png', created_time: '2026-01-02T00:00:00.000Z', is_selected: false, type: 'created' },
];

describe('prependVersion', () => {
  it('prepends a selected type=edited entry carrying original_url', () => {
    const next = prependVersion(baseVersions, 'https://cdn/new.png', 'https://cdn/a.png');
    expect(next).toHaveLength(3);
    expect(next[0]).toMatchObject({
      type: 'edited',
      media_url: 'https://cdn/new.png',
      original_url: 'https://cdn/a.png',
      is_selected: true,
    });
    expect(typeof next[0].created_time).toBe('string');
  });

  it('deselects every prior version', () => {
    const next = prependVersion(baseVersions, 'https://cdn/new.png', 'https://cdn/a.png');
    expect(next.slice(1).every((v) => v.is_selected === false)).toBe(true);
  });

  it('does not mutate the input array', () => {
    const snapshot = JSON.parse(JSON.stringify(baseVersions));
    prependVersion(baseVersions, 'https://cdn/new.png', 'https://cdn/a.png');
    expect(baseVersions).toEqual(snapshot);
  });

  it('produces the first real version from an empty array (base kept as original_url)', () => {
    const next = prependVersion([], 'https://cdn/new.png', 'https://cdn/sketch.png');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      type: 'edited',
      original_url: 'https://cdn/sketch.png',
      is_selected: true,
    });
  });

  it('carries ai_request_id when provided; omits it otherwise', () => {
    const withId = prependVersion(baseVersions, 'https://cdn/new.png', 'https://cdn/a.png', 'req-42');
    expect(withId[0].ai_request_id).toBe('req-42');
    const withoutId = prependVersion(baseVersions, 'https://cdn/new.png', 'https://cdn/a.png');
    expect(withoutId[0].ai_request_id).toBeUndefined();
  });
});

describe('versionFromMediaUrl', () => {
  it('builds a selected type=created display fallback', () => {
    const v = versionFromMediaUrl('https://cdn/sketch.png');
    expect(v).toMatchObject({ media_url: 'https://cdn/sketch.png', is_selected: true, type: 'created' });
    expect(v.original_url).toBeUndefined();
  });
});

describe('mapEditError', () => {
  // no-arg default: REPLICATE_ERROR/TIMEOUT now generalize to 'Xử lý ảnh' (tab-aware — S1).
  const cases: Array<[string, string]> = [
    ['UNSUPPORTED_MODEL', 'Model không hỗ trợ.'],
    ['IMAGE_FETCH_ERROR', 'Không tải được ảnh nguồn.'],
    ['INPUT_TOO_LARGE_FOR_MODEL', 'Ảnh quá lớn để upscale — giảm scale hoặc chọn ảnh nhỏ hơn.'],
    ['IMAGE_TOO_SMALL_FOR_MODEL', 'Ảnh quá nhỏ cho model này (tối thiểu 256px mỗi chiều) — chọn model khác hoặc ảnh lớn hơn.'],
    ['OUTPUT_FETCH_ERROR', 'Ảnh kết quả quá lớn — giảm scale.'],
    ['REPLICATE_RATE_LIMIT', 'Đang quá tải, thử lại sau ít giây.'],
    ['REPLICATE_ERROR', 'Xử lý ảnh thất bại, vui lòng thử lại.'],
    ['TIMEOUT', 'Xử lý ảnh thất bại, vui lòng thử lại.'],
    ['SSRF_BLOCKED', 'URL ảnh không hợp lệ.'],
    ['CONNECTION_ERROR', 'Mất kết nối tới máy chủ — vui lòng thử lại.'],
    // Inpaint / edit-object-image (Gemini) codes (Validation S1).
    ['SAFETY_FILTER_BLOCKED', 'Nội dung prompt/ảnh vi phạm policy.'],
    ['REGION_ASPECT_MISMATCH', 'Tỷ lệ vùng khoanh không khớp ảnh nguồn.'],
    ['REGION_TOO_LARGE', 'Ảnh quá lớn để inpaint — chọn version nhỏ hơn.'],
    ['VALIDATION_ERROR', 'Ảnh vùng khoanh không hợp lệ.'],
    // flux-fill-pro binary-mask codes (design §3).
    ['REGION_REQUIRED', 'Model này cần khoanh vùng — hãy tô vùng cần sửa.'],
    ['MASK_SIZE_MISMATCH', 'Kích thước vùng mask không khớp ảnh nguồn.'],
    ['REGION_KIND_MISMATCH', 'Loại vùng khoanh không phù hợp với model.'],
    ['GEMINI_RATE_LIMIT', 'Đang quá tải, thử lại sau ít giây.'],
    ['NO_IMAGE_RESPONSE', 'Xử lý ảnh thất bại, vui lòng thử lại.'],
    ['GEMINI_ERROR', 'Xử lý ảnh thất bại, vui lòng thử lại.'],
    ['STORAGE_UPLOAD_ERROR', 'Lưu ảnh thất bại, vui lòng thử lại.'],
    ['INTERNAL_ERROR', 'Đã có lỗi xảy ra, vui lòng thử lại.'],
    // Outpaint source-decode failure (05-outpaint-tab.md §3).
    ['DECODE_ERROR', 'Ảnh nguồn lỗi, không đọc được kích thước.'],
  ];
  it.each(cases)('maps EditApiError code %s', (code, message) => {
    expect(mapEditError(new EditApiError('raw', { errorCode: code }))).toBe(message);
  });

  it.each(['REPLICATE_ERROR', 'TIMEOUT', 'NO_IMAGE_RESPONSE', 'GEMINI_ERROR'])(
    'threads actionLabel into the generic %s wording',
    (code) => {
      expect(mapEditError(new EditApiError('raw', { errorCode: code }), { actionLabel: 'Upscale' })).toBe(
        'Upscale thất bại, vui lòng thử lại.',
      );
      expect(
        mapEditError(new EditApiError('raw', { errorCode: code }), { actionLabel: 'Inpaint' }),
      ).toBe('Inpaint thất bại, vui lòng thử lại.');
    },
  );

  it('maps INTERNAL_ERROR to the generic line, never the raw server message', () => {
    expect(mapEditError(new EditApiError('internal stack trace leak', { errorCode: 'INTERNAL_ERROR' }))).toBe(
      'Đã có lỗi xảy ra, vui lòng thử lại.',
    );
  });

  it('maps a CORS-tainted Error to the CORS message', () => {
    expect(mapEditError(new Error('Canvas export failed — canvas may be tainted by CORS'))).toMatch(/CORS/);
  });

  it('falls back to a plain Error message', () => {
    expect(mapEditError(new Error('boom'))).toBe('boom');
  });

  it('falls back to a generic message for unknown values', () => {
    expect(mapEditError(undefined)).toBe('Đã có lỗi xảy ra, vui lòng thử lại.');
    expect(mapEditError(new EditApiError('x', { errorCode: 'WAT' }))).toBe('x');
  });
});

describe('buildUpscalePayload', () => {
  const GRAIN_ON = { enabled: true, amp: 9, blur: 0.8 };
  const GRAIN_OFF = { enabled: false, amp: 9, blur: 0.8 };

  it('sends faceEnhance EXPLICITLY (even false) for scalable models + grain top-level', () => {
    const p = buildUpscalePayload('nightmareai/real-esrgan', 2, false, 'https://cdn/a.png', GRAIN_ON);
    expect(p).toEqual({
      imageUrl: 'https://cdn/a.png',
      scale: 2,
      modelParams: { model: 'nightmareai/real-esrgan', params: { faceEnhance: false } },
      grain: { enabled: true, amp: 9, blur: 0.8 },
    });
  });

  it('forwards faceEnhance=true for scalable models', () => {
    const p = buildUpscalePayload('alexgenovese/upscaler', 4, true, 'https://cdn/a.png', GRAIN_ON);
    expect(p.modelParams.params).toEqual({ faceEnhance: true });
    expect(p.modelParams.model).toBe('alexgenovese/upscaler');
  });

  it('omits params for recraft (native passthrough → empty params)', () => {
    const p = buildUpscalePayload('recraft-ai/recraft-crisp-upscale', 8, true, 'https://cdn/a.png', GRAIN_ON);
    expect(p.modelParams.params).toEqual({});
    expect(p.modelParams.model).toBe('recraft-ai/recraft-crisp-upscale');
  });

  it('omits faceEnhance for xinntao (anime no-op) but forwards scale', () => {
    // xinntao supportsFaceEnhance=false → params {} (no faceEnhance sent); scale honoured.
    const p = buildUpscalePayload('xinntao/realesrgan', 4, true, 'https://cdn/a.png', GRAIN_ON);
    expect(p.modelParams.params).toEqual({});
    expect(p.modelParams.model).toBe('xinntao/realesrgan');
    expect(p.scale).toBe(4);
  });

  it('forwards imageUrl + scale verbatim', () => {
    const p = buildUpscalePayload('nightmareai/real-esrgan', 6, true, 'https://cdn/source.png', GRAIN_ON);
    expect(p.imageUrl).toBe('https://cdn/source.png');
    expect(p.scale).toBe(6);
  });

  it('is MODEL-AGNOSTIC for grain — recraft (no scale/faceEnhance) still carries grain', () => {
    const p = buildUpscalePayload('recraft-ai/recraft-crisp-upscale', 8, true, 'https://cdn/a.png', GRAIN_ON);
    expect(p.grain).toEqual({ enabled: true, amp: 9, blur: 0.8 });
  });

  it('sends an EXPLICIT grain object even when toggle OFF (never omitted)', () => {
    const p = buildUpscalePayload('xinntao/realesrgan', 2, false, 'https://cdn/a.png', GRAIN_OFF);
    expect(p.grain).toEqual({ enabled: false, amp: 9, blur: 0.8 });
  });
});

describe('nearestAspectRatio', () => {
  it.each<[number, number, string]>([
    [1000, 1000, '1:1'],
    [1920, 1080, '16:9'],
    [1080, 1920, '9:16'],
    [800, 1000, '4:5'],
    [1000, 800, '5:4'],
  ])('maps %ix%i to %s', (w, h, expected) => {
    expect(nearestAspectRatio(w, h)).toBe(expected);
  });

  it('falls back to the default ratio on degenerate height/width', () => {
    expect(nearestAspectRatio(1000, 0)).toBe('1:1');
    expect(nearestAspectRatio(0, 1000)).toBe('1:1');
  });
});

describe('exceedsRegionSizeCap', () => {
  it('returns false for a short base64 string', () => {
    expect(exceedsRegionSizeCap('a'.repeat(1000))).toBe(false);
  });

  it('returns true once decoded bytes exceed the cap', () => {
    // length * 0.75 > cap  ⇒  length > cap / 0.75
    const overLength = Math.ceil(REGION_MAX_DECODED_BYTES / 0.75) + 1;
    expect(exceedsRegionSizeCap('a'.repeat(overLength))).toBe(true);
  });

  it('returns false right at the cap boundary', () => {
    const atLength = Math.floor(REGION_MAX_DECODED_BYTES / 0.75);
    expect(exceedsRegionSizeCap('a'.repeat(atLength))).toBe(false);
  });
});

describe('compositeMask', () => {
  const stroke: Stroke = { points: [{ x: 0.5, y: 0.5 }], size: 10, mode: 'erase', color: '#3b6cf6' };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(paintStrokesOnCtx).mockReset();
  });

  const fakeCtx = () =>
    ({
      fillStyle: '',
      fillRect: vi.fn(),
      putImageData: vi.fn(),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
    }) as unknown as CanvasRenderingContext2D;

  it('fills bg, recolors strokes to fg at paint mode, returns prefix-stripped base64', () => {
    const ctx = fakeCtx();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toDataURL: () => 'data:image/png;base64,STUBMASK',
    } as unknown as HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);

    const out = compositeMask([stroke], '#000000', '#ffffff', 20, 10, 10, 5);

    expect(out).toBe('STUBMASK'); // `data:` prefix stripped
    expect(canvas.width).toBe(20);
    expect(canvas.height).toBe(10);
    expect((ctx as unknown as { fillStyle: string }).fillStyle).toBe('#000000');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 20, 10);

    // Strokes forced to fg color + paint mode; brushScale = (20/10 + 10/5)/2 = 2.
    expect(paintStrokesOnCtx).toHaveBeenCalledTimes(1);
    const [, passedStrokes, activeArg, w, h, brushScale, clearFirst] = vi.mocked(paintStrokesOnCtx).mock.calls[0];
    expect(passedStrokes).toEqual([{ ...stroke, color: '#ffffff', mode: 'paint' }]);
    expect(activeArg).toBeNull();
    expect([w, h, brushScale]).toEqual([20, 10, 2]);
    // clearFirst MUST be false — passing true clearRects the black fillRect away, emitting a
    // transparent-bg mask that breaks the "black = KEEP" binary-mask contract.
    expect(clearFirst).toBe(false);
  });

  it('throws when the 2d context is unavailable', () => {
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    expect(() => compositeMask([stroke], '#000000', '#ffffff', 10, 10, 10, 10)).toThrow('Could not get 2D context');
  });
});

describe('fillEnclosedMask', () => {
  const W = 5;
  const H = 5;
  const buildGrid = (whitePixels: Array<[number, number]>): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(W * H * 4); // all black, alpha 0
    for (const [x, y] of whitePixels) {
      const p = (y * W + x) * 4;
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
      data[p + 3] = 255;
    }
    return data;
  };
  const red = (data: Uint8ClampedArray, x: number, y: number): number => data[(y * W + x) * 4];

  it('fills the interior enclosed by a closed stroke ring', () => {
    // A 3×3 ring at (1,1)–(3,3) with a black hole at the center (2,2).
    const ring: Array<[number, number]> = [
      [1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3],
    ];
    const data = buildGrid(ring);
    fillEnclosedMask(data, W, H);
    expect(red(data, 2, 2)).toBe(255); // enclosed center → white (inpaint)
    expect(red(data, 1, 1)).toBe(255); // ring stays white
    expect(red(data, 0, 0)).toBe(0); // outside → black (keep)
    expect(red(data, 4, 4)).toBe(0);
    expect(data[3]).toBe(255); // alpha forced opaque
  });

  it('leaves an open scribble as footprint only (nothing enclosed)', () => {
    // A straight horizontal line across the middle — the canvas is not partitioned.
    const data = buildGrid([[1, 2], [2, 2], [3, 2]]);
    fillEnclosedMask(data, W, H);
    expect(red(data, 2, 2)).toBe(255); // stroke stays white
    expect(red(data, 2, 1)).toBe(0); // above the line → reachable from border → black
    expect(red(data, 2, 3)).toBe(0); // below the line → black
  });
});

describe('DIRECTION_EDGES', () => {
  it('expands all four edges for "all"', () => {
    expect(DIRECTION_EDGES.all).toEqual({ t: 1, r: 1, b: 1, l: 1 });
  });

  it('expands only left+right for "horizontal"', () => {
    expect(DIRECTION_EDGES.horizontal).toEqual({ t: 0, r: 1, b: 0, l: 1 });
  });

  it('expands only top+bottom for "vertical"', () => {
    expect(DIRECTION_EDGES.vertical).toEqual({ t: 1, r: 0, b: 1, l: 0 });
  });

  it('expands a single edge for "bottom"', () => {
    expect(DIRECTION_EDGES.bottom).toEqual({ t: 0, r: 0, b: 1, l: 0 });
  });
});

describe('outpaintFrameInset', () => {
  it('grows top+bottom by ratio·h for vertical (left/right unchanged)', () => {
    // 13% of 800×600: ey = 0.13·600 = 78 each vertical edge; horizontal edges unchanged.
    const inset = outpaintFrameInset({ w: 800, h: 600 }, 'vertical', 13);
    expect(inset).toEqual({ left: 0, top: -78, width: 800, height: 600 + 2 * 78 });
  });

  it('grows left+right by ratio·w for horizontal (top/bottom unchanged)', () => {
    // 25% of 800×600: ex = 0.25·800 = 200 each horizontal edge.
    const inset = outpaintFrameInset({ w: 800, h: 600 }, 'horizontal', 25);
    expect(inset).toEqual({ left: -200, top: 0, width: 800 + 2 * 200, height: 600 });
  });

  it('coincides with the image box at ratio=0', () => {
    expect(outpaintFrameInset({ w: 800, h: 600 }, 'all', 0)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    });
  });

  it('offsets only the expanded edge for a single direction (right)', () => {
    const inset = outpaintFrameInset({ w: 800, h: 600 }, 'right', 50);
    expect(inset).toEqual({ left: 0, top: 0, width: 800 + 400, height: 600 });
  });
});

describe('buildOutpaintPayload', () => {
  it('omits prompt when empty/whitespace; always sends imageSize + model-only modelParams', () => {
    const p = buildOutpaintPayload('google/nano-banana-pro', 'all', 13, '   ', 'https://cdn/a.png');
    expect(p).toEqual({
      imageUrl: 'https://cdn/a.png',
      expandRatio: 13,
      direction: 'all',
      imageSize: '2K',
      modelParams: { model: 'google/nano-banana-pro' },
    });
    expect(p.prompt).toBeUndefined();
  });

  it('trims and forwards a non-empty prompt', () => {
    const p = buildOutpaintPayload('google/nano-banana-pro', 'top', 30, '  extend the sky  ', 'https://cdn/a.png');
    expect(p.prompt).toBe('extend the sky');
    expect(p.direction).toBe('top');
    expect(p.expandRatio).toBe(30);
  });
});

// resolveAiRequestId — walks the `original_url` chain backwards to the nearest ancestor carrying an
// `ai_request_id` (04-inpaint-tab.md §8.3). Fixtures are in-file object literals: editor test files
// type-check against `vite/client` types only, so no node builtin (fs/path) may be imported.
describe('resolveAiRequestId', () => {
  const version = (mediaUrl: string, extra: Partial<Illustration> = {}): Illustration => ({
    media_url: mediaUrl,
    created_time: '2026-07-25T00:00:00.000Z',
    is_selected: false,
    type: 'created',
    ...extra,
  });

  /** Newest-first chain: `v0` is the leaf; every entry's `original_url` points at the NEXT (older)
   *  entry, and ONLY `idAtIndex` carries an `ai_request_id`. */
  const buildChain = (length: number, idAtIndex: number): Illustration[] =>
    Array.from({ length }, (_, i) =>
      version(`https://cdn/v${i}.png`, {
        type: i === 0 ? 'created' : 'edited',
        ...(i < length - 1 ? { original_url: `https://cdn/v${i + 1}.png` } : {}),
        ...(i === idAtIndex ? { ai_request_id: `req-${i}` } : {}),
      }),
    );

  it('returns the version own id without walking (fromAncestor false)', () => {
    const own = version('https://cdn/a.png', { ai_request_id: 'req-direct' });
    expect(resolveAiRequestId(own, [own, ...baseVersions])).toEqual({
      id: 'req-direct',
      fromAncestor: false,
    });
  });

  it('borrows the id of the direct parent one hop up (fromAncestor true)', () => {
    const parent = version('https://cdn/gen.png', { ai_request_id: 'req-parent' });
    const child = version('https://cdn/erased.png', {
      type: 'edited',
      original_url: 'https://cdn/gen.png',
    });
    expect(resolveAiRequestId(child, [child, parent])).toEqual({
      id: 'req-parent',
      fromAncestor: true,
    });
  });

  it('walks multiple hops to the AI-gen root of the chain', () => {
    const root = version('https://cdn/gen.png', { ai_request_id: 'req-root' });
    const mid = version('https://cdn/mid.png', { type: 'edited', original_url: 'https://cdn/gen.png' });
    const leaf = version('https://cdn/leaf.png', { type: 'edited', original_url: 'https://cdn/mid.png' });
    expect(resolveAiRequestId(leaf, [leaf, mid, root])).toEqual({
      id: 'req-root',
      fromAncestor: true,
    });
  });

  it('gives up when original_url points at a url absent from versions (broken chain)', () => {
    const orphan = version('https://cdn/leaf.png', {
      type: 'edited',
      original_url: 'https://cdn/purged.png',
    });
    expect(resolveAiRequestId(orphan, [orphan])).toEqual({ id: null, fromAncestor: false });
  });

  it('terminates on a cycle (A → B → A) instead of hanging', () => {
    const a = version('https://cdn/a.png', { type: 'edited', original_url: 'https://cdn/b.png' });
    const b = version('https://cdn/b.png', { type: 'edited', original_url: 'https://cdn/a.png' });
    expect(resolveAiRequestId(a, [a, b])).toEqual({ id: null, fromAncestor: false });
  });

  it('stops at the hop cap — an id further back than INPAINT_PROV_MAX_HOPS is not reached', () => {
    const chain = buildChain(INPAINT_PROV_MAX_HOPS + 2, INPAINT_PROV_MAX_HOPS + 1);
    expect(resolveAiRequestId(chain[0], chain)).toEqual({ id: null, fromAncestor: false });
    // Sanity: the walk itself is fine — an id on the LAST hop inside the budget is still found, so
    // the null above is the cap doing its job, not a broken traversal.
    const reachable = buildChain(INPAINT_PROV_MAX_HOPS + 2, INPAINT_PROV_MAX_HOPS - 1);
    expect(resolveAiRequestId(reachable[0], reachable)).toEqual({
      id: `req-${INPAINT_PROV_MAX_HOPS - 1}`,
      fromAncestor: true,
    });
  });

  it('returns no provenance for a null version', () => {
    expect(resolveAiRequestId(null, baseVersions)).toEqual({ id: null, fromAncestor: false });
  });
});

describe('urlToBase64', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns prefix-stripped base64 + the source MIME on a valid fetch', async () => {
    // jsdom provides Blob + FileReader; only fetch needs stubbing.
    const blob = new Blob(['hello-reference'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
    const out = await urlToBase64('https://cdn/ref.png');
    expect(out.mimeType).toBe('image/png');
    expect(out.base64Data.length).toBeGreaterThan(0);
    expect(out.base64Data.startsWith('data:')).toBe(false); // prefix stripped
  });

  it('throws REF_FETCH_FAILED when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, blob: async () => new Blob([]) }));
    await expect(urlToBase64('https://cdn/missing.png')).rejects.toThrow('REF_FETCH_FAILED');
  });

  it('throws REF_UNSUPPORTED_TYPE for a non-whitelisted MIME (before reading)', async () => {
    // Fake blob (no FileReader read reached) — reject path validates MIME first.
    const blob = { type: 'image/gif', size: 10 } as unknown as Blob;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
    await expect(urlToBase64('https://cdn/anim.gif')).rejects.toThrow('REF_UNSUPPORTED_TYPE');
  });

  it('throws REF_TOO_LARGE once the decoded blob exceeds the cap (before reading)', async () => {
    const blob = { type: 'image/png', size: MAX_REF_BYTES + 1 } as unknown as Blob;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
    await expect(urlToBase64('https://cdn/huge.png')).rejects.toThrow('REF_TOO_LARGE');
  });
});
