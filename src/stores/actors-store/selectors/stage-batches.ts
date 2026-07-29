// actors-store/selectors/stage-batches.ts — Stage-column read selectors that
// project an `actors` row's pipeline columns (`mixes`/`rmbgs`/`upscales`, raw
// `RemixStageBatchRow[]`) into the SAME `RemixStageBatch[]` shape the shared
// swap-crop-sheet tab layer consumes (id/order/name/crop_sheets + a derived
// `swapTask`). Deliberately mirrors the remix selectors (`useRemixStageBatches`,
// `useAnyStageJobRunning`, `useStageFinals`) so the reused presentational tabs
// render unchanged (design 04 §7.2).
//
// RE-RENDER SAFETY: every projection is `useMemo`-stabilized on the RAW stage
// column ref (fresh arrays live INSIDE the memo only — never a freshly `.map()`ed
// array fed to `useShallow`; memory feedback_zustand_useshallow_nested_arrays).

import { useMemo } from 'react';
import type {
  BatchSwapTaskStatus,
  RemixStageBatch,
  Remix,
} from '@/types/remix';
import { ACTOR_STAGE_JOB_PHASE, type ActorStageKind } from '@/types/actors';
import { collectStageFinals } from '../../remix-store/stage-finals';
import type { ImportFinalEntry } from '../../remix-store/stage-finals';
import { useActorsStore } from '../index';
import type { ActorJob } from '../types';

/**
 * Derive one actor stage-batch's job task from the lean `ActorJob[]` projection
 * (jobs 14/15/16). Mirror of remix `deriveBatchSwapTask` but over `ActorJob`
 * (no `result`/`createdAt` — swap outputs land server-side + the pair refetches,
 * so a terminal job carries no client-side error payload). Latest match wins by
 * array order (the ephemeral `jobs[]` upserts in arrival order).
 */
export function deriveActorBatchSwapTask(
  jobs: ActorJob[],
  pairId: string,
  batchId: string,
  stage: ActorStageKind,
): BatchSwapTaskStatus {
  const phase = ACTOR_STAGE_JOB_PHASE[stage];
  // Last match = most-recently-upserted job for this (pair, batch, phase).
  let job: ActorJob | null = null;
  for (const j of jobs) {
    if (j.phase === phase && j.pairId === pairId && j.batchId === batchId) job = j;
  }
  if (!job) return { state: 'idle' };

  if (job.status === 'queued' || job.status === 'running') {
    return {
      state: 'running',
      current: job.progress?.done ?? 0,
      total: job.progress?.total ?? 0,
    };
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    return { state: 'error', message: 'Swap failed', failedSheets: 0 };
  }
  // completed — the pair refetch already merged `swap_results[]`.
  return { state: 'idle' };
}

/** Every actor stage job of ONE pair (any stage) — ephemeral `jobs[]` filtered.
 *  Memoized on the raw `jobs` ref (fresh array inside the memo only). */
export const useActorJobsForPair = (
  pairId: string | null | undefined,
): ActorJob[] => {
  const jobs = useActorsStore((s) => s.jobs);
  return useMemo(
    () => (pairId ? jobs.filter((j) => j.pairId === pairId) : []),
    [jobs, pairId],
  );
};

/**
 * Project `pair[stage]` → `RemixStageBatch[]` (id/order/name/crop_sheets +
 * derived swapTask), sorted by `order`. Mirror of `useRemixStageBatches`.
 *
 * useMemo deps = `[rows, jobs, pairId, stage]` (raw stage column ref + the
 * pair's ephemeral jobs). The projection arrays are fresh each call → shallow
 * compare would loop.
 */
export const useActorStageBatches = (
  pairId: string | null | undefined,
  stage: ActorStageKind,
): RemixStageBatch[] => {
  const rows = useActorsStore((s) =>
    pairId ? s.actorPairs.find((p) => p.id === pairId)?.[stage] : undefined,
  );
  const jobs = useActorJobsForPair(pairId);

  return useMemo<RemixStageBatch[]>(() => {
    if (!rows || !pairId) return [];
    return rows
      .map((m) => ({
        id: m.id,
        order: m.order,
        name: m.name,
        crop_sheets: m.crop_sheets,
        swapTask: deriveActorBatchSwapTask(jobs, pairId, m.id, stage),
      }))
      .sort((a, b) => a.order - b.order);
  }, [rows, jobs, pairId, stage]);
};

/** True when ANY actor stage job of THIS pair + stage is queued/running.
 *  Guards only WITHIN the stage — the 3 stages run concurrently (disjoint
 *  columns). Boolean primitive — ref-stable by value. */
export const useAnyActorStageJobRunning = (
  pairId: string | null | undefined,
  stage: ActorStageKind,
): boolean =>
  useActorsStore((s) => {
    if (!pairId) return false;
    const phase = ACTOR_STAGE_JOB_PHASE[stage];
    return s.jobs.some(
      (j) =>
        j.phase === phase &&
        j.pairId === pairId &&
        (j.status === 'queued' || j.status === 'running'),
    );
  });

/** Finals of ONE actor stage column (`collectStageFinals`) — the Import source
 *  list (rmbgs ← mixes, upscales ← rmbgs) + Import gating. Memoized on the raw
 *  stage-column ref (fresh arrays inside the memo only). */
export const useActorStageFinals = (
  pairId: string | null | undefined,
  stage: ActorStageKind,
): ImportFinalEntry[] => {
  const rows = useActorsStore((s) =>
    pairId ? s.actorPairs.find((p) => p.id === pairId)?.[stage] : undefined,
  );
  return useMemo<ImportFinalEntry[]>(() => {
    if (!rows || rows.length === 0) return [];
    // collectStageFinals only reads `remix[stage]`; minimal shape keyed on the
    // stable raw column ref (parity remix `useStageFinals`).
    return collectStageFinals({ [stage]: rows } as unknown as Remix, stage);
  }, [rows, stage]);
};
