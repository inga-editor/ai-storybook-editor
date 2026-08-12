// remix-store/slices/swap-slice.ts — Stage-batch lifecycle (⚡2026-06-12
// STAGE-GENERIC: add/import/remove batch + append/remove batch sheet over the
// 3 pipeline columns mixes/rmbgs/upscales) + R5 take-back. The stage-job
// ENQUEUE action (`startStageJob`) lives in jobs-slice.ts (co-located with the
// other background-job enqueue actions per Validation S1) — NOT here.

import { getRemixDataGateway } from '../gateway/remix-data-gateway';
import type { WritableRemixColumn } from '../gateway/remix-data-gateway';
import { createLogger } from '@/utils/logger';
import { STAGE_JOB_CONFIG, type StageKind } from '@/types/remix';
import { useBookStore } from '../../book-store';
import {
  addStageBatch as engineAddStageBatch,
  importStageBatch as engineImportStageBatch,
  removeStageBatch as engineRemoveStageBatch,
  relayoutStageBatchSheets,
  type RelayoutDeps,
} from '../crop-sheet-layout';
import {
  applyTakeFinalBack,
  reconcileOrphanFinals,
} from '../selectors/select-final-crops';
import type { RemixSwapSlice, RemixSliceCreator } from '../types';

const log = createLogger('Store', 'RemixStore');

export const createSwapSlice: RemixSliceCreator<RemixSwapSlice> = (
  set,
  get,
) => {
  // Build the engine `RelayoutDeps` (set/get + active book dimension) — shared
  // by every batch-lifecycle action. `set`/`get` are the full-store creator
  // args; the engine narrows to `{ remixes }`, structurally compatible.
  const buildDeps = (): RelayoutDeps => ({
    set: set as RelayoutDeps['set'],
    get: get as unknown as RelayoutDeps['get'],
    dimension: useBookStore.getState().currentBook?.dimension ?? null,
    patchRemixCropSheets: get().patchRemixCropSheets,
  });

  // R3 per-stage `is_final` orphan reconcile — invoked AFTER a destructive
  // batch mutation (engine already persisted the column). Reads the freshest
  // stage rows, runs the pure reconciler, and persists ONLY when the result
  // actually flips at least one flag. On persist fail we roll back to the
  // pre-reconcile in-store snapshot (engine output = the committed DB state).
  const reconcileFinalsAfterMutation = async (
    remixId: string,
    stage: StageKind,
    callerLabel: string,
  ): Promise<void> => {
    const remix = get().remixes.find((r) => r.id === remixId);
    if (!remix) return;
    const pre = remix[stage] ?? [];
    const result = reconcileOrphanFinals(pre);
    if (!result.changed) return;

    log.info('reconcileFinalsAfterMutation', 'orphan reconcile applied', {
      remixId,
      stage,
      caller: callerLabel,
      claimed: result.log.claimed,
      defensiveCleared: result.log.defensiveCleared,
      dropped: result.log.dropped,
    });

    set((s) => ({
      remixes: s.remixes.map((r) =>
        r.id === remixId ? { ...r, [stage]: result.mixes } : r,
      ),
    }));

    try {
      // `stage` is `StageKind` (⊆ WritableRemixColumn) — narrow the dynamic key
      // so a stray column can never reach the gateway allowlist.
      await getRemixDataGateway().updateColumns(
        remixId,
        { [stage]: result.mixes } as Partial<Record<WritableRemixColumn, unknown>>,
      );
    } catch (error) {
      log.error(
        'reconcileFinalsAfterMutation',
        'persist failed — rollback to engine-committed rows',
        {
          remixId,
          stage,
          caller: callerLabel,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      set((s) => ({
        remixes: s.remixes.map((r) =>
          r.id === remixId ? { ...r, [stage]: pre } : r,
        ),
      }));
    }
  };

  return {
  // ── Stage-batch lifecycle (modal-driven, generic 3 stages) ──────────
  // CONTRACT — DESTRUCTIVE (whole batch): `appendStageBatchSheet`/
  // `removeStageBatchSheet` rebuild the batch's sheets via
  // `buildSheetsFromLayout` (hardcodes `swap_results: []`) — they DESTROY the
  // batch's results. Callers MUST gate (confirm dialog).
  addStageBatch: async (remixId, stage, activeBatchId, selectedCropKeys) => {
    log.info('addStageBatch', 'invoked', {
      remixId,
      stage,
      activeBatchId,
      selectionSize: selectedCropKeys.size,
    });
    return engineAddStageBatch(
      buildDeps(),
      remixId,
      stage,
      activeBatchId,
      selectedCropKeys,
    );
  },

  importStageBatch: async (remixId, stage, selectedFinalKeys) => {
    log.info('importStageBatch', 'invoked', {
      remixId,
      stage,
      selectionSize: selectedFinalKeys.size,
    });
    return engineImportStageBatch(buildDeps(), remixId, stage, selectedFinalKeys);
  },

  // ── Lazy seed of an initial batch (stage 'mixes' ONLY — modal mount) ──
  // Thin alias to `migrateLegacyRemixToBatch` with a fast-path guard
  // `mixes.length >= 1`. rmbgs/upscales NEVER seed (0 batches valid).
  seedInitialBatchIfMissing: async (remixId) => {
    const remix = get().remixes.find((r) => r.id === remixId);
    if (!remix) {
      log.warn('seedInitialBatchIfMissing', 'remix not found — skip', {
        remixId,
      });
      return false;
    }
    if (remix.mixes.length >= 1) {
      log.debug('seedInitialBatchIfMissing', 'batch already present — skip', {
        remixId,
        mixCount: remix.mixes.length,
      });
      return false;
    }
    log.info('seedInitialBatchIfMissing', 'delegate to migration', { remixId });
    return get().migrateLegacyRemixToBatch(remixId);
  },

  removeStageBatch: async (remixId, stage, batchId) => {
    log.info('removeStageBatch', 'invoked', { remixId, stage, batchId });
    const ok = await engineRemoveStageBatch(buildDeps(), remixId, stage, batchId);
    if (ok) await reconcileFinalsAfterMutation(remixId, stage, 'removeStageBatch');
    return ok;
  },

  appendStageBatchSheet: async (remixId, stage, batchId) => {
    log.info('appendStageBatchSheet', 'invoked', { remixId, stage, batchId });
    const ok = await relayoutStageBatchSheets(buildDeps(), remixId, stage, batchId, 1);
    if (ok) await reconcileFinalsAfterMutation(remixId, stage, 'appendStageBatchSheet');
    return ok;
  },

  removeStageBatchSheet: async (remixId, stage, batchId, sheetIndex) => {
    // `sheetIndex` is accepted for caller-API parity but unused: the engine
    // re-packs from scratch, so "which" sheet is moot. Delta -1 + SHEET_MIN
    // clamp inside `relayoutStageBatchSheets` is the guard.
    log.info('removeStageBatchSheet', 'invoked', {
      remixId,
      stage,
      batchId,
      sheetIndex,
    });
    const ok = await relayoutStageBatchSheets(buildDeps(), remixId, stage, batchId, -1);
    if (ok) await reconcileFinalsAfterMutation(remixId, stage, 'removeStageBatchSheet');
    return ok;
  },

  // ── R5 user Take-Back (per-stage `is_final` mutex override) ─────────
  takeFinalBack: async (remixId, stage, spreadId, layerId, fromBatchId) => {
    log.info('takeFinalBack', 'invoked', {
      remixId,
      stage,
      spreadId,
      layerId,
      fromBatchId,
    });

    // Defense-in-depth: UI already disables the button when a job of THIS
    // stage is running. Cross-check via jobs[] (mirror selector logic without
    // pulling React hooks into store code).
    const phase = STAGE_JOB_CONFIG[stage].phase;
    const state = get();
    const jobRunning = state.jobs.some(
      (j) =>
        j.phase === phase &&
        j.remixId === remixId &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (jobRunning) {
      log.warn('takeFinalBack', 'gated by running stage job', { remixId, stage });
      throw new Error(
        'Cannot take a final crop back while a job is running for this stage',
      );
    }

    const prevRemix = state.remixes.find((r) => r.id === remixId);
    if (!prevRemix) {
      log.warn('takeFinalBack', 'remix not found — skip', { remixId });
      return false;
    }

    const nextRows = applyTakeFinalBack(
      prevRemix[stage] ?? [],
      spreadId,
      layerId,
      fromBatchId,
    );
    if (nextRows === null) {
      log.warn('takeFinalBack', 'target crop or fromBatchId missing — skip', {
        remixId,
        stage,
        fromBatchId,
        spreadId,
        layerId,
      });
      return false;
    }

    // Optimistic in-store update.
    set((s) => ({
      remixes: s.remixes.map((r) =>
        r.id === remixId ? { ...r, [stage]: nextRows } : r,
      ),
    }));
    log.debug('takeFinalBack', 'optimistic set applied', { remixId, stage });

    try {
      await getRemixDataGateway().updateColumns(
        remixId,
        { [stage]: nextRows } as Partial<Record<WritableRemixColumn, unknown>>,
      );
    } catch (error) {
      log.error('takeFinalBack', 'persist failed — rollback', {
        remixId,
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
      set((s) => ({
        remixes: s.remixes.map((r) => (r.id === remixId ? prevRemix : r)),
      }));
      return false;
    }

    log.info('takeFinalBack', 'done', { remixId, stage, fromBatchId });
    return true;
  },
  };
};
