// actors-store/slices/jobs-slice.ts — Actor stage-job enqueue (jobs 14/15/16)
// + ephemeral `jobs[]` projection. Enqueue via REST + optimistic seed into the
// unified BackgroundJobsStore (single ingest path, ADR-037); the index bridge
// fans the row back to `applyJobRow`. Job success writes `swap_results[]`
// SERVER-side → the bridge refetches the pair (client never merges by hand).

import { toast } from 'sonner';
import { createLogger } from '@/utils/logger';
import { ACTOR_STAGE_JOB_PHASE } from '@/types/actors';
import {
  enqueueActorStageJob,
  EnqueueJobError,
} from '@/apis/jobs-api';
import { useAuthStore } from '../../auth-store';
import { useBackgroundJobsStore } from '../../background-jobs-store';
import type { BackgroundJob } from '../../background-jobs-store';
import type {
  ActorJob,
  ActorsJobsSlice,
  ActorsSliceCreator,
} from '../types';

const log = createLogger('Store', 'ActorsStore');

export const createJobsSlice: ActorsSliceCreator<ActorsJobsSlice> = (
  set,
  get,
) => ({
  jobs: [],

  startStageJob: async ({ pairId, stage, batchId, modelParams, grain }) => {
    const phase = ACTOR_STAGE_JOB_PHASE[stage];

    // Guard WITHIN the stage only — the 3 stages run concurrently (disjoint cols).
    const alreadyRunning = get().jobs.some(
      (j) =>
        j.phase === phase &&
        j.pairId === pairId &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (alreadyRunning) {
      log.debug('startStageJob', 'stage job already running — no-op', {
        pairId,
        stage,
        batchId,
      });
      return { kind: 'skipped', reason: 'busy' };
    }

    log.info('startStageJob', 'enqueue', {
      pairId,
      stage,
      batchId,
      model: modelParams?.model,
      grainEnabled: stage === 'upscales' ? grain?.enabled : undefined,
    });

    try {
      // `grain` is TOP-LEVEL + upscale-only — the API wrapper strips it otherwise.
      const data = await enqueueActorStageJob(pairId, stage, {
        batch_id: batchId,
        model_params: modelParams,
        grain,
      });

      if ('skipped' in data && data.skipped) {
        log.info('startStageJob', 'skipped', { pairId, stage, reason: data.reason });
        toast.info(`Nothing to process (${data.reason})`);
        return { kind: 'skipped', reason: data.reason };
      }

      if ('deduped' in data && data.deduped) {
        log.info('startStageJob', 'deduped', {
          pairId,
          stage,
          jobId: data.job_id,
          status: data.status,
        });
        // Mirror the active row into jobs[] if not present (realtime fills it).
        if (!get().jobs.find((j) => j.id === data.job_id)) {
          const shared = useBackgroundJobsStore.getState().jobsById[data.job_id];
          if (shared) get().applyJobRow(shared);
        }
        toast.info('This stage is already running');
        return { kind: 'deduped', jobId: data.job_id, status: data.status };
      }

      log.info('startStageJob', 'enqueued', {
        pairId,
        stage,
        batchId,
        jobId: data.job_id,
        totalSteps: data.total_steps,
      });

      // Optimistic seed into the unified store — the index bridge upserts jobs[].
      const nowIso = new Date().toISOString();
      useBackgroundJobsStore.getState().seed({
        id: data.job_id,
        type: data.type,
        bookId: null,
        userId: useAuthStore.getState().user?.id ?? '',
        status: 'queued',
        currentStep: 0,
        totalSteps: data.total_steps,
        stepDetails: null,
        params: { pair_id: pairId, batch_id: batchId },
        result: null,
        cancelRequested: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      return { kind: 'enqueued', jobId: data.job_id, totalSteps: data.total_steps };
    } catch (err) {
      if (err instanceof EnqueueJobError) {
        log.error('startStageJob', 'enqueue failed', {
          pairId,
          stage,
          httpStatus: err.httpStatus,
          code: err.code,
        });
        toast.error(
          err.code === 'REFERENCE_IMAGE_MISSING'
            ? 'This actor has no artwork yet'
            : err.message,
        );
      } else {
        log.error('startStageJob', 'enqueue failed (unexpected)', {
          pairId,
          stage,
          error: err instanceof Error ? err.message : String(err),
        });
        toast.error('Failed to start the job');
      }
      throw err;
    }
  },

  cancelJob: async (jobId) => {
    log.info('cancelJob', 'delegate to background-jobs store', { jobId });
    await useBackgroundJobsStore.getState().cancelJob(jobId);
  },

  dismissJob: (jobId) => {
    log.debug('dismissJob', 'remove from store', { jobId });
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) }));
  },

  applyJobRow: (row: BackgroundJob) => {
    const pairId = typeof row.params?.pair_id === 'string' ? row.params.pair_id : '';
    const batchId = typeof row.params?.batch_id === 'string' ? row.params.batch_id : '';
    // The index bridge only forwards ACTOR_SWAP_TYPES rows → `type` is a phase.
    const incoming: ActorJob = {
      id: row.id,
      phase: row.type as ActorJob['phase'],
      pairId,
      batchId,
      status: row.status,
      progress: { done: row.currentStep, total: row.totalSteps },
    };

    set((s) => {
      const idx = s.jobs.findIndex((j) => j.id === incoming.id);
      if (idx === -1) return { jobs: [...s.jobs, incoming] };
      const next = [...s.jobs];
      next[idx] = { ...next[idx], ...incoming };
      return { jobs: next };
    });
    log.debug('applyJobRow', 'upsert', {
      jobId: incoming.id,
      phase: incoming.phase,
      status: incoming.status,
    });
  },
});
