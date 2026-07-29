// use-remix-stage-adapter.ts — Builds the `StageDataAdapter` from the RemixStore
// for the swap-crop-sheet modal. This is the remix implementation of the seam
// (phase 08 adds an actors-store sibling). Mounted by `SwapCropSheetModal` via
// `StageDataAdapterProvider`; also used as the no-provider fallback inside
// `useStageDataAdapter` (isolated tab unit tests).
//
// RE-RENDER SAFETY: the adapter object is `useMemo`-stabilized on the RAW store
// refs (`remix`, `jobs`, per-stage finals) — never on freshly-mapped arrays and
// with no inline arrows inside a `useShallow` selector — both of which loop in
// this codebase (memory feedback_zustand_useshallow_*). The store actions
// (`addStageBatch` / `takeFinalBack`) are stable refs.

import { useMemo } from 'react';
import { createLogger } from '@/utils/logger';
import {
  useRemixById,
  useRemixActions,
  useStageFinals,
  useJobsForRemix,
} from '@/stores/remix-store';
import type { ImportFinalEntry } from '@/stores/remix-store/stage-finals';
import type { StageKind } from '@/types/remix';
import type { StageDataAdapter } from '../swap-crop-sheet-modal/stage-data-adapter';

const log = createLogger('Editor', 'useRemixStageAdapter');

/** Assemble the remix-backed stage adapter for `remixId`. Pass '' for the
 *  no-provider fallback (selectors short-circuit to null/[]). */
export function useRemixStageAdapter(remixId: string): StageDataAdapter {
  const remix = useRemixById(remixId);
  const jobs = useJobsForRemix(remixId);
  const { addStageBatch, takeFinalBack } = useRemixActions();
  // Fixed-order per-stage finals (all three columns) so the resolver can serve
  // both stage tabs (import gating) and the Import dialog list. Each is
  // memoized on its raw column ref inside `useStageFinals`.
  const mixFinals = useStageFinals(remixId, 'mixes');
  const rmbgFinals = useStageFinals(remixId, 'rmbgs');
  const upscaleFinals = useStageFinals(remixId, 'upscales');

  return useMemo<StageDataAdapter>(() => {
    const finalsByStage: Record<StageKind, ImportFinalEntry[]> = {
      mixes: mixFinals,
      rmbgs: rmbgFinals,
      upscales: upscaleFinals,
    };
    log.debug('build', 'assemble remix stage adapter', {
      remixId,
      hasRemix: remix !== null,
      jobCount: jobs.length,
    });
    return {
      ownerId: remixId,
      remix,
      jobs,
      stageFinals: (stage: StageKind) => finalsByStage[stage],
      addStageBatch: (stage, sourceBatchId, cropSubset) =>
        addStageBatch(remixId, stage, sourceBatchId, cropSubset),
      takeFinalBack: (stage, spreadId, layerId, fromBatchId) =>
        takeFinalBack(remixId, stage, spreadId, layerId, fromBatchId),
    };
  }, [
    remixId,
    remix,
    jobs,
    mixFinals,
    rmbgFinals,
    upscaleFinals,
    addStageBatch,
    takeFinalBack,
  ]);
}
