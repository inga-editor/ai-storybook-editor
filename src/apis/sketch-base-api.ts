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

/** Per-kind RAW-sheet generate route (05 = character, 06 = prop).
 *  ⚡ 2026-07-28: alter characters reuse the CHARACTER route (05) — the sheet they land in is
 *  selected by the `targetSheet` body param below, NOT by a separate endpoint. */
const BASE_SHEET_ENDPOINT: Record<BaseKind, string> = {
  characters: '/api/sketch/generate-base-character-sheet',
  props: '/api/sketch/generate-base-prop-sheet',
  alter_characters: '/api/sketch/generate-base-character-sheet',
};

/** Which base-sheet node route 05 writes into. Wire enum (api 05 §request) — the response echoes
 *  the RESOLVED value back so the caller can verify it was honoured. */
export type BaseSheetTarget = 'character_sheet' | 'alter_character_sheet';

/**
 * kind → `targetSheet` discriminator for route 05. DERIVED HERE (not a caller argument) on
 * purpose: `targetSheet` and the entity set MUST both come from the ONE `kind` variable, because
 * api 05 is STATELESS — it happily writes the character cast into the alter sheet if the two
 * disagree, with NO server error (the FE is the only gate). Passing it separately would make that
 * mismatch expressible; deriving it makes it impossible.
 *
 * `props` is ABSENT on purpose: route 06 is `extra="forbid"`, so sending `targetSheet` there is a
 * 400. `Partial` + the `undefined` guard in the body build is what keeps prop requests
 * byte-identical to before this change.
 */
const BASE_SHEET_TARGET: Partial<Record<BaseKind, BaseSheetTarget>> = {
  characters: 'character_sheet',
  alter_characters: 'alter_character_sheet',
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
  data?: {
    imageUrl: string;
    storagePath: string;
    cellOrder: string[];
    grid: SheetGrid;
    aiRequestId?: string;
    /** Echo of the RESOLVED `targetSheet` (route 05 only; route 06 never sends it back). */
    targetSheet?: BaseSheetTarget;
  } & SaveResourceOutcomeFields;
  error?: string;
  meta?: { processingTime?: number; mimeType?: string; tokenUsage?: number };
}

/**
 * Generate the RAW base sheet for one kind (all base entities as cells). Dispatches 05|06 by kind
 * and, for the two CHARACTER kinds, stamps the `targetSheet` discriminator so route 05 writes the
 * right sheet node. Storage layout is deliberately UNCHANGED for alter (same `characters/` prefix)
 * — the sheets are distinguished by the snapshot node, never by the folder.
 * Never throws — returns GenerateBaseSheetResult | ImageApiFailure (errorCode preserved).
 */
export async function callGenerateBaseSheet(
  kind: BaseKind,
  { entities, artStyleId, stylePrompt, referenceImages, modelParams, snapshotId, saveResource }: GenerateBaseSheetParams,
): Promise<GenerateBaseSheetResult | ImageApiFailure> {
  const path = BASE_SHEET_ENDPOINT[kind];
  const targetSheet = BASE_SHEET_TARGET[kind];
  log.info('callGenerateBaseSheet', 'start', {
    kind,
    targetSheet: targetSheet ?? null,
    entityCount: entities.length,
    referenceCount: referenceImages.length,
    hasModelParams: !!modelParams,
  });
  const res = await callImageApi<GenerateBaseSheetResult>(path, {
    entities,
    artStyleId,
    stylePrompt,
    referenceImages,
    // Route 05 only — route 06 (props) is extra="forbid", so an unconditional field would 400.
    // Guard on `undefined` (not truthiness) so the map stays the single source of truth.
    ...(targetSheet !== undefined ? { targetSheet } : {}),
    // Only include modelParams when present — keeps the body byte-minimal so the backend uses its DB default.
    ...(modelParams ? { modelParams } : {}),
    // Attribution-only — forward snapshotId so the AI-usage logger stamps book cost.
    ...(snapshotId ? { snapshotId } : {}),
    // Opt-in auto-persist — attach only when defined (strict backward-compat).
    ...(saveResource ? { saveResource } : {}),
  });
  // The endpoint is stateless: if the echo ever disagrees with what we asked for, the raw sheet
  // landed in the WRONG sheet node server-side (BE-first saveResource) — loud, not silent.
  const echoed = 'data' in res ? res.data?.targetSheet : undefined;
  if (targetSheet && echoed && echoed !== targetSheet) {
    log.error('callGenerateBaseSheet', 'targetSheet echo mismatch', { kind, requested: targetSheet, echoed });
  }
  warnIfSaveResourceFailed(log.warn, 'callGenerateBaseSheet', res);
  return res;
}
