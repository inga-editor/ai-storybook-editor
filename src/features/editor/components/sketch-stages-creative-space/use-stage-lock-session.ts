// use-stage-lock-session.ts — owns EVERYTHING about holding + persisting a stage in the Sketch
// Stages creative space (9th collab space). Mirror of use-variant-entity-lock-session.ts with the
// kind dimension removed: ONE grain, the WHOLE stage node at step 1 / rtype 5 (resolver
// `(1,5) → sketch.stages[key]` pre-exists; ownedKeys undefined ⇒ whole node). base.styles[] and
// every variant live INSIDE the node, so one lock covers the entire stage — and the derived
// variants[base] clone is the SAME node (no second lock, no contention).
//
// LOCK-ON-INTERACT (browse ≠ lock): `lockedStageKey` starts null and is set ONLY by `adopt()`
// from a genuine interaction (＋ add style / 🔒 lock style / ✏ edit text / ✨ generate / [✎] edit /
// crop pick / [⧉] extract) — never by browsing, so the lock never auto-acquires on mount.
//
// BATCH-AT-RELEASE (ADR-043 Rev): cheap gestures mutate the store under the hold; the held-session
// release-cleanup diffs the whole node vs the acquire-time baseline and saves ONCE (switch stage /
// unmount / the header's "Unsaved" → `commitStage`). `manageHeaderStatus` default true ⇒ hold =
// "Unsaved" → release settles "Saving…" → "Saved" (never "Auto-saved").
//   ⚡ EXCEPTIONS — `flushStageNow` (H2 select-crop race, see doc below); the generate / re-cut
//   chains persist their own AI output inside the stage job slice (not routed through here).
//
// TEARDOWN ORDER (memory *held-session teardown-order*): the SPACE must declare
// useCollabPersistSession / useContentSyncSession BEFORE this hook — React runs effect destroys in
// declaration order on unmount, and the shared engine's cleanup already binds a local `acquired`
// flag + captured bookId, but the persist-session must still be torn down first so the release-save
// runs against a live session.
//
// SOLO (`collabPersist=false` = no book loaded): every path no-ops; the global use-auto-save owns
// persistence (mirror the sibling spaces).

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { type LockTarget, type SavePayload, type SessionStatus } from '@/stores/resource-lock-store';
import {
  resolveSketchStageLockTarget,
  buildSketchStagePayload,
  flushSketchStageUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-stage-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { useHeldResourceSession } from '@/features/editor/hooks/use-held-resource-session';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useStageLockSession');

export interface UseStageLockSessionResult {
  /** Lock-on-interact: adopt this stage (idempotent — re-adopting the held one is a no-op). */
  adopt: (stageKey: string) => void;
  /** Browse: keep the hold only when it is the SAME stage, else drop it → the session
   *  release-saves the OLD node. Mount / re-select is a no-op (nothing held yet). */
  releaseUnlessSame: (stageKey: string) => void;
  /** True when this stage is the one currently adopted. */
  isAdopted: (stageKey: string | null) => boolean;
  /** Persist the FRESH stage node NOW, independent of the held-session baseline (H2). */
  flushStageNow: (stageKey: string) => void;
  /** Explicit save WHILE STILL HOLDING — the job slice's saveNow seam is NOT this (it uses
   *  flushSketchStageUnderLock off-render); exposed for parity/debug surfaces. */
  saveNow: () => Promise<boolean>;
  /** Held-session status for the CURRENT target ('idle' when nothing adopted). */
  status: SessionStatus;
  /** The stage currently adopted (null = browsing only). Drives `editable`. */
  lockedStageKey: string | null;
}

export function useStageLockSession(): UseStageLockSessionResult {
  const [lockedStageKey, setLockedStageKey] = useState<string | null>(null);

  // Lock target — null until a genuine interaction adopts a stage (browse ≠ lock).
  const target = useMemo<LockTarget | null>(
    () => (lockedStageKey ? resolveSketchStageLockTarget(lockedStageKey) : null),
    [lockedStageKey],
  );

  // Live (non-reactive) read of the WHOLE locked stage node — baseline + dirty-diff source. Reads
  // getState() through the closure so a switch's release-cleanup still sees the OLD stage (effect
  // destroys run before creates; the engine's cbRef latched the previous render's getNode).
  const getNode = useCallback(
    () =>
      lockedStageKey
        ? useSnapshotStore.getState().sketch.stages.find((s) => s.key === lockedStageKey) ?? null
        : null,
    [lockedStageKey],
  );
  const buildPayload = useCallback((node: unknown): SavePayload => buildSketchStagePayload(node), []);

  // 409 on acquire → another editor holds this stage. Toast + drop the interaction (idle).
  const handleLockBlocked = useCallback((holder: string) => {
    log.info('handleLockBlocked', 'stage held by another editor', { hasHolder: !!holder });
    toast.info('Another editor is editing this stage — your change was not saved.');
    setLockedStageKey(null);
  }, []);

  // Heartbeat 409 → lock stolen mid-edit. Drop + toast; content-sync reconciles the winner's node.
  const handleLockLost = useCallback(() => {
    log.warn('handleLockLost', 'stage lock lost — drop hold');
    setLockedStageKey(null);
    toast.warning('You lost the edit lock for this stage — a later change may not have saved.');
  }, []);

  const { status, saveNow } = useHeldResourceSession({
    target,
    getNode,
    ownedKeys: undefined, // whole stage node (base.styles[] + variants[] together)
    buildPayload,
    onBlocked: handleLockBlocked,
    onLost: handleLockLost,
  });

  // Header "Unsaved" → commit now: null the held target so the session cleanup release-saves the
  // stage (Saving…→Saved) and unlocks it. The stage stays DISPLAYED (browse ≠ lock); the next
  // genuine interaction re-acquires. Mirrors the sibling spaces' commitEntity.
  const commitStage = useCallback(() => {
    log.info('commitStage', 'commit held stage session (save + unlock)');
    setLockedStageKey(null);
  }, []);
  useRegisterEditCommit(commitStage);

  const adopt = useCallback((stageKey: string) => {
    setLockedStageKey((prev) => (prev === stageKey ? prev : stageKey));
  }, []);

  const releaseUnlessSame = useCallback((stageKey: string) => {
    setLockedStageKey((prev) => (prev === stageKey ? prev : null));
  }, []);

  const isAdopted = useCallback(
    (stageKey: string | null) => lockedStageKey !== null && lockedStageKey === stageKey,
    [lockedStageKey],
  );

  /**
   * ⚡ H2 — the ONE gesture that persists eagerly (`handleSelectCrop`). The pick mutates the store
   * SYNCHRONOUSLY in the same event that adopts the stage, so the held-session baseline (captured
   * after acquire's round-trip) can be cloned ALREADY-PICKED → the release dirty-diff false → pick
   * lost.
   *
   * ⚡ unified-item-save phase 3: routes through the engine's `ensureSaved` (via
   * `flushSketchStageUnderLock`) — a `saveNow` while held (keeps the lock), or a one-shot in the
   * narrow in-flight-acquire race (idle auto-save 60s is the net). Caller toasts the outcome.
   */
  const flushStageNow = useCallback((stageKey: string) => {
    log.debug('flushStageNow', 'engine ensureSaved (H2 net)', { stageKey });
    void flushSketchStageUnderLock(stageKey).then((outcome) =>
      toastSketchSaveOutcome(outcome, resolveSketchStageLockTarget(stageKey)),
    );
  }, []);

  // Memoized handle (referential stability for consumers' useCallback deps). Changes exactly when
  // the adopted stage / session status changes — when dependents genuinely must recompute.
  return useMemo(
    () => ({ adopt, releaseUnlessSame, isAdopted, flushStageNow, saveNow, status, lockedStageKey }),
    [adopt, releaseUnlessSame, isAdopted, flushStageNow, saveNow, status, lockedStageKey],
  );
}
