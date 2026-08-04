// idle-sweep.ts — SCAFFOLD ONLY (phase 2). The unified-item-save spec §4.3 adds a per-item
// idle auto-save: a single 15s interval sweeps held+dirty sessions and `saveNow`s any whose
// `now − lastSavedAt ≥ idleAutoSaveMs`. That timer is DELIBERATELY NOT started in phase 1 —
// this file only reserves the surface so the store wires it later without a new module.
//
// One interval for ALL sessions (never per-session — avoids leaks on a teardown-order race).

/** Interval cadence for the idle sweep (phase 2). */
export const IDLE_SWEEP_TICK_MS = 15_000;

/**
 * Install the idle-sweep interval. PHASE 1: no-op — returns a no-op teardown so a future caller
 * (or a test) can adopt it unchanged. Phase 2 replaces the body with the sweep tick that calls
 * `useSaveSessionStore.getState().saveNow(key)` for each stale held+dirty session.
 */
export function installIdleSweep(): () => void {
  return () => {
    /* no-op until phase 2 */
  };
}
