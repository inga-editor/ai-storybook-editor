// use-lineup-lock-session.ts — owns holding + persisting the `sketch.lineups[]` node in the
// Sketch Lineup creative space (rtype 12 — ADR-043 §Mở rộng 2026-07-25). ONE grain: the WHOLE
// tabs array (one lock covers every tab), saved collection-scope column-root.
//
// LOCK-ON-INTERACT (browse ≠ lock): `engaged` starts false and is flipped ONLY by the first WRITE
// gesture routed through `withLock` (check/uncheck, tab create/rename/delete, cleanup) — never by
// mount / tab switching / zoom. `withLock` AWAITS acquire BEFORE mutating (spec §5.2 — 409 means
// the mutation is CANCELLED, not applied optimistically).
//
// FLUSH-AFTER-EVERY-MUTATE (plan phase-03 Insight #3): the held-session captures its baseline in
// an effect AFTER acquire's round-trip, so a release-time dirty-diff could see the first mutation
// already inside the baseline → silently skipped. The node is tiny (tab config), so every
// successful `withLock` also runs a baseline-independent `flushSketchLineupsUnderLock` — the
// held-session stays as the release-save safety net + header status driver.
//
// TEARDOWN ORDER (memory *held-session teardown-order*): the SPACE must declare
// useCollabPersistSession + useContentSyncSession BEFORE this hook.
//
// SOLO (`collabPersist=false`): `withLock` just runs the mutation — setters mark sync.isDirty and
// the global whole-doc autosave persists (never autoSaveSnapshot from the space).

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  useResourceLockStore,
  keyOf,
  type LockTarget,
  type SavePayload,
  type SessionStatus,
} from '@/stores/resource-lock-store';
import {
  LINEUP_LOCK_TARGET,
  buildSketchLineupsPayload,
  flushSketchLineupsUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-lineups-save-helper';
import { toastLockedByOther } from '@/utils/collab-save-toasts';
import { resolveLockHolderName } from '@/stores/snapshot-store/slices/collab-image-save-helper';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { useHeldResourceSession } from '@/features/editor/hooks/use-held-resource-session';
import type { SketchLineupTab } from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useLineupLockSession');

export interface UseLineupLockSessionResult {
  /**
   * Run a WRITE mutation under the lineup lock. Solo → mutate immediately. Collab → acquire
   * first (already-held = skip); 409 → toast + the mutation is DROPPED (`false`). On success the
   * fresh tabs array is flushed to the gateway immediately (baseline-independent).
   */
  withLock: (mutate: () => void) => Promise<boolean>;
  /** Held-session status ('idle' while browsing — nothing engaged). */
  status: SessionStatus;
  /** True once a write gesture engaged the session (drives "editing" affordances if needed). */
  engaged: boolean;
  /** Header "Unsaved" commit: disengage → the held-session release-saves + unlocks. */
  commit: () => void;
}

export function useLineupLockSession(): UseLineupLockSessionResult {
  const [engaged, setEngaged] = useState(false);

  // Target flips null ⇄ the module-constant singleton — never a per-render object.
  const target = useMemo<LockTarget | null>(() => (engaged ? LINEUP_LOCK_TARGET : null), [engaged]);

  // Off-render fresh read (anti stale-closure): the release-cleanup diff must see the LATEST tabs.
  const getNode = useCallback(
    (): SketchLineupTab[] => useSnapshotStore.getState().sketch.lineups ?? [],
    [],
  );
  const buildPayload = useCallback(
    (node: unknown): SavePayload =>
      buildSketchLineupsPayload(Array.isArray(node) ? (node as SketchLineupTab[]) : []),
    [],
  );

  const handleLockBlocked = useCallback((holder: string) => {
    log.info('handleLockBlocked', 'lineups held by another editor', { hasHolder: !!holder });
    toast.info('Another editor is editing the Lineup — your change was not saved.');
    setEngaged(false);
  }, []);

  const handleLockLost = useCallback(() => {
    log.warn('handleLockLost', 'lineup lock lost — drop hold');
    setEngaged(false);
    toast.warning('You lost the edit lock for the Lineup — a later change may not have saved.');
  }, []);

  const { status } = useHeldResourceSession({
    target,
    getNode,
    ownedKeys: undefined, // whole tabs array
    buildPayload,
    onBlocked: handleLockBlocked,
    onLost: handleLockLost,
  });

  const withLock = useCallback(
    async (mutate: () => void): Promise<boolean> => {
      const rl = useResourceLockStore.getState();
      if (!rl.collabPersist) {
        log.debug('withLock', 'solo — mutate only (whole-doc autosave persists)');
        mutate();
        return true;
      }
      const bookId = rl.bookId;
      if (!bookId) {
        log.warn('withLock', 'collab persist active but no book connected — drop mutation');
        return false;
      }
      // Acquire BEFORE mutating (never optimistic). Already held → CAS renew is idempotent, but
      // skipping the round-trip keeps repeat gestures snappy.
      if (!rl.myLocks.has(keyOf(bookId, LINEUP_LOCK_TARGET))) {
        const acq = await rl.acquire(LINEUP_LOCK_TARGET);
        if (!acq.ok) {
          log.info('withLock', 'acquire blocked — mutation dropped');
          toastLockedByOther(resolveLockHolderName(LINEUP_LOCK_TARGET));
          return false;
        }
      }
      // Hand ownership to the held-session (release-save + header status). Its own acquire is an
      // idempotent renew of the lock we just took.
      setEngaged(true);
      mutate();
      // Baseline-independent immediate flush (Insight #3 — never lose the first mutation).
      const ok = await flushSketchLineupsUnderLock(getNode());
      if (!ok) log.warn('withLock', 'immediate flush failed (held-session release-save remains)');
      return true;
    },
    [getNode],
  );

  // Header "Unsaved" → commit: disengage so the held-session cleanup release-saves + unlocks.
  const commit = useCallback(() => {
    log.info('commit', 'commit held lineup session (save + unlock)');
    setEngaged(false);
  }, []);
  useRegisterEditCommit(commit);

  return useMemo(
    () => ({ withLock, status, engaged, commit }),
    [withLock, status, engaged, commit],
  );
}
