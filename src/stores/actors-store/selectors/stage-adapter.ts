// actors-store/selectors/stage-adapter.ts — Builds the shared `StageDataAdapter`
// (the phase-04 seam) from the ActorsStore for the swap-casting-slot modal. This
// is the actors sibling of `useRemixStageAdapter`: it projects ONE `actors` pair
// + its stage-batch actions into the SAME shape the reused `useStageBatchTab`
// hook + Import dialog consume, so the swap-crop-sheet tab layer renders unchanged
// (design 04 §7.2).
//
// The adapter's `remix` field is a MINIMAL `Remix`-shaped view of the pair — only
// the 3 stage columns are read (`useCropOwnership` + `collectStageFinals` touch
// nothing else). The rev6 subset Add-Batch is translated here: the shared hook
// hands us `(stage, sourceBatchId, tickKeys)`; we resolve the ticked crops off the
// source batch and delegate to the store's native-px batch builder.
//
// RE-RENDER SAFETY: the adapter object is `useMemo`-stabilized on the RAW pair ref
// + stable store-action refs — never a freshly-mapped array inside `useShallow`
// (memory feedback_zustand_useshallow_*).

import { useMemo } from 'react';
import { createLogger } from '@/utils/logger';
import type { Remix, RemixJob, StageKind } from '@/types/remix';
import type { ActorStageKind } from '@/types/actors';
import type { StageDataAdapter } from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal/stage-data-adapter';
import { ACTOR_STAGE_JOB_PHASE } from '@/types/actors';
import { currentCropsOfBatch } from '../../remix-store/crop-sheet-layout';
import type { ImportFinalEntry } from '../../remix-store/stage-finals';
import { useActorPairById, useActorsActions } from '../selectors';
import { useActorStageFinals, useActorJobsForPair } from './stage-batches';
import type { ActorJob, CropRef } from '../types';

const log = createLogger('Store', 'useActorStageAdapter');

/** actor stage phase → remix job phase (adapter.jobs is typed `RemixJob[]`). */
const ACTOR_TO_REMIX_PHASE = {
  actor_swap: 'remix_mix_swap',
  actor_rmbg: 'remix_rmbg',
  actor_upscale: 'remix_upscale',
} as const;

/** Lean `ActorJob` → `RemixJob` projection so the adapter satisfies the shared
 *  contract. The reused actor tab does not read `adapter.jobs` (no crop-heartbeat
 *  / detect view), so the lossy fields default; kept honest for the type + any
 *  future consumer. */
function projectActorJob(job: ActorJob): RemixJob {
  return {
    id: job.id,
    remixId: job.pairId,
    phase: ACTOR_TO_REMIX_PHASE[job.phase],
    triggeredBy: 'user',
    status: job.status,
    batchId: job.batchId,
    currentStep: job.progress?.done ?? 0,
    totalSteps: job.progress?.total ?? 0,
    cancelRequested: false,
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * Assemble the actors-backed stage adapter for `pairId`. The `stage` argument is
 * the modal's active stage (used for logging only — the adapter is stage-agnostic
 * like the remix one, serving all 3 columns via `stageFinals`).
 */
export function useActorStageAdapter(
  pairId: string | null | undefined,
  stage: ActorStageKind,
): StageDataAdapter {
  const pair = useActorPairById(pairId);
  const { addStageBatch, takeFinalBack } = useActorsActions();
  const jobs = useActorJobsForPair(pairId);
  // Fixed-order per-stage finals (all three columns) — one adapter serves both
  // stage tabs (import gating) and the Import dialog list.
  const mixFinals = useActorStageFinals(pairId, 'mixes');
  const rmbgFinals = useActorStageFinals(pairId, 'rmbgs');
  const upscaleFinals = useActorStageFinals(pairId, 'upscales');

  return useMemo<StageDataAdapter>(() => {
    const finalsByStage: Record<StageKind, ImportFinalEntry[]> = {
      mixes: mixFinals,
      rmbgs: rmbgFinals,
      upscales: upscaleFinals,
    };
    // Minimal Remix-shaped view — only the 3 stage columns are read downstream.
    const remixView: Remix | null = pair
      ? ({
          id: pair.id,
          mixes: pair.mixes,
          rmbgs: pair.rmbgs,
          upscales: pair.upscales,
        } as unknown as Remix)
      : null;

    log.debug('build', 'assemble actor stage adapter', {
      pairId,
      stage,
      hasPair: pair !== null,
      jobCount: jobs.length,
    });

    return {
      ownerId: pairId ?? '',
      remix: remixView,
      jobs: jobs.map(projectActorJob),
      stageFinals: (s: StageKind) => finalsByStage[s],
      addStageBatch: async (s, sourceBatchId, cropSubset) => {
        if (!pairId || !pair) {
          log.warn('addStageBatch', 'no pair — abort', { pairId, stage: s });
          return null;
        }
        // rev6 subset: resolve the ticked crops off the source batch's
        // pre-job crops, then delegate to the store's native-px builder.
        const rows = pair[s as ActorStageKind] ?? [];
        const activeBatch = rows.find((m) => m.id === sourceBatchId) ?? rows[0];
        if (!activeBatch) {
          log.warn('addStageBatch', 'no source batch — abort', {
            pairId,
            stage: s,
            sourceBatchId,
          });
          return null;
        }
        const refs: CropRef[] = currentCropsOfBatch(activeBatch)
          .filter((c) => cropSubset.has(`${c.spread_id}/${c.id}`))
          .map((c) => ({
            spread_id: c.spread_id,
            id: c.id,
            media_url: c.media_url,
            tags: c.tags,
            nativeDim: { w: c.geometry.w, h: c.geometry.h },
          }));
        if (refs.length === 0) {
          log.warn('addStageBatch', 'selection resolved to zero crops', {
            pairId,
            stage: s,
          });
          return null;
        }
        return addStageBatch(pairId, s as ActorStageKind, refs);
      },
      takeFinalBack: async (s, spreadId, layerId, fromBatchId) => {
        if (!pairId) return false;
        try {
          await takeFinalBack(pairId, s as ActorStageKind, spreadId, layerId, fromBatchId);
          return true;
        } catch (err) {
          log.warn('takeFinalBack', 'store take-back rejected', {
            pairId,
            stage: s,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      },
    };
  }, [
    pairId,
    stage,
    pair,
    jobs,
    mixFinals,
    rmbgFinals,
    upscaleFinals,
    addStageBatch,
    takeFinalBack,
  ]);
}

// Re-export the actor stage phase map for symmetry (used by the modal wiring).
export { ACTOR_STAGE_JOB_PHASE };
