// crop-sheet-layout.ts — Client-side crop-sheet layout helpers for the remix
// store (⚡2026-06-12 — STAGE-GENERIC over the 3 pipeline columns
// `mixes`/`rmbgs`/`upscales`). Entry points:
//   - `computeCropSheets`        — create-time seed (stage 'mixes' ONLY): mutates
//     the insert payload IN PLACE so `mixes[0].crop_sheets[]` lands in the INSERT.
//   - `relayoutStageBatchSheets` — K±1 stepper relayout, scoped to ONE batch of
//     ONE stage column.
//   - `addStageBatch`            — rev6 tick-subset add (all 3 stages).
//   - `removeStageBatch`         — BATCH_MIN guard only on 'mixes'.
//   - `importStageBatch`         — Import finals of the previous stage into a
//     new batch (rmbgs/upscales only — copy-on-build snapshot, 05-14).
//
// Source-dim resolution differs per stage (the ONLY divergence):
//   - 'mixes'           : % of spread, re-scanned from the frozen illustration
//                         via `groupCropsForBatch` (single source of truth).
//   - 'rmbgs'/'upscales': NATIVE piece px (original_crops[].geometry.{w,h} —
//                         the import-time estimate), packed with `absolutePx`.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import type {
  CropEntry,
  InsertableRemixRow,
  Remix,
  RemixCropSheet,
  RemixMix,
  StageKind,
} from '@/types/remix';
import { PREV_STAGE } from '@/types/remix';
import {
  DIMENSION_CANVAS_SIZE,
  DEFAULT_CANVAS_SIZE,
} from '@/constants/canvas-dimension-constants';
import {
  computeCropSheetLayout,
  sheetExceedsPixelCap,
} from '@/utils/crop-sheet-layout-engine';
import type {
  CropInput,
  CropSheetLayoutResult,
} from '@/utils/crop-sheet-layout-engine';
import { groupCropsForBatch } from '@/utils/crop-grouping';
import { makeBatchSkeleton } from './clone-builder';
import { collectStageFinals, buildStageBatchInput } from './stage-finals';
import type { CropSheetUpdate } from './types';

/**
 * Returns the de-duplicated crops currently living in a batch (per-batch
 * scope — rev6). Reads ONLY the pre-swap `sheet.original_crops[]` lineup
 * (never `swap_results[].crops[]`, which is post-job output). Dedup key
 * `(spread_id, id)` — first occurrence wins.
 */
export function currentCropsOfBatch(batch: RemixMix): CropEntry[] {
  const seen = new Set<string>();
  const out: CropEntry[] = [];
  for (const sheet of batch.crop_sheets) {
    // Defensive `?? []` — a stale pre-rename row (legacy `crops` key) must
    // degrade to empty, not crash (hard cutover sanctioned, crash is not).
    for (const crop of sheet.original_crops ?? []) {
      const dedupKey = `${crop.spread_id}/${crop.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      out.push(crop);
    }
  }
  return out;
}

/** Minimum number of batches — applies to stage 'mixes' ONLY (auto-seeded);
 *  rmbgs/upscales may go down to 0 batches (empty-state CTA Import). */
export const BATCH_MIN = 1;

const log = createLogger('Store', 'CropSheetLayout');

/** Minimum crop sheets a batch can hold (relayout clamp). The maximum is the
 *  batch's own crop count — a sheet holds ≥1 crop, so K can never exceed it
 *  (resolved per-batch in `relayoutStageBatchSheets`; no flat ceiling). */
export const SHEET_MIN = 1;

/** Resolves the spread (px) for the layout engine from a book dimension code.
 *  Falls back to the legacy 800×600 spread when the dimension is unset/unknown. */
function resolveSpread(dimension: number | null | undefined): {
  width: number;
  height: number;
} {
  if (dimension == null) return DEFAULT_CANVAS_SIZE;
  return DIMENSION_CANVAS_SIZE[dimension] ?? DEFAULT_CANVAS_SIZE;
}

/** Builds the title for sheet `index` — `"sheet <n+1>"` (1-based). */
function sheetTitle(index: number): string {
  return `sheet ${index + 1}`;
}

/** 32MP soft-cap check (warn-only v1 — chốt 2026-06-12): native-dim sheets of
 *  stage 2/3 can exceed the cap; we log + still build (no auto-split). */
function warnOversizeSheets(
  layout: CropSheetLayoutResult,
  ctx: { stage: StageKind; action: string },
): void {
  for (const sheet of layout.sheets) {
    if (sheetExceedsPixelCap(sheet)) {
      log.warn(ctx.action, 'sheet exceeds 32MP soft cap — warn-only v1', {
        stage: ctx.stage,
        sheetIndex: sheet.index,
        width: sheet.sheetGeometry.width,
        height: sheet.sheetGeometry.height,
      });
    }
  }
}

/**
 * Materializes engine output into `RemixCropSheet[]`. Each placement's
 * `geometry` (px, sheet-relative) overwrites the placeholder geometry on the
 * matching LEAN `CropEntry` metadata. `image_url` is always '' (client
 * composes) and `swap_results` is always [] (geometry changed → stale).
 */
export function buildSheetsFromLayout(
  layout: CropSheetLayoutResult,
  cropMetaById: Record<string, CropEntry>,
): RemixCropSheet[] {
  return layout.sheets.map((sheet) => ({
    title: sheetTitle(sheet.index),
    sheet_geometry: sheet.sheetGeometry,
    image_url: '',
    swap_results: [],
    original_crops: sheet.placements
      .map((p) => {
        const meta = cropMetaById[p.id];
        if (!meta) return null;
        return { ...meta, geometry: p.geometry };
      })
      .filter((c): c is CropEntry => c !== null),
  }));
}

/** Engine inputs for a stage-2/3 batch from its OWN lean crops: native piece
 *  px (geometry.{w,h}) + affinity key. Pack with `absolutePx: true`. */
function stageNativeInputs(crops: CropEntry[]): {
  cropInputs: CropInput[];
  cropMetaById: Record<string, CropEntry>;
} {
  const cropInputs: CropInput[] = [];
  const cropMetaById: Record<string, CropEntry> = {};
  for (const c of crops) {
    if (c.geometry.w <= 0 || c.geometry.h <= 0) {
      log.warn('stageNativeInputs', 'crop has degenerate dims — skip', {
        id: c.id,
      });
      continue;
    }
    cropInputs.push({
      id: c.id,
      widthPct: c.geometry.w, // absolute px under absolutePx:true
      heightPct: c.geometry.h,
      objectKey: c.tags[0]?.object_key,
    });
    cropMetaById[c.id] = c;
  }
  return { cropInputs, cropMetaById };
}

/**
 * Computes crop sheets for the single seed batch of an insert payload and
 * writes them back IN PLACE — called inside `createRemix` BEFORE the Supabase
 * INSERT. Stage 'mixes' ONLY (rmbgs/upscales start empty — Import-driven).
 */
export function computeCropSheets(
  payload: InsertableRemixRow,
  dimension: number | null | undefined,
): void {
  const spread = resolveSpread(dimension);
  log.info('computeCropSheets', 'start', {
    charCount: payload.characters.length,
    propCount: payload.props.length,
    batchCount: payload.mixes.length,
    spreadW: spread.width,
    spreadH: spread.height,
  });

  if (payload.mixes.length === 0) {
    log.warn('computeCropSheets', 'no batch skeleton — skip', {});
    return;
  }

  // groupCropsForBatch reads a Remix-like view (illustration + characters/props
  // + remix_config — the purged config's characters[] is the swappable gate).
  const remixView = {
    illustration: payload.illustration,
    characters: payload.characters,
    props: payload.props,
    remix_config: payload.remix_config,
  } as Remix;

  const { cropInputs, cropMetaById } = groupCropsForBatch(remixView);
  log.debug('computeCropSheets', 'grouped batch', {
    cropCount: cropInputs.length,
  });

  const layout = computeCropSheetLayout(cropInputs, { sheetCount: 1, spread });
  payload.mixes[0].crop_sheets = buildSheetsFromLayout(layout, cropMetaById);

  log.info('computeCropSheets', 'done', {
    batchSheetCount: payload.mixes[0].crop_sheets.length,
  });
}

// ── Stage-generic deps + persistence ─────────────────────────────────────────

/** Narrow store-accessor pair so this module stays decoupled from the full
 *  zustand store type (avoids a circular import with index.ts). */
export interface RelayoutDeps {
  set: (updater: (s: { remixes: Remix[] }) => { remixes: Remix[] }) => void;
  get: () => { remixes: Remix[] };
  /** Active book dimension code — resolves the layout spread size. */
  dimension: number | null | undefined;
  /** Cross-slice action — in-store-only update of a batch's `crop_sheets[]`
   *  (CRUD slice). Supabase persistence is handled HERE (engine). */
  patchRemixCropSheets: (remixId: string, updates: CropSheetUpdate[]) => void;
}

/** Persist ONE stage column with the freshest in-store value, rolling back to
 *  `prevRemix` on error. Full-column write (parity with the legacy persistMixes
 *  — single-writer v1 assumption). Returns `true` on success. */
async function persistStageColumn(
  deps: RelayoutDeps,
  remixId: string,
  stage: StageKind,
  prevRemix: Remix,
  action: string,
): Promise<boolean> {
  const { set, get } = deps;
  const remixAfter = get().remixes.find((r) => r.id === remixId);
  if (!remixAfter) {
    log.warn(action, 'remix gone before persist — skip', { remixId, stage });
    return false;
  }
  const { error } = await supabase
    .from('remixes')
    .update({ [stage]: remixAfter[stage] })
    .eq('id', remixId);
  if (error) {
    log.error(action, 'persist failed — rollback', {
      remixId,
      stage,
      error: error.message,
    });
    // ROLLBACK LIMITATION (v1 single-writer assumption): restore the whole
    // remix snapshot. Concurrent realtime writes during the persist window are
    // clobbered — acceptable in v1 (modal is sole writer).
    set((s) => ({
      remixes: s.remixes.map((r) => (r.id === remixId ? prevRemix : r)),
    }));
    return false;
  }
  return true;
}

// ── relayout (stage-scoped append / remove sheet) ────────────────────────────

/**
 * Re-layouts ALL crop sheets of ONE batch of ONE stage at
 * `currentSheetCount + delta`, clamped to `[SHEET_MIN, cropCount]` (a sheet
 * holds ≥1 crop, so K can never exceed the batch's crop count).
 *
 * Stage 'mixes' re-groups from the frozen illustration (source-% geometry);
 * rmbgs/upscales re-pack the batch's OWN crops at native px (`absolutePx`).
 *
 * SWAP-RESULTS CONTRACT (callers MUST gate): a successful re-layout REBUILDS
 * the batch's sheets via `buildSheetsFromLayout` (hardcodes `swap_results: []`)
 * — it DESTROYS the batch's results. Callers gate with the confirm dialog.
 */
export async function relayoutStageBatchSheets(
  deps: RelayoutDeps,
  remixId: string,
  stage: StageKind,
  batchId: string,
  delta: number,
): Promise<boolean> {
  const { get, dimension, patchRemixCropSheets } = deps;
  log.info('relayoutStageBatchSheets', 'start', { remixId, stage, batchId, delta });

  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('relayoutStageBatchSheets', 'remix not found — abort', { remixId });
    return false;
  }

  const batch = (prevRemix[stage] ?? []).find((m) => m.id === batchId);
  if (!batch) {
    log.warn('relayoutStageBatchSheets', 'batch not found — abort', {
      remixId,
      stage,
      batchId,
    });
    return false;
  }

  const currentCount = batch.crop_sheets.length;
  // Cap K at the batch's crop count — a sheet holds ≥1 crop, so requesting more
  // sheets than crops only yields empties (replaces the old SHEET_MAX=10).
  const cropCount = currentCropsOfBatch(batch).length;
  const nextCount = Math.min(cropCount, Math.max(SHEET_MIN, currentCount + delta));
  if (nextCount === currentCount) {
    log.debug('relayoutStageBatchSheets', 'no count change — skip', {
      remixId,
      stage,
      batchId,
      currentCount,
    });
    return false;
  }

  // Resolve engine inputs per stage (see module header).
  let cropInputs: CropInput[];
  let cropMetaById: Record<string, CropEntry>;
  let absolutePx = false;
  if (stage === 'mixes') {
    // Re-group from the frozen illustration, filtered to the batch's lineup
    // (subset batches carry a strict subset of the illustration's crops).
    const grouped = groupCropsForBatch(prevRemix);
    const batchCropKeys = new Set(
      currentCropsOfBatch(batch).map((c) => `${c.spread_id}/${c.id}`),
    );
    cropInputs = grouped.cropInputs.filter((ci) => {
      const meta = grouped.cropMetaById[ci.id];
      if (!meta) return false;
      return batchCropKeys.has(`${meta.spread_id}/${meta.id}`);
    });
    cropMetaById = {};
    for (const ci of cropInputs) {
      cropMetaById[ci.id] = grouped.cropMetaById[ci.id];
    }
  } else {
    // Stage 2/3 — the batch's own snapshot crops at native px.
    ({ cropInputs, cropMetaById } = stageNativeInputs(currentCropsOfBatch(batch)));
    absolutePx = true;
  }

  if (cropInputs.length === 0) {
    log.warn('relayoutStageBatchSheets', 'no crops to layout — abort', {
      remixId,
      stage,
      batchId,
    });
    return false;
  }

  const spread = resolveSpread(dimension);
  const layout = computeCropSheetLayout(cropInputs, {
    sheetCount: nextCount,
    spread,
    ...(absolutePx ? { absolutePx } : {}),
  });
  warnOversizeSheets(layout, { stage, action: 'relayoutStageBatchSheets' });
  const newSheets = buildSheetsFromLayout(layout, cropMetaById);

  log.debug('relayoutStageBatchSheets', 'optimistic replaceAll', {
    remixId,
    stage,
    batchId,
    currentCount,
    nextCount,
    cropCount: cropInputs.length,
  });

  patchRemixCropSheets(remixId, [
    { kind: 'replaceAll', stage, entityKey: batchId, sheets: newSheets },
  ]);

  const ok = await persistStageColumn(
    deps,
    remixId,
    stage,
    prevRemix,
    'relayoutStageBatchSheets',
  );
  if (ok) {
    log.info('relayoutStageBatchSheets', 'done', { remixId, stage, batchId, nextCount });
  }
  return ok;
}

// ── add / remove / import batch (whole-batch lifecycle) ──────────────────────

/**
 * Appends a NEW batch to a stage column as a SUBSET clone of the active batch
 * (rev6 tick-flow — ALL 3 stages). `selectedCropKeys` = `${spread_id}/${id}`
 * keys ticked off the active batch's PRE-JOB `original_crops[]` (input
 * media_url of THAT stage — never the stage's own output). Packed at K=1.
 *
 * Throws on empty selection / zero match (stale). Returns the new batch id on
 * persist success, `null` on guard miss / persist error.
 */
export async function addStageBatch(
  deps: RelayoutDeps,
  remixId: string,
  stage: StageKind,
  activeBatchId: string,
  selectedCropKeys: ReadonlySet<string>,
): Promise<string | null> {
  const { set, get, dimension } = deps;
  log.info('addStageBatch', 'start', {
    remixId,
    stage,
    activeBatchId,
    selectionSize: selectedCropKeys.size,
  });

  if (selectedCropKeys.size === 0) {
    log.warn('addStageBatch', 'empty selection — throw', { remixId, stage });
    throw new Error('addStageBatch requires a non-empty crop selection');
  }

  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('addStageBatch', 'remix not found — abort', { remixId });
    return null;
  }

  const rows = prevRemix[stage] ?? [];
  const activeBatch = rows.find((m) => m.id === activeBatchId) ?? rows[0];
  if (!activeBatch) {
    log.warn('addStageBatch', 'no active batch — abort', {
      remixId,
      stage,
      activeBatchId,
    });
    return null;
  }

  // Pre-job lineup of the active batch, filtered to the ticked keys.
  const subset = currentCropsOfBatch(activeBatch).filter((c) =>
    selectedCropKeys.has(`${c.spread_id}/${c.id}`),
  );
  if (subset.length === 0) {
    log.warn('addStageBatch', 'selection has zero matches — throw', {
      remixId,
      stage,
      activeBatchId,
      selectionSize: selectedCropKeys.size,
    });
    throw new Error(
      'No selected crops match the active batch — selection stale',
    );
  }

  let cropInputs: CropInput[];
  let cropMetaById: Record<string, CropEntry>;
  let absolutePx = false;
  if (stage === 'mixes') {
    // Re-derive source-% inputs from the frozen illustration (CropEntry
    // geometry is engine OUTPUT px — cannot feed it back).
    const subsetKeys = new Set(subset.map((c) => `${c.spread_id}/${c.id}`));
    const grouped = groupCropsForBatch(prevRemix);
    cropInputs = grouped.cropInputs.filter((ci) => {
      const meta = grouped.cropMetaById[ci.id];
      if (!meta) return false;
      return subsetKeys.has(`${meta.spread_id}/${meta.id}`);
    });
    cropMetaById = {};
    for (const ci of cropInputs) {
      cropMetaById[ci.id] = grouped.cropMetaById[ci.id];
    }
  } else {
    ({ cropInputs, cropMetaById } = stageNativeInputs(subset));
    absolutePx = true;
  }

  if (cropInputs.length === 0) {
    log.warn('addStageBatch', 'subset resolved to no engine inputs — abort', {
      remixId,
      stage,
      subsetSize: subset.length,
    });
    return null;
  }

  const spread = resolveSpread(dimension);
  const layout = computeCropSheetLayout(cropInputs, {
    sheetCount: 1,
    spread,
    ...(absolutePx ? { absolutePx } : {}),
  });
  warnOversizeSheets(layout, { stage, action: 'addStageBatch' });

  const order = rows.reduce((max, m) => Math.max(max, m.order), -1) + 1;
  const newBatch: RemixMix = {
    ...makeBatchSkeleton(order, `Batch ${rows.length + 1}`),
    crop_sheets: buildSheetsFromLayout(layout, cropMetaById),
  };

  set((s) => ({
    remixes: s.remixes.map((r) =>
      r.id === remixId ? { ...r, [stage]: [...(r[stage] ?? []), newBatch] } : r,
    ),
  }));

  log.debug('addStageBatch', 'optimistic push', {
    remixId,
    stage,
    batchId: newBatch.id,
    order,
    sheetCount: newBatch.crop_sheets.length,
    cropCount: cropInputs.length,
  });

  const ok = await persistStageColumn(deps, remixId, stage, prevRemix, 'addStageBatch');
  if (!ok) return null;
  log.info('addStageBatch', 'done', { remixId, stage, batchId: newBatch.id });
  return newBatch.id;
}

/**
 * Removes a batch from a stage column. `BATCH_MIN` guard applies to stage
 * 'mixes' ONLY — rmbgs/upscales may drop to 0 batches (empty-state CTA).
 * Optimistic filter + full-column persist with rollback.
 */
export async function removeStageBatch(
  deps: RelayoutDeps,
  remixId: string,
  stage: StageKind,
  batchId: string,
): Promise<boolean> {
  const { set, get } = deps;
  log.info('removeStageBatch', 'start', { remixId, stage, batchId });

  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('removeStageBatch', 'remix not found — abort', { remixId });
    return false;
  }
  const rows = prevRemix[stage] ?? [];
  if (!rows.some((m) => m.id === batchId)) {
    log.warn('removeStageBatch', 'batch not found — abort', { remixId, stage, batchId });
    return false;
  }
  if (stage === 'mixes' && rows.length <= BATCH_MIN) {
    log.warn('removeStageBatch', 'cannot remove last mixes batch — abort', {
      remixId,
      batchId,
      count: rows.length,
    });
    return false;
  }

  set((s) => ({
    remixes: s.remixes.map((r) =>
      r.id === remixId
        ? { ...r, [stage]: (r[stage] ?? []).filter((m) => m.id !== batchId) }
        : r,
    ),
  }));

  log.debug('removeStageBatch', 'optimistic remove', { remixId, stage, batchId });
  return persistStageColumn(deps, remixId, stage, prevRemix, 'removeStageBatch');
}

/**
 * Imports the PREVIOUS stage's finals into a NEW batch of `stage` (rmbgs /
 * upscales only — 05-14). Copy-on-build snapshot: later finals changes never
 * reconcile into the built batch. Packed at K=1 with native-px dims.
 *
 * Throws on empty selection / zero match against the fresh finals (stale).
 * Returns the new batch id, `null` on guard miss / persist error.
 */
export async function importStageBatch(
  deps: RelayoutDeps,
  remixId: string,
  stage: 'rmbgs' | 'upscales',
  selectedFinalKeys: ReadonlySet<string>,
): Promise<string | null> {
  const { set, get, dimension } = deps;
  log.info('importStageBatch', 'start', {
    remixId,
    stage,
    selectionSize: selectedFinalKeys.size,
  });

  if (selectedFinalKeys.size === 0) {
    log.warn('importStageBatch', 'empty selection — throw', { remixId, stage });
    throw new Error('importStageBatch requires a non-empty finals selection');
  }

  const prevRemix = get().remixes.find((r) => r.id === remixId);
  if (!prevRemix) {
    log.warn('importStageBatch', 'remix not found — abort', { remixId });
    return null;
  }

  // Fresh finals of the previous stage — stale ticked keys are pruned here.
  const finals = collectStageFinals(prevRemix, PREV_STAGE[stage]);
  const { cropInputs, selected } = buildStageBatchInput(finals, selectedFinalKeys);
  if (selected.length === 0) {
    log.warn('importStageBatch', 'no finals match selection — throw', {
      remixId,
      stage,
      selectionSize: selectedFinalKeys.size,
      finalsCount: finals.length,
    });
    throw new Error('Selection is stale — finals changed');
  }

  const spread = resolveSpread(dimension);
  const layout = computeCropSheetLayout(cropInputs, {
    sheetCount: 1,
    spread,
    absolutePx: true,
  });
  warnOversizeSheets(layout, { stage, action: 'importStageBatch' });

  // Lean CropEntry meta from the finals — media_url = previous stage's OUTPUT
  // piece; geometry placeholder is overwritten by the placement.
  const cropMetaById: Record<string, CropEntry> = {};
  for (const f of selected) {
    cropMetaById[f.id] = {
      spread_id: f.spread_id,
      id: f.id,
      media_url: f.media_url,
      tags: f.tags,
      geometry: { x: 0, y: 0, w: 0, h: 0 },
    };
  }

  const rows = prevRemix[stage] ?? [];
  const order = rows.reduce((max, m) => Math.max(max, m.order), -1) + 1;
  const newBatch: RemixMix = {
    ...makeBatchSkeleton(order, `Batch ${rows.length + 1}`),
    crop_sheets: buildSheetsFromLayout(layout, cropMetaById),
  };

  set((s) => ({
    remixes: s.remixes.map((r) =>
      r.id === remixId ? { ...r, [stage]: [...(r[stage] ?? []), newBatch] } : r,
    ),
  }));

  log.debug('importStageBatch', 'optimistic push', {
    remixId,
    stage,
    batchId: newBatch.id,
    order,
    importedCount: selected.length,
  });

  const ok = await persistStageColumn(deps, remixId, stage, prevRemix, 'importStageBatch');
  if (!ok) return null;
  log.info('importStageBatch', 'done', { remixId, stage, batchId: newBatch.id });
  return newBatch.id;
}
