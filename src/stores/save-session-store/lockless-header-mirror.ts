// lockless-header-mirror.ts — mirrors REAL dirtiness of lockless sessions into the header hold.
//
// Why: the header maps `holdCount > 0` → "Unsaved" (editor-page). For a LOCKED session that is
// correct — the hold starts on the first-click lock gate, so holding ≈ actively editing. A LOCKLESS
// session however is 'held' for as long as the item is merely SELECTED (it begins synchronously on
// mount, no interact gate), so a begin-time `beginHold()` showed a permanent "Unsaved" in every
// lock-exempt space (sketch base/variant/stage/lineup, entity spaces) even with zero edits.
//
// Fix: the engine never beginHold()s a lockless session. Instead this module subscribes to BOTH
// the snapshot store (edits flip dirty true) and the save-session store (baseline rebase after
// saveNow / idle sweep / rebaseBaseline flips dirty false; begin/end change the session set) and
// reconciles ONE global mirrored hold: any lockless+header-managed session dirty ⇒ hold
// (→ "Unsaved"), none ⇒ release (→ "Saved"). Reconciliation is SYNCHRONOUS with the store write
// (zustand notifies in the same task), so the label transition renders in the same React batch as
// the save — no stale "Unsaved" flash frame (a React-effect mirror would flip AFTER paint).
//
// Locked domains are untouched: their begin/end still drive beginHold/endHold directly, and this
// reconciler skips every `locking !== 'none'` session.

import { createLogger } from '@/utils/logger';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useEditSessionStatusStore } from '@/stores/edit-session-status-store';
import { SAVE_POLICIES } from './save-policies';
import type { SaveSessionState } from './index';

const log = createLogger('Store', 'LocklessHeaderMirror');

type GetState = () => SaveSessionState;
type Subscribe = (listener: () => void) => () => void;

// ── Non-reactive module scope (single mirror + single subscription pair) ────────────────────────
let mirrorHeld = false;
let unsubscribe: (() => void) | null = null;

/** Recompute "any lockless header-managed session dirty" and flip the mirrored hold on change. */
export function reconcileLocklessHeaderMirror(getState: GetState): void {
  const { sessions, isDirty } = getState();
  let dirty = false;
  for (const [key, entry] of sessions) {
    if (entry.status !== 'held') continue;
    if (SAVE_POLICIES[entry.domain].locking !== 'none') continue;
    if (!entry.manageHeaderStatus) continue;
    if (isDirty(key)) {
      dirty = true;
      break;
    }
  }
  if (dirty === mirrorHeld) return;
  mirrorHeld = dirty;
  const ess = useEditSessionStatusStore.getState();
  if (dirty) {
    log.debug('reconcile', 'lockless session dirty — mirror hold (header Unsaved)');
    ess.beginHold();
  } else {
    log.debug('reconcile', 'lockless sessions clean — release mirrored hold');
    ess.endHold();
  }
}

/**
 * Start the mirror subscriptions if not already running. Called on every lockless `begin`
 * (idempotent). `subscribeSessions` is passed in by the store (its own `subscribe`) to avoid an
 * import cycle — this module is imported BY `./index`, mirroring the `GetState` pattern of
 * `idle-sweep`. Snapshot subscribe uses `?.` so the mocked plain-object snapshot store in engine
 * unit tests (no `subscribe`) needs no stubbing — tests drive `reconcileLocklessHeaderMirror`
 * directly.
 */
export function ensureHeaderMirrorRunning(getState: GetState, subscribeSessions: Subscribe): void {
  if (unsubscribe !== null) return;
  const reconcile = () => reconcileLocklessHeaderMirror(getState);
  const unsubSnapshot = (useSnapshotStore as { subscribe?: Subscribe }).subscribe?.(reconcile);
  const unsubSessions = subscribeSessions(reconcile);
  unsubscribe = () => {
    unsubSnapshot?.();
    unsubSessions();
  };
  log.info('ensureHeaderMirrorRunning', 'mirror subscriptions started');
}

/** Stop the mirror when no sessions remain (paired with `maybeStopSweep`). The final dropEntry's
 *  notification already reconciled the hold to released before we get here. */
export function maybeStopHeaderMirror(getState: GetState): void {
  if (unsubscribe === null) return;
  if (getState().sessions.size > 0) return;
  // Defensive: an empty map can never be dirty, but reconcile once so a missed notification can't
  // leave a stale mirrored hold behind.
  reconcileLocklessHeaderMirror(getState);
  unsubscribe();
  unsubscribe = null;
  log.info('maybeStopHeaderMirror', 'mirror subscriptions stopped');
}

/** Test-only: reset module singletons between cases (mirrors `__resetHistoryBridge`). */
export function __resetLocklessHeaderMirror(): void {
  mirrorHeld = false;
  unsubscribe?.();
  unsubscribe = null;
}
