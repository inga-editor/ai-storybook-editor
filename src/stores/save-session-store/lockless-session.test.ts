// lockless-session.test.ts — the `locking:'none'` lifecycle (ADR-044 addendum 2, "lock scope =
// spread-only", phase 03). A lock-exempt domain (entity grain) runs a full session — synchronous
// baseline, dirty tracking, idle auto-save, save-on-leave, one-shot ensureSaved — WITHOUT ever
// touching acquire/heartbeat/release. `illustration-entity` is the representative lockless domain
// here (its `locking` flipped to 'none' this phase); `scene-spread` is the regression control that
// MUST still acquire/release. Same mocked-store harness as index.test.ts (engine wiring, no I/O).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const lock = {
    bookId: 'book1' as string | null,
    collabPersist: true,
    myLocks: new Set<string>(),
    acquire: vi.fn(async (_t: unknown) => ({ ok: true }) as { ok: boolean; holder?: string }),
    save: vi.fn(
      async (_t: unknown, _p: unknown) =>
        ({ ok: true }) as { ok: boolean; blocked?: boolean; lost?: boolean },
    ),
    release: vi.fn(async (_t: unknown) => {}),
    releaseAndSave: vi.fn(async (_t: unknown, _d: boolean, _p: unknown, _b?: string) => {}),
    addMyLock: vi.fn(),
    removeMyLock: vi.fn(),
    registerOnLost: vi.fn(),
    unregisterOnLost: vi.fn(),
  };
  const snapshot = {
    characters: [{ key: 'hero', name: 'A' }] as Array<{ key: string; name: string }>,
    props: [] as unknown[],
    stages: [] as unknown[],
    illustration: { spreads: [] as Array<Record<string, unknown>> },
    sketch: { characters: [], props: [], stages: [], base: {}, lineups: [] },
    isApplyingRemotePatch: false,
    flushSnapshot: vi.fn(async () => {}),
  };
  const ess = { beginHold: vi.fn(), endHold: vi.fn(), markSaving: vi.fn(), markSaved: vi.fn() };
  const hist = { beginSession: vi.fn(), endSession: vi.fn() };
  const saveResource = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean });
  return { lock, snapshot, ess, hist, saveResource };
});

vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.lock },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  isSketchWriteBlocked: () => false,
  FALLBACK_HOLDER_NAME: 'another editor',
  ACTION_TYPE_CREATE: 2,
}));
vi.mock('@/stores/snapshot-store', () => ({ useSnapshotStore: { getState: () => h.snapshot } }));
vi.mock('@/apis/resource-lock-api', () => ({ saveResource: (...a: unknown[]) => h.saveResource(...a) }));
vi.mock('@/stores/edit-session-status-store', () => ({
  useEditSessionStatusStore: { getState: () => h.ess },
}));
vi.mock('@/stores/edit-history-store', () => ({ useEditHistoryStore: { getState: () => h.hist } }));
vi.mock('@/stores/edit-history-store/item-key', () => ({
  buildItemKey: (domain: string, t: { resource_type: number; resource_id: string; locale: string | null }) =>
    `${domain}:${t.resource_type}:${t.resource_id}:${t.locale ?? '∅'}`,
}));

import { useSaveSessionStore } from './index';
import { maybeStopSweep } from './idle-sweep';
import { __resetHistoryBridge } from './history-bridge';
import { __resetLocklessHeaderMirror } from './lockless-header-mirror';

// illustration-entity is LOCKLESS this phase — the representative lock-exempt domain under test.
const ENTITY_ID = 'character/hero';
const KEY = 'book1|2|3|hero|'; // keyOf(book1, {step:2,rtype:3,resource_id:hero,locale:null})
const TARGET = { step: 2, resource_type: 3, resource_id: 'hero', locale: null };
const EDIT_PAYLOAD = { action_type: 3, patch: { key: 'hero', name: 'A' }, log: true };

const store = () => useSaveSessionStore.getState();

beforeEach(() => {
  __resetHistoryBridge();
  __resetLocklessHeaderMirror();
  useSaveSessionStore.setState({ sessions: new Map() });
  h.lock.bookId = 'book1';
  h.lock.collabPersist = true;
  h.lock.myLocks = new Set();
  h.lock.acquire.mockReset().mockResolvedValue({ ok: true });
  h.lock.save.mockReset().mockResolvedValue({ ok: true });
  h.lock.release.mockReset().mockResolvedValue(undefined);
  h.lock.releaseAndSave.mockReset().mockResolvedValue(undefined);
  h.lock.addMyLock.mockReset();
  h.lock.removeMyLock.mockReset();
  h.lock.registerOnLost.mockReset();
  h.lock.unregisterOnLost.mockReset();
  h.snapshot.characters = [{ key: 'hero', name: 'A' }];
  h.snapshot.illustration.spreads = [];
  h.snapshot.isApplyingRemotePatch = false;
  h.snapshot.flushSnapshot.mockReset().mockResolvedValue(undefined);
  h.ess.beginHold.mockReset();
  h.ess.endHold.mockReset();
  h.ess.markSaving.mockReset();
  h.ess.markSaved.mockReset();
  h.hist.beginSession.mockReset();
  h.hist.endSession.mockReset();
  h.saveResource.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  // Stop the module-singleton idle sweep an unmatched begin may have started (empty sessions ⇒
  // maybeStopSweep clears the interval), then restore any fake timers a test installed.
  useSaveSessionStore.setState({ sessions: new Map() });
  maybeStopSweep(() => useSaveSessionStore.getState());
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

describe('begin — lockless (no acquire, synchronous held)', () => {
  // Criterion 1: acquire NOT called; status 'held' set SYNCHRONOUSLY (before the promise resolves).
  it('never calls acquire and holds synchronously', async () => {
    const p = store().begin('illustration-entity', ENTITY_ID);
    // Synchronous: the entry is already held before we ever await the returned promise.
    expect(useSaveSessionStore.getState().sessions.get(KEY)?.status).toBe('held');
    expect(h.lock.acquire).not.toHaveBeenCalled();
    expect(h.lock.addMyLock).not.toHaveBeenCalled();
    expect(h.lock.registerOnLost).not.toHaveBeenCalled();
    expect(await p).toBe('held');
    // Undo bridge still driven by the session engine; the header hold is NOT — a lockless session
    // is held while merely selected, so begin-time beginHold would show a permanent "Unsaved".
    // The hold is dirty-mirrored instead (see lockless-header-mirror.test.ts).
    expect(h.hist.beginSession).toHaveBeenCalledTimes(1);
    expect(h.ess.beginHold).not.toHaveBeenCalled();
  });

  // Criterion 2: baseline captured BEFORE begin returns — a mutation right after the call is dirty.
  it('captures the baseline synchronously (mutate-right-after-begin ⇒ dirty)', async () => {
    const p = store().begin('illustration-entity', ENTITY_ID);
    // Mutate immediately (before awaiting): if the baseline were captured async, this would leak
    // into it and the session would read clean — the B2 silent-data-loss trap.
    h.snapshot.characters[0].name = 'B';
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(true);
    await p;
  });

  it('respects isCancelled — a cancelled begin seeds no entry', async () => {
    const status = await store().begin('illustration-entity', ENTITY_ID, null, {
      isCancelled: () => true,
    });
    expect(status).toBe('idle');
    expect(useSaveSessionStore.getState().sessions.has(KEY)).toBe(false);
  });
});

describe('end — lockless (save-only, no unlock)', () => {
  // Criterion 3: dirty end → rl.save ONCE; release / releaseAndSave / removeMyLock NEVER.
  it('DIRTY → rl.save exactly once, no release/releaseAndSave', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    await store().end(KEY);
    await Promise.resolve(); // let the fire-and-forget persist settle its .then
    expect(h.lock.save).toHaveBeenCalledTimes(1);
    expect(h.lock.save).toHaveBeenCalledWith(TARGET, {
      action_type: 3,
      patch: { key: 'hero', name: 'B' },
      log: true,
    });
    expect(h.lock.releaseAndSave).not.toHaveBeenCalled();
    expect(h.lock.release).not.toHaveBeenCalled();
    expect(h.lock.removeMyLock).not.toHaveBeenCalled();
    expect(h.hist.endSession).toHaveBeenCalledTimes(1);
    expect(useSaveSessionStore.getState().sessions.has(KEY)).toBe(false);
    // Header: no endHold (the engine never began a hold — the mirror owns it); the save-on-leave
    // still settles the label Saving…→Saved.
    expect(h.ess.endHold).not.toHaveBeenCalled();
    expect(h.ess.markSaving).toHaveBeenCalledTimes(1);
    expect(h.ess.markSaved).toHaveBeenCalledTimes(1);
  });

  // Criterion 4: clean end → no persist call of any kind.
  it('CLEAN → no save, no release', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    await store().end(KEY);
    expect(h.lock.save).not.toHaveBeenCalled();
    expect(h.lock.releaseAndSave).not.toHaveBeenCalled();
    expect(h.lock.release).not.toHaveBeenCalled();
    expect(useSaveSessionStore.getState().sessions.has(KEY)).toBe(false);
  });
});

describe('saveNow — lockless Saving… transient', () => {
  // The header-managed lockless saveNow drives markSaving→markSaved itself (a locked session's
  // label stays "Unsaved" while holding, so only the lockless path marks).
  it('dirty saveNow marks Saving…→Saved around the persist', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    const outcome = await store().saveNow(KEY);
    expect(outcome).toBe('saved');
    expect(h.ess.markSaving).toHaveBeenCalledTimes(1);
    expect(h.ess.markSaved).toHaveBeenCalledTimes(1);
    // markSaving strictly before markSaved (transient, not a settled flicker).
    expect(h.ess.markSaving.mock.invocationCallOrder[0]).toBeLessThan(
      h.ess.markSaved.mock.invocationCallOrder[0],
    );
  });

  it('failed saveNow still settles the phase (finally) and stays dirty', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    h.lock.save.mockResolvedValue({ ok: false });
    const outcome = await store().saveNow(KEY);
    expect(outcome).toBe('failed');
    expect(h.ess.markSaved).toHaveBeenCalledTimes(1); // finally ran — phase never sticks at 'saving'
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(true); // no rebase on failure
  });
});

describe('ensureSaved — lockless one-shot (no session)', () => {
  // Criterion 5: no-session lockless → rl.save without acquire/release, returns 'saved', no entry.
  it('saves straight to the gateway, no acquire/release, returns "saved"', async () => {
    const outcome = await store().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('saved');
    expect(h.lock.save).toHaveBeenCalledWith(TARGET, EDIT_PAYLOAD);
    expect(h.lock.acquire).not.toHaveBeenCalled();
    expect(h.lock.release).not.toHaveBeenCalled();
    expect(useSaveSessionStore.getState().sessions.size).toBe(0);
  });

  it('degraded gateway save (ADR-047) → "blocked", still no acquire/release', async () => {
    h.lock.save.mockResolvedValue({ ok: false, blocked: true });
    const outcome = await store().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('blocked');
    expect(h.lock.acquire).not.toHaveBeenCalled();
    expect(h.lock.release).not.toHaveBeenCalled();
  });

  it('missing local node → "failed" (never save a missing anchor)', async () => {
    h.snapshot.characters = [];
    expect(await store().ensureSaved('illustration-entity', ENTITY_ID)).toBe('failed');
    expect(h.lock.save).not.toHaveBeenCalled();
  });
});

describe('idle sweep + flush-on-hidden cover lockless sessions', () => {
  // Criterion 6: an overdue dirty lockless session is swept (saveNow → gateway save).
  it('idle sweep saves an overdue dirty lockless session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await store().begin('illustration-entity', ENTITY_ID); // starts the sweep, lastSavedAt=0
    h.snapshot.characters[0].name = 'B'; // dirty
    await vi.advanceTimersByTimeAsync(60_000); // idleAutoSaveMs=60_000 → the 60s tick saves once
    expect(h.lock.save).toHaveBeenCalledTimes(1);
    expect(h.lock.save).toHaveBeenCalledWith(TARGET, {
      action_type: 3,
      patch: { key: 'hero', name: 'B' },
      log: true,
    });
  });

  // Criterion 7: flushAllOnHidden fires one keepalive save for a held+dirty lockless session.
  it('flushAllOnHidden flushes a held+dirty lockless session', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B'; // dirty
    store().flushAllOnHidden();
    expect(h.saveResource).toHaveBeenCalledTimes(1);
    const [bookId, target, payload] = h.saveResource.mock.calls[0] as unknown as [
      string,
      { resource_id: string },
      { action_type: number; patch: unknown },
    ];
    expect(bookId).toBe('book1');
    expect(target.resource_id).toBe('hero');
    expect(payload.action_type).toBe(3);
    expect(payload.patch).toEqual({ key: 'hero', name: 'B' });
  });
});

describe('regression — spread domains still acquire/release (locking ≠ none unchanged)', () => {
  // Criterion 8: the whole-spread domains keep the pessimistic acquire→release lifecycle intact.
  it('scene-spread begin acquires and end release-saves', async () => {
    h.snapshot.illustration.spreads = [{ id: 'sp1', manuscript: 'x' }];
    const SCENE_KEY = 'book1|2|6|sp1|';
    const SCENE_TARGET = { step: 2, resource_type: 6, resource_id: 'sp1', locale: null };
    expect(await store().begin('scene-spread', 'sp1')).toBe('held');
    expect(h.lock.acquire).toHaveBeenCalledWith(SCENE_TARGET);
    expect(h.lock.addMyLock).toHaveBeenCalledWith(SCENE_TARGET);
    h.snapshot.illustration.spreads[0].manuscript = 'edited';
    await store().end(SCENE_KEY);
    expect(h.lock.releaseAndSave).toHaveBeenCalledTimes(1);
    expect(h.lock.removeMyLock).toHaveBeenCalledWith(SCENE_TARGET);
    expect(h.lock.save).not.toHaveBeenCalled(); // release path uses releaseAndSave, not bare save
  });
});
