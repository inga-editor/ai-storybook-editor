// use-spread-thumbnail-job.ts — enqueue + watch the `spread_thumbnail` background
// job (api/jobs/17) that renders + persists every `spreads[i].thumbnail_url`.
//
// React 19 discipline: progress + optimistic thumbnail overrides are DERIVED from
// the active job in render (no setState mirrors store state). The single effect is
// the genuine terminal SIDE-EFFECT — refetch the snapshot (the BE leaf-writer emits
// no content-sync) + a partial-failure summary toast — wired through the imperative
// `subscribeJobs` API. `useActiveJob` (survives reload — caught by the store top-up)
// is the whole source of truth; the BE dedups to one job per book so there is no
// need for a local `jobId` mirror.

import * as React from 'react';
import { toast } from 'sonner';
import {
  useActiveJob,
  useBackgroundJobsStore,
  SPREAD_THUMBNAIL_TYPES,
  type BackgroundJob,
} from '@/stores/background-jobs-store';
import {
  enqueueSpreadThumbnails,
  isSpreadThumbnailsDeduped,
  isSpreadThumbnailsSkipped,
  EnqueueJobError,
  type SpreadThumbnailStepDetail,
} from '@/apis/jobs-api';
import { resolveBleedCanvasSize } from '@/utils/canvas-math-utils';
import { useAuthStore } from '@/stores/auth-store';
import { useSnapshotActions } from '@/stores/snapshot-store/selectors';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useSpreadThumbnailJob');

export interface SpreadThumbnailProgress {
  done: number;
  total: number;
}

export interface UseSpreadThumbnailJob {
  /** A `spread_thumbnail` job for this book is queued/running. */
  isRunning: boolean;
  /** `{done,total}` while running, else null. */
  progress: SpreadThumbnailProgress | null;
  /** spreadId → thumbnail_url for `step_details` entries already `done` (optimistic). */
  thumbnailOverrides: Record<string, string>;
  /** Kick off a full regenerate (no `spread_ids` — overwrites all, user-confirmed). */
  startGenerate: () => void;
}

interface UseSpreadThumbnailJobArgs {
  bookId: string | null;
  snapshotId: string | null;
  dimension: number | null;
  spreadCount: number;
}

export function useSpreadThumbnailJob({
  bookId,
  snapshotId,
  dimension,
  spreadCount,
}: UseSpreadThumbnailJobArgs): UseSpreadThumbnailJob {
  const { fetchSnapshot } = useSnapshotActions();

  // Active job for this book (types-filtered so actor/remix/export jobs never match).
  const job = useActiveJob({ types: [...SPREAD_THUMBNAIL_TYPES], bookId });

  const isRunning = job != null; // useActiveJob only returns queued|running rows.
  const progress = React.useMemo<SpreadThumbnailProgress | null>(
    () => (job ? { done: job.currentStep, total: job.totalSteps } : null),
    [job],
  );

  const stepDetails = job?.stepDetails ?? null;
  const thumbnailOverrides = React.useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (!stepDetails) return out;
    for (const [spreadId, raw] of Object.entries(stepDetails)) {
      const detail = raw as SpreadThumbnailStepDetail;
      if (detail?.status === 'done' && typeof detail.thumbnail_url === 'string') {
        out[spreadId] = detail.thumbnail_url;
      }
    }
    return out;
  }, [stepDetails]);

  // Terminal side-effect — refetch the snapshot (BE writer emits no content-sync) and
  // surface a partial-failure summary. Event-driven (subscribeJobs), NOT a render-
  // mirroring setState. Subscribes for ANY spread_thumbnail terminal of this book so
  // a reload-adopted job still refetches.
  React.useEffect(() => {
    if (!bookId) return;
    const unsubscribe = useBackgroundJobsStore.getState().subscribeJobs(
      { types: [...SPREAD_THUMBNAIL_TYPES], bookId },
      (event) => {
        if (event.transition !== 'terminal') return;
        const result = (event.job.result ?? {}) as {
          errors?: unknown[];
          generated?: number;
          total?: number;
        };
        const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
        log.info('onTerminal', 'thumbnail job finalized', {
          jobId: event.job.id,
          status: event.job.status,
          errorCount,
        });
        // User-facing terminal copy (incl. partial-failure warning) is owned by the
        // GLOBAL use-job-notifications allowlist (decision #3) so it fires even after
        // navigating away — no config-local toast here to avoid a duplicate. This
        // effect only owns the genuine local side-effect: refetch the snapshot.
        void fetchSnapshot(bookId);
      },
    );
    return unsubscribe;
  }, [bookId, fetchSnapshot]);

  const startGenerate = React.useCallback(() => {
    if (!snapshotId) {
      log.warn('startGenerate', 'no snapshot id — cannot enqueue', { bookId });
      return;
    }
    if (spreadCount === 0) {
      log.debug('startGenerate', 'no spreads — skip enqueue', { bookId });
      return;
    }
    // Canvas resolved from book dimension (default 3mm bleed) — single-source TS.
    const full = resolveBleedCanvasSize(dimension).full;
    const canvas = { width: Math.round(full.width), height: Math.round(full.height) };
    log.info('startGenerate', 'enqueue', {
      snapshotId,
      canvasW: canvas.width,
      canvasH: canvas.height,
      spreadCount,
    });
    void (async () => {
      try {
        const data = await enqueueSpreadThumbnails({ snapshot_id: snapshotId, canvas });
        if (isSpreadThumbnailsSkipped(data)) {
          log.info('startGenerate', 'skipped', { reason: data.reason });
          toast.info('No spreads to generate thumbnails for.');
          return;
        }
        if (isSpreadThumbnailsDeduped(data)) {
          // Already running — attach to it (useActiveJob already reflects the row).
          log.info('startGenerate', 'deduped', {
            jobId: data.job_id,
            status: data.status,
          });
          toast.info('Thumbnails are already generating.');
          return;
        }
        log.info('startGenerate', 'enqueued', {
          jobId: data.job_id,
          totalSteps: data.total_steps,
        });
        // Optimistic seed so the button flips to "Generating…" before realtime lands.
        const nowIso = new Date().toISOString();
        const seeded: BackgroundJob = {
          id: data.job_id,
          type: data.type,
          bookId,
          userId: useAuthStore.getState().user?.id ?? '',
          status: 'queued',
          currentStep: 0,
          totalSteps: data.total_steps,
          stepDetails: null,
          params: { snapshot_id: snapshotId },
          result: null,
          cancelRequested: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        useBackgroundJobsStore.getState().seed(seeded);
      } catch (err) {
        if (err instanceof EnqueueJobError) {
          log.error('startGenerate', 'enqueue failed', {
            httpStatus: err.httpStatus,
            code: err.code,
          });
          toast.error(err.message);
        } else {
          log.error('startGenerate', 'enqueue failed (unexpected)', {
            error: err instanceof Error ? err.message : String(err),
          });
          toast.error('Failed to start thumbnail generation.');
        }
      }
    })();
  }, [snapshotId, spreadCount, dimension, bookId]);

  return { isRunning, progress, thumbnailOverrides, startGenerate };
}
