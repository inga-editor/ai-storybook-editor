// idle-sweep.test.ts — the single-interval per-item idle auto-save (unified-item-save-spec §4.3).
// The sweep is driven with a FAKE getState (a controlled sessions Map + saveNow/isDirty spies) so
// the tick logic is asserted deterministically under fake timers, independent of the real store.
// The snapshot / status / logger modules are mocked (the sweep reads isApplyingRemotePatch, drives
// the header, and warns on a failed save). NO node builtins.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SaveSessionState } from './index';
import type { SaveOutcome } from './types';

const h = vi.hoisted(() => ({
  snapshot: { isApplyingRemotePatch: false },
  ess: { markSaving: vi.fn(), markSaved: vi.fn() },
  warnSpy: vi.fn(),
  writeBlocked: false, // ADR-047: degraded resource → the sweep must skip it (no save, no toast)
}));

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: () => {}, debug: () => {}, warn: h.warnSpy, error: () => {} }),
}));
vi.mock('@/stores/snapshot-store', () => ({ useSnapshotStore: { getState: () => h.snapshot } }));
vi.mock('@/stores/edit-session-status-store', () => ({
  useEditSessionStatusStore: { getState: () => h.ess },
}));
// resource-lock-store is pulled in transitively by save-policies' collab helpers — mock it to keep
// the test off the real (supabase) store. Only keyOf-shaped exports are ever read at import time.
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => ({ bookId: 'book1' }) },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  isSketchWriteBlocked: () => h.writeBlocked,
  FALLBACK_HOLDER_NAME: 'another editor',
}));

import { ensureSweepRunning, maybeStopSweep } from './idle-sweep';

// 'illustration-entity' carries the default 60_000 idleAutoSaveMs — the cadence under test.
const IDLE_MS = 60_000;

interface FakeEntry {
  domain: string;
  status: string;
  lastSavedAt: number;
  manageHeaderStatus: boolean;
}

/** A controllable stand-in for the save-session store state the sweep reads. */
function makeFakeState() {
  const sessions = new Map<string, FakeEntry>();
  const state = {
    sessions,
    isDirty: vi.fn((_key: string) => true),
    saveNow: vi.fn(async (_key: string): Promise<SaveOutcome> => 'saved'),
  };
  return state;
}

function heldEntry(over: Partial<FakeEntry> = {}): FakeEntry {
  return { domain: 'illustration-entity', status: 'held', lastSavedAt: 0, manageHeaderStatus: true, ...over };
}

let state: ReturnType<typeof makeFakeState>;
const getState = () => state as unknown as SaveSessionState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  h.snapshot.isApplyingRemotePatch = false;
  h.writeBlocked = false;
  h.ess.markSaving.mockReset();
  h.ess.markSaved.mockReset();
  h.warnSpy.mockReset();
  state = makeFakeState();
});

afterEach(() => {
  // Force-stop the module-singleton interval (empty sessions ⇒ maybeStopSweep clears it) so no test
  // leaks its interval into the next.
  maybeStopSweep(() => ({ sessions: new Map() }) as unknown as SaveSessionState);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('idle sweep — save cadence', () => {
  it('dirty session past 60s → exactly ONE save (then baseline clean → no repeat)', async () => {
    state.sessions.set('k1', heldEntry({ lastSavedAt: 0 }));
    let dirty = true;
    state.isDirty.mockImplementation(() => dirty);
    state.saveNow.mockImplementation(async () => {
      dirty = false; // saveNow rebases → no longer dirty (mirrors the real store)
      state.sessions.get('k1')!.lastSavedAt = Date.now();
      return 'saved';
    });

    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS); // ticks at 15/30/45 skip (window), 60 saves
    expect(state.saveNow).toHaveBeenCalledTimes(1);
    // Header went Saving… → Saved.
    expect(h.ess.markSaving).toHaveBeenCalledTimes(1);
    expect(h.ess.markSaved).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2); // now clean → never saves again
    expect(state.saveNow).toHaveBeenCalledTimes(1);
  });

  it('clean session → never saves', async () => {
    state.sessions.set('k1', heldEntry());
    state.isDirty.mockReturnValue(false);
    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(state.saveNow).not.toHaveBeenCalled();
  });

  it('within the idle window (<60s) → not yet saved', async () => {
    state.sessions.set('k1', heldEntry({ lastSavedAt: 0 }));
    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 15_000); // 45s — still inside the window
    expect(state.saveNow).not.toHaveBeenCalled();
  });
});

describe('idle sweep — skip conditions', () => {
  it('status ≠ "held" (lost) → skip', async () => {
    state.sessions.set('k1', heldEntry({ status: 'lost' }));
    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(state.saveNow).not.toHaveBeenCalled();
  });

  it('isApplyingRemotePatch → skip the whole tick (never save over a peer merge)', async () => {
    state.sessions.set('k1', heldEntry({ lastSavedAt: 0 }));
    h.snapshot.isApplyingRemotePatch = true;
    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(state.saveNow).not.toHaveBeenCalled();
  });

  it('degraded resource (isSketchWriteBlocked) → skip, never save (no degraded-toast spam)', async () => {
    state.sessions.set('k1', heldEntry({ lastSavedAt: 0 }));
    h.writeBlocked = true;
    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(state.saveNow).not.toHaveBeenCalled();
  });

  it('manageHeaderStatus:false → saves WITHOUT touching the header label', async () => {
    state.sessions.set('k1', heldEntry({ lastSavedAt: 0, manageHeaderStatus: false }));
    let dirty = true;
    state.isDirty.mockImplementation(() => dirty);
    state.saveNow.mockImplementation(async () => {
      dirty = false;
      return 'saved';
    });
    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(state.saveNow).toHaveBeenCalledTimes(1);
    expect(h.ess.markSaving).not.toHaveBeenCalled();
    expect(h.ess.markSaved).not.toHaveBeenCalled();
  });
});

describe('idle sweep — failure handling', () => {
  it('save fails → keeps dirty, ONE warn, retries on the next window', async () => {
    state.sessions.set('k1', heldEntry({ lastSavedAt: 0 }));
    state.isDirty.mockReturnValue(true); // dirty stays (a failed save never rebases)
    state.saveNow.mockResolvedValue('failed');

    ensureSweepRunning(getState);
    await vi.advanceTimersByTimeAsync(IDLE_MS); // first attempt at 60s → fails
    expect(state.saveNow).toHaveBeenCalledTimes(1);
    expect(h.warnSpy).toHaveBeenCalledTimes(1); // exactly one warn, no toast

    await vi.advanceTimersByTimeAsync(15_000); // next tick (75s) still stale + dirty → retry
    expect(state.saveNow).toHaveBeenCalledTimes(2);
  });
});

describe('idle sweep — lifecycle', () => {
  it('maybeStopSweep clears the interval once sessions is empty', async () => {
    state.sessions.set('k1', heldEntry());
    ensureSweepRunning(getState);
    expect(vi.getTimerCount()).toBe(1);

    state.sessions.clear();
    maybeStopSweep(getState);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ensureSweepRunning is idempotent — never a second interval', () => {
    state.sessions.set('k1', heldEntry());
    ensureSweepRunning(getState);
    ensureSweepRunning(getState);
    expect(vi.getTimerCount()).toBe(1);
  });
});
