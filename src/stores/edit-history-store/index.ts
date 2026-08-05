// edit-history-store/index.ts — in-memory, session-scoped undo/redo (ADR-045). Immer store,
// sibling of snapshot-store. Undo/redo work between edit gestures WITHIN a held edit session;
// begin/endSession tie 1:1 to the per-spread / per-entity held sessions.
//
// Stack model (symmetric): `past` holds pre-gesture checkpoints, the LIVE snapshot-store node
// is the present. undo → future.push(current) + apply(past.pop()); redo → past.push(current) +
// apply(future.pop()). MAX_HISTORY caps `past` (oldest dropped).
//
// React-19 / useShallow discipline: every exported selector returns a PRIMITIVE (bool) or a
// STABLE method ref — never a freshly-built array/object — so no useShallow footgun.

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createLogger } from '@/utils/logger';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { applyItemSnapshot } from './apply-item-snapshot';
import { selectItemSubtree } from './item-key';
import { MAX_HISTORY, type EditHistoryState, type ItemKey } from './types';

const log = createLogger('Store', 'EditHistoryStore');

/** Read + clone the CURRENT live sub-tree for `key` (pushed to the opposite stack so the
 *  reverse op can restore it). Cloned so the stored entry is a stable, owned snapshot. */
function cloneCurrentSubtree(key: string): unknown {
  return structuredClone(selectItemSubtree(useSnapshotStore.getState(), key));
}

export const useEditHistoryStore = create<EditHistoryState>()(
  immer((set, get) => ({
    histories: {},
    activeKey: null,
    isApplyingHistory: false,

    setApplyingHistory: (v) =>
      set((s) => {
        s.isApplyingHistory = v;
      }),

    beginSession: (key, baseline, domain) => {
      log.info('beginSession', 'open session', { key, domain });
      set((s) => {
        // Share the held-session baseline clone directly (never re-clone; never mutated here).
        s.histories[key] = { key, domain, baseline, past: [], future: [] };
        s.activeKey = key;
      });
    },

    capture: (key, prevSnapshot, label) => {
      set((s) => {
        const h = s.histories[key];
        if (!h) return; // no live session for this key — ignore (session may have ended)
        h.past.push({ snapshot: prevSnapshot, label, ts: Date.now() });
        h.future = []; // a fresh edit invalidates the redo branch
        if (h.past.length > MAX_HISTORY) {
          h.past.splice(0, h.past.length - MAX_HISTORY); // drop oldest
        }
        // Edit-following focus (dual-session, ADR-044 addendum 2026-08-05): with TWO sessions
        // open on one spread (scene rtype 6 ∥ retouch rtype 10), Ctrl+Z must target the stack
        // the user LAST edited — not whichever acquire happened to resolve last at beginSession.
        s.activeKey = key;
      });
      log.debug('capture', 'pushed checkpoint', { key, label });
    },

    undo: () => {
      const key = get().activeKey;
      if (!key) {
        log.debug('undo', 'no active session');
        return;
      }
      const h = get().histories[key];
      if (!h || h.past.length === 0) {
        log.debug('undo', 'nothing to undo', { key });
        return;
      }
      const target = h.past[h.past.length - 1];
      const current = cloneCurrentSubtree(key);
      set((s) => {
        const hh = s.histories[key];
        if (!hh) return;
        hh.past.pop();
        hh.future.push({ snapshot: current, label: target.label, ts: Date.now() });
      });
      log.info('undo', 'restore checkpoint', { key });
      // Guard so the restore's subtree change does NOT re-trigger capture.
      get().setApplyingHistory(true);
      try {
        applyItemSnapshot(key, target.snapshot);
      } finally {
        get().setApplyingHistory(false);
      }
    },

    redo: () => {
      const key = get().activeKey;
      if (!key) {
        log.debug('redo', 'no active session');
        return;
      }
      const h = get().histories[key];
      if (!h || h.future.length === 0) {
        log.debug('redo', 'nothing to redo', { key });
        return;
      }
      const target = h.future[h.future.length - 1];
      const current = cloneCurrentSubtree(key);
      set((s) => {
        const hh = s.histories[key];
        if (!hh) return;
        hh.future.pop();
        hh.past.push({ snapshot: current, label: target.label, ts: Date.now() });
      });
      log.info('redo', 'restore checkpoint', { key });
      get().setApplyingHistory(true);
      try {
        applyItemSnapshot(key, target.snapshot);
      } finally {
        get().setApplyingHistory(false);
      }
    },

    endSession: (key) => {
      log.info('endSession', 'close session', { key });
      set((s) => {
        delete s.histories[key];
        // Dual-session: ending the active session must not orphan a STILL-OPEN sibling (e.g.
        // the retouch session releases while the scene session is held) — fall back to any
        // remaining open session so its undo stack stays reachable.
        if (s.activeKey === key)
          s.activeKey = (Object.keys(s.histories)[0] as ItemKey | undefined) ?? null;
      });
    },

    reset: () => {
      log.info('reset', 'clear all sessions');
      set((s) => {
        s.histories = {};
        s.activeKey = null;
        s.isApplyingHistory = false;
      });
    },
  })),
);

// ── Derived selectors (primitive / stable-ref returns → no useShallow) ─────────────────────

/** True when the active session has a past checkpoint to undo. */
export const useCanUndo = (): boolean =>
  useEditHistoryStore((s) => {
    const k = s.activeKey;
    return k ? (s.histories[k]?.past.length ?? 0) > 0 : false;
  });

/** True when the active session has a future checkpoint to redo. */
export const useCanRedo = (): boolean =>
  useEditHistoryStore((s) => {
    const k = s.activeKey;
    return k ? (s.histories[k]?.future.length ?? 0) > 0 : false;
  });

/** The currently-active session key (null = no held session). */
export const useActiveHistoryKey = (): ItemKey | null =>
  useEditHistoryStore((s) => s.activeKey);
