// sketch-variant-api.ts — client for the sketch VARIANT creative space (api 08/09/10). Two calls the
// variant-generate job slice (phase-03) chains for ONE non-base variant: generate the RAW 4-cell sheet
// (08 = character, 09 = prop — dispatched by kind, snapshot-reading) then cut the 4 cells out of it
// (10, kind-agnostic CV). Mirrors sketch-base-api.ts: flat apis/*.ts + callImageApi<R> (X-API-Key +
// Bearer built in). Never throws — returns Result | ImageApiFailure, with errorCode preserved so the
// slice can classify (BASE_NOT_READY / EMPTY_VARIANT_DESCRIPTION / LLM_ERROR / ALL_CROPS_FAILED …).
//
// ⚡ Generate is SNAPSHOT-READING (differs from base, which ships entity text in the payload): the
// payload carries only { snapshotId, entityKey, variantKey, modelParams? } and the backend reads
// `snapshot.sketch` from the DB — so the job MUST flush the snapshot BEFORE calling generate.
//
// ⚡ Contract (2026-07-15, ADR-047): `artStyleId` was DROPPED (backend `extra="forbid"` → sending it
// now 400s VALIDATION_ERROR) — style/medium are inferred from the BASE_VARIANT anchor. An optional
// `modelParams` (allowlist group `sketch-variant`) replaces it; omit → the backend DB default model.
//
// Wire shape is camelCase (backend Pydantic), envelope { success, data, meta? } — the slice reads
// r.data.*. Contract types below follow api/sketch/08,09 §Result + 10 §Result VERBATIM (grid carries
// aspectRatio+cellCount, references is an audit object, crop geometry uses w/h — see note in report).

import { callImageApi, type ImageApiFailure } from './image-api-client';
import type { BaseKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';
import { warnIfSaveResourceFailed } from '@/utils/save-resource-path';

const log = createLogger('API', 'SketchVariantApi');

/** Per-kind variant-sheet generate route (08 = character, 09 = prop). Path preserved verbatim. */
const VARIANT_SHEET_ENDPOINT: Record<BaseKind, string> = {
  characters: '/api/sketch/generate-character-variant-sheet',
  props: '/api/sketch/generate-prop-variant-sheet',
};

/** Crop (10) is kind-agnostic — single route; the sheet + cellCount + pathPrefix travel in the body. */
const CROP_SHEET_ROW_ENDPOINT = '/api/sketch/crop-sheet-row';

// ── generate (08/09) ────────────────────────────────────────────────────────────────────────────

/** Optional model override (allowlist group `sketch-variant`). Omit → backend DB default model +
 *  temperature 0.3. `model` = a public id (e.g. `google/nano-banana-pro`); `params.temperature`
 *  clamps to [0,2] server-side. The variant space has no model UI yet — plumbed through for parity. */
export interface VariantModelParams {
  model?: string;
  params?: { temperature?: number };
}

export interface GenerateVariantSheetParams {
  /** snapshot.id (UUID). ⚡ Backend reads snapshot.sketch from the DB (snapshot-reading) — the job
   *  flushes the snapshot before calling so the endpoint sees the just-saved variant description. */
  snapshotId: string;
  entityKey: string; // sketch.{characters|props}[].key
  variantKey: string; // sketch.{...}[].variants[].key — MUST be non-base (base → 422)
  /** ⚡ artStyleId DROPPED (backend extra=forbid). Optional model override only; omit → DB default. */
  modelParams?: VariantModelParams;
  /** Opt-in auto-persist directive — attached to the body only when defined. */
  saveResource?: SaveResourceDirective;
}

/** Fixed 4-cell / 1-row / 21:9 grid echoed by generate (per 08 §Result — cols:4, rows:1). Pass-through. */
export interface VariantSheetGrid {
  cols: number;
  rows: number;
  aspectRatio: string; // "21:9"
  cellCount: number; // 4
}

/** Audit block (debug resolve/skip of reference images) — NOT the base-sheet {title, media_url}[]. */
export interface VariantSheetReferences {
  base: boolean; // BASE_VARIANT anchor was sent (always true unless the call 422'd on BASE_NOT_READY)
  characters?: string[]; // resolved @mention character refs
  props?: string[]; // resolved @mention prop refs
  skipped?: Array<{ mention: string; reason: string }>; // dangling / missing-variant / empty-crop mentions
}

export interface GenerateVariantSheetResult {
  success: boolean;
  data?: {
    imageUrl: string; // raw 21:9 sheet (CUT SOURCE) → prepend variants[].raw_sheet.illustrations[]
    storagePath: string;
    entityKey: string; // echo
    variantKey: string; // echo
    grid: VariantSheetGrid;
    references?: VariantSheetReferences;
    /** Soft ref → ai_service_logs.id — raw sheet = direct Gemini output (provenance). */
    aiRequestId?: string;
  } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number; model?: string };
}

// ── crop (10) ───────────────────────────────────────────────────────────────────────────────────

export interface CropSheetRowParams {
  imageUrl: string; // effective raw sheet url (SSRF-guarded backend-side)
  cellCount: number; // 4 for the variant sheet
  pathPrefix: string; // sketches/variants/{characters|props}/{entityKey}/{variantKey}
}

/** Content-region bbox of one crop within the raw sheet — ⚡ w/h (not width/height), per 10 §Result. */
export interface SheetRowCropGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One cell cut from the raw sheet, in reading order (crops[i] ↔ raw_sheet.crops[i], positional). */
export interface SheetRowCrop {
  cell: number; // 1-based reading order (LEFT→RIGHT)
  imageUrl: string;
  storagePath: string;
  geometry: SheetRowCropGeometry;
  source: 'rect' | 'detect' | 'geo'; // detect tier used for this cell (rect = closed-frame, best)
}

export interface CropSheetRowResult {
  success: boolean;
  data?: {
    crops: SheetRowCrop[]; // reading order LEFT→RIGHT
    cellCount: number;
    sheetDimensions: { width: number; height: number };
  };
  error?: string;
  meta?: {
    processingTime?: number;
    fetchMs?: number;
    detectMs?: number;
    uploadMs?: number;
    rectCount?: number; // #cells that found a closed frame (source='rect')
    geoFallbackCount?: number; // #cells that fell back to even 'geo' split (may be misaligned)
    fullbleedWarning?: boolean; // image borders not white → suspected mockup, crops may be off
    cv2Available?: boolean; // false → line/geo path used
    skipped?: Array<{ cell: number; reason: string }>; // crop upload failed (non-fatal, index-shifting)
  };
}

/**
 * Generate the RAW variant sheet for one kind (4 independent draws of ONE non-base variant, 1 row,
 * 21:9). Dispatches 08|09 by kind. SNAPSHOT-READING — the backend reads snapshot.sketch by snapshotId,
 * so the caller must flush the snapshot first. Never throws — returns
 * GenerateVariantSheetResult | ImageApiFailure (errorCode preserved).
 */
export async function callGenerateVariantSheet(
  kind: BaseKind,
  { snapshotId, entityKey, variantKey, modelParams, saveResource }: GenerateVariantSheetParams,
): Promise<GenerateVariantSheetResult | ImageApiFailure> {
  const path = VARIANT_SHEET_ENDPOINT[kind];
  log.info('callGenerateVariantSheet', 'start', { kind, entityKey, variantKey, hasModelParams: !!modelParams });
  const res = await callImageApi<GenerateVariantSheetResult>(path, {
    snapshotId,
    entityKey,
    variantKey,
    // Only include modelParams when present — the body is extra="forbid" but the field is optional,
    // so an absent key (not `undefined`) keeps the request byte-minimal → backend uses its DB default.
    ...(modelParams ? { modelParams } : {}),
    // Opt-in auto-persist — attach only when defined (strict backward-compat).
    ...(saveResource ? { saveResource } : {}),
  });
  warnIfSaveResourceFailed(log.warn, 'callGenerateVariantSheet', res);
  return res;
}

/**
 * Cut a 1-row N-cell sheet into N crops in reading order (10, CV — reads no DB). `imageUrl` comes
 * straight from the generate result or the effective raw illustration. Never throws — returns
 * CropSheetRowResult | ImageApiFailure (errorCode preserved).
 */
export async function callCropSheetRow({
  imageUrl,
  cellCount,
  pathPrefix,
}: CropSheetRowParams): Promise<CropSheetRowResult | ImageApiFailure> {
  log.info('callCropSheetRow', 'start', { pathPrefix, cellCount });
  return callImageApi<CropSheetRowResult>(CROP_SHEET_ROW_ENDPOINT, {
    imageUrl,
    cellCount,
    pathPrefix,
  });
}
