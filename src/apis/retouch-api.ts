import { callImageApi, type ImageApiFailure } from './image-api-client';
import { createLogger } from '@/utils/logger';
import type { WordTiming } from '@/types/spread-types';
import type { AspectRatio } from '@/constants/aspect-ratio-constants';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('API', 'RetouchApi');

// --- Types ---

export interface LayeringImageParams {
  imageUrl: string;
  description?: string;
  numberOfLayers?: number;
  goFast?: boolean;
  seed?: number | null;
  outputFormat?: 'webp' | 'jpg' | 'png';
  outputQuality?: number;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
}

export interface LayeringImageResult {
  success: boolean;
  data?: { urls: string[]; contentType: string; aiRequestId?: string };
  error?: string;
  meta?: { processingTime?: number; numberOfLayers?: number; replicatePredictionId?: string };
}

export interface EditObjectImageParams {
  prompt: string;
  imageUrl: string;
  /** Region annotation (Inpaint tab), PNG base64 WITHOUT the `data:` URI prefix. `kind` selects
   *  the flatten style per model: `marked_source` = source + translucent set-of-mark (Gemini,
   *  nano-banana-pro); `binary_mask` = black-KEEP / white-INPAINT mask (flux-fill-pro). Omit `kind`
   *  → server treats as `marked_source` (backward-compat). Omit the whole field for a prompt-only
   *  full-image edit (Gemini only; flux requires a mask). */
  regionAnnotation?: { base64Data: string; mimeType: string; kind?: 'marked_source' | 'binary_mask' };
  /** Reference images (identity/material anchors for content named in `prompt`). Max 5,
   *  base64 WITHOUT the `data:` prefix. ⚡2026-07-25: the Inpaint tab NEVER sets `description` for
   *  ANY item (04-inpaint-tab.md §8.1) — a provenance ref only carries a POSITIONAL label of the OLD
   *  call, which would mis-align the NEW call's image map; the API applies its own generic
   *  "ẢNH THAM KHẢO" label. The field stays optional for other / future callers. */
  referenceImages?: Array<{ base64Data: string; mimeType: string; description?: string }>;
  // GIỮ `string` (Validation S1): caller image-task-slice.ts passes StartEditTaskParams.aspectRatio?: string.
  // nearestAspectRatio() returns AspectRatio (assignable to string) → no type-safety loss on the inpaint path.
  aspectRatio?: string;
  imageSize?: string;
  /** Model override — allowlist group `edit-object` (v1 Gemini-only). Omit `params` → server
   *  temperature default 0.3. Out-of-allowlist model → 422 UNSUPPORTED_MODEL. */
  modelParams?: { model: string; params?: { temperature?: number } };
  /** Book-edit context → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Remix context → ai_service_logs.remix_id (discriminator — wins over snapshotId). */
  remixId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface EditObjectImageResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number; model?: string };
}

// ── Outpaint (09-outpaint-image) ──────────────────────────────────────────────

/** Edge-expansion direction — mirrors the API enum + DIRECTION_EDGES map 1:1. Server derives
 *  the output aspect ratio from source + direction + expandRatio (NO `aspectRatio` param). */
export type ExpandDirection =
  | 'all' | 'top' | 'bottom' | 'left' | 'right' | 'horizontal' | 'vertical';

export interface OutpaintImageParams {
  imageUrl: string;
  /** Per-edge expand percent (0, 100] — gated ratio>0 at the UI; >50 → server log.warn (quality). */
  expandRatio: number;
  direction: ExpandDirection;
  /** Optional guidance, ≤ 2000 chars; omit when empty (server fills its own continuation prompt). */
  prompt?: string;
  /** Gemini output resolution. Default '2K' server-side; FE sends explicit (parity inpaint). */
  imageSize?: '1K' | '2K' | '4K';
  /** Model override — allowlist group `outpaint` (v1 Gemini-only; out-of-allowlist → 422
   *  UNSUPPORTED_MODEL). Omit `params` → server temperature default 0.4. */
  modelParams?: { model: string; params?: { temperature?: number } };
  /** Book-edit context → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Remix context → ai_service_logs.remix_id (discriminator — wins over snapshotId). */
  remixId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface OutpaintImageResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: {
    processingTime?: number;
    mimeType?: string;
    tokenUsage?: number;
    model?: string;
    canvasAspectRatio?: string;
    outputWidth?: number;
    outputHeight?: number;
    expandedEdges?: string[];
  };
}

export interface CropBoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
  aspectRatio: string;
}

export interface CropObjectImageParams {
  imageUrl: string;
  boundingBoxes: CropBoundingBox[];
}

export interface CropObjectResult {
  boxIndex: number;
  base64: string;
  mimeType: 'image/png';
  aspectRatio: string;
  width?: number;
  height?: number;
}

export interface CropObjectImageResult {
  success: boolean;
  data?: {
    croppedObjects: CropObjectResult[];
  };
  error?: string;
  meta?: {
    processingTime?: number;
    sourceWidth?: number;
    sourceHeight?: number;
    sourceMimeType?: string;
    inputBytes?: number;
  };
}

// --- Detect Objects (07-detect-objects) ---

/** Structured tag mirroring snapshot illustration tags spec — carried into spawned
 *  layer.tags[]. `variant_key` is null when the @mention has no "/variant" segment. */
export interface DetectTag {
  type: 'character' | 'prop';
  object_key: string;
  variant_key: string | null;
}

export interface DetectObjectsParams {
  imageUrl: string;
  visualDescription: string;
  snapshotId: string;
  /** Override bounding model — allowlist group `detect-objects`. Omit → server default. */
  modelParams?: { model?: string; params?: Record<string, unknown> };
}

export interface DetectedObject {
  object: string; // "@key/variant" mention (audit)
  tag: DetectTag;
  /** Bounding box in basis points: 100% == 10000 (consumer divides by 100 → %). */
  geometry: { x: number; y: number; w: number; h: number };
  /** Canonical visual aspect after server clamp — NOT derivable from basis w/h. */
  ratio: AspectRatio;
  confidence?: number;
}

export interface DetectObjectsResult {
  success: boolean;
  data?: { objects: DetectedObject[] };
  error?: string;
  meta?: {
    processingTime?: number;
    model?: string;
    tokenUsage?: number;
    sourceWidth?: number;
    sourceHeight?: number;
    detectedCount?: number;
    droppedCount?: number;
  };
}

// --- Detect Texts (11-detect-texts) — OCR bounding boxes for raw_textbox spawn ---
// Minimal Objects sibling: input is imageUrl + optional model only (no visualDescription /
// snapshotId — OCR needs no scene context); response carries `texts[]` (no ratio/tag).
// Types validated against the live OpenAPI (`/docs#/retouch/detect_texts...`).

export interface DetectTextsParams {
  imageUrl: string;
  /** OCR model override — allowlist group `detect-texts`. `model` is REQUIRED when `modelParams`
   *  is present (live OpenAPI required:["model"]). Omit `modelParams` → server default. */
  modelParams?: { model: string; params?: Record<string, unknown> };
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
}

export interface DetectedText {
  /** Verbatim OCR text — may be multi-line (`\n`). ⚠️ never logged (PII — spec §Security). */
  content: string;
  /** Bounding box in basis points: 100% == 10000 (consumer divides by 100 → %). */
  geometry: { x: number; y: number; w: number; h: number };
  confidence?: number;
}

export interface DetectTextsResult {
  success: boolean;
  data?: { texts: DetectedText[] };
  error?: string;
  httpStatus?: number;
  errorCode?: string;
  meta?: {
    processingTime?: number;
    model?: string;
    tokenUsage?: number;
    sourceWidth?: number;
    sourceHeight?: number;
    detectedCount?: number;
    droppedCount?: number;
  };
}

export interface ImageRemoveBgParams {
  imageUrl: string;
  preserveAlpha?: boolean;
  backgroundColor?: string | null;
  /** Replicate rmbg model owner/name — allowlist group `rmbg` (⚡2026-06-13). Omit → Bria
   *  default (server-side). Validated against the allowlist at the endpoint before binding
   *  to the core (never forwarded raw). FE sends explicit value to match the UI default. */
  model?: string;
  /** Book-edit context → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Remix context → ai_service_logs.remix_id (discriminator — wins over snapshotId). */
  remixId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface ImageRemoveBgResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; replicatePredictionId?: string; backgroundColor?: string | null };
}

// ── Remove Text (10-remove-text-image) ─────────────────────────────────────────

export interface RemoveTextImageParams {
  imageUrl: string;
  /** Replicate text-removal model — allowlist group `remove-text`. Omit → server default
   *  (`flux-kontext-apps/text-removal`). Flat `model` (NOT nested `modelParams`). FE sends
   *  explicit value to match the UI default. */
  model?: string;
  /** Book-edit context → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Remix context → ai_service_logs.remix_id (discriminator — wins over snapshotId). */
  remixId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface RemoveTextImageResult {
  success: true;
  data: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  meta?: {
    processingTime?: number;
    mimeType?: string;
    model?: string;
    replicatePredictionId?: string;
  };
}

export interface GenerateNarrationParams {
  script: string;
  voiceId: string;
  speed?: number;
  emotion?: string;
}

export interface GenerateNarrationResult {
  success: boolean;
  data?: {
    audioUrl: string;
    storagePath: string;
    voiceId: string;
    wordTimings?: WordTiming[];
  };
  error?: string;
  meta?: {
    processingTime?: number;
    audioEncoding?: string;
    sampleRateHertz?: number;
    characterCount?: number;
  };
}

// --- API ---

export async function callCropObjectImage(
  params: CropObjectImageParams
): Promise<CropObjectImageResult | ImageApiFailure> {
  log.info('callCropObjectImage', 'start', { boxCount: params.boundingBoxes.length });
  const res = await callImageApi<CropObjectImageResult>('/api/retouch/crop-object-image', params);
  if (res.success) {
    const data = (res as CropObjectImageResult).data;
    log.info('callCropObjectImage', 'success', {
      count: data?.croppedObjects.length ?? 0,
      processingMs: (res as CropObjectImageResult).meta?.processingTime,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callCropObjectImage', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  return res;
}

export async function callDetectObjects(
  params: DetectObjectsParams
): Promise<DetectObjectsResult | ImageApiFailure> {
  log.info('callDetectObjects', 'start', {
    imageUrl: params.imageUrl.slice(0, 80),
    descLen: params.visualDescription.length,
    model: params.modelParams?.model,
  });
  const res = await callImageApi<DetectObjectsResult>('/api/retouch/detect-objects', params);
  if (res.success) {
    const r = res as DetectObjectsResult;
    log.info('callDetectObjects', 'success', {
      count: r.data?.objects.length ?? 0,
      detectedCount: r.meta?.detectedCount,
      droppedCount: r.meta?.droppedCount,
      processingMs: r.meta?.processingTime,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callDetectObjects', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  return res;
}

export async function callDetectTexts(
  params: DetectTextsParams,
): Promise<DetectTextsResult | ImageApiFailure> {
  log.info('callDetectTexts', 'start', {
    imageUrl: params.imageUrl.slice(0, 80),
    model: params.modelParams?.model,
  });
  const res = await callImageApi<DetectTextsResult>('/api/retouch/detect-texts', params);
  if (res.success) {
    const r = res as DetectTextsResult;
    // ⚠️ count/meta only — never log OCR `content` (PII, spec §Security).
    log.info('callDetectTexts', 'success', {
      count: r.data?.texts.length ?? 0,
      detectedCount: r.meta?.detectedCount,
      droppedCount: r.meta?.droppedCount,
      processingMs: r.meta?.processingTime,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.warn('callDetectTexts', 'failed', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  return res;
}

export async function callEditObjectImage(
  params: EditObjectImageParams
): Promise<EditObjectImageResult | ImageApiFailure> {
  log.info('callEditObjectImage', 'start', {
    promptLength: params.prompt.length,
    refCount: params.referenceImages?.length ?? 0,
    hasRegion: !!params.regionAnnotation,
    aspectRatio: params.aspectRatio,
    imageSize: params.imageSize,
    model: params.modelParams?.model,
  });
  const res = await callImageApi<EditObjectImageResult>('/api/retouch/edit-object-image', params);
  if (res.success) {
    const r = res as EditObjectImageResult;
    log.info('callEditObjectImage', 'success', {
      processingMs: r.meta?.processingTime,
      mimeType: r.meta?.mimeType,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callEditObjectImage', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  warnIfSaveResourceFailed(log.warn, 'callEditObjectImage', res);
  return res;
}

export async function callOutpaintImage(
  params: OutpaintImageParams
): Promise<OutpaintImageResult | ImageApiFailure> {
  log.info('callOutpaintImage', 'start', {
    imageUrl: params.imageUrl.slice(0, 80),
    direction: params.direction,
    expandRatio: params.expandRatio,
    hasPrompt: !!params.prompt,
    model: params.modelParams?.model,
  });
  const res = await callImageApi<OutpaintImageResult>('/api/retouch/outpaint-image', params);
  if (res.success) {
    const r = res as OutpaintImageResult;
    log.info('callOutpaintImage', 'success', {
      processingMs: r.meta?.processingTime,
      canvasAspectRatio: r.meta?.canvasAspectRatio,
      outputWidth: r.meta?.outputWidth,
      outputHeight: r.meta?.outputHeight,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callOutpaintImage', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  warnIfSaveResourceFailed(log.warn, 'callOutpaintImage', res);
  return res;
}

export async function callImageRemoveBg(
  params: ImageRemoveBgParams
): Promise<ImageRemoveBgResult | ImageApiFailure> {
  log.info('callImageRemoveBg', 'start', {
    imageUrl: params.imageUrl.slice(0, 80),
    preserveAlpha: params.preserveAlpha,
    backgroundColor: params.backgroundColor,
  });
  const res = await callImageApi<ImageRemoveBgResult>('/api/retouch/image-remove-bg', params);
  if (res.success) {
    const r = res as ImageRemoveBgResult;
    log.info('callImageRemoveBg', 'success', {
      processingMs: r.meta?.processingTime,
      mimeType: r.meta?.mimeType,
      predictionId: r.meta?.replicatePredictionId,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callImageRemoveBg', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  warnIfSaveResourceFailed(log.warn, 'callImageRemoveBg', res);
  return res;
}

export async function callRemoveTextImage(
  params: RemoveTextImageParams
): Promise<RemoveTextImageResult | ImageApiFailure> {
  log.info('callRemoveTextImage', 'start', {
    imageUrl: params.imageUrl.slice(0, 80),
    model: params.model,
  });
  const res = await callImageApi<RemoveTextImageResult>('/api/retouch/remove-text-image', params);
  if (res.success) {
    const r = res as RemoveTextImageResult;
    log.info('callRemoveTextImage', 'success', {
      processingMs: r.meta?.processingTime,
      model: r.meta?.model,
      predictionId: r.meta?.replicatePredictionId,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callRemoveTextImage', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  warnIfSaveResourceFailed(log.warn, 'callRemoveTextImage', res);
  return res;
}

// TODO: Re-implement narration generation via the ElevenLabs voice API.
// The `retouch-generate-narration` edge function is deprecated. The branching
// modal should drive narration through the ElevenLabs-backed voice endpoints
// (see narrate-script-api.ts `/api/text/narrate-script` or voice-api.ts).
// Stubbed until that wiring lands — returns a not-available failure so callers
// degrade gracefully instead of hitting the dead edge function.
export async function callGenerateNarration(
  params: GenerateNarrationParams
): Promise<GenerateNarrationResult> {
  log.warn('callGenerateNarration', 'not implemented — retouch-generate-narration deprecated, pending ElevenLabs migration', {
    scriptLength: params.script.length,
    voiceId: params.voiceId,
  });
  return { success: false, error: 'Tính năng sinh narration đang được chuyển sang ElevenLabs, tạm thời chưa khả dụng.' };
}

export async function callLayeringImage(
  params: LayeringImageParams
): Promise<LayeringImageResult | ImageApiFailure> {
  log.info('callLayeringImage', 'start', { hasDescription: !!params.description, layers: params.numberOfLayers });
  const res = await callImageApi<LayeringImageResult>('/api/retouch/layering-image', params);
  if (res.success) {
    const meta = (res as LayeringImageResult).meta;
    log.info('callLayeringImage', 'success', {
      layerCount: (res as LayeringImageResult).data?.urls.length ?? 0,
      processingMs: meta?.processingTime,
      predictionId: meta?.replicatePredictionId,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callLayeringImage', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  return res;
}

// --- Segment Layer ---

export interface SegmentLayerParams {
  imageUrl: string;
  prompt: string;
  threshold?: number;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
}

export interface SegmentLayerResult {
  success: boolean;
  data?: {
    imageUrl: string;
    storagePath: string;
    aiRequestId?: string;
  };
  error?: string;
  meta?: {
    processingTime?: number;
    mimeType?: string;
    sourceWidth?: number;
    sourceHeight?: number;
    coverageRatio?: number;
  };
}

export async function callSegmentLayer(
  params: SegmentLayerParams
): Promise<SegmentLayerResult | ImageApiFailure> {
  const promptPreview = params.prompt.slice(0, 100);
  log.info('callSegmentLayer', 'start', { promptLen: params.prompt.length, threshold: params.threshold, promptPreview });
  const res = await callImageApi<SegmentLayerResult>('/api/retouch/segment-layer', params);
  if (res.success) {
    log.info('callSegmentLayer', 'success', { coverageRatio: (res as SegmentLayerResult).meta?.coverageRatio });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callSegmentLayer', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  return res;
}

// --- Generate Background (08-generate-background) ---

/** One object to remove from the scene before the background is repainted. v1 sends
 *  `imageUrl`-only (API accepts one-of imageUrl⊕base64; FE never uploads base64). */
export interface GenerateBackgroundRemoveObject {
  imageUrl: string;
  name?: string;
  type?: 'character' | 'prop';
  visualDescription?: string;
}

export interface GenerateBackgroundParams {
  imageUrl: string;
  removeObjects: GenerateBackgroundRemoveObject[]; // [1..16]
  prompt?: string;
  aspectRatio?: string; // omit → API auto-derives nearest source ratio
  imageSize?: string;   // omit → API default "2K"
  /** Model override — allowlist group `generate-background`. Omit → server default. */
  modelParams?: { model: string; params?: { temperature?: number } };
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateBackgroundResult {
  success: true;
  data: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  meta?: {
    processingTime?: number;
    mimeType?: string;
    tokenUsage?: number;
    model?: string;
    aspectRatio?: string;
    removedCount?: number;
  };
}

export async function callGenerateBackground(
  params: GenerateBackgroundParams
): Promise<GenerateBackgroundResult | ImageApiFailure> {
  // Redact: log object count + prompt length only (no full URLs / prompt text — privacy).
  log.info('callGenerateBackground', 'start', {
    removeCount: params.removeObjects.length,
    promptLen: params.prompt?.length ?? 0,
    hasModelParams: !!params.modelParams,
  });
  const res = await callImageApi<GenerateBackgroundResult>('/api/retouch/generate-background', params);
  if (res.success) {
    const r = res as GenerateBackgroundResult;
    log.info('callGenerateBackground', 'success', {
      storagePath: r.data.storagePath,
      removedCount: r.meta?.removedCount,
      processingMs: r.meta?.processingTime,
    });
  } else {
    const { error, httpStatus, errorCode } = res as ImageApiFailure;
    log.error('callGenerateBackground', 'error', { errorCode, httpStatus, msg: error?.slice(0, 100) });
  }
  warnIfSaveResourceFailed(log.warn, 'callGenerateBackground', res);
  return res;
}
