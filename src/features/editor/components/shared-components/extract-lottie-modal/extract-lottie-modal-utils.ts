// extract-lottie-modal-utils.ts — Pure/isolable helpers for the Extract-Lottie modal
// (design README §5). No store access. The crux is the .lottie v2 build:
//
//   buildLottieAnimation(...)  → pure bodymovin-JSON builder (canvas-free, fully unit-tested:
//                                exact ks.a / ks.p / parent / ty math per README §5).
//   buildLottieFile(...)       → fetch each selected version PNG → inline data-URI asset (e:1)
//                                → new DotLottie().addAnimation().build() → Blob.
//
// ⚡ Asset embedding (verified against @dotlottie/dotlottie-js@1.8.0): we hand the builder
// INLINE data-URI images (`e:1`, `p:'data:image/png;base64,…'`). On `.build()` the library
// AUTO-EXTERNALIZES them to `i/img_i.png` file-in-zip entries and emits a `version:"2"`
// manifest — i.e. we get the design's preferred `e:0` file-in-zip layout for free from the
// single inline path (no fflate hand-rolling, no e:0/e:1 branch). Round-trip proven: archive
// entries = manifest.json + a/rig.json + i/img_i.png.

import { DotLottie } from '@dotlottie/dotlottie-js';
import { createLogger } from '@/utils/logger';
import type { BBoxPct, LottiePart, LottiePartVersion } from './extract-lottie-modal-types';
import { LOTTIE_BODYMOVIN_VERSION, LOTTIE_FR, LOTTIE_OP } from './extract-lottie-modal-constants';

const log = createLogger('Editor', 'ExtractLottieModalUtils');

// ── 4.1 Alpha bounding box ───────────────────────────────────────────────────

/** Centered 25%×25% default when a cutout is empty (API already blocks coverage<0.005). */
const CENTER_DEFAULT_BBOX: BBoxPct = { x: 37.5, y: 37.5, w: 25, h: 25 };

/** Load an image with anonymous CORS (Storage public host sends CORS headers — required for
 *  a taint-free canvas `getImageData`). Rejects on error/timeout so callers can fall back. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/**
 * Scan a segment cutout's alpha channel → tight bbox in % (0-100) of the full image.
 * Downscales to ≤512px longest side (scan is % anyway → resolution-independent), pads ~1%,
 * clamps 0-100. Empty cutout → centered 25% default (01 §4).
 */
export async function detectAlphaBBox(imgUrl: string): Promise<BBoxPct> {
  const img = await loadImage(imgUrl);
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  if (!natW || !natH) return { ...CENTER_DEFAULT_BBOX };

  const scale = Math.min(1, 512 / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ...CENTER_DEFAULT_BBOX };
  ctx.drawImage(img, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { ...CENTER_DEFAULT_BBOX }; // fully transparent

  const pad = 1; // ~1% breathing room
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const xPct = clamp((minX / w) * 100 - pad);
  const yPct = clamp((minY / h) * 100 - pad);
  const wPct = clamp(((maxX - minX + 1) / w) * 100 + pad * 2);
  const hPct = clamp(((maxY - minY + 1) / h) * 100 + pad * 2);
  return {
    x: xPct,
    y: yPct,
    w: Math.min(wPct, 100 - xPct),
    h: Math.min(hPct, 100 - yPct),
  };
}

// ── 4.2 Client crop ──────────────────────────────────────────────────────────

/**
 * Crop the RGBA cutout to its bbox region → PNG data URL (transparent outside the object is
 * preserved). KISS — no crop-object-image round-trip (README §4.1). Output px = bbox natural px.
 */
export async function cropImageByBBox(imgUrl: string, bboxPct: BBoxPct): Promise<string> {
  const img = await loadImage(imgUrl);
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  const sx = Math.round((bboxPct.x / 100) * natW);
  const sy = Math.round((bboxPct.y / 100) * natH);
  const sw = Math.max(1, Math.round((bboxPct.w / 100) * natW));
  const sh = Math.max(1, Math.round((bboxPct.h / 100) * natH));
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/png');
}

// ── 4.2b Source-rect mapping (sub-part extraction on a parent part's asset) ──

/** Map a bbox in % of a SOURCE image (which occupies `rect` of the original) → original-image %. */
export function localToOriginal(local: BBoxPct, rect: BBoxPct): BBoxPct {
  return {
    x: rect.x + (local.x / 100) * rect.w,
    y: rect.y + (local.y / 100) * rect.h,
    w: (local.w / 100) * rect.w,
    h: (local.h / 100) * rect.h,
  };
}

/** Inverse of localToOriginal (`rect` w/h must be > 0). */
export function originalToLocal(orig: BBoxPct, rect: BBoxPct): BBoxPct {
  return {
    x: ((orig.x - rect.x) / rect.w) * 100,
    y: ((orig.y - rect.y) / rect.h) * 100,
    w: (orig.w / rect.w) * 100,
    h: (orig.h / rect.h) * 100,
  };
}

/** Intersection of two bboxes (same space). null = no overlap. */
export function intersectBBox(a: BBoxPct, b: BBoxPct): BBoxPct | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ── 4.2c Erase extracted sub-parts from a part's asset (client-only, no AI) ──

/** One region to erase: the sub-part's crop-time PNG (RGBA cutout for normal parts → erases only
 *  the object pixels; opaque rect for manual crops → erases the whole rect) + its frozen crop
 *  rect in ORIGINAL %. */
export interface EraseRegion {
  url: string;
  rect: BBoxPct;
}

/** Sub-parts of `parent` in the EXTRACTION tree — parts whose crop/segment source was one of the
 *  parent's version assets — that already carry a crop version. The pixel-space link is
 *  `source.url` (rig `parentId` is reparentable and deliberately ignored). The returned version
 *  is the crop-time one: an edited version's pixels no longer match what was cut out. */
export function erasableChildrenOf(
  parts: LottiePart[],
  parent: LottiePart,
): { part: LottiePart; version: LottiePartVersion }[] {
  const parentUrls = new Set(parent.versions.map((v) => v.media_url));
  const out: { part: LottiePart; version: LottiePartVersion }[] = [];
  for (const p of parts) {
    if (p.id === parent.id || p.kind === 'null' || !p.source) continue;
    if (!parentUrls.has(p.source.url)) continue;
    const version = p.versions.find((v) => v.type === 'crop') ?? p.versions[0];
    if (!version) continue;
    out.push({ part: p, version });
  }
  return out;
}

/** Alpha-dilation radius (asset px) when erasing sub-parts — the segment cutout's anti-aliased
 *  edge would otherwise leave a semi-transparent halo around every erased region. */
const ERASE_DILATE_PX = 2;

/**
 * Erase each region's pixels from a part asset → full-size PNG data URL (same dims as the asset).
 * Pure canvas compositing: binarize each region's alpha (any alpha>0 → opaque so anti-aliased
 * cutout edges erase fully), then `destination-out` draws at ±ERASE_DILATE_PX offsets mapped via
 * `assetRect` (the asset's bboxAtCrop in original %). Returns null when nothing visible remains.
 */
export async function erasePartsFromAsset(
  assetUrl: string,
  assetRect: BBoxPct,
  erasures: EraseRegion[],
): Promise<string | null> {
  const img = await loadImage(assetUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H) return null;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);

  for (const erasure of erasures) {
    const eImg = await loadImage(erasure.url);
    const mask = document.createElement('canvas');
    mask.width = eImg.naturalWidth;
    mask.height = eImg.naturalHeight;
    const mctx = mask.getContext('2d');
    if (!mctx) throw new Error('Canvas 2D context unavailable');
    mctx.drawImage(eImg, 0, 0);
    const id = mctx.getImageData(0, 0, mask.width, mask.height);
    for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] > 0 ? 255 : 0;
    mctx.putImageData(id, 0, 0);

    const local = originalToLocal(erasure.rect, assetRect);
    const dx = (local.x / 100) * W;
    const dy = (local.y / 100) * H;
    const dw = (local.w / 100) * W;
    const dh = (local.h / 100) * H;
    ctx.globalCompositeOperation = 'destination-out';
    for (const ox of [-ERASE_DILATE_PX, 0, ERASE_DILATE_PX]) {
      for (const oy of [-ERASE_DILATE_PX, 0, ERASE_DILATE_PX]) {
        ctx.drawImage(mask, dx + ox, dy + oy, dw, dh);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // Empty check on a small downscale (a remainder invisible at 256px is visually nothing).
  const scale = Math.min(1, 256 / Math.max(W, H));
  const cw = Math.max(1, Math.round(W * scale));
  const ch = Math.max(1, Math.round(H * scale));
  const check = document.createElement('canvas');
  check.width = cw;
  check.height = ch;
  const cctx = check.getContext('2d');
  if (cctx) {
    cctx.drawImage(canvas, 0, 0, cw, ch);
    const { data } = cctx.getImageData(0, 0, cw, ch);
    let hasPixel = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        hasPixel = true;
        break;
      }
    }
    if (!hasPixel) return null;
  }

  return canvas.toDataURL('image/png');
}

// ── 4.3 Build .lottie v2 ─────────────────────────────────────────────────────

/** Resolve the version the build should use: explicit selection, else last (most recent). */
export function selectedVersionOf(part: LottiePart): LottiePartVersion | null {
  if (part.versions.length === 0) return null;
  return (
    part.versions.find((v) => v.id === part.selectedVersionId) ??
    part.versions[part.versions.length - 1]
  );
}

/** Transform-origin in % of the ORIGINAL image. No default pivot is invented: an unset image part
 *  uses its bboxAtCrop TOP-LEFT (→ anchor [0,0], the neutral Lottie origin — render is unchanged,
 *  no center joint is baked in); an unset null node (no geometry) uses 0,0. `bboxAtCrop` is the
 *  selected version's frozen crop rect. */
function pivotOf(part: LottiePart, bboxAtCrop: BBoxPct | null): { x: number; y: number } {
  if (part.pivot) return part.pivot;
  if (part.kind === 'null' || !bboxAtCrop) return { x: 0, y: 0 };
  return { x: bboxAtCrop.x, y: bboxAtCrop.y };
}

/** Bodymovin transform (static — no keyframes). */
interface LottieTransform {
  a: { a: 0; k: [number, number, number] };
  p: { a: 0; k: [number, number, number] };
  s: { a: 0; k: [number, number, number] };
  r: { a: 0; k: 0 };
  o: { a: 0; k: 100 };
}
interface LottieLayer {
  ddd: 0;
  ind: number;
  ty: number;
  nm: string;
  sr: 1;
  ip: 0;
  op: number;
  st: 0;
  bm: 0;
  ks: LottieTransform;
  refId?: string;
  parent?: number;
}
interface LottieAsset {
  id: string;
  w: number;
  h: number;
  u: string;
  p: string;
  e: 0 | 1;
}
export interface LottieAnimationJson {
  v: string;
  fr: number;
  ip: 0;
  op: number;
  w: number;
  h: number;
  nm: string;
  assets: LottieAsset[];
  layers: LottieLayer[];
}

/** Per-normal-part asset payload the pure builder needs (data URI + natural px dims). */
export interface PartAsset {
  dataUrl: string;
  w: number;
  h: number;
}

/**
 * ⭐ Pure bodymovin builder (README §5). Canvas-/network-free so the anchor/parent math is
 * unit-pinned. `assetByPartId` supplies the inline PNG + dims for every NORMAL part that has a
 * selected version; null parts (and any normal without an asset) become `ty:3` null layers.
 *
 * Layer order = parts order (head = topmost). `ind` is 1-based; `parent` references the parent
 * part's `ind`. Anchor (layer-local px) places the asset so its top-left lands at bboxAtCrop's
 * top-left while the pivot is the transform origin. A parented layer's `ks.p` lives in the
 * PARENT's local (asset-px) space, so it is resolved by inverting the whole ancestor chain —
 * anchor AND scale of every ancestor, not just the parent pivot delta.
 */
export function buildLottieAnimation(
  parts: LottiePart[],
  imgW: number,
  imgH: number,
  title: string,
  assetByPartId: Map<string, PartAsset>,
): LottieAnimationJson {
  const indexById = new Map(parts.map((p, i) => [p.id, i]));
  const assets: LottieAsset[] = [];
  const layers: LottieLayer[] = [];

  // ── Pass 1: per-layer params in FIXED spaces — anchor/scale in asset px, pivot in comp px.
  // Anchor + scale: the asset fills its bboxAtCrop rect in comp px (README §5). The stored PNG
  // may be a DIFFERENT resolution than that rect (e.g. a full-res 1024² swapped ball dropped
  // into a ~178px slot), so `s` maps native asset px → box comp px — keeping full image
  // resolution (no downscaled re-encode) while rendering at the correct size. Anchor is the
  // pivot's position WITHIN the box, in asset-local px (transform origin, applied pre-scale).
  // When asset px already equal the box (a crop at original resolution) → s=100, unchanged.
  const calcs = parts.map((part, i) => {
    const version = selectedVersionOf(part);
    const asset = assetByPartId.get(part.id);
    const isImageLayer = part.kind !== 'null' && !!version && !!asset;
    const bboxAtCrop = version?.bboxAtCrop ?? part.bbox ?? null;

    const pivot = pivotOf(part, bboxAtCrop);
    const pivotComp = { x: (pivot.x / 100) * imgW, y: (pivot.y / 100) * imgH };

    let anchor: [number, number, number] = [0, 0, 0];
    let scale: [number, number, number] = [100, 100, 100];
    if (isImageLayer && bboxAtCrop && asset) {
      const boxLeftComp = (bboxAtCrop.x / 100) * imgW;
      const boxTopComp = (bboxAtCrop.y / 100) * imgH;
      const boxW = (bboxAtCrop.w / 100) * imgW;
      const boxH = (bboxAtCrop.h / 100) * imgH;
      const sx = boxW > 0 && asset.w > 0 ? (boxW / asset.w) * 100 : 100;
      const sy = boxH > 0 && asset.h > 0 ? (boxH / asset.h) * 100 : 100;
      const fx = boxW > 0 ? (pivotComp.x - boxLeftComp) / boxW : 0;
      const fy = boxH > 0 ? (pivotComp.y - boxTopComp) / boxH : 0;
      anchor = [fx * asset.w, fy * asset.h, 0];
      scale = [sx, sy, 100];
    }

    const rawParentIdx = part.parentId != null ? indexById.get(part.parentId) : undefined;
    const parentIdx = rawParentIdx !== undefined && rawParentIdx !== i ? rawParentIdx : null;
    return { part, asset, isImageLayer, pivotComp, anchor, scale, parentIdx };
  });

  // ── Pass 2: ks.p. Lottie evaluates a layer's transform in its parent's LOCAL space:
  // world(x) = T_parent(p + M(x − a)), so the invariant "the anchor lands at pivotComp in comp
  // space" gives p_L = T_parent⁻¹(pivotComp_L), inverted recursively up the chain:
  //   toLocal(root, y)  = y                                  (comp space)
  //   toLocal(i, y)     = a_i + (toLocal(parent_i, y) − p_i) / s_i
  //   p_i               = toLocal(parent_i, pivotComp_i)
  // A `stack` guards malformed parent cycles (degrades that link to comp space).
  const posCache = new Map<number, { x: number; y: number }>();
  const layerPos = (i: number, stack: ReadonlySet<number>): { x: number; y: number } => {
    const hit = posCache.get(i);
    if (hit) return hit;
    const c = calcs[i];
    const pos =
      c.parentIdx === null || stack.has(i)
        ? c.pivotComp
        : toLocal(c.parentIdx, c.pivotComp, new Set(stack).add(i));
    posCache.set(i, pos);
    return pos;
  };
  const toLocal = (
    i: number,
    point: { x: number; y: number },
    stack: ReadonlySet<number>,
  ): { x: number; y: number } => {
    const c = calcs[i];
    const up =
      c.parentIdx === null || stack.has(c.parentIdx) ? point : toLocal(c.parentIdx, point, stack);
    const p = layerPos(i, stack);
    return {
      x: c.anchor[0] + (up.x - p.x) / (c.scale[0] / 100 || 1),
      y: c.anchor[1] + (up.y - p.y) / (c.scale[1] / 100 || 1),
    };
  };

  calcs.forEach((c, i) => {
    const pos = layerPos(i, new Set());
    const layer: LottieLayer = {
      ddd: 0,
      ind: i + 1,
      ty: c.isImageLayer ? 2 : 3,
      nm: c.part.name,
      sr: 1,
      ip: 0,
      op: LOTTIE_OP,
      st: 0,
      bm: 0,
      ks: {
        a: { a: 0, k: c.anchor },
        p: { a: 0, k: [pos.x, pos.y, 0] },
        s: { a: 0, k: c.scale },
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
      },
    };
    if (c.parentIdx !== null) layer.parent = c.parentIdx + 1;

    if (c.isImageLayer && c.asset) {
      const refId = `img_${i}`;
      layer.refId = refId;
      assets.push({ id: refId, w: c.asset.w, h: c.asset.h, u: '', p: c.asset.dataUrl, e: 1 });
    }
    layers.push(layer);
  });

  return {
    v: LOTTIE_BODYMOVIN_VERSION,
    fr: LOTTIE_FR,
    ip: 0,
    op: LOTTIE_OP,
    w: imgW,
    h: imgH,
    nm: title || 'rig',
    assets,
    layers,
  };
}

/** Fetch a URL → PNG data URL + natural dims (for the inline asset payload). */
async function fetchAsPartAsset(url: string): Promise<PartAsset> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Failed to fetch part asset (${res.status})`);
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read part asset blob'));
    reader.readAsDataURL(blob);
  });
  const dims = await loadImage(dataUrl).then((img) => ({
    w: img.naturalWidth,
    h: img.naturalHeight,
  }));
  return { dataUrl, w: dims.w, h: dims.h };
}

/**
 * Build the downloadable `.lottie` v2 Blob (README §5). Fetches each selected version PNG,
 * feeds them as inline assets to the pure builder, then zips via @dotlottie/dotlottie-js
 * (auto-externalizes to `i/*.png`, manifest `version:"2"`). Throws on any fetch/build failure
 * so the caller can abort WITHOUT spawning an auto_pic (atomic order — build+download first).
 */
export async function buildLottieFile(
  parts: LottiePart[],
  imgW: number,
  imgH: number,
  title: string,
): Promise<Blob> {
  const assetByPartId = new Map<string, PartAsset>();
  for (const part of parts) {
    if (part.kind === 'null') continue;
    const version = selectedVersionOf(part);
    if (!version) continue;
    assetByPartId.set(part.id, await fetchAsPartAsset(version.media_url));
  }

  const animation = buildLottieAnimation(parts, imgW, imgH, title, assetByPartId);

  const dotLottie = new DotLottie();
  type AddAnimationArg = Parameters<DotLottie['addAnimation']>[0];
  dotLottie.addAnimation({ id: 'rig', data: animation as unknown as AddAnimationArg['data'] });
  await dotLottie.build();
  const blob = await dotLottie.toBlob();
  log.debug('buildLottieFile', 'built', {
    bytes: blob.size,
    layers: animation.layers.length,
    assets: animation.assets.length,
  });
  return blob;
}

// ── 4.4 Download + slugify ───────────────────────────────────────────────────

export function slugify(title: string | undefined): string {
  const base = (title ?? 'lottie')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'lottie';
}

/** Editor context (not the artifact sandbox) → a plain `<a download>` click works. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has committed the navigation.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
