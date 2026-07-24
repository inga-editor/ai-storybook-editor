// sketch-stage-api.ts — client for the sketch STAGE creative space (api 11/12). Two generate
// calls the stage-generate job slice chains; the 2-cell cut REUSES the kind-agnostic positional
// cutter `callCropSheetRow` (api 10, in sketch-variant-api.ts) with `cellCount=2` — no crop
// machinery here. Convention: flat apis/*.ts + callImageApi<R> (X-API-Key + Bearer built in).
// Never throws — returns Result | ImageApiFailure, errorCode preserved for slice classification
// (BASE_NOT_READY / EMPTY_STAGE_DESCRIPTION / LLM_ERROR …).
//
// ⚡ The two calls DIFFER in state model (mirror their char/prop siblings):
//   • 11 generate-base-stage-sheet — STATELESS like 05/06: the payload carries the base text
//     (visualDescription/artLanguage from variants[base] IN THE STORE) + artStyleId + STYLE refs.
//     No snapshot flush needed before calling.
//   • 12 generate-stage-variant-sheet — SNAPSHOT-READING like 08/09: `{snapshotId, entityKey,
//     variantKey}` only; the backend reads snapshot.sketch from the DB (anchors on the locked
//     BASE chain — NO artStyleId, style is inferred from the BASE_VARIANT image). The job MUST
//     flush the stage node BEFORE calling, else the AI reads stale text / an unlocked base.
//
// Both sheets are a fixed 2-cell / 1-row / 21:9 grid (2 DIFFERENT takes of the same stage —
// the user later locks 1 of 2). Wire shape camelCase, envelope { success, data, meta? }.

import { callImageApi, type ImageApiFailure } from './image-api-client';
import { createLogger } from '@/utils/logger';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('API', 'SketchStageApi');

const BASE_STAGE_SHEET_ENDPOINT = '/api/sketch/generate-base-stage-sheet';
const STAGE_VARIANT_SHEET_ENDPOINT = '/api/sketch/generate-stage-variant-sheet';

/** Fixed 2-cell / 1-row / 21:9 grid echoed by both generates (11/12 §Result). Pass-through. */
export interface StageSheetGrid {
  cols: number; // 2
  rows: number; // 1
  aspectRatio: string; // "21:9"
  cellCount: number; // 2
}

/** Optional model override — group `sketch-base` for 11 (has seed), `sketch-variant` for 12.
 *  Omit → backend DB default model. Out-of-allowlist → 422 UNSUPPORTED_MODEL. */
export interface StageModelParams {
  model?: string;
  params?: { temperature?: number; seed?: number };
}

// ── 11 — generate-base-stage-sheet (STATELESS) ─────────────────────────────────────────────────

/** STYLE reference for the attempt — hosted art-style refs travel as media_url (MODE A, no
 *  upload roundtrip; SSRF-guarded backend-side). base64 kept for contract parity. */
export type StageReferenceImage = { base64Data: string; mimeType: string } | { media_url: string };

export interface GenerateBaseStageSheetParams {
  stageKey: string; // sketch.stages[].key
  visualDescription: string; // from variants[base].visual_design — both empty → 422 EMPTY_STAGE_DESCRIPTION
  artLanguage: string; // from variants[base].art_language
  artStyleId: string; // art_styles.id (type=0) — caller resolves book.sketchstyle_id
  stylePrompt?: string; // styles[i].style_prompt
  referenceImages?: StageReferenceImage[]; // ≤3 STYLE refs from styles[i].image_references
  modelParams?: StageModelParams; // allowlist group `sketch-base`
  /** Attribution-only snapshot version id → ai_service_logs.snapshot_id (book cost). */
  snapshotId?: string;
  /** Opt-in auto-persist directive — attached to the body only when defined. */
  saveResource?: SaveResourceDirective;
}

export interface GenerateBaseStageSheetResult {
  success: boolean;
  data?: {
    imageUrl: string; // raw 2-cell sheet → prepend stages[].base.styles[i].illustrations[]
    storagePath: string;
    stageKey: string; // echo
    grid: StageSheetGrid;
    /** Soft ref → ai_service_logs.id — raw sheet = direct Gemini output (provenance). */
    aiRequestId?: string;
  } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number; model?: string; temperature?: number };
}

/**
 * Generate the 2-cell base sheet for ONE stage style attempt (11 — 2 DIFFERENT takes of the same
 * stage under one art style). STATELESS: base text ships in the payload, no flush needed first.
 * Never throws — returns GenerateBaseStageSheetResult | ImageApiFailure (errorCode preserved).
 */
export async function callGenerateBaseStageSheet(
  params: GenerateBaseStageSheetParams,
): Promise<GenerateBaseStageSheetResult | ImageApiFailure> {
  const { modelParams, referenceImages, stylePrompt, snapshotId, saveResource, ...required } = params;
  log.info('callGenerateBaseStageSheet', 'start', {
    stageKey: params.stageKey,
    refCount: referenceImages?.length ?? 0,
    hasModelParams: !!modelParams,
  });
  // Body is extra="forbid" with optional fields — absent keys (not `undefined`) keep it minimal.
  const res = await callImageApi<GenerateBaseStageSheetResult>(BASE_STAGE_SHEET_ENDPOINT, {
    ...required,
    ...(stylePrompt ? { stylePrompt } : {}),
    ...(referenceImages && referenceImages.length > 0 ? { referenceImages } : {}),
    ...(modelParams ? { modelParams } : {}),
    // Attribution-only — forward snapshotId so the AI-usage logger stamps book cost.
    ...(snapshotId ? { snapshotId } : {}),
    // Opt-in auto-persist — attach only when defined (strict backward-compat).
    ...(saveResource ? { saveResource } : {}),
  });
  warnIfSaveResourceFailed(log.warn, 'callGenerateBaseStageSheet', res);
  return res;
}

// ── 12 — generate-stage-variant-sheet (SNAPSHOT-READING) ───────────────────────────────────────

export interface GenerateStageVariantSheetParams {
  /** snapshot.id (UUID). ⚡ Backend reads snapshot.sketch from the DB — the job flushes the stage
   *  node first so the endpoint sees the just-saved text + locked base chain. */
  snapshotId: string;
  entityKey: string; // sketch.stages[].key (the stageKey)
  variantKey: string; // MUST be non-base (base → 422 CANNOT_GENERATE_BASE_VARIANT — use 11)
  modelParams?: StageModelParams; // allowlist group `sketch-variant` (no seed)
  /** Opt-in auto-persist directive — attached to the body only when defined. */
  saveResource?: SaveResourceDirective;
}

/** Audit block (debug resolve/skip of reference mentions) — mirror 08/09. */
export interface StageVariantSheetReferences {
  base: boolean; // BASE_VARIANT anchor sent (always true unless 422 BASE_NOT_READY)
  props?: string[];
  skipped?: Array<{ mention: string; reason: string }>;
}

export interface GenerateStageVariantSheetResult {
  success: boolean;
  data?: {
    imageUrl: string; // raw 2-cell sheet → prepend stages[].variants[vk].illustrations[]
    storagePath: string;
    entityKey: string; // echo
    variantKey: string; // echo
    grid: StageSheetGrid;
    references?: StageVariantSheetReferences;
    /** Soft ref → ai_service_logs.id — raw sheet = direct Gemini output (provenance). */
    aiRequestId?: string;
  } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number; model?: string; temperature?: number };
}

/**
 * Generate the 2-cell variant sheet for ONE non-base stage variant (12 — anchored on the LOCKED
 * base image, same-artist; NO artStyleId). SNAPSHOT-READING — flush the stage node first.
 * Never throws — returns GenerateStageVariantSheetResult | ImageApiFailure (errorCode preserved).
 */
export async function callGenerateStageVariantSheet({
  snapshotId,
  entityKey,
  variantKey,
  modelParams,
  saveResource,
}: GenerateStageVariantSheetParams): Promise<GenerateStageVariantSheetResult | ImageApiFailure> {
  log.info('callGenerateStageVariantSheet', 'start', { entityKey, variantKey, hasModelParams: !!modelParams });
  const res = await callImageApi<GenerateStageVariantSheetResult>(STAGE_VARIANT_SHEET_ENDPOINT, {
    snapshotId,
    entityKey,
    variantKey,
    ...(modelParams ? { modelParams } : {}),
    // Opt-in auto-persist — attach only when defined (strict backward-compat).
    ...(saveResource ? { saveResource } : {}),
  });
  warnIfSaveResourceFailed(log.warn, 'callGenerateStageVariantSheet', res);
  return res;
}
