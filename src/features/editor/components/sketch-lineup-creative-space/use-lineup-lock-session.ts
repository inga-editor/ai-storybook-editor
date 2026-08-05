// use-lineup-lock-session.ts — owns persisting the `sketch.lineups[]` node in the Sketch Lineup
// creative space (rtype 12 — ADR-043 §Mở rộng 2026-07-25). ONE grain: the WHOLE tabs array, saved
// collection-scope column-root.
//
// LOCKLESS (ADR-044 addendum 2): entity domains no longer acquire a lock. The save session binds to
// the rtype-12 grain ALWAYS and the engine begins it synchronously as 'held' — no acquire, no
// blocked toast, last-write-wins. Writes call `runWrite` DIRECTLY (mutate → flush); there is no
// acquire round-trip and no `withLock` gate. The session stays mounted purely for save-on-leave +
// auto-save + the header status.
//
// FLUSH-AFTER-EVERY-MUTATE: the node is tiny (tab config), so every successful `runWrite` also runs
// a baseline-independent `flushSketchLineupsUnderLock` (eager persist); the held session remains the
// release-save safety net + header status driver.
//
// TEARDOWN ORDER (memory *held-session teardown-order*): the SPACE must declare
// useCollabPersistSession + useContentSyncSession BEFORE this hook.
//
// SOLO (`collabPersist=false`): the setters mark sync.isDirty and the global whole-doc autosave
// persists; the flush is a best-effort no-op.

import { useCallback, useMemo } from 'react';
import {
  LINEUP_LOCK_TARGET,
  flushSketchLineupsUnderLock,
} from '@/stores/snapshot-store/slices/collab-sketch-lineups-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { useRegisterEditCommit } from '@/stores/edit-session-status-store';
import { useSaveSession } from '@/features/editor/hooks/use-save-session';
import { deriveSaveTarget } from '@/stores/save-session-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useLineupLockSession');

export interface UseLineupLockSessionResult {
  /** Run a WRITE mutation, then flush the fresh tabs array to the gateway (lockless — no acquire).
   *  `mutate` runs SYNCHRONOUSLY, so a caller may read state it set right after this returns. */
  runWrite: (mutate: () => void) => void;
}

export function useLineupLockSession(): UseLineupLockSessionResult {
  // Session bound to the rtype-12 grain ALWAYS (lockless ⇒ begins 'held' synchronously) so
  // save-on-leave + auto-save stay wired. getNode (WHOLE tabs array) + buildPayload live in the
  // `sketch-lineups` policy (save-policies). onBlocked/onLost dropped: a lockless session can't be
  // blocked or lost.
  const { saveNow } = useSaveSession(deriveSaveTarget(LINEUP_LOCK_TARGET));

  // Header "Unsaved" → commit: saveNow persists the tabs array + rebases the baseline.
  const commit = useCallback(() => {
    log.info('commit', 'commit lineup session (saveNow)');
    void saveNow();
  }, [saveNow]);
  useRegisterEditCommit(commit);

  const runWrite = useCallback((mutate: () => void) => {
    mutate();
    // Immediate flush (never lose the first mutation). Routes through the engine's `ensureSaved`
    // (saveNow while held); the caller toasts a non-clean outcome.
    void flushSketchLineupsUnderLock().then((outcome) => {
      if (outcome !== 'saved' && outcome !== 'clean') {
        log.warn('runWrite', 'immediate flush not persisted (release-save remains)', { outcome });
        toastSketchSaveOutcome(outcome, LINEUP_LOCK_TARGET);
      }
    });
  }, []);

  return useMemo(() => ({ runWrite }), [runWrite]);
}
