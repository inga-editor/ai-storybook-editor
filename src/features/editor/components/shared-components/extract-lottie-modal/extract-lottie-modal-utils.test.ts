// extract-lottie-modal-utils.test.ts — Unit tests for the pure .lottie build math + archive
// round-trip + slugify. The canvas helpers (detectAlphaBBox / cropImageByBBox) are NOT covered
// here — jsdom has no real 2D raster backend; they are exercised in the live smoke.

import { describe, it, expect } from 'vitest';
import { DotLottie, unzipDotLottie } from '@dotlottie/dotlottie-js';
import {
  buildLottieAnimation,
  slugify,
  localToOriginal,
  originalToLocal,
  intersectBBox,
  erasableChildrenOf,
  type PartAsset,
} from './extract-lottie-modal-utils';
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

    // B: parented to A (ind 1). pivotComp=[600,480]; ks.p is in A's LOCAL (asset-px) space:
    //    p = a_A + (pivotComp_B − pivotComp_A)/s_A = [150,160] + [350,160] = [500,320]
    //    anchor=pivot−cropTopLeft=[100,80]
    expect(lb.ty).toBe(2);
    expect(lb.ind).toBe(2);
    expect(lb.parent).toBe(1);
    expect(lb.refId).toBe('img_1');
    expect(lb.ks.a.k).toEqual([100, 80, 0]);
    expect(lb.ks.p.k).toEqual([500, 320, 0]);

    // static transform (no keyframes)
    expect(la.ks.s.k).toEqual([100, 100, 100]);
    expect(la.ks.o.k).toBe(100);
    expect(la.ks.r.k).toBe(0);
  });

  it('renders a parented child at its pivot even when the parent is anchored AND scaled', () => {
    // World-space invariant: evaluating Lottie's transform chain must land every layer's anchor
    // at its pivotComp. Parent asset at HALF the box resolution → s_A = 200 (the case the old
    // "child − parent pivot" formula broke, shifting children by the parent anchor/scale).
    const a = withCropVersion(
      makePart({ id: 'a', pivot: { x: 25, y: 40 } }),
      { x: 10, y: 20, w: 30, h: 40 },
    );
    const b = withCropVersion(
      makePart({ id: 'b', parentId: 'a', pivot: { x: 60, y: 60 } }),
      { x: 50, y: 50, w: 20, h: 20 },
    );
    const anim = buildLottieAnimation([a, b], imgW, imgH, 'rig', new Map<string, PartAsset>([
      ['a', { dataUrl: PNG_1x1, w: 150, h: 160 }], // box 300×320 → s=[200,200]
      ['b', { dataUrl: PNG_1x1, w: 200, h: 160 }],
    ]));
    const [la, lb] = anim.layers;
    // Evaluate the chain: world = p_A + s_A×(p_B − a_A); expect the child pivot comp [600,480].
    const world = {
      x: (la.ks.p.k[0] as number) + ((la.ks.s.k[0] as number) / 100) * ((lb.ks.p.k[0] as number) - (la.ks.a.k[0] as number)),
      y: (la.ks.p.k[1] as number) + ((la.ks.s.k[1] as number) / 100) * ((lb.ks.p.k[1] as number) - (la.ks.a.k[1] as number)),
    };
    expect(world.x).toBeCloseTo(600, 8);
    expect(world.y).toBeCloseTo(480, 8);
  });

  it('unset pivot uses the bboxAtCrop TOP-LEFT (neutral origin, no invented center)', () => {
    const a = withCropVersion(makePart({ id: 'a' }), { x: 10, y: 20, w: 30, h: 40 });
    // box = 30%×40% of 1000×800 = 300×320; asset matches → scale stays 100.
    const anim = buildLottieAnimation([a], imgW, imgH, 'rig', new Map([['a', { dataUrl: PNG_1x1, w: 300, h: 320 }]]));
    // no pivot → origin = box top-left (10,20)% → comp [100,160]; anchor = origin−topLeft = [0,0]
    expect(anim.layers[0].ks.p.k).toEqual([100, 160, 0]);
    expect(anim.layers[0].ks.a.k).toEqual([0, 0, 0]);
    expect(anim.layers[0].ks.s.k).toEqual([100, 100, 100]);
  });

  it('scales a full-res asset down to its bbox rect (native px ≠ box px → keeps resolution)', () => {
    // Same box (300×320) but a 1024² native asset (e.g. a swapped ball). Unset pivot → top-left
    // origin: position = box top-left, anchor = [0,0]; scale still maps native→box.
    const a = withCropVersion(makePart({ id: 'a' }), { x: 10, y: 20, w: 30, h: 40 });
    const anim = buildLottieAnimation([a], imgW, imgH, 'rig', new Map([['a', { dataUrl: PNG_1x1, w: 1024, h: 1024 }]]));
    const [la] = anim.layers;
    expect(la.ks.p.k).toEqual([100, 160, 0]); // box top-left comp — independent of asset px
    expect(la.ks.a.k).toEqual([0, 0, 0]); // origin at asset top-left (fx=fy=0)
    expect(la.ks.s.k).toEqual([(300 / 1024) * 100, (320 / 1024) * 100, 100]);
  });

  it('treats a manual (hand-crop) part as an image layer, same as normal', () => {
    // A manual part is an opaque rectangle cropped from the original — downstream it is an image
    // layer identical to a normal part (invariant: image part = kind !== 'null').
    const m = withCropVersion(makePart({ id: 'm', kind: 'manual' }), { x: 10, y: 20, w: 30, h: 40 });
    const anim = buildLottieAnimation([m], imgW, imgH, 'rig', new Map([['m', { dataUrl: PNG_1x1, w: 300, h: 320 }]]));
    const [lm] = anim.layers;
    expect(lm.ty).toBe(2);
    expect(lm.refId).toBe('img_0');
    expect(anim.assets).toHaveLength(1);
  });

  it('emits a ty:3 null layer (no asset, origin anchor, unset pivot → 0,0)', () => {
    const n = makePart({ id: 'n', kind: 'null' });
    const anim = buildLottieAnimation([n], imgW, imgH, 'rig', new Map());
    expect(anim.assets).toHaveLength(0);
    const [ln] = anim.layers;
    expect(ln.ty).toBe(3);
    expect(ln.refId).toBeUndefined();
    expect(ln.ks.a.k).toEqual([0, 0, 0]);
    expect(ln.ks.p.k).toEqual([0, 0, 0]); // unset null pivot → 0,0
  });
});

describe('source-rect mapping (sub-part extraction)', () => {
  const rect: BBoxPct = { x: 20, y: 40, w: 50, h: 30 }; // parent asset rect in original %

  it('localToOriginal maps source-local % into the rect', () => {
    // local (10,20,40,50)% of a 50×30 rect at (20,40) → (25, 46, 20, 15) original %
    expect(localToOriginal({ x: 10, y: 20, w: 40, h: 50 }, rect)).toEqual({ x: 25, y: 46, w: 20, h: 15 });
  });

  it('originalToLocal is the inverse (round-trip)', () => {
    const local: BBoxPct = { x: 10, y: 20, w: 40, h: 50 };
    const back = originalToLocal(localToOriginal(local, rect), rect);
    expect(back.x).toBeCloseTo(local.x, 10);
    expect(back.y).toBeCloseTo(local.y, 10);
    expect(back.w).toBeCloseTo(local.w, 10);
    expect(back.h).toBeCloseTo(local.h, 10);
  });

  it('intersectBBox clips to the overlap and returns null when disjoint', () => {
    expect(intersectBBox({ x: 0, y: 0, w: 30, h: 50 }, rect)).toEqual({ x: 20, y: 40, w: 10, h: 10 });
    expect(intersectBBox({ x: 0, y: 0, w: 10, h: 10 }, rect)).toBeNull();
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

describe('erasableChildrenOf — extraction-tree children with a crop version', () => {
  const parentRect: BBoxPct = { x: 10, y: 10, w: 60, h: 60 };
  const parent = withCropVersion(makePart({ id: 'body' }), parentRect);
  const parentUrl = parent.versions[0].media_url;
  const childRect: BBoxPct = { x: 20, y: 20, w: 20, h: 20 };

  it('returns only cropped parts whose source.url is one of the parent version assets', () => {
    const arm = withCropVersion(
      makePart({ id: 'arm', source: { url: parentUrl, rect: parentRect } }),
      childRect,
    );
    const uncropped = makePart({ id: 'raw', source: { url: parentUrl, rect: parentRect } });
    const fromOriginal = withCropVersion(makePart({ id: 'root' }), childRect); // no source
    const fromOther = withCropVersion(
      makePart({ id: 'other', source: { url: 'https://example/else.png', rect: parentRect } }),
      childRect,
    );
    const nullPart = makePart({ id: 'null1', kind: 'null', source: { url: parentUrl, rect: parentRect } });

    const out = erasableChildrenOf([parent, arm, uncropped, fromOriginal, fromOther, nullPart], parent);
    expect(out.map(({ part }) => part.id)).toEqual(['arm']);
    expect(out[0].version.bboxAtCrop).toEqual(childRect);
  });

  it('prefers the crop-time version over a selected edited version', () => {
    const arm = withCropVersion(
      makePart({ id: 'arm', source: { url: parentUrl, rect: parentRect } }),
      childRect,
    );
    const edited = {
      id: 'arm-v2',
      media_url: 'https://example/arm-edited.png',
      type: 'edited' as const,
      original_url: arm.versions[0].media_url,
      bboxAtCrop: childRect,
      created_time: '2026-08-19T00:00:00.000Z',
    };
    const armEdited = { ...arm, versions: [...arm.versions, edited], selectedVersionId: edited.id };

    const out = erasableChildrenOf([parent, armEdited], parent);
    expect(out).toHaveLength(1);
    expect(out[0].version.type).toBe('crop');
  });

  it('matches children cut from a NON-selected parent version and never the parent itself', () => {
    const v2 = {
      id: 'body-v2',
      media_url: 'https://example/body-v2.png',
      type: 'edited' as const,
      bboxAtCrop: parentRect,
      created_time: '2026-08-19T00:00:00.000Z',
    };
    const parentTwoVersions = { ...parent, versions: [...parent.versions, v2], selectedVersionId: v2.id };
    const leg = withCropVersion(
      makePart({ id: 'leg', source: { url: parentUrl, rect: parentRect } }),
      childRect,
    );
    const out = erasableChildrenOf([parentTwoVersions, leg], parentTwoVersions);
    expect(out.map(({ part }) => part.id)).toEqual(['leg']);
  });
});
