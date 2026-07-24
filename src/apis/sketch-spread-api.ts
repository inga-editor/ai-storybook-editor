// sketch-spread-api.ts — client for the sketch spread-image generate endpoint.
// The endpoint is PER-PAGE: one call generates ONE page (`page`). The backend reads the
// spread's art_direction + entity crops straight from the persisted snapshot — so the body
// carries the identifiers plus `page` (+ optional `targetRatio`), no variants[], no
// modelParams (v1). ⚡2026-07-21 minimal-prompt rework: no artStyleId (pencil-sketch style
// is hardcoded backend-side; sending it → 400 extra=forbid — hard cutover).
// Mirrors illustration-api.ts convention: flat apis/*.ts + callImageApi<R> (never throws).

import { callImageApi, type ImageApiFailure } from './image-api-client';
import { createLogger } from '@/utils/logger';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('API', 'SketchSpreadApi');

const GENERATE_SPREAD_IMAGE_PATH = '/api/sketch/generate-spread-image';

export type SketchGeneratePage = 'left' | 'right' | 'full';

export interface GenerateSpreadImageParams {
  snapshotId: string;
  sketchSpreadId: string;
  /** Which page of the spread to generate — backend generates ONE page per call. */
  page: SketchGeneratePage;
  /** Optional "W:H" override; omit to let the backend pick its per-page default. */
  targetRatio?: string;
  // modelParams omitted in v1 (KISS).
  /** Opt-in auto-persist directive — attached to the body only when defined. */
  saveResource?: SaveResourceDirective;
}

export interface GenerateSpreadImageResult {
  success: boolean;
  data?: {
    imageUrl: string;
    storagePath: string;
    page: SketchGeneratePage;
    targetRatio: string;
    genAspectRatio: string;
    /** Trục đã CENTER-crop sau gen: 'width' = 2 mép ngang đều, 'height' = trên+dưới đều, null = khớp enum. */
    trimAxis: 'width' | 'height' | null;
    /** TỔNG fraction đã cắt (0 nếu khớp enum). */
    trimFraction: number;
    /** Soft ref → ai_service_logs.id của call Gemini sinh ảnh này (cost attribution). FE ghi vào
     *  illustration entry's `ai_request_id`. Additive optional — mirrors sketch base/variant/stage. */
    aiRequestId?: string;
  } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number; model?: string };
}

/**
 * Generate the backdrop image for ONE page of a sketch spread. The backend resolves the page's
 * art_direction + entity reference crops from the persisted snapshot (why the caller flushes
 * before each call). Never throws — returns GenerateSpreadImageResult | ImageApiFailure
 * (errorCode preserved for classification).
 */
export async function callGenerateSketchSpread(
  params: GenerateSpreadImageParams,
): Promise<GenerateSpreadImageResult | ImageApiFailure> {
  log.info('callGenerateSketchSpread', 'start', {
    sketchSpreadId: params.sketchSpreadId,
    page: params.page,
  });

  const body = {
    snapshotId: params.snapshotId,
    sketchSpreadId: params.sketchSpreadId,
    page: params.page,
    ...(params.targetRatio ? { targetRatio: params.targetRatio } : {}),
    ...(params.saveResource ? { saveResource: params.saveResource } : {}),
  };

  const res = await callImageApi<GenerateSpreadImageResult>(GENERATE_SPREAD_IMAGE_PATH, body);
  warnIfSaveResourceFailed(log.warn, 'callGenerateSketchSpread', res);
  return res;
}
