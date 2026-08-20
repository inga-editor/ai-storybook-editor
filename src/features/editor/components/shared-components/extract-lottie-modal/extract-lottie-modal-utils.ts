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

// ── 4.3 Build .lottie v2 ─────────────────────────────────────────────────────

/** Resolve the version the build should use: explicit selection, else last (most recent). */
export function selectedVersionOf(part: LottiePart): LottiePartVersion | null {
  if (part.versions.length === 0) return null;
  return (
    part.versions.find((v) => v.id === part.selectedVersionId) ??
    part.versions[part.versions.length - 1]
  );
}

/** Pivot in % of the ORIGINAL image, with defaults (README §5): unset normal = center of
 *  bboxAtCrop; unset null = 50/50. `bboxAtCrop` is the selected version's frozen crop rect. */
function pivotOf(part: LottiePart, bboxAtCrop: BBoxPct | null): { x: number; y: number } {
  if (part.pivot) return part.pivot;
  if (part.kind === 'null' || !bboxAtCrop) return { x: 50, y: 50 };
  return { x: bboxAtCrop.x + bboxAtCrop.w / 2, y: bboxAtCrop.y + bboxAtCrop.h / 2 };
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
 * top-left while the pivot is the transform origin; parented children carry parent-LOCAL
 * position (child pivot comp − parent pivot comp).
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

  parts.forEach((part, i) => {
    const version = selectedVersionOf(part);
    const asset = assetByPartId.get(part.id);
    const isImageLayer = part.kind === 'normal' && !!version && !!asset;
    const bboxAtCrop = version?.bboxAtCrop ?? part.bbox ?? null;

    const pivot = pivotOf(part, bboxAtCrop);
    const pivotCompX = (pivot.x / 100) * imgW;
    const pivotCompY = (pivot.y / 100) * imgH;

    // Position: parent-local when parented (subtract parent pivot comp px).
    let posX = pivotCompX;
    let posY = pivotCompY;
    let parent: number | undefined;
    if (part.parentId && indexById.has(part.parentId)) {
      const parentIdx = indexById.get(part.parentId)!;
      const parentPart = parts[parentIdx];
      const parentPivot = pivotOf(parentPart, selectedVersionOf(parentPart)?.bboxAtCrop ?? null);
      posX -= (parentPivot.x / 100) * imgW;
      posY -= (parentPivot.y / 100) * imgH;
      parent = parentIdx + 1;
    }

    // Anchor + scale: the asset fills its bboxAtCrop rect in comp px (README §5). The stored PNG
    // may be a DIFFERENT resolution than that rect (e.g. a full-res 1024² swapped ball dropped
    // into a ~178px slot), so `s` maps native asset px → box comp px — keeping full image
    // resolution (no downscaled re-encode) while rendering at the correct size. Anchor is the
    // pivot's position WITHIN the box, in asset-local px (transform origin, applied pre-scale).
    // When asset px already equal the box (a crop at original resolution) → s=100, unchanged.
    let anchor: [number, number, number] = [0, 0, 0];
    let scale: [number, number, number] = [100, 100, 100];
    if (isImageLayer && bboxAtCrop && asset) {
      const boxLeftComp = (bboxAtCrop.x / 100) * imgW;
      const boxTopComp = (bboxAtCrop.y / 100) * imgH;
      const boxW = (bboxAtCrop.w / 100) * imgW;
      const boxH = (bboxAtCrop.h / 100) * imgH;
      const sx = boxW > 0 && asset.w > 0 ? (boxW / asset.w) * 100 : 100;
      const sy = boxH > 0 && asset.h > 0 ? (boxH / asset.h) * 100 : 100;
      const fx = boxW > 0 ? (pivotCompX - boxLeftComp) / boxW : 0;
      const fy = boxH > 0 ? (pivotCompY - boxTopComp) / boxH : 0;
      anchor = [fx * asset.w, fy * asset.h, 0];
      scale = [sx, sy, 100];
    }

    const layer: LottieLayer = {
      ddd: 0,
      ind: i + 1,
      ty: isImageLayer ? 2 : 3,
      nm: part.name,
      sr: 1,
      ip: 0,
      op: LOTTIE_OP,
      st: 0,
      bm: 0,
      ks: {
        a: { a: 0, k: anchor },
        p: { a: 0, k: [posX, posY, 0] },
        s: { a: 0, k: scale },
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
      },
    };
    if (parent !== undefined) layer.parent = parent;

    if (isImageLayer && asset) {
      const refId = `img_${i}`;
      layer.refId = refId;
      assets.push({ id: refId, w: asset.w, h: asset.h, u: '', p: asset.dataUrl, e: 1 });
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
    if (part.kind !== 'normal') continue;
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
