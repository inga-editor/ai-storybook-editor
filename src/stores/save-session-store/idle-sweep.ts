// idle-sweep.ts — the per-item idle auto-save (unified-item-save-spec §4.3, store design §7).
// ⚡ PHASE 2. ONE singleton 15s interval sweeps EVERY held session and `saveNow`s any that has
// gone `idleAutoSaveMs` (default 60_000) past its last successful save while still dirty. This is
// the safety net the 6 collab spaces never had (before, the only persist was release-save on
// switch — 30 min in one item = 0 requests).
//
// Why ONE interval for all sessions (never a timer per session): a per-session timer leaks when a
// space teardown runs out of order (the held-session bug, 2026-07-11). A single module-scope
// interval — started on the first held session, stopped when `sessions` empties — has no such race
// and mirrors `resource-lock-store/heartbeat.ts`.
//
// Auto-save = a NORMAL save (`action_type:3, log:true` via `saveNow` → the persist fork): it emits
// an audit row + peer content-sync, exactly like a manual save (decision 2026-08-04). The lock is
// KEPT (never release/re-acquire — no peer window, no undo-session churn).

import { createLogger } from '@/utils/logger';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { useEditSessionStatusStore } from '@/stores/edit-session-status-store';
import { isSketchWriteBlocked } from '@/stores/resource-lock-store';
import { SAVE_POLICIES } from './save-policies';
import type { SaveSessionState } from './index';

const log = createLogger('Store', 'SaveSessionIdleSweep');

/** Interval cadence for the idle sweep. A dirty item is saved 60–75s after its last save. */
export const IDLE_SWEEP_TICK_MS = 15_000;

/**
 * Grain-double mitigation (rtype 14, ADR-044 addendum 2): the base space runs TWO grains on the same
 * `sketch.{collection}` array — the mounted rtype-14 collection session AND the base-sheet generate
 * job (which re-clones every entity's base variant on a locked style, then persists the collection
 * itself at the end of its chain). If the idle sweep fired the rtype-14 session's whole-array save
 * WHILE that job is mid-flight, it could race the job's in-progress clone writes (last-writer-wins on
 * the WHOLE array). So the sweep SKIPS a `sketch-base-entities` session whose collection has a base
 * generate op running. The flag source is the job slice's running-state read DIRECTLY (no new state
 * in the save-session-store). Collection → base kinds: `characters` covers both `characters` and the
 * `alter_characters` kind (both persist into `sketch.characters[]`); `props` covers `props`; `stages`
 * has no base generate op (its rtype-14 session is import-only, one-shot — never a mounted session).
 */
function baseGenerateRunningForCollection(collection: string): boolean {
  const ops = useSnapshotStore.getState().baseSheetGenerateOps;
  if (collection === 'characters') return ops.characters != null || ops.alter_characters != null;
  if (collection === 'props') return ops.props != null;
  return false;
}

type GetState = () => SaveSessionState;

// ── Non-reactive module scope (single interval + in-flight de-dupe) ─────────────────────────────
let intervalId: ReturnType<typeof setInterval> | null = null;
/** Keys with an auto-save in flight — a slow save must not overlap the next tick (double write). */
const inFlight = new Set<string>();

/**
 * One auto-save for a single stale held+dirty session. Drives the shared save-phase Saving→Saved for
 * sessions that manage the label (suppressed for a self-labelled session — the base entity modal),
 * mirroring a manual save. NOTE: while the lock is HELD the header renders "Unsaved" (collabHolding
 * forces `dirty`, editor-page.tsx), so this transition is masked until the eventual release-save —
 * same as a manual saveNow-while-holding; kept for parity + the non-collab/settled path.
 * A rejected/blocked save keeps the item dirty + the lock and logs ONE warn (no toast — the sweep
 * runs unattended); the next tick retries because `lastSavedAt` was not advanced.
 */
async function autoSaveOne(getState: GetState, key: string, manageHeaderStatus: boolean): Promise<void> {
  if (inFlight.has(key)) return; // a previous tick's save is still resolving — skip
  inFlight.add(key);
  const ess = useEditSessionStatusStore.getState();
  if (manageHeaderStatus) ess.markSaving();
  try {
    const outcome = await getState().saveNow(key);
    if (outcome === 'failed' || outcome === 'blocked') {
      log.warn('autoSaveOne', 'auto-save not persisted — keep dirty, retry next tick', {
        key,
        outcome,
      });
    }
  } catch (err) {
    log.error('autoSaveOne', 'auto-save threw', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (manageHeaderStatus) ess.markSaved();
    inFlight.delete(key);
  }
}

/** One sweep pass: save each held session whose dirty window elapsed. */
function tick(getState: GetState): void {
  // Never save over a peer's realtime merge in progress (content-sync sets this around the mutation).
  // The peer's change on a resource I hold is skipped by content-sync anyway, but guard here too so a
  // tick that lands mid-merge can't race the applied patch.
  if (useSnapshotStore.getState().isApplyingRemotePatch) {
    log.debug('tick', 'applying remote patch — skip this sweep', {});
    return;
  }
  const now = Date.now();
  const { sessions, isDirty } = getState();
  for (const [key, entry] of sessions) {
    if (entry.status !== 'held') continue; // acquiring / blocked / lost / releasing → not savable
    const ms = SAVE_POLICIES[entry.domain].idleAutoSaveMs;
    if (ms == null) continue; // domain opted out of auto-save
    if (now - entry.lastSavedAt < ms) continue; // still inside the idle window
    // ADR-047: a DEGRADED (consent-pending) sketch resource is refused by the gateway save — which
    // would raise a degraded TOAST on every retry tick (the sweep must run unattended). Skip it
    // entirely; the header already surfaces the degraded state, and it resumes once consent clears.
    if (isSketchWriteBlocked(entry.target)) continue;
    // Grain-double: never auto-save the whole rtype-14 collection while its kind's base generate job
    // is mid-flight (it re-clones entities + persists the collection itself at chain end).
    if (entry.domain === 'sketch-base-entities' && baseGenerateRunningForCollection(entry.id)) {
      log.debug('tick', 'base generate running for collection — skip rtype-14 tick', {
        key,
        collection: entry.id,
      });
      continue;
    }
    if (!isDirty(key)) continue; // nothing changed since the last save
    log.info('tick', 'idle auto-save', { key, domain: entry.domain });
    void autoSaveOne(getState, key, entry.manageHeaderStatus);
  }
}

/**
 * Start the single sweep interval if it is not already running. Called after every successful
 * `begin` (idempotent — a no-op once running). The store passes its own `get` so the tick reads
 * live session state without importing the store instance at module-eval time (avoids a cycle).
 */
export function ensureSweepRunning(getState: GetState): void {
  if (intervalId !== null) return;
  log.info('ensureSweepRunning', 'start idle sweep', { tickMs: IDLE_SWEEP_TICK_MS });
  intervalId = setInterval(() => tick(getState), IDLE_SWEEP_TICK_MS);
}

/**
 * Stop the sweep interval WHEN no sessions remain. Called at the end of `end` / `onLost`. Keeping
 * the interval alive while ≥1 session exists (even a non-held one) is fine — the tick skips them —
 * and stopping only on an empty map keeps the lifecycle symmetric with `ensureSweepRunning`.
 */
export function maybeStopSweep(getState: GetState): void {
  if (intervalId === null) return;
  if (getState().sessions.size > 0) return;
  log.info('maybeStopSweep', 'no sessions — stop idle sweep', {});
  clearInterval(intervalId);
  intervalId = null;
  inFlight.clear();
}
