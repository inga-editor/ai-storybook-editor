// use-lock-first-action.ts — "first-click lock gate" for spread-grain collab spaces (ADR-044).
//
// Problem: every in-spread edit affordance (sidebar add, header modals, canvas mutations) needs the
// spread's resource lock HELD before it may mutate — mutating earlier bakes the change into the save
// session baseline (captured at acquire) → clean diff → silently unsaved. The legacy answer was to
// disable those controls until the user locked via item-select, which is a chicken-and-egg UX.
//
// This hook turns any such control into a lock-acquiring interaction: call `runWithLock(action)` —
// if the lock is already held the action runs synchronously; otherwise the action is queued (one
// slot, last click wins), the lock is requested, and the action runs when the session reaches HELD.
// The pending action is dropped when the acquire is blocked / the lock is lost (the space's
// onBlocked/onLost toasts explain why) or when the target key (spread) changes.
//
// NOTE: this is the shared PRIMITIVE — spaces normally consume it as `runWithLock` from
// `useSaveSession` (pass `requestLock` + `gateResetKey` there); use this hook directly only for a
// lock flow that lives outside a save session.

import { useCallback, useEffect, useRef } from "react";
import type { SessionStatus } from "@/stores/resource-lock-store";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "useLockFirstAction");

interface UseLockFirstActionArgs {
  /** True while THIS editor holds the target's lock (session HELD on the current key). */
  isHeld: boolean;
  /** Live session status — 'blocked' / 'lost' drops the pending action. */
  lockStatus: SessionStatus;
  /** Ask the owning space to acquire the lock (same path as its lock-on-select interaction). */
  requestLock: () => void;
  /** Pending action is only valid for this key (spread id) — a change clears it. */
  resetKey: string | null;
}

export function useLockFirstAction({
  isHeld,
  lockStatus,
  requestLock,
  resetKey,
}: UseLockFirstActionArgs): (action: () => void) => void {
  // Ref, not state: read/written in handlers + effects only, never rendered (React 19 rule).
  const pendingActionRef = useRef<(() => void) | null>(null);

  // Latest requestLock without re-memoizing the returned runner.
  const requestLockRef = useRef(requestLock);
  useEffect(() => {
    requestLockRef.current = requestLock;
  }, [requestLock]);

  // Flush the pending action once the lock lands; drop it on a failed/stolen acquire.
  useEffect(() => {
    if (pendingActionRef.current == null) return;
    if (isHeld) {
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      log.info("flushEffect", "lock held — run deferred action", {});
      action();
    } else if (lockStatus === "blocked" || lockStatus === "lost") {
      log.debug("flushEffect", "drop deferred action", { lockStatus });
      pendingActionRef.current = null;
    }
  }, [isHeld, lockStatus]);

  // A pending action is only valid for the key it was requested on.
  useEffect(() => {
    pendingActionRef.current = null;
  }, [resetKey]);

  // isHeld read via ref so the runner identity is stable across lock transitions.
  const isHeldRef = useRef(isHeld);
  useEffect(() => {
    isHeldRef.current = isHeld;
  }, [isHeld]);

  return useCallback((action: () => void) => {
    if (isHeldRef.current) {
      action();
      return;
    }
    log.info("runWithLock", "defer action until lock held", {});
    pendingActionRef.current = action;
    requestLockRef.current();
  }, []);
}
