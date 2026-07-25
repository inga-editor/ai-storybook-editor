// sketch-lineup-slice.ts — pure write sinks for `sketch.lineups[]` (multi-tab lineup config,
// rtype 12 collab node — 2026-07-25). Own slice file: sketch-slice.ts already exceeds the
// 500-line rule. Every setter marks `sync.isDirty` — that is the ONLY persist path in SOLO mode
// (global whole-doc auto-save); under collab the held session saves the node and autosave is
// suppressed (see use-lineup-lock-session / collab-sketch-lineups-save-helper).
//
// INVARIANTS enforced by CALLERS, not here (spec §2/§3): 12-tab cap, no deleting the last tab —
// these are UI guards; the setters stay pure/permissive so peer-merged states never wedge.
import type { StateCreator } from 'zustand';
import type { SnapshotStore, SketchLineupSlice } from '../types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'SketchLineupSlice');

export const createSketchLineupSlice: StateCreator<
  SnapshotStore,
  [['zustand/immer', never]],
  [],
  SketchLineupSlice
> = (set) => ({
  addSketchLineupTab: (tab, virtualTab) =>
    set((state) => {
      const lineups = state.sketch.lineups ?? [];
      // First materialization: the virtual tab the user has been looking at must become tab 1 —
      // pushing only `tab` would swallow the on-screen tab (plan phase-02 Insight #6).
      const seeded = lineups.length === 0 && virtualTab !== undefined && virtualTab.id !== tab.id;
      state.sketch.lineups = seeded ? [virtualTab!, tab] : [...lineups, tab];
      log.info('addSketchLineupTab', 'add tab', {
        tabId: tab.id,
        seeded,
        total: state.sketch.lineups.length,
      });
      state.sync.isDirty = true;
    }),

  renameSketchLineupTab: (tabId, name) =>
    set((state) => {
      const tab = (state.sketch.lineups ?? []).find((t) => t.id === tabId);
      if (!tab) {
        log.debug('renameSketchLineupTab', 'tab not found — no-op', { tabId });
        return;
      }
      log.info('renameSketchLineupTab', 'rename tab', { tabId });
      tab.name = name; // caller trims/clamps (modal maxLength + coercer defense-in-depth)
      state.sync.isDirty = true;
    }),

  removeSketchLineupTab: (tabId) =>
    set((state) => {
      const before = state.sketch.lineups?.length ?? 0;
      state.sketch.lineups = (state.sketch.lineups ?? []).filter((t) => t.id !== tabId);
      if (state.sketch.lineups.length === before) {
        log.debug('removeSketchLineupTab', 'tab not found — no-op', { tabId });
        return;
      }
      // Deliberately NO last-tab guard here (UI guard only) — a peer-merged state may
      // legitimately hold zero tabs and the space re-seeds its virtual tab.
      log.info('removeSketchLineupTab', 'remove tab', { tabId, total: state.sketch.lineups.length });
      state.sync.isDirty = true;
    }),

  setSketchLineupTabEntries: (tabId, entries) =>
    set((state) => {
      const tab = (state.sketch.lineups ?? []).find((t) => t.id === tabId);
      if (!tab) {
        log.debug('setSketchLineupTabEntries', 'tab not found — no-op', { tabId });
        return;
      }
      log.info('setSketchLineupTabEntries', 'replace entries', { tabId, count: entries.length });
      tab.entries = entries; // caller order preserved (append-order membership — no display semantics)
      state.sync.isDirty = true;
    }),
});
