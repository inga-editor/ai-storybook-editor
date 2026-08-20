// extract-lottie-modal-utils.test.ts — Unit tests for the pure .lottie build math + archive
// round-trip + slugify. The canvas helpers (detectAlphaBBox / cropImageByBBox) are NOT covered
// here — jsdom has no real 2D raster backend; they are exercised in the live smoke.

import { describe, it, expect } from 'vitest';
import { DotLottie, unzipDotLottie } from '@dotlottie/dotlottie-js';
import { buildLottieAnimation, slugify, type PartAsset } from './extract-lottie-modal-utils';
import type { BBoxPct, LottiePart } from './extract-lottie-modal-types';

// 1×1 transparent PNG — valid asset payload so DotLottie.build() can externalize it.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makePart(over: Partial<LottiePart> & Pick<LottiePart, 'id'>): LottiePart {
  return {
    name: over.name ?? over.id,
    kind: 'normal',
    parentId: null,
    bbox: null,
    aspect: 'Free',
    segmentUrl: null,
    versions: [],
    selectedVersionId: null,
    pivot: null,
    maskStrokes: [],
    ...over,
  };
}

function withCropVersion(part: LottiePart, bboxAtCrop: BBoxPct): LottiePart {
  const v = {
    id: `${part.id}-v1`,
    media_url: `https://example/${part.id}.png`,
    type: 'crop' as const,
    bboxAtCrop,
    created_time: '2026-08-19T00:00:00.000Z',
  };
  return { ...part, versions: [v], selectedVersionId: v.id, bbox: bboxAtCrop };
}

describe('buildLottieAnimation — anchor / parent math (README §5)', () => {
  const imgW = 1000;
  const imgH = 800;

  it('pins exact ks.a / ks.p / parent / ty for a 2-part parented rig', () => {
    // Part A (parent): crop (10,20,30,40)% pivot (25,40)%
    const a = withCropVersion(
      makePart({ id: 'a', pivot: { x: 25, y: 40 } }),
      { x: 10, y: 20, w: 30, h: 40 },
    );
    // Part B (child of A): crop (50,50,20,20)% pivot (60,60)%
    const b = withCropVersion(
      makePart({ id: 'b', parentId: 'a', pivot: { x: 60, y: 60 } }),
      { x: 50, y: 50, w: 20, h: 20 },
    );
    const assets = new Map<string, PartAsset>([
      ['a', { dataUrl: PNG_1x1, w: 300, h: 320 }],
      ['b', { dataUrl: PNG_1x1, w: 200, h: 160 }],
    ]);

    const anim = buildLottieAnimation([a, b], imgW, imgH, 'rig', assets);

    expect(anim.v).toBe('5.7.0');
    expect(anim.w).toBe(imgW);
    expect(anim.h).toBe(imgH);
    expect(anim.layers).toHaveLength(2);
    expect(anim.assets).toHaveLength(2);

    const [la, lb] = anim.layers;
    // A: image layer, no parent. pivotComp=[250,320]; anchor=pivot-cropTopLeft=[150,160]
    expect(la.ty).toBe(2);
    expect(la.ind).toBe(1);
    expect(la.parent).toBeUndefined();
    expect(la.refId).toBe('img_0');
    expect(la.ks.a.k).toEqual([150, 160, 0]);
    expect(la.ks.p.k).toEqual([250, 320, 0]);

    // B: parented to A (ind 1). pivotComp=[600,480]; pos=child−parentPivot=[350,160]
    //    anchor=pivot−cropTopLeft=[100,80]
    expect(lb.ty).toBe(2);
    expect(lb.ind).toBe(2);
    expect(lb.parent).toBe(1);
    expect(lb.refId).toBe('img_1');
    expect(lb.ks.a.k).toEqual([100, 80, 0]);
    expect(lb.ks.p.k).toEqual([350, 160, 0]);

    // static transform (no keyframes)
    expect(la.ks.s.k).toEqual([100, 100, 100]);
    expect(la.ks.o.k).toBe(100);
    expect(la.ks.r.k).toBe(0);
  });

  it('defaults unset normal pivot to the bboxAtCrop center (asset px == box px → s=100)', () => {
    const a = withCropVersion(makePart({ id: 'a' }), { x: 10, y: 20, w: 30, h: 40 });
    // box = 30%×40% of 1000×800 = 300×320; asset matches → scale stays 100, anchor in box px.
    const anim = buildLottieAnimation([a], imgW, imgH, 'rig', new Map([['a', { dataUrl: PNG_1x1, w: 300, h: 320 }]]));
    // center = (10+15, 20+20)% = (25,40)% → comp [250,320]; anchor = center−topLeft = [150,160]
    expect(anim.layers[0].ks.p.k).toEqual([250, 320, 0]);
    expect(anim.layers[0].ks.a.k).toEqual([150, 160, 0]);
    expect(anim.layers[0].ks.s.k).toEqual([100, 100, 100]);
  });

  it('scales a full-res asset down to its bbox rect (native px ≠ box px → keeps resolution)', () => {
    // Same box (300×320) but a 1024² native asset (e.g. a swapped ball). Position is unchanged;
    // scale maps native→box and anchor is the pivot fraction (center) in asset-local px.
    const a = withCropVersion(makePart({ id: 'a' }), { x: 10, y: 20, w: 30, h: 40 });
    const anim = buildLottieAnimation([a], imgW, imgH, 'rig', new Map([['a', { dataUrl: PNG_1x1, w: 1024, h: 1024 }]]));
    const [la] = anim.layers;
    expect(la.ks.p.k).toEqual([250, 320, 0]); // pivot comp — independent of asset px
    expect(la.ks.a.k).toEqual([512, 512, 0]); // center of the 1024² asset (fx=fy=0.5)
    expect(la.ks.s.k).toEqual([(300 / 1024) * 100, (320 / 1024) * 100, 100]);
  });

  it('emits a ty:3 null layer (no asset, origin anchor, 50/50 default pivot)', () => {
    const n = makePart({ id: 'n', kind: 'null' });
    const anim = buildLottieAnimation([n], imgW, imgH, 'rig', new Map());
    expect(anim.assets).toHaveLength(0);
    const [ln] = anim.layers;
    expect(ln.ty).toBe(3);
    expect(ln.refId).toBeUndefined();
    expect(ln.ks.a.k).toEqual([0, 0, 0]);
    expect(ln.ks.p.k).toEqual([500, 400, 0]); // 50%/50% of 1000×800
  });
});

describe('buildLottieAnimation → DotLottie archive (v2 file-in-zip)', () => {
  it('zips to manifest version:"2" + a/rig.json + i/img_0.png', async () => {
    const a = withCropVersion(makePart({ id: 'a', pivot: { x: 50, y: 50 } }), { x: 25, y: 25, w: 50, h: 50 });
    const anim = buildLottieAnimation([a], 100, 100, 'rig', new Map([['a', { dataUrl: PNG_1x1, w: 1, h: 1 }]]));

    const dl = new DotLottie();
    type Arg = Parameters<DotLottie['addAnimation']>[0];
    dl.addAnimation({ id: 'rig', data: anim as unknown as Arg['data'] });
    await dl.build();
    const ab = await dl.toArrayBuffer();

    const entries = await unzipDotLottie(new Uint8Array(ab));
    const paths = Object.keys(entries);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('a/rig.json');
    expect(paths).toContain('i/img_0.png'); // inline e:1 auto-externalized to file-in-zip

    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    expect(manifest.version).toBe('2');
    expect(manifest.animations).toEqual([{ id: 'rig' }]);
  });
});

describe('slugify', () => {
  it('kebab-cases, strips punctuation, collapses separators', () => {
    expect(slugify('My Image (Lottie)!')).toBe('my-image-lottie');
    expect(slugify('  a__b  c ')).toBe('a-b-c');
  });
  it('falls back to "lottie" for empty/undefined', () => {
    expect(slugify('')).toBe('lottie');
    expect(slugify(undefined)).toBe('lottie');
    expect(slugify('!!!')).toBe('lottie');
  });
});
