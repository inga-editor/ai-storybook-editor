// index.test.ts — the engine lifecycle: begin→held (baseline clone), dirty-gate on end, saveNow
// (save-while-held + rebase), 409→blocked, onLost→lost+bridge, and the SINGLE solo/collab persist
// fork. resource-lock-store / snapshot-store / status / history stores are mocked so the engine's
// wiring is asserted without real I/O (same shape as the collab helper tests).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const lock = {
    bookId: 'book1' as string | null,
    collabPersist: true,
    myLocks: new Set<string>(),
    acquire: vi.fn(async (_t: unknown) => ({ ok: true }) as { ok: boolean; holder?: string }),
    save: vi.fn(async (_t: unknown, _p: unknown) => ({ ok: true }) as { ok: boolean; blocked?: boolean; lost?: boolean }),
    releaseAndSave: vi.fn(async (_t: unknown, _d: boolean, _p: unknown, _b?: string) => {}),
    addMyLock: vi.fn(),
    removeMyLock: vi.fn(),
    registerOnLost: vi.fn(),
    unregisterOnLost: vi.fn(),
    _lostCbs: {} as Record<string, () => void>,
  };
  lock.registerOnLost = vi.fn((key: string, cb: () => void) => {
    lock._lostCbs[key] = cb;
  });
  const snapshot = {
    characters: [{ key: 'hero', name: 'A' }] as Array<{ key: string; name: string }>,
    props: [] as unknown[],
    stages: [] as unknown[],
    illustration: { spreads: [] as unknown[] },
    sketch: { characters: [], props: [], stages: [], base: {}, lineups: [] },
    flushSnapshot: vi.fn(async () => {}),
  };
  const ess = { beginHold: vi.fn(), endHold: vi.fn(), markSaving: vi.fn(), markSaved: vi.fn() };
  const hist = { beginSession: vi.fn(), endSession: vi.fn() };
  return { lock, snapshot, ess, hist };
});

vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.lock },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  FALLBACK_HOLDER_NAME: 'another editor',
  ACTION_TYPE_CREATE: 2,
}));
vi.mock('@/stores/snapshot-store', () => ({ useSnapshotStore: { getState: () => h.snapshot } }));
vi.mock('@/stores/edit-session-status-store', () => ({
  useEditSessionStatusStore: { getState: () => h.ess },
}));
vi.mock('@/stores/edit-history-store', () => ({ useEditHistoryStore: { getState: () => h.hist } }));
vi.mock('@/stores/edit-history-store/item-key', () => ({
  buildItemKey: (domain: string, t: { resource_type: number; resource_id: string; locale: string | null }) =>
    `${domain}:${t.resource_type}:${t.resource_id}:${t.locale ?? '∅'}`,
}));

import { useSaveSessionStore } from './index';
import { __resetHistoryBridge } from './history-bridge';

const ENTITY_ID = 'character/hero';
const KEY = 'book1|2|3|hero|'; // keyOf(book1, {step:2,rtype:3,resource_id:hero,locale:null})
const TARGET = { step: 2, resource_type: 3, resource_id: 'hero', locale: null };

function resetStore() {
  useSaveSessionStore.setState({ sessions: new Map() });
}

beforeEach(() => {
  __resetHistoryBridge();
  resetStore();
  h.lock.bookId = 'book1';
  h.lock.collabPersist = true;
  h.lock.myLocks = new Set();
  h.lock._lostCbs = {};
  h.lock.acquire.mockReset().mockResolvedValue({ ok: true });
  h.lock.save.mockReset().mockResolvedValue({ ok: true });
  h.lock.releaseAndSave.mockReset().mockResolvedValue(undefined);
  h.lock.addMyLock.mockReset();
  h.lock.removeMyLock.mockReset();
  h.lock.registerOnLost.mockClear();
  h.lock.unregisterOnLost.mockReset();
  h.snapshot.characters = [{ key: 'hero', name: 'A' }];
  h.snapshot.flushSnapshot.mockReset().mockResolvedValue(undefined);
  h.ess.beginHold.mockReset();
  h.ess.endHold.mockReset();
  h.ess.markSaving.mockReset();
  h.ess.markSaved.mockReset();
  h.hist.beginSession.mockReset();
  h.hist.endSession.mockReset();
});

describe('begin → held', () => {
  it('acquires, clones the projected baseline, holds, and bridges the header + undo', async () => {
    const status = await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID, null, {
      manageHeaderStatus: true,
    });
    expect(status).toBe('held');
    expect(h.lock.acquire).toHaveBeenCalledWith(TARGET);
    expect(h.lock.addMyLock).toHaveBeenCalledWith(TARGET);
    expect(h.ess.beginHold).toHaveBeenCalledTimes(1);
    expect(h.hist.beginSession).toHaveBeenCalledWith(
      'illustration-entity:3:hero:∅',
      { key: 'hero', name: 'A' },
      'illustration-entity',
    );
    const entry = useSaveSessionStore.getState().sessions.get(KEY);
    expect(entry?.status).toBe('held');
    expect(entry?.baseline).toEqual({ key: 'hero', name: 'A' });
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(false);
  });

  it('baseline is a CLONE — a later store mutation makes the session dirty', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(true);
  });

  it('manageHeaderStatus:false suppresses beginHold', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID, null, {
      manageHeaderStatus: false,
    });
    expect(h.ess.beginHold).not.toHaveBeenCalled();
  });
});

describe('409 → blocked', () => {
  it('does not hold, calls onBlocked, and never addMyLock/beginHold', async () => {
    h.lock.acquire.mockResolvedValue({ ok: false, holder: 'peer' });
    const onBlocked = vi.fn();
    const status = await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID, null, {
      onBlocked,
    });
    expect(status).toBe('blocked');
    expect(onBlocked).toHaveBeenCalledWith('peer');
    expect(h.lock.addMyLock).not.toHaveBeenCalled();
    expect(h.ess.beginHold).not.toHaveBeenCalled();
    expect(useSaveSessionStore.getState().sessions.get(KEY)?.status).toBe('blocked');
  });
});

describe('end — dirty gate', () => {
  it('CLEAN → releaseAndSave(dirty=false, no payload), no gateway save', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    await useSaveSessionStore.getState().end(KEY);
    expect(h.lock.releaseAndSave).toHaveBeenCalledWith(TARGET, false, undefined, 'book1');
    expect(h.lock.save).not.toHaveBeenCalled();
    expect(h.lock.removeMyLock).toHaveBeenCalledWith(TARGET);
    expect(h.hist.endSession).toHaveBeenCalledWith('illustration-entity:3:hero:∅');
    expect(useSaveSessionStore.getState().sessions.has(KEY)).toBe(false);
  });

  it('DIRTY → releaseAndSave(dirty=true, whole-node payload)', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    await useSaveSessionStore.getState().end(KEY);
    expect(h.lock.releaseAndSave).toHaveBeenCalledWith(
      TARGET,
      true,
      { action_type: 3, patch: { key: 'hero', name: 'B' }, log: true },
      'book1',
    );
  });
});

describe('saveNow — save while held', () => {
  it('dirty → gateway save + rebase baseline; returns "saved"', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    const outcome = await useSaveSessionStore.getState().saveNow(KEY);
    expect(outcome).toBe('saved');
    expect(h.lock.save).toHaveBeenCalledWith(TARGET, {
      action_type: 3,
      patch: { key: 'hero', name: 'B' },
      log: true,
    });
    // rebased → no longer dirty, and a release now must not double-save.
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(false);
  });

  it('clean → "clean", no gateway save', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    const outcome = await useSaveSessionStore.getState().saveNow(KEY);
    expect(outcome).toBe('clean');
    expect(h.lock.save).not.toHaveBeenCalled();
  });

  it('not held → "failed"', async () => {
    expect(await useSaveSessionStore.getState().saveNow(KEY)).toBe('failed');
  });
});

describe('onLost', () => {
  it('marks lost, drops the header hold, reverts via callback, and closes undo', async () => {
    const onLost = vi.fn();
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID, null, { onLost });
    // The heartbeat fires the registered lost cb.
    h.lock._lostCbs[KEY]();
    expect(useSaveSessionStore.getState().sessions.get(KEY)?.status).toBe('lost');
    expect(h.ess.endHold).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith({ key: 'hero', name: 'A' });
    expect(h.hist.endSession).toHaveBeenCalledWith('illustration-entity:3:hero:∅');
  });

  it('end() after lost does NOT release-save again (lock already gone)', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.lock._lostCbs[KEY]();
    h.hist.endSession.mockClear();
    await useSaveSessionStore.getState().end(KEY);
    expect(h.lock.releaseAndSave).not.toHaveBeenCalled();
    expect(h.lock.unregisterOnLost).toHaveBeenCalledWith(KEY);
    expect(useSaveSessionStore.getState().sessions.has(KEY)).toBe(false);
  });
});

describe('solo/collab persist fork (the SINGLE branch)', () => {
  it('solo (collabPersist=false at begin) → saveNow flushes the whole snapshot, no gateway save', async () => {
    h.lock.collabPersist = false; // captured false at begin
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    const outcome = await useSaveSessionStore.getState().saveNow(KEY);
    expect(outcome).toBe('saved');
    expect(h.snapshot.flushSnapshot).toHaveBeenCalledTimes(1);
    expect(h.lock.save).not.toHaveBeenCalled();
  });

  it('collab → saveNow uses the gateway save, not flushSnapshot', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    await useSaveSessionStore.getState().saveNow(KEY);
    expect(h.lock.save).toHaveBeenCalledTimes(1);
    expect(h.snapshot.flushSnapshot).not.toHaveBeenCalled();
  });

  it('C1 regression: a LIVE collabPersist flip to false between begin and end still release-saves via the gateway', async () => {
    // Mirrors the space unmount teardown-order: useCollabPersistSession disconnect() flips the live
    // flag BEFORE this cleanup. The captured begin-time value (true) must win, else the server lock
    // strands (parity with the OLD hook, which called releaseAndSave unconditionally).
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    h.lock.collabPersist = false; // teardown flip AFTER the session was captured collab
    await useSaveSessionStore.getState().end(KEY);
    expect(h.lock.releaseAndSave).toHaveBeenCalledWith(
      TARGET,
      true,
      { action_type: 3, patch: { key: 'hero', name: 'B' }, log: true },
      'book1',
    );
    expect(h.snapshot.flushSnapshot).not.toHaveBeenCalled();
  });
});

describe('rebaseBaseline (save-via-API bridge)', () => {
  it('re-anchors the baseline to the current node so a generate result is not counted dirty', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'generated';
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(true);
    useSaveSessionStore.getState().rebaseBaseline(KEY);
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(false);
  });
});
