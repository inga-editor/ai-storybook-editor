// extract-lottie-modal-types.ts — Session-local types shared across the 4 mode tabs +
// component props (design README §2.2 + 01-parts-tab §3.4 `bboxAtCrop` extension). Nothing
// here persists to a snapshot except the final auto_pic spawn payload; the draft subset is
// JSON-serializable (localStorage). `Stroke` is reused verbatim — it is fully serializable
// (normalized 0..1 points + primitives), so no separate draft stroke type is needed.

import type { SpreadImage } from '@/types/spread-types';
import type { Stroke } from '../edit-image-modal/erase-stroke-engine';

// 'normal' = AI-segment cutout (RGBA), 'manual' = hand-drawn rectangle cropped from the ORIGINAL
// image (opaque), 'null' = rig node (no asset). normal + manual are both image-bearing parts —
// downstream (pivot/edit/view/build/extract) treats them identically via `kind !== 'null'`.
export type LottiePartKind = 'normal' | 'manual' | 'null';
export type LottieModeTab = 'parts' | 'pivot' | 'edit' | 'eraser' | 'view';

/** Rectangle in % (0-100) of the ORIGINAL image — matches SpreadImage.geometry + crop APIs. */
export interface BBoxPct {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One cropped/edited asset version of a part. `bboxAtCrop` is frozen at crop time — the
 *  .lottie build sizes/positions from THIS, never the live (possibly re-dragged) part.bbox. */
export interface LottiePartVersion {
  id: string;
  media_url: string; // Storage URL (RGBA PNG). Any resolution — the build scales it to the
  // bbox rect (crop = box px → scale 100; a full-res replacement is scaled down, keeping quality).
  type: 'crop' | 'edited';
  original_url?: string; // edited: source version url (provenance)
  bboxAtCrop: BBoxPct; // ⚡ build uses THIS (01 §3.4)
  created_time: string;
}

export interface LottiePart {
  id: string;
  name: string;
  kind: LottiePartKind;
  parentId: string | null;
  bbox: BBoxPct | null; // % of original; null-part = null (rig node, no asset)
  /** Crop/segment SOURCE image: undefined/null = the ORIGINAL image. Set when the part was created
   *  while an image part was selected (sub-part extraction) — the parent's selected-version asset
   *  URL + that asset's rect in ORIGINAL %. bbox stays in original %; source.rect maps original ↔
   *  source-local space (segmentUrl of such a part is in source-local space too). */
  source?: { url: string; rect: BBoxPct } | null;
  aspect: string; // 'Free' | '1:1' | ... (PART_ASPECT_RATIOS)
  segmentUrl: string | null; // RGBA cutout full-size (normal only)
  versions: LottiePartVersion[];
  selectedVersionId: string | null;
  pivot: { x: number; y: number } | null; // % of ORIGINAL image
  maskStrokes: Stroke[]; // Edit tab, per-part
}

export interface ExtractLottieModalState {
  activeTab: LottieModeTab;
  parts: LottiePart[]; // list order = layer order (head = top)
  activePartId: string | null;
  zoom: number; // 50..400
  isProcessing: boolean;
}

export interface NewAutoPicFromLottie {
  sourceImageId: string;
  staticImageUrl: string;
  suggestedTitle: string;
}

export interface ExtractLottieModalProps {
  open: boolean;
  image: SpreadImage | null;
  spreadId: string;
  attribution?: { snapshotId?: string };
  onClose: () => void;
  /** Spawn the static auto_pic. Returns `true` when spawned, `false` when the host rejected it
   *  (e.g. spread not held) — the modal then keeps the draft + stays open instead of clearing. */
  onCreateAutoPic: (payload: NewAutoPicFromLottie) => boolean;
}

/** Draft persisted to localStorage — serializable subset (asset urls only, no base64/refs). */
export interface LottieDraft {
  version: 1;
  sourceUrl: string; // detect stale source on restore (README §6)
  parts: LottiePart[];
  activeTab: LottieModeTab;
  activePartId: string | null;
  savedAt: string;
}
