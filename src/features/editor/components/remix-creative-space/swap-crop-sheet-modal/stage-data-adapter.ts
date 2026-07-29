// stage-data-adapter.ts — The seam between the swap-crop-sheet stage tabs (the
// shared `useStageBatchTab` hook + the rmbg/upscale/import consumers) and the
// data/actions that back ONE owner (a remix row today; an actors casting pair
// in phase 08). The tabs read everything through this adapter instead of
// importing the remix store directly, so the SAME presentational + hook layer
// can be mounted by `SwapCropSheetModal` (remix) or `SwapCastingSlotModal`
// (actors) — each supplies its own adapter via `StageDataAdapterProvider`.
//
// ⚠️ MIGRATION NOTE: the contract intentionally uses the concrete remix types
// (`Remix` / `RemixJob` / `ImportFinalEntry`) rather than a fully-abstract shape
// — `useCropOwnership` still takes a `Remix` (its signature is pinned by an
// existing test) and the tabs read the full `RemixJob` fields. Phase 08 can
// generalize these once the actors adapter is real. Keeping them concrete now
// guarantees the zero-behavior-change refactor for remix.

import { createContext, useContext } from 'react';
import type { Remix, RemixJob, StageKind } from '@/types/remix';
import type { ImportFinalEntry } from '@/stores/remix-store/stage-finals';
import { useRemixStageAdapter } from '../hooks/use-remix-stage-adapter';

/** Data + actions the stage tabs need for ONE owner at whatever stage is open.
 *  Remix builds this from its store (`useRemixStageAdapter`); actors will build
 *  an equivalent from the actors store (phase 08). */
export interface StageDataAdapter {
  /** id of the owner — a `remixId` today, a casting `pairId` in phase 08. Used
   *  for logging / keys only; consumers never infer type from it. */
  ownerId: string;
  /** Raw owner row — feeds `useCropOwnership(remix, stage, …)` (per-stage
   *  `is_final` ownership). Null while unresolved / after a realtime delete. */
  remix: Remix | null;
  /** All running/terminal jobs of this owner (every stage). Tabs filter by the
   *  stage's phase (rmbg detect view / upscale crop-heartbeat). */
  jobs: RemixJob[];
  /** Finals of ONE stage column — the Import source list (rmbgs ← mixes,
   *  upscales ← rmbgs) + Import gating. Resolver keyed by stage so one adapter
   *  serves both stage tabs and the Import dialog. */
  stageFinals: (stage: StageKind) => ImportFinalEntry[];

  /** rev6 subset Add Batch — clone `sourceBatchId` restricted to `cropSubset`
   *  (tick keys). Resolves the new batch id, or null on guard miss. */
  addStageBatch: (
    stage: StageKind,
    sourceBatchId: string,
    cropSubset: ReadonlySet<string>,
  ) => Promise<string | null>;
  /** rev7 user take-back — set `is_final` on the crop matching
   *  `(spreadId, layerId)` inside `fromBatchId`, clearing every sibling. */
  takeFinalBack: (
    stage: StageKind,
    spreadId: string,
    layerId: string,
    fromBatchId: string,
  ) => Promise<boolean>;
}

const StageDataAdapterContext = createContext<StageDataAdapter | null>(null);

/** Mount at the modal root, fed the owner's adapter (remix: `useRemixStageAdapter`). */
export const StageDataAdapterProvider = StageDataAdapterContext.Provider;

/**
 * Read the stage adapter for the enclosing modal.
 *
 * Normally the value comes from the `StageDataAdapterProvider` mounted at the
 * modal root. When a stage tab is rendered OUTSIDE a provider (the isolated
 * component unit tests render `<BatchesTab>` directly and mock the remix
 * store), we fall back to a remix-store-derived adapter so behavior is
 * identical — the fallback hook is invoked unconditionally for stable hook
 * order and its result is used ONLY when no provider is present. Phase 08 drops
 * the fallback once every mount wraps a provider.
 */
export function useStageDataAdapter(): StageDataAdapter {
  const ctx = useContext(StageDataAdapterContext);
  // Empty owner id → the remix selectors short-circuit to null/[] (no
  // subscription cost); in provider contexts this fallback is never read.
  const fallback = useRemixStageAdapter('');
  return ctx ?? fallback;
}
