// sketch-base-api.ts — client for the base-sheet workflow (design store #14, api 05/06). This file
// owns ONLY the RAW-sheet generate call (05|06 dispatched by kind — all base entities of one kind laid
// out as cells). Convention: flat apis/*.ts + callImageApi<R> (X-API-Key + Bearer
// built in). Never throws — returns Result | ImageApiFailure, with errorCode preserved so the slice can
// classify (LLM_ERROR / ART_STYLE_NO_REFERENCES …).
//
// ⚡2026-07-15: the base-only crop route (07 `crop-base-sheet`) was REMOVED backend-side. Base crop now
// reuses the kind-agnostic POSITIONAL cutter (api 10 `callCropSheetRow`, in sketch-variant-api.ts) —
// this file no longer owns any crop machinery. The slice pairs `crops[]` ↔ `cellOrder[]` by 1-based
// cell (see sketch-base-generate-job-slice.ts).
//
// Wire shape is camelCase (backend Pydantic): generate → { imageUrl, storagePath, cellOrder, grid }
// under a { success, data } envelope (same as GenerateSketchSheetResult) — the slice reads r.data.*.

import { callImageApi, type ImageApiFailure } from './image-api-client';
import type { VariantModelParams } from './sketch-variant-api';
import type { BaseKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('API', 'SketchBaseApi');

/** Per-kind RAW-sheet generate route (05 = character, 06 = prop). */
const BASE_SHEET_ENDPOINT: Record<BaseKind, string> = {
  characters: '/api/sketch/generate-base-character-sheet',
  props: '/api/sketch/generate-base-prop-sheet',
};

/** One base entity's text row for the sheet prompt (camelCase — backend contract).
 * Only visual_design + art_language drive the sheet; description/height dropped 2026-07-14
 * (backend model is extra="forbid" → sending either now 400s). */
export interface BaseSheetEntity {
  key: string;
  visualDescription: string;
  artLanguage: string;
}

/** Style reference image — inline base64 OR a storage URL (backend SSRF-guards the URL). */
export type BaseReferenceImage = { base64Data: string; mimeType: string } | { media_url: string };

/** Sheet grid geometry echoed by generate (pass-through — not consumed by the slice). */
export interface SheetGrid {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

/** Optional model override for the base sheet (allowlist group `sketch-base`). Reuses the variant
 *  space's identical wire shape ({model?; params?:{temperature?}}) — DRY, one source of truth. The
 *  base space has no model UI yet; plumbed through for parity (omit → backend DB default model). */
export type SketchModelParams = VariantModelParams;

export interface GenerateBaseSheetParams {
  entities: BaseSheetEntity[];
  /** UUID of `art_styles.id` (= `book.sketchstyle_id`). Backend fetches the row (description + refs). */
  artStyleId: string;
  stylePrompt: string;
  referenceImages: BaseReferenceImage[];
  /** Optional model override; omit → backend DB default (kept byte-minimal in the request body). */
  modelParams?: SketchModelParams;
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — attached to the body only when defined. */
  saveResource?: SaveResourceDirective;
}

export interface GenerateBaseSheetResult {
  success: boolean;
  data?: { imageUrl: string; storagePath: string; cellOrder: string[]; grid: SheetGrid; aiRequestId?: string } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

/**
 * Generate the RAW base sheet for one kind (all base entities as cells). Dispatches 05|06 by kind.
 * Never throws — returns GenerateBaseSheetResult | ImageApiFailure (errorCode preserved).
 */
export async function callGenerateBaseSheet(
  kind: BaseKind,
  { entities, artStyleId, stylePrompt, referenceImages, modelParams, snapshotId, saveResource }: GenerateBaseSheetParams,
): Promise<GenerateBaseSheetResult | ImageApiFailure> {
  const path = BASE_SHEET_ENDPOINT[kind];
  log.info('callGenerateBaseSheet', 'start', {
    kind,
    entityCount: entities.length,
    referenceCount: referenceImages.length,
    hasModelParams: !!modelParams,
  });
  const res = await callImageApi<GenerateBaseSheetResult>(path, {
    entities,
    artStyleId,
    stylePrompt,
    referenceImages,
    // Only include modelParams when present — keeps the body byte-minimal so the backend uses its DB default.
    ...(modelParams ? { modelParams } : {}),
    // Attribution-only — forward snapshotId so the AI-usage logger stamps book cost.
    ...(snapshotId ? { snapshotId } : {}),
    // Opt-in auto-persist — attach only when defined (strict backward-compat).
    ...(saveResource ? { saveResource } : {}),
  });
  warnIfSaveResourceFailed(log.warn, 'callGenerateBaseSheet', res);
  return res;
}
