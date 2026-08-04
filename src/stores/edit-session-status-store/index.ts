// edit-session-status-store — global UI status for the collab HELD edit session (ADR-044/045).
// Decouples the header save-label from the 60s snapshot auto-save loop: while any collab creative
// space is mounted, the header shows Unsaved (holding lock) → Saving… (release-save in flight) →
// Saved, and NEVER "Auto-saved". Written ONLY by the save-session engine (single choke point — DRY);
// read by EditorPage which folds it into the header SaveStatus. `mountCount` ref-counts mounted
// collab spaces (>0 ⇒ collab UI active) so it survives StrictMode's mount/unmount/mount. Every
// exported selector returns a PRIMITIVE → no useShallow footgun.

import { useEffect } from 'react';
import { create } from 'zustand';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'EditSessionStatusStore');

/** Save lifecycle of the most-recent held session release. `idle` = fresh/holding (label driven by
 *  the active-history key instead), `saving` = release-save in flight, `saved` = persisted. */
export type CollabSavePhase = 'idle' | 'saving' | 'saved';

interface EditSessionStatusState {
  /** Ref-count of mounted collab creative spaces (0 outside them; normally 0 or 1). Driven by the
   *  shared `useCollabPersistSession` (ONE choke point for all 6 collab spaces incl. sketch — DRY). */
  mountCount: number;
  /** Ref-count of currently-HELD edit locks across any collab space (>0 ⇒ header "Unsaved"). Driven
   *  uniformly by the save-session engine (`useSaveSession`) across all collab spaces (5 held-session
   *  + both sketch spaces) — so the save-label is single-sourced here, decoupled from the undo store. */
  holdCount: number;
  savePhase: CollabSavePhase;
  /** Commit-now hook for the active collab space: releases its held lock (→ save + unlock). Set by
   *  the mounted space; called by the header "Unsaved" button. Null when no collab space is active. */
  commitFn: (() => void) | null;
  /** A collab space mounted → switch the header into collab-label mode. */
  enter: () => void;
  /** A collab space unmounted → fall back to snapshot-derived status when count hits 0. Resets the
   *  hold/phase state at 0 so a teardown-order race can never leave a stale "Unsaved"/"Saving…". */
  leave: () => void;
  /** A lock became HELD → header "Unsaved"; also clears any stale terminal phase (fresh session). */
  beginHold: () => void;
  /** A held lock released/lost → decrement (floored at 0, so an order-independent double-cleanup is safe). */
  endHold: () => void;
  /** Release-save started (dirty). */
  markSaving: () => void;
  /** Release-save finished (or nothing to save) → terminal "Saved". */
  markSaved: () => void;
  /** The active space registers its commit-now callback (idempotent-safe: last registrant wins). */
  registerCommit: (fn: () => void) => void;
  /** Unregister on unmount — guarded so a late cleanup can't clobber the next space's registration. */
  clearCommit: (fn: () => void) => void;
}

export const useEditSessionStatusStore = create<EditSessionStatusState>((set) => ({
  mountCount: 0,
  holdCount: 0,
  savePhase: 'idle',
  commitFn: null,
  enter: () => set((s) => ({ mountCount: s.mountCount + 1 })),
  leave: () =>
    set((s) => {
      const mountCount = Math.max(0, s.mountCount - 1);
      // Last collab space gone → hard-reset hold/phase (defense against a teardown-order race where
      // leave() runs before a lock's endHold(); endHold's floor keeps the later decrement at 0).
      return mountCount === 0 ? { mountCount, holdCount: 0, savePhase: 'idle' } : { mountCount };
    }),
  beginHold: () => {
    log.debug('beginHold', 'lock held — header Unsaved');
    set((s) => ({ holdCount: s.holdCount + 1, savePhase: 'idle' }));
  },
  endHold: () => {
    log.debug('endHold', 'lock released/lost');
    set((s) => ({ holdCount: Math.max(0, s.holdCount - 1) }));
  },
  markSaving: () => {
    log.debug('markSaving', 'release-save in flight');
    set({ savePhase: 'saving' });
  },
  markSaved: () => {
    log.debug('markSaved', 'release-save settled');
    set({ savePhase: 'saved' });
  },
  registerCommit: (fn) => set({ commitFn: fn }),
  clearCommit: (fn) => set((s) => (s.commitFn === fn ? { commitFn: null } : s)),
}));

/**
 * Register the active collab space's "commit now" callback (release the held lock → save + unlock)
 * so the global header "Unsaved" button can trigger it. `commit` MUST be stable (wrap in useCallback
 * with stable setter deps). One collab space is mounted at a time → single-slot registry is safe.
 */
export function useRegisterEditCommit(commit: () => void): void {
  useEffect(() => {
    useEditSessionStatusStore.getState().registerCommit(commit);
    return () => useEditSessionStatusStore.getState().clearCommit(commit);
  }, [commit]);
}

/** True while ≥1 collab creative space is mounted → header uses the session-driven save label. */
export const useCollabUiActive = (): boolean =>
  useEditSessionStatusStore((s) => s.mountCount > 0);

/** True while ≥1 edit lock is HELD → header shows "Unsaved" (single-sourced across all collab spaces). */
export const useCollabHolding = (): boolean =>
  useEditSessionStatusStore((s) => s.holdCount > 0);

/** Current release-save phase for the header label. */
export const useCollabSavePhase = (): CollabSavePhase =>
  useEditSessionStatusStore((s) => s.savePhase);
