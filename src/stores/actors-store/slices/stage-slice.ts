// actors-store/slices/stage-slice.ts — Stage-batch lifecycle (mixes/rmbgs/
// upscales) for the `actors` row. LWW client-direct: optimistic immer-style
// mutate → UPDATE 1 stage column of `actors` → rollback on error (no lock —
// grain 1 row/pair, parity remix swap-slice).
//
// REUSE, NOT FORK: every crop-layout/finals transform is an IMPORT of the PURE
// remix helper (`buildSheetsFromLayout`, `currentCropsOfBatch`,
// `applyTakeFinalBack`, `reconcileOrphanFinals`, `makeBatchSkeleton`). Only the
// table-coupled orchestration (find pair → optimistic set → persist to `actors`)
// is actors-local, because the remix engine hardcodes the `remixes` table.

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import {
  DIMENSION_CANVAS_SIZE,
  DEFAULT_CANVAS_SIZE,
} from '@/constants/canvas-dimension-constants';
import {
  computeCropSheetLayout,
  type CropInput,
} from '@/utils/crop-sheet-layout-engine';
import type {
  CropEntry,
  RemixCropSheet,
  RemixStageBatchRow,
} from '@/types/remix';
import { ACTOR_STAGE_JOB_PHASE, type ActorStageKind } from '@/types/actors';
import { useBookStore } from '../../book-store';
import {
  buildSheetsFromLayout,
  currentCropsOfBatch,
  SHEET_MIN,
  BATCH_MIN,
} from '../../remix-store/crop-sheet-layout';
import { makeBatchSkeleton } from '../../remix-store/clone-builder';
import {
  applyTakeFinalBack,
  reconcileOrphanFinals,
} from '../../remix-store/selectors/select-final-crops';
import type { ImportFinalEntry } from '../../remix-store/stage-finals';
import type {
  ActorPair,
  ActorsStageSlice,
  ActorsSliceCreator,
  CropRef,
} from '../types';

const log = createLogger('Store', 'ActorsStore');

/** Resolve the layout spread (px) from the active book dimension (2-line config
 *  lookup — NOT the batch pure-helper the reuse rule protects). */
function resolveSpread(): { width: number; height: number } {
  const dimension = useBookStore.getState().currentBook?.dimension ?? null;
  if (dimension == null) return DEFAULT_CANVAS_SIZE;
  return DIMENSION_CANVAS_SIZE[dimension] ?? DEFAULT_CANVAS_SIZE;
}

/** A crop-shaped entry both `CropRef` and `ImportFinalEntry` satisfy — the
 *  common input for the shared batch builder. */
interface BatchSeedEntry {
  spread_id: string;
  id: string;
  media_url: string;
  tags: CropEntry['tags'];
  nativeDim: { w: number; h: number };
}

/** Build a NEW K=1 batch from explicit seed entries (native-px pack,
 *  `absolutePx: true`). Shared by `addStageBatch` + `importStageBatch`. */
function buildBatchFromEntries(
  entries: BatchSeedEntry[],
  order: number,
  name: string,
): RemixStageBatchRow {
  const cropInputs: CropInput[] = [];
  const cropMetaById: Record<string, CropEntry> = {};
  for (const e of entries) {
    if (e.nativeDim.w <= 0 || e.nativeDim.h <= 0) continue;
    cropInputs.push({
      id: e.id,
      widthPct: e.nativeDim.w, // absolute px under absolutePx:true
      heightPct: e.nativeDim.h,
      objectKey: e.tags[0]?.object_key,
    });
    cropMetaById[e.id] = {
      spread_id: e.spread_id,
      id: e.id,
      media_url: e.media_url,
      tags: e.tags,
      geometry: { x: 0, y: 0, w: 0, h: 0 },
    };
  }
  const layout = computeCropSheetLayout(cropInputs, {
    sheetCount: 1,
    spread: resolveSpread(),
    absolutePx: true,
  });
  return {
    ...makeBatchSkeleton(order, name),
    crop_sheets: buildSheetsFromLayout(layout, cropMetaById),
  };
}

/** Re-pack ONE batch's OWN crops at `current ± delta` sheets (native-px),
 *  clamped to `[SHEET_MIN, cropCount]`. Returns fresh sheets, or `null` on a
 *  no-op / degenerate input. DESTRUCTIVE: `buildSheetsFromLayout` hardcodes
 *  `swap_results: []` — callers MUST gate. */
function relayoutBatchSheets(
  batch: RemixStageBatchRow,
  delta: number,
): RemixCropSheet[] | null {
  const crops = currentCropsOfBatch(batch);
  const current = batch.crop_sheets.length;
  const cropCount = crops.length;
  const next = Math.min(cropCount, Math.max(SHEET_MIN, current + delta));
  if (next === current) return null;

  const cropInputs: CropInput[] = [];
  const cropMetaById: Record<string, CropEntry> = {};
  for (const c of crops) {
    if (c.geometry.w <= 0 || c.geometry.h <= 0) continue;
    cropInputs.push({
      id: c.id,
      widthPct: c.geometry.w,
      heightPct: c.geometry.h,
      objectKey: c.tags[0]?.object_key,
    });
    cropMetaById[c.id] = c;
  }
  if (cropInputs.length === 0) return null;

  const layout = computeCropSheetLayout(cropInputs, {
    sheetCount: next,
    spread: resolveSpread(),
    absolutePx: true,
  });
  return buildSheetsFromLayout(layout, cropMetaById);
}

export const createStageSlice: ActorsSliceCreator<ActorsStageSlice> = (
  set,
  get,
) => {
  /** Persist ONE stage column of `pair` with the freshest in-store value,
   *  rolling the whole pair back to `prevPair` on error. */
  const persistStageColumn = async (
    pairId: string,
    stage: ActorStageKind,
    prevPair: ActorPair,
    action: string,
  ): Promise<boolean> => {
    const after = get().actorPairs.find((p) => p.id === pairId);
    if (!after) {
      log.warn(action, 'pair gone before persist — skip', { pairId, stage });
      return false;
    }
    const { error } = await supabase
      .from('actors')
      .update({ [stage]: after[stage] })
      .eq('id', pairId);
    if (error) {
      log.error(action, 'persist failed — rollback', {
        pairId,
        stage,
        error: error.message,
      });
      set((s) => ({
        actorPairs: s.actorPairs.map((p) => (p.id === pairId ? prevPair : p)),
      }));
      return false;
    }
    return true;
  };

  /** Per-stage `is_final` orphan reconcile AFTER a destructive batch mutation —
   *  persists ONLY when at least one flag flips (idempotent). */
  const reconcileFinalsAfterMutation = async (
    pairId: string,
    stage: ActorStageKind,
    caller: string,
  ): Promise<void> => {
    const pair = get().actorPairs.find((p) => p.id === pairId);
    if (!pair) return;
    const pre = pair[stage] ?? [];
    const result = reconcileOrphanFinals(pre);
    if (!result.changed) return;

    log.info('reconcileFinalsAfterMutation', 'orphan reconcile applied', {
      pairId,
      stage,
      caller,
      claimed: result.log.claimed,
      defensiveCleared: result.log.defensiveCleared,
    });
    set((s) => ({
      actorPairs: s.actorPairs.map((p) =>
        p.id === pairId ? { ...p, [stage]: result.mixes } : p,
      ),
    }));
    const { error } = await supabase
      .from('actors')
      .update({ [stage]: result.mixes })
      .eq('id', pairId);
    if (error) {
      log.error('reconcileFinalsAfterMutation', 'persist failed — rollback', {
        pairId,
        stage,
        error: error.message,
      });
      set((s) => ({
        actorPairs: s.actorPairs.map((p) =>
          p.id === pairId ? { ...p, [stage]: pre } : p,
        ),
      }));
    }
  };

  return {
    addStageBatch: async (pairId, stage, cropSubset) => {
      log.info('addStageBatch', 'invoked', {
        pairId,
        stage,
        selectionSize: cropSubset?.length ?? 0,
      });
      if (!cropSubset || cropSubset.length === 0) {
        log.warn('addStageBatch', 'empty crop subset — skip', { pairId, stage });
        return null;
      }
      const prevPair = get().actorPairs.find((p) => p.id === pairId);
      if (!prevPair) {
        log.warn('addStageBatch', 'pair not found — abort', { pairId });
        return null;
      }
      const rows = prevPair[stage] ?? [];
      const order = rows.reduce((max, m) => Math.max(max, m.order), -1) + 1;
      const batch = buildBatchFromEntries(
        cropSubset as CropRef[],
        order,
        `Batch ${rows.length + 1}`,
      );

      set((s) => ({
        actorPairs: s.actorPairs.map((p) =>
          p.id === pairId ? { ...p, [stage]: [...(p[stage] ?? []), batch] } : p,
        ),
      }));
      log.debug('addStageBatch', 'optimistic push', {
        pairId,
        stage,
        batchId: batch.id,
        sheetCount: batch.crop_sheets.length,
      });
      const ok = await persistStageColumn(pairId, stage, prevPair, 'addStageBatch');
      if (ok) log.info('addStageBatch', 'done', { pairId, stage, batchId: batch.id });
      return ok ? batch.id : null;
    },

    importStageBatch: async (pairId, stage, entries) => {
      log.info('importStageBatch', 'invoked', {
        pairId,
        stage,
        selectionSize: entries.length,
      });
      if (entries.length === 0) {
        log.warn('importStageBatch', 'empty entries — skip', { pairId, stage });
        return null;
      }
      const prevPair = get().actorPairs.find((p) => p.id === pairId);
      if (!prevPair) {
        log.warn('importStageBatch', 'pair not found — abort', { pairId });
        return null;
      }
      const rows = prevPair[stage] ?? [];
      const order = rows.reduce((max, m) => Math.max(max, m.order), -1) + 1;
      // ImportFinalEntry already carries spread_id/id/media_url/tags/nativeDim.
      const batch = buildBatchFromEntries(
        entries as ImportFinalEntry[],
        order,
        `Batch ${rows.length + 1}`,
      );

      set((s) => ({
        actorPairs: s.actorPairs.map((p) =>
          p.id === pairId ? { ...p, [stage]: [...(p[stage] ?? []), batch] } : p,
        ),
      }));
      log.debug('importStageBatch', 'optimistic push', {
        pairId,
        stage,
        batchId: batch.id,
        importedCount: entries.length,
      });
      const ok = await persistStageColumn(pairId, stage, prevPair, 'importStageBatch');
      if (ok) log.info('importStageBatch', 'done', { pairId, stage, batchId: batch.id });
      return ok ? batch.id : null;
    },

    removeStageBatch: async (pairId, stage, batchId) => {
      log.info('removeStageBatch', 'invoked', { pairId, stage, batchId });
      const prevPair = get().actorPairs.find((p) => p.id === pairId);
      if (!prevPair) {
        log.warn('removeStageBatch', 'pair not found — abort', { pairId });
        return;
      }
      const rows = prevPair[stage] ?? [];
      if (!rows.some((m) => m.id === batchId)) {
        log.warn('removeStageBatch', 'batch not found — abort', { pairId, stage, batchId });
        return;
      }
      // Parity remix: BATCH_MIN guard on 'mixes' only; rmbgs/upscales → 0 OK.
      if (stage === 'mixes' && rows.length <= BATCH_MIN) {
        log.warn('removeStageBatch', 'cannot remove last mixes batch — abort', {
          pairId,
          batchId,
          count: rows.length,
        });
        return;
      }

      set((s) => ({
        actorPairs: s.actorPairs.map((p) =>
          p.id === pairId
            ? { ...p, [stage]: (p[stage] ?? []).filter((m) => m.id !== batchId) }
            : p,
        ),
      }));
      const ok = await persistStageColumn(pairId, stage, prevPair, 'removeStageBatch');
      if (ok) await reconcileFinalsAfterMutation(pairId, stage, 'removeStageBatch');
    },

    appendStageBatchSheet: async (pairId, stage, batchId) => {
      log.info('appendStageBatchSheet', 'invoked', { pairId, stage, batchId });
      await relayoutOne(pairId, stage, batchId, 1, 'appendStageBatchSheet');
    },

    removeStageBatchSheet: async (pairId, stage, batchId, sheetIndex) => {
      // `sheetIndex` accepted for caller-API parity but unused (engine re-packs).
      log.info('removeStageBatchSheet', 'invoked', { pairId, stage, batchId, sheetIndex });
      await relayoutOne(pairId, stage, batchId, -1, 'removeStageBatchSheet');
    },

    takeFinalBack: async (pairId, stage, spreadId, layerId, batchId) => {
      log.info('takeFinalBack', 'invoked', { pairId, stage, spreadId, layerId, batchId });

      // Defense-in-depth: UI already disables while a job of THIS stage runs.
      const phase = ACTOR_STAGE_JOB_PHASE[stage];
      const jobRunning = get().jobs.some(
        (j) =>
          j.phase === phase &&
          j.pairId === pairId &&
          (j.status === 'queued' || j.status === 'running'),
      );
      if (jobRunning) {
        log.warn('takeFinalBack', 'gated by running stage job', { pairId, stage });
        throw new Error('Cannot take a final crop back while a job runs for this stage');
      }

      const prevPair = get().actorPairs.find((p) => p.id === pairId);
      if (!prevPair) {
        log.warn('takeFinalBack', 'pair not found — skip', { pairId });
        return;
      }
      const nextRows = applyTakeFinalBack(
        prevPair[stage] ?? [],
        spreadId,
        layerId,
        batchId,
      );
      if (nextRows === null) {
        log.warn('takeFinalBack', 'target crop or batchId missing — skip', {
          pairId,
          stage,
          batchId,
        });
        return;
      }

      set((s) => ({
        actorPairs: s.actorPairs.map((p) =>
          p.id === pairId ? { ...p, [stage]: nextRows } : p,
        ),
      }));
      const ok = await persistStageColumn(pairId, stage, prevPair, 'takeFinalBack');
      if (ok) log.info('takeFinalBack', 'done', { pairId, stage, batchId });
    },
  };

  /** Shared append/remove-sheet body — relayout ONE batch ±1 sheet + persist +
   *  finals reconcile. Hoisted so both actions delegate to one implementation. */
  async function relayoutOne(
    pairId: string,
    stage: ActorStageKind,
    batchId: string,
    delta: number,
    caller: string,
  ): Promise<void> {
    const prevPair = get().actorPairs.find((p) => p.id === pairId);
    if (!prevPair) {
      log.warn(caller, 'pair not found — abort', { pairId });
      return;
    }
    const batch = (prevPair[stage] ?? []).find((m) => m.id === batchId);
    if (!batch) {
      log.warn(caller, 'batch not found — abort', { pairId, stage, batchId });
      return;
    }
    const newSheets = relayoutBatchSheets(batch, delta);
    if (newSheets === null) {
      log.debug(caller, 'no sheet-count change — skip', { pairId, stage, batchId });
      return;
    }
    set((s) => ({
      actorPairs: s.actorPairs.map((p) =>
        p.id === pairId
          ? {
              ...p,
              [stage]: (p[stage] ?? []).map((m) =>
                m.id === batchId ? { ...m, crop_sheets: newSheets } : m,
              ),
            }
          : p,
      ),
    }));
    const ok = await persistStageColumn(pairId, stage, prevPair, caller);
    if (ok) await reconcileFinalsAfterMutation(pairId, stage, caller);
  }
};
