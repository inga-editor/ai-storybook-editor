// use-edit-history-capture.ts — mount ONCE at the editor root. Subscribes to EVERY open
// session's sub-tree via the snapshot-store's subscribeWithSelector and turns each settled
// edit gesture into ONE undo checkpoint in THAT session's stack (ADR-045). Multi-key since
// the dual-session change (ADR-044 addendum 2026-08-05): a spread can hold scene (rtype 6)
// and retouch (rtype 10) sessions at once — capturing only the ACTIVE key would silently
// drop checkpoints for the sibling partition. `capture` itself re-aims `activeKey` at the
// last-edited session (edit-following focus), so Ctrl+Z targets what the user just changed.
//
// Guards (both mandatory — else infinite capture / spurious undo steps):
//   • isApplyingHistory (edit-history) — an undo/redo apply must not be re-captured.
//   • isApplyingRemotePatch (snapshot)  — a peer's realtime merge must not become an undo step.
//
// React-19 discipline: the effect deps are the useShallow-stable open-keys array (+ the stable
// `capture` ref); all gesture bookkeeping lives in effect-local vars (never a ref read/write in
// render, never set-state-in-effect). Subscriptions are torn down + re-created when the open-key
// SET changes (begin/end only — not on activeKey moves), and every pending debounce timer is
// cleared on cleanup (so a session close cancels a stale capture).

import { useEffect } from 'react';
import { dequal } from 'dequal';
import { useShallow } from 'zustand/react/shallow';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useEditHistoryStore } from '@/stores/edit-history-store';
import { selectItemSubtree } from '@/stores/edit-history-store/item-key';
import { SETTLE_MS, type ItemKey } from '@/stores/edit-history-store/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useEditHistoryCapture');

/** Coarse v1 label (unresolved #4) — refine to per-owned-key deltas later if telemetry needs it. */
function inferLabel(): string {
  return 'edit';
}

export function useEditHistoryCapture(): void {
  // Object.keys returns a fresh array each call → useShallow keeps the ref stable unless the
  // open-session SET actually changes (the sanctioned fresh-array pattern).
  const openKeys = useEditHistoryStore(
    useShallow((s) => Object.keys(s.histories) as ItemKey[]),
  );
  const capture = useEditHistoryStore((s) => s.capture);

  useEffect(() => {
    if (openKeys.length === 0) return;
    log.debug('subscribe', 'attach capture subscriptions', { count: openKeys.length });

    const cleanups = openKeys.map((key) => {
      // Per-key gesture bookkeeping (effect-local — never a ref in render).
      let pendingPrev: unknown = null;
      let hasPending = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = (): void => {
        timer = null;
        if (!hasPending) return;
        const prev = pendingPrev;
        hasPending = false;
        pendingPrev = null;
        capture(key, prev, inferLabel());
      };

      const unsubscribe = useSnapshotStore.subscribe(
        (state) => selectItemSubtree(state, key),
        (next, prev) => {
          // Skip an undo/redo apply (else the restore is re-captured) …
          if (useEditHistoryStore.getState().isApplyingHistory) return;
          // … and a realtime content-sync merge (a peer's edit is not a local undo step).
          if (useSnapshotStore.getState().isApplyingRemotePatch) return;
          // Redundant with the equalityFn but belt-and-suspenders against a same-value fire.
          if (dequal(prev, next)) return;

          if (!hasPending) {
            // First change of the gesture → remember the PRE-gesture sub-tree (owned clone).
            pendingPrev = structuredClone(prev);
            hasPending = true;
          }
          if (timer) clearTimeout(timer);
          timer = setTimeout(flush, SETTLE_MS);
        },
        { equalityFn: dequal },
      );

      return (): void => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      };
    });

    return () => {
      cleanups.forEach((cleanup) => cleanup());
      log.debug('subscribe', 'detach capture subscriptions', { count: cleanups.length });
    };
  }, [openKeys, capture]);
}
