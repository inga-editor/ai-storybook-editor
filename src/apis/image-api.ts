import { callImageApi, type ImageApiFailure } from './image-api-client';
import { createLogger } from '@/utils/logger';
import type { AspectRatio } from '@/constants/aspect-ratio-constants';
import type { ExtractedTrait, VisualProfileTrait } from '@/types/human';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

export type { AspectRatio };

const log = createLogger('API', 'ImageApi');

const imageApiBaseUrl = import.meta.env.VITE_IMAGE_API_BASE_URL as string;
const imageApiKey = import.meta.env.VITE_IMAGE_API_KEY as string;

// --- New types: multipart FastAPI normalize-ratio ---

export interface NormalizeImageData extends SaveResourceOutcomeFields {
  publicUrl: string;
  path: string;
  ratio: AspectRatio | null;
  mimeType: 'image/png' | 'image/gif' | 'image/svg+xml';
  srcDimensions: { width: number; height: number };
  outputDimensions: { width: number; height: number };
  wasPadded: boolean;
  wasConverted: boolean;
  wasPassthrough: boolean;
}

export interface NormalizeImageMeta {
  processingTime?: number;
  paddedPixels?: number;
  inputBytes?: number;
  outputBytes?: number;
  sourceMimeType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/svg+xml';
}

export interface NormalizeImageSuccess {
  success: true;
  data: NormalizeImageData;
  meta?: NormalizeImageMeta;
}

export interface NormalizeImageFailure {
  success: false;
  error: string;
  httpStatus: number;
  errorCode?: string;
  srcRatio?: number;
  minSupportedRatio?: number;
}

export type NormalizeImageResult = NormalizeImageSuccess | NormalizeImageFailure;

// --- Internal helpers ---

async function postMultipart<R extends { success: boolean }>(
  path: string,
  form: FormData,
): Promise<R | NormalizeImageFailure> {
  const url = `${imageApiBaseUrl}${path}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      // Do NOT set Content-Type — browser adds multipart boundary automatically
      headers: { 'X-API-Key': imageApiKey },
      body: form,
    });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      let errorCode: string | undefined;
      let srcRatio: number | undefined;
      let minSupportedRatio: number | undefined;

      try {
        const body = await response.json() as Record<string, unknown>;
        const detail = body?.detail;
        const detailError =
          typeof detail === 'object' && detail !== null
            ? (detail as Record<string, unknown>).error as Record<string, unknown> | undefined
            : undefined;

        errorCode =
          (typeof detailError === 'object' && detailError !== null ? detailError.code as string | undefined : undefined) ??
          (typeof body?.error === 'object' && body.error !== null ? (body.error as Record<string, unknown>).code as string | undefined : undefined);

        message = (
          (typeof detailError === 'object' && detailError !== null && typeof detailError.message === 'string' ? detailError.message : null) ??
          (typeof detail === 'string' ? detail : null) ??
          (typeof body?.error === 'object' && body.error !== null
            ? ((body.error as Record<string, unknown>).message as string | undefined ?? JSON.stringify(body.error))
            : null) ??
          (typeof body?.error === 'string' ? body.error : null) ??
          (body?.message as string | undefined) ??
          `HTTP ${response.status}`
        );

        if (errorCode === 'IMAGE_TOO_TALL' && typeof detailError === 'object' && detailError !== null) {
          srcRatio = typeof detailError.srcRatio === 'number' ? detailError.srcRatio : undefined;
          minSupportedRatio = typeof detailError.minSupportedRatio === 'number' ? detailError.minSupportedRatio : undefined;
        }
      } catch { /* non-JSON body */ }

      log.error('postMultipart', 'http error', { path, errorCode, httpStatus: response.status });
      return { success: false, error: String(message), httpStatus: response.status, errorCode, srcRatio, minSupportedRatio };
    }

    const data = await response.json() as R;
    return data;
  } catch (err) {
    log.error('postMultipart', 'network error', { path, error: err });
    return { success: false, error: 'Network error. Please try again.', httpStatus: 0 };
  }
}

// --- API ---

/**
 * Upload image and normalize aspect ratio via FastAPI image-api (multipart, 1-step).
 * POST /api/image/normalize-ratio
 */
export async function normalizeImage(
  file: File,
  outputPrefix?: string,
  saveResource?: SaveResourceDirective,
): Promise<NormalizeImageResult> {
  log.info('normalizeImage', 'start', { filename: file.name, size: file.size, type: file.type, outputPrefix });

  const form = new FormData();
  form.append('file', file);
  if (outputPrefix) form.append('outputPrefix', outputPrefix);
  // Multipart flow: JSON-encode the directive into a FormData field named `saveResource`
  // (NOT a JSON body). Append only when defined — strict backward-compat with the BE model.
  if (saveResource) form.append('saveResource', JSON.stringify(saveResource));

  const result = await postMultipart<NormalizeImageSuccess>('/api/image/normalize-ratio', form);

  if (result.success) {
    log.debug('normalizeImage', 'ok', {
      path: result.data.path,
      ratio: result.data.ratio,
      wasPadded: result.data.wasPadded,
      wasPassthrough: result.data.wasPassthrough,
    });
  } else {
    log.error('normalizeImage', 'failed', { errorCode: result.errorCode, httpStatus: result.httpStatus });
  }

  warnIfSaveResourceFailed(log.warn, 'normalizeImage', result);
  return result;
}

// --- Human visual-profile pipeline (normalize-human → extract-human-traits) ---

export type FaceToManyStyle = '3D' | 'Emoji' | 'Video Game' | 'Pixels' | 'Clay' | 'Toy';

export interface NormalizeHumanResponse {
  success: true;
  data: { imageUrl: string; storagePath: string } & SaveResourceOutcomeFields;
}

export interface ExtractHumanTraitsResponse {
  success: true;
  data: { traits: ExtractedTrait[] } & SaveResourceOutcomeFields;
}

/** Host-only for logging — never log full URL (may carry signed tokens). */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Stylize a real-person image into a normalized character reference (Replicate face-to-many).
 * POST /api/image/normalize-human
 */
export async function normalizeHuman(
  imageUrl: string,
  style: FaceToManyStyle = '3D',
  saveResource?: SaveResourceDirective,
): Promise<NormalizeHumanResponse | ImageApiFailure> {
  log.info('normalizeHuman', 'start', { host: urlHost(imageUrl), style });
  const result = await callImageApi<NormalizeHumanResponse>('/api/image/normalize-human', {
    imageUrl,
    style,
    // Attach the directive only when defined — strict backward-compat (BE model is extra=forbid).
    ...(saveResource ? { saveResource } : {}),
  });
  if (result.success) {
    log.debug('normalizeHuman', 'ok', { host: urlHost(result.data.imageUrl) });
  } else {
    log.error('normalizeHuman', 'failed', { errorCode: result.errorCode, httpStatus: result.httpStatus });
  }
  warnIfSaveResourceFailed(log.warn, 'normalizeHuman', result);
  return result;
}

/**
 * Extract 5 fixed visual traits from a real-person image (Gemini multimodal vision).
 * POST /api/image/extract-human-traits
 */
export async function extractHumanTraits(
  imageUrl: string,
  descriptionLanguage: 'en' | 'vi' = 'en',
  saveResource?: SaveResourceDirective,
): Promise<ExtractHumanTraitsResponse | ImageApiFailure> {
  log.info('extractHumanTraits', 'start', { host: urlHost(imageUrl), descriptionLanguage });
  const result = await callImageApi<ExtractHumanTraitsResponse>('/api/image/extract-human-traits', {
    imageUrl,
    descriptionLanguage,
    // Attach the directive only when defined — strict backward-compat (BE model is extra=forbid).
    ...(saveResource ? { saveResource } : {}),
  });
  if (result.success) {
    log.debug('extractHumanTraits', 'ok', { count: result.data.traits.length });
  } else {
    log.error('extractHumanTraits', 'failed', { errorCode: result.errorCode, httpStatus: result.httpStatus });
  }
  warnIfSaveResourceFailed(log.warn, 'extractHumanTraits', result);
  return result;
}

// --- Upscale (multi-model super-resolution — image/05-upscale-image.md) ---

/** Replicate upscale model allowlist (group `upscale`). Single source for the
 *  EditImageModal upscale tab (constants re-export this type). `xinntao/realesrgan`
 *  (Anime variant) is the group default (2026-06-29 BE flip). */
export type UpscaleModel =
  | 'xinntao/realesrgan'
  | 'nightmareai/real-esrgan'
  | 'recraft-ai/recraft-crisp-upscale'
  | 'alexgenovese/upscaler';

export interface UpscaleImagePayload {
  imageUrl: string;
  /** int 1..8 in the UI (default 2); API accepts float (0,10]. recraft ignores it (native passthrough). */
  scale: number;
  /** Model select via `modelParams.model` (NOT flat `model`); faceEnhance via params (recraft → `{}`). */
  modelParams: { model: UpscaleModel; params: { faceEnhance?: boolean } };
  /** TOP-LEVEL (NOT in `modelParams`) watercolor monochrome grain post-process applied AFTER
   *  upscale — model-agnostic (same for all 4 models). Bounds (BE-enforced, 400 on out-of-range):
   *  amp 0..50, blur 0..5. `seed` NOT exposed → API default. API omit=off, but the FE always sends
   *  an explicit object: `enabled:false` turns it off. */
  grain?: { enabled: boolean; amp: number; blur: number; seed?: number };
  /** Book-edit context → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Remix context → ai_service_logs.remix_id (discriminator — wins over snapshotId). */
  remixId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface UpscaleImageResponse {
  success: true;
  data: { imageUrl: string; storagePath: string; width: number; height: number; aiRequestId?: string } & SaveResourceOutcomeFields;
  meta?: {
    processingTime?: number;
    mimeType?: string;
    model?: string;
    scale?: number;
    fixedRatio?: boolean;
    sourceType?: 'url' | 'base64';
    tileCount?: number;
    replicatePredictionIds?: string[];
    /** Replicate variant label — set only for `xinntao/realesrgan` (e.g. "Anime - anime6B");
     *  null for the other models. Type-only forward-compat; the FE does NOT display it. */
    variant?: string;
    /** Grain post-process outcome — ALWAYS present; false when grain off OR it failed
     *  (non-fatal, server returns pre-grain bytes). */
    grainApplied?: boolean;
    /** Resolved grain params — present ONLY when `grainApplied` is true. */
    grain?: { amp: number; blur: number; seed: number };
  };
}

/**
 * Upscale (super-resolution) an image via Replicate (sync) → permanent Storage URL.
 * POST /api/image/upscale-image. JSON client (parity normalizeHuman) — NOT multipart.
 */
export async function callImageUpscale(
  payload: UpscaleImagePayload,
): Promise<UpscaleImageResponse | ImageApiFailure> {
  log.info('callImageUpscale', 'start', {
    host: urlHost(payload.imageUrl),
    model: payload.modelParams.model,
    scale: payload.scale,
    faceEnhance: payload.modelParams.params.faceEnhance,
    grainEnabled: payload.grain?.enabled,
  });
  const result = await callImageApi<UpscaleImageResponse>('/api/image/upscale-image', payload);
  if (result.success) {
    log.debug('callImageUpscale', 'ok', {
      host: urlHost(result.data.imageUrl),
      fixedRatio: result.meta?.fixedRatio,
      width: result.data.width,
      height: result.data.height,
      grainApplied: result.meta?.grainApplied,
    });
  } else {
    log.error('callImageUpscale', 'failed', { errorCode: result.errorCode, httpStatus: result.httpStatus });
  }
  warnIfSaveResourceFailed(log.warn, 'callImageUpscale', result);
  return result;
}

// --- Parametric variant (image/06-generate-parametric-variant.md) ---

/** Which axis family the variant is generated along — selects the BE system prompt (1 endpoint,
 *  3 prompt rows). `photo` axes are NOT generatable (BE → 400 UNSUPPORTED_AXIS); the FE disables
 *  Generate for them, so the union deliberately has no `photo` member. */
export type ParametricAxisKind = 'character' | 'country' | 'religion';

/** Sub-axis of the `character` kind. Absent for country/religion. */
export type ParametricAxisName = 'gender' | 'age';

export interface GenerateParametricVariantPayload {
  axisKind: ParametricAxisKind;
  axisName?: ParametricAxisName;
  /** Source ("ảnh gốc") resolved by the FE chain — see 01-visuals-tab.md §4.1. */
  sourceImageUrl: string;
  sourceValue: string;
  targetValue: string;
  /** Human-readable forms fed to the prompt (`age` → "5 tuổi", `country` → "Vietnam").
   *  Omitted when the raw value already reads fine (gender / religion). */
  sourceValueLabel?: string;
  targetValueLabel?: string;
  characterName?: string;
  /** Optional extra user instruction (≤1000 chars) — the main instruction is server-side. */
  prompt?: string;
  referenceImages?: Array<{ base64Data: string; mimeType: string }>;
  imageSize?: '1K' | '2K' | '4K';
  modelParams?: { model: string; params?: { temperature?: number } };
  /** Book-edit context → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Remix context → ai_service_logs.remix_id (discriminator — wins over snapshotId). */
  remixId?: string;
  /** Opt-in auto-persist directive (anchor = the `values[]` entry of `targetValue`). */
  saveResource?: SaveResourceDirective;
  // ⚠ NO `aspectRatio`: the server measures the source image and picks the nearest enum so every
  // value of one item stacks pixel-for-pixel. Blocked at the type level on purpose — do NOT add.
}

export interface GenerateParametricVariantResult {
  success: true;
  data: {
    imageUrl: string;
    storagePath: string;
    aiRequestId?: string;
  } & SaveResourceOutcomeFields;
  meta?: {
    processingTime?: number;
    mimeType?: string;
    tokenUsage?: number;
    model?: string;
    aspectRatio?: string;
    promptTemplate?: string;
  };
}

/**
 * Generate ONE parametric-slot value variant of an image (Gemini, sync) → permanent Storage URL.
 * POST /api/image/generate-parametric-variant. Thin wrapper (parity `callImageUpscale`): no retry,
 * no error mapping — the UI reads `errorCode` and maps it to a toast (01-visuals-tab.md §5).
 */
export async function callGenerateParametricVariant(
  payload: GenerateParametricVariantPayload,
): Promise<GenerateParametricVariantResult | ImageApiFailure> {
  // Countable/enum fields only — never the prompt text, the reference base64, or the full
  // source URL (may carry a signed token): host only.
  log.info('callGenerateParametricVariant', 'start', {
    axisKind: payload.axisKind,
    axisName: payload.axisName,
    sourceValue: payload.sourceValue,
    targetValue: payload.targetValue,
    host: urlHost(payload.sourceImageUrl),
    refCount: payload.referenceImages?.length ?? 0,
    hasPrompt: !!payload.prompt,
    hasSaveResource: !!payload.saveResource,
  });
  const result = await callImageApi<GenerateParametricVariantResult>(
    '/api/image/generate-parametric-variant',
    payload,
  );
  if (result.success) {
    log.debug('callGenerateParametricVariant', 'ok', {
      host: urlHost(result.data.imageUrl),
      targetValue: payload.targetValue,
      saved: result.data.saved,
      aspectRatio: result.meta?.aspectRatio,
    });
  } else {
    log.error('callGenerateParametricVariant', 'failed', {
      errorCode: result.errorCode,
      httpStatus: result.httpStatus,
      axisKind: payload.axisKind,
      targetValue: payload.targetValue,
    });
  }
  warnIfSaveResourceFailed(log.warn, 'callGenerateParametricVariant', result);
  return result;
}

/** Map API trait shape → persisted DB shape: drop `present`, null-out description when absent, reserve image_url. */
export function toStoredTraits(apiTraits: ExtractedTrait[]): VisualProfileTrait[] {
  return apiTraits.map((t) => ({
    type: t.type,
    description: t.present ? t.description : null,
    image_url: null,
  }));
}
