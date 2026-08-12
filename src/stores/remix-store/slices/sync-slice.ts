// remix-store/slices/sync-slice.ts — Server sync slice. Snapshot remix load
// (syncFromServer), store reset (clearAll), unified-store job event apply
// (onRemixJobEvent — ADR-037 consumer), and targeted single-remix refetch on
// active→terminal job transitions.

import { getRemixDataGateway } from '../gateway/remix-data-gateway';
import { createLogger } from '@/utils/logger';
import { newUuid } from '@/utils/uuid';
import type { Remix, RemixMix } from '@/types/remix';
import {
  DIMENSION_CANVAS_SIZE,
  DEFAULT_CANVAS_SIZE,
} from '@/constants/canvas-dimension-constants';
import { computeCropSheetLayout } from '@/utils/crop-sheet-layout-engine';
import { groupCropsForBatch } from '@/utils/crop-grouping';
import { buildSheetsFromLayout } from '../crop-sheet-layout';
import { mapRowToRemix } from '../supabase-mapping';
import { mapBackgroundJobToRemixJob } from '../map-background-job-row';
import {
  needsMigration as needsFinalFlagMigration,
  reconcileOrphanFinals,
} from '../selectors/select-final-crops';
import { pruneSupersededJobs } from '../slice-helpers';
import { useBookStore } from '../../book-store';
import type { RemixSyncSlice, RemixSliceCreator } from '../types';

const log = createLogger('Store', 'RemixStore');

/** Detect a remix still on the legacy (pre-batch) shape. Idempotent guard for
 *  `migrateLegacyRemixToBatch` — true when there's no batch, a batch is missing
 *  its uuid `id`, or a batch still carries the legacy `keys[]` lineup.
 *  (Per-entity `crop_sheets[]` removed 2026-05-26 — no longer a migration trigger.) */
function needsBatchMigration(remix: Remix): boolean {
  if (remix.mixes.length === 0) return true;
  if (
    remix.mixes.some(
      (m) => m.id == null || (m as { keys?: unknown }).keys != null,
    )
  ) {
    return true;
  }
  return false;
}

export const createSyncSlice: RemixSliceCreator<RemixSyncSlice> = (
  set,
  get,
) => ({
  // First-successful-sync flag (see RemixSyncSlice.hasSyncedOnce). Starts false;
  // an error return in `syncFromServer` leaves it false so the sub-app preselect
  // keeps waiting for a real load.
  hasSyncedOnce: false,

  syncFromServer: async (snapshotId) => {
    log.info('syncFromServer', 'start', { snapshotId });
    let rows;
    try {
      rows = await getRemixDataGateway().listBySnapshot(snapshotId);
    } catch (error) {
      log.error('syncFromServer', 'failed', {
        snapshotId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const remixes = rows.map(mapRowToRemix);
    log.info('syncFromServer', 'done', { snapshotId, count: remixes.length });
    // `hasSyncedOnce` flips true in the SAME commit that populates `remixes`, so
    // any reader gated on it sees a fully-loaded list (no populated-vs-flag race).
    set({ remixes, activeRemixId: null, hasSyncedOnce: true });

    // R3 / migration — one-shot fixup for remixes whose mixes blob predates
    // the `is_final` flag (Validation Session 1: case "created" semantic on
    // initial load, NEVER on realtime "updated"). `reconcileOrphanFinals` is
    // idempotent (`changed=false` short-circuits before persist) so this is
    // safe to call across every load — work only happens once per remix.
    for (const remix of remixes) {
      if (!needsFinalFlagMigration(remix.mixes)) continue;
      const result = reconcileOrphanFinals(remix.mixes);
      if (!result.changed) continue;
      log.info('syncFromServer', 'is_final migration applied', {
        remixId: remix.id,
        claimed: result.log.claimed,
        defensiveCleared: result.log.defensiveCleared,
        dropped: result.log.dropped,
      });
      set((s) => ({
        remixes: s.remixes.map((r) =>
          r.id === remix.id ? { ...r, mixes: result.mixes } : r,
        ),
      }));
      try {
        await getRemixDataGateway().updateColumns(remix.id, { mixes: result.mixes });
      } catch (error) {
        log.error('syncFromServer', 'is_final migration persist failed', {
          remixId: remix.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Roll the migrated remix back to the loaded-from-server shape — the
        // UI will fall back to `resolveFinalCrops` defensive winner pick.
        set((s) => ({
          remixes: s.remixes.map((r) =>
            r.id === remix.id ? { ...r, mixes: remix.mixes } : r,
          ),
        }));
      }
    }
  },

  clearAll: () => {
    log.info('clearAll', 'clearing remix store');
    set({
      remixes: [],
      activeRemixId: null,
      jobs: [],
      hasSyncedOnce: false,
    });
  },

  onRemixJobEvent: (event) => {
    // ADR-037: the unified BackgroundJobsStore fans out every remix-swap job
    // event here (predicate already filtered to the 3 remix types). Upsert the
    // derived RemixJob into the `jobs[]` projection (Option A — readers keep
    // `useRemixStore(s => s.jobs)`), prune superseded lineage, then refetch the
    // remix row once the job goes terminal (DB may carry fresh audio/crop urls).

    // Removal (DELETE event / 30s auto-dismiss) — drop the projection copy.
    if (event.transition === 'removed') {
      log.debug('onRemixJobEvent', 'removed', { jobId: event.job.id });
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== event.job.id) }));
      return;
    }

    const incoming = mapBackgroundJobToRemixJob(event.job);

    set((s) => {
      const idx = s.jobs.findIndex((j) => j.id === incoming.id);
      if (idx === -1) {
        return { jobs: pruneSupersededJobs([...s.jobs, incoming]) };
      }
      const next = [...s.jobs];
      next[idx] = { ...next[idx], ...incoming };
      return { jobs: pruneSupersededJobs(next) };
    });
    log.debug('onRemixJobEvent', 'upsert', {
      jobId: incoming.id,
      status: incoming.status,
      phase: incoming.phase,
      transition: event.transition,
    });

    if (event.transition === 'terminal' && incoming.remixId) {
      log.info('onRemixJobEvent', 'terminal → refetch remix', {
        remixId: incoming.remixId,
        jobId: incoming.id,
        status: incoming.status,
      });
      void get()
        .refetchRemix(incoming.remixId)
        .catch((err) => {
          log.warn('onRemixJobEvent', 'refetch failed', {
            remixId: incoming.remixId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  },

  refetchRemix: async (remixId) => {
    log.info('refetchRemix', 'fetch', { remixId });
    let data;
    try {
      data = await getRemixDataGateway().getById(remixId);
    } catch (error) {
      log.error('refetchRemix', 'failed', {
        remixId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!data) {
      log.warn('refetchRemix', 'row not found', { remixId });
      return;
    }

    const remix = mapRowToRemix(data);
    set((s) => {
      const idx = s.remixes.findIndex((r) => r.id === remixId);
      if (idx === -1) {
        // Remix was deleted locally since the job started; ignore.
        return s;
      }
      const next = [...s.remixes];
      next[idx] = remix;
      return { remixes: next };
    });
    log.info('refetchRemix', 'done', { remixId });
  },

  migrateLegacyRemixToBatch: async (remixId) => {
    const prevRemix = get().remixes.find((r) => r.id === remixId);
    if (!prevRemix) {
      log.warn('migrateLegacyRemixToBatch', 'remix not found — skip', {
        remixId,
      });
      return false;
    }
    if (!needsBatchMigration(prevRemix)) {
      log.debug('migrateLegacyRemixToBatch', 'no migration needed', { remixId });
      return false;
    }

    log.info('migrateLegacyRemixToBatch', 'start', {
      remixId,
      mixCount: prevRemix.mixes.length,
    });

    // Rebuild crops from the frozen illustration tags (single source of truth) —
    // NOT from legacy entity/mix crops (no longer type-valid post-reshape).
    const dimension = useBookStore.getState().currentBook?.dimension ?? null;
    const spread =
      dimension == null
        ? DEFAULT_CANVAS_SIZE
        : DIMENSION_CANVAS_SIZE[dimension] ?? DEFAULT_CANVAS_SIZE;
    const { cropInputs, cropMetaById } = groupCropsForBatch(prevRemix);
    const layout = computeCropSheetLayout(cropInputs, { sheetCount: 1, spread });

    // Preserve an existing valid batch id (idempotent re-shape); else a new uuid.
    const existingId = prevRemix.mixes.find((m) => typeof m.id === 'string')?.id;
    const batch: RemixMix = {
      id: existingId ?? newUuid(),
      order: 0,
      name: 'Batch 1',
      crop_sheets: buildSheetsFromLayout(layout, cropMetaById),
    };

    // Optimistic: single batch + cleared entity crop_sheets.
    set((s) => ({
      remixes: s.remixes.map((r) =>
        r.id === remixId
          ? {
              ...r,
              mixes: [batch],
              characters: r.characters,
              props: r.props,
            }
          : r,
      ),
    }));

    const remixAfter = get().remixes.find((r) => r.id === remixId);
    if (!remixAfter) {
      log.warn('migrateLegacyRemixToBatch', 'remix gone before persist — skip', {
        remixId,
      });
      return false;
    }

    try {
      await getRemixDataGateway().updateColumns(remixId, {
        mixes: remixAfter.mixes,
        characters: remixAfter.characters,
        props: remixAfter.props,
      });
    } catch (error) {
      log.error('migrateLegacyRemixToBatch', 'persist failed — rollback', {
        remixId,
        error: error instanceof Error ? error.message : String(error),
      });
      set((s) => ({
        remixes: s.remixes.map((r) => (r.id === remixId ? prevRemix : r)),
      }));
      return false;
    }

    log.info('migrateLegacyRemixToBatch', 'done', {
      remixId,
      batchId: batch.id,
      sheetCount: batch.crop_sheets.length,
    });
    return true;
  },
});
