// use-stage-lock-session.ts — owns the per-stage SAVE SESSION for the Sketch Stages creative space
// (9th collab space). ONE grain, the WHOLE stage node at step 1 / rtype 5 (resolver
// `(1,5) → sketch.stages[key]`; ownedKeys undefined ⇒ whole node). base.styles[] and every variant
// live INSIDE the node, so one session covers the entire stage.
//
// LOCKLESS (ADR-044 addendum 2): entity domains no longer acquire a lock. The session binds DIRECTLY
// to the SELECTED stage and the engine begins it synchronously as 'held' — no acquire, no peer-lock
// veil, last-write-wins. The former lock-on-interact model (`adopt`/`releaseUnlessSame`/`isAdopted`)
// is gone: selecting a stage IS the session target; switching stage re-targets it (the OLD node
// release-saves on the switch).
//
// BATCH-AT-RELEASE (ADR-043): cheap gestures mutate the store under the held session and land at the
// release-save (switch stage / unmount / the header's "Unsaved" → `commitStage` → saveNow).
//   ⚡ EXCEPTION — `flushStageNow` (crop-pick net, see doc below); the generate / re-cut chains
//   persist their own AI output inside the stage job slice (not routed through here).
//
// TEARDOWN ORDER (memory *held-session teardown-order*): the SPACE must declare
// useCollabPersistSession / useContentSyncSession BEFORE this hook.
//
// SOLO (no book loaded): every path no-ops; the global use-auto-save owns persistence.

import { useCallback, useMemo } from 'react';
import { type LockTarget } from '@/stores/resource-lock-store';
import {
  resolveSketchStageLockTarget,
  flushSketchStageUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-stage-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useStageLockSession');

export interface UseStageLockSessionResult {
  /** Persist the FRESH stage node NOW, independent of the held-session baseline (crop-pick net). */
  flushStageNow: (stageKey: string) => void;
}

export function useStageLockSession(selectedStageKey: string | null): UseStageLockSessionResult {
  // Session target binds to the SELECTED stage (lockless ⇒ begins 'held' synchronously).
  const target = useMemo<LockTarget | null>(
    () => (selectedStageKey ? resolveSketchStageLockTarget(selectedStageKey) : null),
    [selectedStageKey],
  );

  // getNode (WHOLE stage node) + buildPayload live in the `sketch-stage` policy (save-policies).
  // onBlocked/onLost dropped: a lockless session can't be blocked or lost.
  const { saveNow } = useSaveSession(deriveSaveTarget(target));

  // Header "Unsaved" → commit now: saveNow persists the stage node + rebases the baseline
  // (Saving…→Saved) while staying on the same selection. Mirrors the sibling spaces.
  const commitStage = useCallback(() => {
    log.info('commitStage', 'commit stage session (saveNow)');
    void saveNow();
  }, [saveNow]);
  useRegisterEditCommit(commitStage);

  /**
   * ⚡ crop-pick net (`handleSelectCrop`). Picking a crop is a high-value gesture worth persisting
   * eagerly rather than waiting for the release-save. Routes through the engine's `ensureSaved` (via
   * `flushSketchStageUnderLock`) — a `saveNow` while held; the idle auto-save (60s) is the net
   * otherwise (spec §4.3). Caller toasts the outcome.
   */
  const flushStageNow = useCallback((stageKey: string) => {
    log.debug('flushStageNow', 'engine ensureSaved (crop-pick net)', { stageKey });
    void flushSketchStageUnderLock(stageKey).then((outcome) =>
      toastSketchSaveOutcome(outcome, resolveSketchStageLockTarget(stageKey)),
    );
  }, []);

  // Memoized handle (referential stability for consumers' useCallback deps).
  return useMemo(() => ({ flushStageNow }), [flushStageNow]);
}
