// remix-store/slices/jobs-slice.ts — Remix enqueue slice (ADR-037 consumer).
// Enqueue via REST + optimistic seed into the unified BackgroundJobsStore
// (`seed`), which fans the row back as a remix-swap event → `jobs[]` projection.
// cancelJob delegates to the shared generic action. Inject (client-side
// finalize) lives here too: injectFinalCrops resolves is_final winner crops,
// mutates the illustration blob, and persists it in ONE Supabase UPDATE.

import { getRemixDataGateway } from '../gateway/remix-data-gateway';
import { createLogger } from '@/utils/logger';
import {
  CLIENT_AUDIO_CHUNK_CAP,
  DETECT_JOB_CONFIG,
  STAGE_JOB_CONFIG,
} from '@/types/remix';
import type { InjectResult, RemixIllustration } from '@/types/remix';
import {
  enqueueAudioSwap,
  enqueueRemixStageJob,
  enqueueRemixSpriteSwap,
  enqueueDetectDefects,
  EnqueueJobError,
  type EnqueueAudioSwapEnqueuedData,
  type EnqueueAudioSwapDedupedData,
  type EnqueueDetectData,
} from '@/apis/jobs-api';
import { useAuthStore } from '../../auth-store';
import { useBackgroundJobsStore } from '../../background-jobs-store';
import { resolveFinalCrops } from '../selectors/select-final-crops';
import { applyFinalCrops } from '../apply-final-crops';
import { buildModelParams } from './build-model-params';
import type { RemixJobsSlice, RemixSliceCreator } from '../types';

const log = createLogger('Store', 'RemixStore');

export const createJobsSlice: RemixSliceCreator<RemixJobsSlice> = (
  set,
  get,
) => ({
  jobs: [],

  // ── Audio swap enqueue ─────────────────────────────────────────────
  startAudioJob: async (remixId, opts) => {
    log.info('startAudioJob', 'enqueue', {
      remixId,
      triggeredBy: opts.triggeredBy,
    });

    const params = {
      triggered_by: opts.triggeredBy,
      max_concurrent_chunks_per_textbox:
        opts.maxConcurrentChunksPerTextbox ?? CLIENT_AUDIO_CHUNK_CAP,
    };

    const result = await enqueueAudioSwap(remixId, params);
    if (!result.success) {
      log.error('startAudioJob', 'failed', {
        remixId,
        error: result.error,
        httpStatus: result.httpStatus,
        errorCode: result.errorCode,
      });
      throw new Error(result.error);
    }

    const data = result.data;

    if ('skipped' in data && data.skipped) {
      log.info('startAudioJob', 'skipped', {
        remixId,
        reason: data.reason,
      });
      return { kind: 'skipped', reason: data.reason };
    }

    if ('deduped' in data && data.deduped) {
      const deduped = data as EnqueueAudioSwapDedupedData;
      log.info('startAudioJob', 'deduped', {
        remixId,
        jobId: deduped.job_id,
        status: deduped.status,
      });
      // Ensure job row is present locally; reconcile from the shared store if
      // its channel already ingested the deduped job (else realtime fills it).
      if (!get().jobs.find((j) => j.id === deduped.job_id)) {
        const shared = useBackgroundJobsStore.getState().jobsById[deduped.job_id];
        if (shared) get().onRemixJobEvent({ job: shared, prev: null, transition: 'appeared' });
      }
      return {
        kind: 'deduped',
        jobId: deduped.job_id,
        status: deduped.status,
      };
    }

    const enqueued = data as EnqueueAudioSwapEnqueuedData;
    log.info('startAudioJob', 'enqueued', {
      remixId,
      jobId: enqueued.job_id,
      totalSteps: enqueued.total_steps,
    });

    // Optimistic seed into the unified store (single ingest path). The remix
    // consumer callback upserts it into `jobs[]` ('appeared'); realtime UPDATE
    // reconciles by id next.
    const nowIso = new Date().toISOString();
    useBackgroundJobsStore.getState().seed({
      id: enqueued.job_id,
      type: 'remix_audio_swap',
      bookId: null,
      userId: useAuthStore.getState().user?.id ?? '',
      status: 'queued',
      currentStep: 0,
      totalSteps: enqueued.total_steps,
      stepDetails: null,
      params: { remix_id: remixId, triggered_by: opts.triggeredBy },
      result: null,
      cancelRequested: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return {
      kind: 'enqueued',
      jobId: enqueued.job_id,
      totalSteps: enqueued.total_steps,
      chunksToRegen: enqueued.chunks_to_regen,
      textboxesToRecombine: enqueued.textboxes_to_recombine,
    };
  },

  // ── Inject (Phase 3 — client-side finalize) ────────────────────────
  // Synchronous finalize (NO background job): resolve the is_final winner
  // crops, mutate the illustration blob (pure helper), optimistically set
  // local state, then persist the full `illustration` column in ONE Supabase
  // UPDATE. Rollback via refetchRemix on persist failure. Pure: returns
  // InjectResult or throws — the UI handler owns the toast.
  injectFinalCrops: async (remixId): Promise<InjectResult> => {
    log.info('injectFinalCrops', 'inject requested', { remixId });

    const remix = get().remixes.find((r) => r.id === remixId);
    if (!remix) {
      log.warn('injectFinalCrops', 'remix not found', { remixId });
      throw new Error('REMIX_NOT_FOUND');
    }

    const finals = resolveFinalCrops(remix);
    if (finals.length === 0) {
      log.warn('injectFinalCrops', 'no final crops to inject', { remixId });
      throw new Error('no final crops to inject');
    }

    const nowISO = new Date().toISOString();
    const { spreads, appliedCount, collapsedCount, spreadCount } =
      applyFinalCrops(remix.illustration, finals, nowISO);

    const nextIllustration: RemixIllustration = {
      ...remix.illustration,
      spreads,
    };

    // Optimistic local update (same body as the persisted UPDATE).
    set((s) => ({
      remixes: s.remixes.map((r) =>
        r.id === remixId ? { ...r, illustration: nextIllustration } : r,
      ),
    }));

    try {
      await getRemixDataGateway().updateColumns(remixId, {
        illustration: nextIllustration,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('injectFinalCrops', 'persist failed; rolling back', {
        remixId,
        error: message,
      });
      // Rollback to authoritative server row, then surface the error.
      await get().refetchRemix(remixId);
      throw new Error(message);
    }

    log.info('injectFinalCrops', 'inject complete', {
      remixId,
      appliedCount,
      collapsedCount,
      spreadCount,
    });
    return { appliedCount, collapsedCount, spreadCount };
  },

  // ── Stage-batch job enqueue (⚡2026-06-12 generic — jobs 05/09/10) ──
  // Mirrors startAudioJob: POST enqueue + optimistic seed of the stage's job
  // type. Backend dedups PER-TYPE (1 job per remix+stage; the 3 stages run
  // concurrently — disjoint JSONB columns). ⚡2026-06-13 `params` WIRED →
  // buildModelParams(stage, params) → body `model_params` (API per-model handle).
  startStageJob: async (p) => {
    const { remixId, stage, batchId, params, forceResweep = true } = p;
    const { phase, endpointSegment } = STAGE_JOB_CONFIG[stage];

    // Guard within THE stage only — other stages stay unblocked.
    const alreadyRunning = get().jobs.some(
      (j) =>
        j.phase === phase &&
        j.remixId === remixId &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (alreadyRunning) {
      log.debug('startStageJob', 'stage job already running — no-op', {
        remixId,
        stage,
        batchId,
      });
      return { kind: 'skipped', reason: 'busy' };
    }

    const modelParams = buildModelParams(stage, params);
    // ⚡2026-06-29 Watercolor grain — TOP-LEVEL job body field (sibling of
    // model_params), UPSCALE stage only. Default ON → always send an explicit
    // {enabled,amp,blur}; the backend clamps amp/blur + adds a per-crop seed
    // offset. Grain is MODEL-AGNOSTIC (unlike noise) — no model gate here.
    const grain =
      stage === 'upscales'
        ? {
            enabled: params.grainEnabled,
            amp: params.grainAmp,
            blur: params.grainBlur,
          }
        : undefined;
    log.info('startStageJob', 'enqueue', {
      remixId,
      stage,
      batchId,
      forceResweep,
      model: modelParams.model,
      grainEnabled: grain?.enabled,
    });
    // Throws EnqueueJobError on non-2xx (e.g. 422 MISSING_VARIANT_REFERENCE on
    // mix-swap) — caller (modal) toasts on `code`.
    const data = await enqueueRemixStageJob(remixId, endpointSegment, {
      batch_id: batchId,
      force_resweep: forceResweep,
      model_params: modelParams,
      grain,
    });

    if ('skipped' in data && data.skipped) {
      log.info('startStageJob', 'skipped', { remixId, stage, reason: data.reason });
      return { kind: 'skipped', reason: data.reason };
    }

    if ('deduped' in data && data.deduped) {
      log.info('startStageJob', 'deduped', {
        remixId,
        stage,
        jobId: data.job_id,
        status: data.status,
      });
      // Reconcile jobs[] from the shared store if the active row isn't
      // mirrored locally yet (realtime fills it otherwise).
      if (!get().jobs.find((j) => j.id === data.job_id)) {
        const shared = useBackgroundJobsStore.getState().jobsById[data.job_id];
        if (shared) get().onRemixJobEvent({ job: shared, prev: null, transition: 'appeared' });
      }
      return {
        kind: 'deduped',
        jobId: data.job_id,
        status: data.status,
      };
    }

    log.info('startStageJob', 'enqueued', {
      remixId,
      stage,
      batchId,
      jobId: data.job_id,
      totalSteps: data.total_steps,
    });

    // Optimistic seed into the unified store — consumer callback upserts jobs[].
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
      // `model_params` intentionally omitted — backend owns `background_jobs.params`;
      // realtime UPDATE reconciles the persisted row (FE seed is optimistic only).
      params: { remix_id: remixId, batch_id: batchId },
      result: null,
      cancelRequested: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return {
      kind: 'enqueued',
      jobId: data.job_id,
      totalSteps: data.total_steps,
    };
  },

  // ── Sprite (Variants) crop-sheet swap enqueue (api/jobs/02) ────────
  // Mirrors startMixSwap: POST enqueue + optimistic seed `remix_sprite_swap`
  // row. INDEPENDENT of mix-swap (disjoint dedup key = sprite_id); an
  // already-running swap for the SAME sprite no-ops. ⚡2026-06-13 body carries
  // `sprite_id` + `force_resweep` + `model_params` (swap model + temperature).
  startSpriteSwap: async (args) => {
    const { remixId, spriteId, params, forceResweep = true } = args;

    const alreadyRunning = get().jobs.some(
      (j) =>
        j.phase === 'remix_sprite_swap' &&
        j.remixId === remixId &&
        j.spriteId === spriteId &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (alreadyRunning) {
      log.debug('startSpriteSwap', 'swap already running — no-op', {
        remixId,
        spriteId,
      });
      return { kind: 'skipped', reason: 'busy' };
    }

    const modelParams = buildModelParams('sprites', params);
    log.info('startSpriteSwap', 'enqueue', {
      remixId,
      spriteId,
      forceResweep,
      model: modelParams.model,
    });
    // Throws EnqueueJobError on non-2xx (incl. 422 NO_SWAP_OBJECTS /
    // MISSING_OBJECT_CONFIG, 404 SPRITE_NOT_FOUND) — caller (modal) toasts on `code`.
    const data = await enqueueRemixSpriteSwap(remixId, {
      sprite_id: spriteId,
      force_resweep: forceResweep,
      model_params: modelParams,
    });

    if ('skipped' in data && data.skipped) {
      log.info('startSpriteSwap', 'skipped', { remixId, reason: data.reason });
      return { kind: 'skipped', reason: data.reason };
    }

    if ('deduped' in data && data.deduped) {
      log.info('startSpriteSwap', 'deduped', {
        remixId,
        jobId: data.job_id,
        status: data.status,
      });
      if (!get().jobs.find((j) => j.id === data.job_id)) {
        const shared = useBackgroundJobsStore.getState().jobsById[data.job_id];
        if (shared) get().onRemixJobEvent({ job: shared, prev: null, transition: 'appeared' });
      }
      return { kind: 'deduped', jobId: data.job_id, status: data.status };
    }

    log.info('startSpriteSwap', 'enqueued', {
      remixId,
      spriteId,
      jobId: data.job_id,
      totalSteps: data.total_steps,
    });

    // Optimistic seed into the unified store — consumer callback upserts jobs[].
    const nowIso = new Date().toISOString();
    useBackgroundJobsStore.getState().seed({
      id: data.job_id,
      type: 'remix_sprite_swap',
      bookId: null,
      userId: useAuthStore.getState().user?.id ?? '',
      status: 'queued',
      currentStep: 0,
      totalSteps: data.total_steps,
      stepDetails: null,
      // `model_params` intentionally omitted — backend owns `background_jobs.params`;
      // realtime UPDATE reconciles the persisted row (FE seed is optimistic only).
      params: { remix_id: remixId, sprite_id: spriteId },
      result: null,
      cancelRequested: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return {
      kind: 'enqueued',
      jobId: data.job_id,
      totalSteps: data.total_steps,
    };
  },

  // ── Generic swap-defect detection enqueue (api/jobs/11 sprite + 12 mix) ──────
  // ⚡2026-06-27 — ONE generic action, parameterized by `plane` (sprite/mix);
  // endpoint + scope-key + job-type resolved from `DETECT_JOB_CONFIG`. Mirrors
  // startSpriteSwap: POST enqueue + optimistic seed. INDEPENDENT of swap AND of
  // the other plane (disjoint dedup keys → sprite-check + mix-check run in
  // parallel); an already-running detect for the SAME scope no-ops. Advisory/
  // ephemeral — defects land in `background_jobs.result.defectsBySheet` (NOT
  // `remixes`). SECURITY: never log defect message/media/human — counts + ids.
  startDetectJob: async (args) => {
    const { plane, remixId, scopeId, params } = args;
    const cfg = DETECT_JOB_CONFIG[plane];

    // Guard within THIS plane only (sprite-check + mix-check are independent).
    const alreadyRunning = get().jobs.some(
      (j) =>
        j.phase === cfg.phase &&
        j.remixId === remixId &&
        (plane === 'sprite' ? j.spriteId === scopeId : j.batchId === scopeId) &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (alreadyRunning) {
      log.debug('startDetectJob', 'detect already running — no-op', {
        plane,
        remixId,
        scopeId,
      });
      return { kind: 'skipped', reason: 'busy' };
    }

    log.info('startDetectJob', 'enqueue', {
      plane,
      remixId,
      scopeId,
      model: params.swapModel,
    });

    let data: EnqueueDetectData;
    try {
      data = await enqueueDetectDefects(plane, remixId, {
        scopeId,
        force_resweep: true,
        swap_model: params.swapModel,
        swap_temperature: params.swapTemperature,
      });
    } catch (err) {
      // ⚡DEDUP DIVERGENCE (handle BOTH contracts): mix (job 12) returns HTTP
      // 409 JOB_ALREADY_ACTIVE when a detect is already active, whereas sprite
      // (job 11) returns HTTP 200 `{ deduped: true }`. Treat the 409 as "already
      // running" (attach to the active job via realtime), NOT a hard error. The
      // active job_id rides in error.details (not surfaced by the client); the
      // realtime active-status top-up mirrors it into jobs[] → overlay/progress.
      // Any OTHER failure propagates (the modal toasts it non-fatal).
      if (
        err instanceof EnqueueJobError &&
        (err.httpStatus === 409 || err.code === 'JOB_ALREADY_ACTIVE')
      ) {
        log.info('startDetectJob', 'deduped (409 active job)', {
          plane,
          remixId,
          scopeId,
        });
        return { kind: 'deduped', jobId: '', status: 'running' };
      }
      throw err;
    }

    if ('skipped' in data && data.skipped) {
      log.info('startDetectJob', 'skipped', { plane, remixId, reason: data.reason });
      return { kind: 'skipped', reason: data.reason };
    }

    if ('deduped' in data && data.deduped) {
      log.info('startDetectJob', 'deduped (200 envelope)', {
        plane,
        remixId,
        jobId: data.job_id,
        status: data.status,
      });
      if (!get().jobs.find((j) => j.id === data.job_id)) {
        const shared = useBackgroundJobsStore.getState().jobsById[data.job_id];
        if (shared) get().onRemixJobEvent({ job: shared, prev: null, transition: 'appeared' });
      }
      return { kind: 'deduped', jobId: data.job_id, status: data.status };
    }

    log.info('startDetectJob', 'enqueued', {
      plane,
      remixId,
      scopeId,
      jobId: data.job_id,
      totalSteps: data.total_steps,
    });

    // Optimistic seed into the unified store — consumer callback upserts jobs[].
    // For detect, the job-type string == the phase (see DETECT_JOB_CONFIG).
    const nowIso = new Date().toISOString();
    useBackgroundJobsStore.getState().seed({
      id: data.job_id,
      type: cfg.phase,
      bookId: null,
      userId: useAuthStore.getState().user?.id ?? '',
      status: 'queued',
      currentStep: 0,
      totalSteps: data.total_steps,
      stepDetails: null,
      params: { remix_id: remixId, [cfg.scopeKey]: scopeId },
      result: null,
      cancelRequested: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return {
      kind: 'enqueued',
      jobId: data.job_id,
      totalSteps: data.total_steps,
    };
  },

  cancelJob: async (jobId) => {
    // Delegate to the generic shared action. The shared store applies the
    // optimistic cancelRequested flag + rollback and fans an 'updated' event
    // back to `onRemixJobEvent`, so the `jobs[]` projection reflects it.
    log.info('cancelJob', 'delegate to background-jobs store', { jobId });
    await useBackgroundJobsStore.getState().cancelJob(jobId);
  },

  dismissJob: (jobId) => {
    log.debug('dismissJob', 'remove from store', { jobId });
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) }));
  },
});
