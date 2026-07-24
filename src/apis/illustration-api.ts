import { callImageApi, type ImageApiFailure } from './image-api-client';
import { createLogger } from '@/utils/logger';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('API', 'IllustrationApi');

// --- Types ---

export interface GenerateCharacterBaseParams {
  characterKey: string;
  basicInfo?: {
    description?: string;
    gender?: string;
    age?: string;
    category_id?: string;
    role?: string;
  };
  personality?: {
    core_essence?: string;
    flaws?: string;
    emotions?: string;
    reactions?: string;
    desires?: string;
    likes?: string;
    fears?: string;
    contradictions?: string;
  };
  baseVariant: {
    appearance?: {
      height?: number;
      hair?: string;
      eyes?: string;
      face?: string;
      build?: string;
    };
    visual_description: string;
  };
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend fetches description + image_references. */
  artStyleId: string;
  referenceImages?: Array<{ base64Data: string; mimeType: string }>;
  aspectRatio?: string;
  imageSize?: string;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateCharacterBaseResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

export interface GenerateCharacterVariantParams {
  characterKey: string;
  variantKey: string;
  variantAppearance?: {
    height?: number;
    hair?: string;
    eyes?: string;
    face?: string;
    build?: string;
  };
  variantVisualDescription: string;
  baseVariantImageUrl: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend fetches description + image_references. */
  artStyleId: string;
  additionalReferenceImages?: Array<{ base64Data: string; mimeType: string }>;
  aspectRatio?: string;
  imageSize?: string;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateCharacterVariantResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

// --- API ---

export async function callGenerateCharacterBase(
  params: GenerateCharacterBaseParams
): Promise<GenerateCharacterBaseResult | ImageApiFailure> {
  log.info('callGenerateCharacterBase', 'start', {
    characterKey: params.characterKey,
    refCount: params.referenceImages?.length ?? 0,
  });
  const res = await callImageApi<GenerateCharacterBaseResult>(
    '/api/illustration/generate-character-base',
    params
  );
  warnIfSaveResourceFailed(log.warn, 'callGenerateCharacterBase', res);
  return res;
}

// --- Prop Base Types ---

export interface GeneratePropBaseParams {
  propKey: string;
  propName?: string;
  propType?: "narrative" | "anchor";
  categoryName?: string;
  categoryType?: number;
  baseStateVisualDescription: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend fetches description + image_references. */
  artStyleId: string;
  referenceImages?: Array<{ base64Data: string; mimeType: string }>;
  aspectRatio?: string;
  imageSize?: string;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GeneratePropBaseResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

// --- Prop Base API ---

export async function callGeneratePropBase(
  params: GeneratePropBaseParams
): Promise<GeneratePropBaseResult | ImageApiFailure> {
  log.info('callGeneratePropBase', 'start', {
    propKey: params.propKey,
    refCount: params.referenceImages?.length ?? 0,
  });
  const res = await callImageApi<GeneratePropBaseResult>(
    '/api/illustration/generate-prop-base',
    params
  );
  warnIfSaveResourceFailed(log.warn, 'callGeneratePropBase', res);
  return res;
}

// --- Prop Variant Types ---

export interface GeneratePropVariantParams {
  propKey: string;
  variantKey: string;
  variantVisualDescription: string;
  basePropImageUrl: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend fetches description + image_references. */
  artStyleId: string;
  additionalReferenceImages?: Array<{ base64Data: string; mimeType: string }>;
  aspectRatio?: string;
  imageSize?: string;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GeneratePropVariantResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

// --- Prop Variant API ---

export async function callGeneratePropVariant(
  params: GeneratePropVariantParams
): Promise<GeneratePropVariantResult | ImageApiFailure> {
  log.info('callGeneratePropVariant', 'start', {
    propKey: params.propKey,
    variantKey: params.variantKey,
    refCount: params.additionalReferenceImages?.length ?? 0,
  });
  const res = await callImageApi<GeneratePropVariantResult>(
    '/api/illustration/generate-prop-variant',
    params
  );
  warnIfSaveResourceFailed(log.warn, 'callGeneratePropVariant', res);
  return res;
}

// --- Stage Base Types ---

export interface GenerateStageBaseParams {
  stageKey: string;
  stageName?: string;
  locationDescription?: string;
  baseSetting: {
    visual_description: string;
    temporal?: { era?: string; season?: string; weather?: string; time_of_day?: string };
    sensory?: { atmosphere?: string; soundscape?: string; lighting?: string; color_palette?: string };
    emotional?: { mood?: string };
  };
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend fetches description + image_references. */
  artStyleId: string;
  referenceImages?: Array<{ base64Data: string; mimeType: string }>;
  aspectRatio?: string;
  imageSize?: string;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateStageBaseResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

// --- Stage Base API ---

export async function callGenerateStageBase(
  params: GenerateStageBaseParams
): Promise<GenerateStageBaseResult | ImageApiFailure> {
  log.info('callGenerateStageBase', 'start', {
    stageKey: params.stageKey,
    refCount: params.referenceImages?.length ?? 0,
  });
  const res = await callImageApi<GenerateStageBaseResult>(
    '/api/illustration/generate-stage-base',
    params
  );
  warnIfSaveResourceFailed(log.warn, 'callGenerateStageBase', res);
  return res;
}

// --- Stage Variant Types ---

export interface GenerateStageVariantParams {
  stageKey: string;
  variantKey: string;
  variantVisualDescription: string;
  variantTemporal?: { era?: string; season?: string; weather?: string; time_of_day?: string };
  variantSensory?: { atmosphere?: string; soundscape?: string; lighting?: string; color_palette?: string };
  variantEmotional?: { mood?: string };
  baseStageImageUrl: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend fetches description + image_references. */
  artStyleId: string;
  additionalReferenceImages?: Array<{ base64Data: string; mimeType: string }>;
  aspectRatio?: string;
  imageSize?: string;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateStageVariantResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

// --- Stage Variant API ---

export async function callGenerateStageVariant(
  params: GenerateStageVariantParams
): Promise<GenerateStageVariantResult | ImageApiFailure> {
  log.info('callGenerateStageVariant', 'start', {
    stageKey: params.stageKey,
    variantKey: params.variantKey,
    refCount: params.additionalReferenceImages?.length ?? 0,
  });
  const res = await callImageApi<GenerateStageVariantResult>(
    '/api/illustration/generate-stage-variant',
    params
  );
  warnIfSaveResourceFailed(log.warn, 'callGenerateStageVariant', res);
  return res;
}

// --- Scene Types ---

export interface GenerateSceneParams {
  visualDescription: string;
  /** UUID of `art_styles.id` (= `book.artstyle_id`), NOT the description. Backend fetches description + image_references. */
  artStyleId: string;
  stageVariantImageUrl?: string;
  referenceImages?: Array<{ base64Data: string; mimeType: string }>;
  aspectRatio?: string;
  imageSize?: string;
  /** Model override (07-generate-scene) — allowlist group `scene`; out-of-allowlist → 422 UNSUPPORTED_MODEL. */
  modelParams?: { model: string; params?: Record<string, unknown> };
  /** Edge treatment param (07-generate-scene Flow §6b) — v1 backend echoes meta, output unchanged (no-op). */
  edgeTreatment?: string;
  /** Snapshot id (= meta.id) so the backend can resolve `@<key>/<variant>` mentions → entity reference images. */
  snapshotId?: string;
  /** Opt-in auto-persist directive — forwarded to the body only when defined (JSON.stringify drops undefined). */
  saveResource?: SaveResourceDirective;
}

export interface GenerateSceneResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

// --- Scene API ---

export async function callGenerateScene(
  params: GenerateSceneParams
): Promise<GenerateSceneResult | ImageApiFailure> {
  log.info('callGenerateScene', 'start', {
    hasStageVariantImage: !!params.stageVariantImageUrl,
    refCount: params.referenceImages?.length ?? 0,
  });
  const res = await callImageApi<GenerateSceneResult>(
    '/api/illustration/generate-scene',
    params
  );
  warnIfSaveResourceFailed(log.warn, 'callGenerateScene', res);
  return res;
}

export async function callGenerateCharacterVariant(
  params: GenerateCharacterVariantParams
): Promise<GenerateCharacterVariantResult | ImageApiFailure> {
  log.info('callGenerateCharacterVariant', 'start', {
    characterKey: params.characterKey,
    variantKey: params.variantKey,
    refCount: params.additionalReferenceImages?.length ?? 0,
  });
  const res = await callImageApi<GenerateCharacterVariantResult>(
    '/api/illustration/generate-character-variant',
    params
  );
  warnIfSaveResourceFailed(log.warn, 'callGenerateCharacterVariant', res);
  return res;
}
