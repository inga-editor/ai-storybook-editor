// actors-store/selectors.ts — Read-side `use*` hooks. Kept out of `create()` so
// the store factory stays compose-only. `index.ts` re-exports this module
// (`export *`) — selectors must NOT be imported back into the create() body.

import { useShallow } from 'zustand/react/shallow';
import { useActorsStore } from './index';
import type { ActorPair } from './types';

export const useActorPairs = (): ActorPair[] =>
  useActorsStore((s) => s.actorPairs);

export const useSelectedPairId = (): string | null =>
  useActorsStore((s) => s.selectedPairId);

export const useActorPairById = (
  pairId: string | null | undefined,
): ActorPair | null =>
  useActorsStore((s) =>
    pairId ? s.actorPairs.find((p) => p.id === pairId) ?? null : null,
  );

export const useSelectedActorPair = (): ActorPair | null =>
  useActorsStore((s) =>
    s.selectedPairId
      ? s.actorPairs.find((p) => p.id === s.selectedPairId) ?? null
      : null,
  );

/** True while ANY actor stage job (any pair, any stage) is queued/running.
 *  Boolean primitive — ref-stable by value. */
export const useAnyActorJobRunning = (): boolean =>
  useActorsStore((s) =>
    s.jobs.some((j) => j.status === 'queued' || j.status === 'running'),
  );

/** Actions-only bundle — does NOT re-render on data change (useShallow on
 *  stable action refs; NO inline arrows). */
export const useActorsActions = () =>
  useActorsStore(
    useShallow((s) => ({
      createActorPair: s.createActorPair,
      deleteActorPair: s.deleteActorPair,
      setSelectedPairId: s.setSelectedPairId,
      addStageBatch: s.addStageBatch,
      importStageBatch: s.importStageBatch,
      removeStageBatch: s.removeStageBatch,
      appendStageBatchSheet: s.appendStageBatchSheet,
      removeStageBatchSheet: s.removeStageBatchSheet,
      takeFinalBack: s.takeFinalBack,
      startStageJob: s.startStageJob,
      cancelJob: s.cancelJob,
      dismissJob: s.dismissJob,
      injectActorFinals: s.injectActorFinals,
      syncFromServer: s.syncFromServer,
      refetchPair: s.refetchPair,
      reset: s.reset,
    })),
  );

export { useActorCoverage } from './selectors/actor-coverage';
export {
  useActorStageBatches,
  useAnyActorStageJobRunning,
  useActorStageFinals,
  useActorJobsForPair,
  deriveActorBatchSwapTask,
} from './selectors/stage-batches';
export { useActorStageAdapter } from './selectors/stage-adapter';
