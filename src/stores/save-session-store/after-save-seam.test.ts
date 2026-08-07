// after-save-seam.test.ts — the ENGINE seam `fireAfterSave` (independent of the support-languages
// hook). Injects a spy `afterSave` on a policy and asserts: it fires exactly once on a successful
// saveNow / end release; it is NOT fired on a clean save (no write); a THROW inside the hook is
// swallowed (saveNow still returns 'saved'); and the multi-book guard skips the hook when the open
// book differs from the session's captured book. Same mocked-store harness as index.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const lock = {
    bookId: 'book1' as string | null,
    collabPersist: true,
    myLocks: new Set<string>(),
    acquire: vi.fn(async (_t: unknown) => ({ ok: true }) as { ok: boolean; holder?: string }),
    save: vi.fn(async (_t: unknown, _p: unknown) => ({ ok: true }) as { ok: boolean; blocked?: boolean }),
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
    illustration: { spreads: [] as unknown[] },
    sketch: { characters: [], props: [], stages: [], base: {}, lineups: [] },
    flushSnapshot: vi.fn(async () => {}),
  };
  const ess = { beginHold: vi.fn(), endHold: vi.fn(), markSaving: vi.fn(), markSaved: vi.fn() };
  const hist = { beginSession: vi.fn(), endSession: vi.fn() };
  const book = { currentBook: { id: 'book1' } as { id: string } | null };
  return { lock, snapshot, ess, hist, book };
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
vi.mock('@/stores/book-store', () => ({ useBookStore: { getState: () => h.book } }));
vi.mock('@/stores/edit-session-status-store', () => ({
  useEditSessionStatusStore: { getState: () => h.ess },
}));
vi.mock('@/stores/edit-history-store', () => ({ useEditHistoryStore: { getState: () => h.hist } }));
vi.mock('@/stores/edit-history-store/item-key', () => ({
  buildItemKey: (domain: string, t: { resource_type: number; resource_id: string; locale: string | null }) =>
    `${domain}:${t.resource_type}:${t.resource_id}:${t.locale ?? '∅'}`,
}));

import { useSaveSessionStore, SAVE_POLICIES } from './index';
import { __resetHistoryBridge } from './history-bridge';
import { maybeStopSweep } from './idle-sweep';

// Drive the seam on `illustration-entity`: force a locking mode (whole-node payload keeps the
// assertions simple) and inject a spy afterSave. Both restored after each test.
const ORIG_LOCKING = SAVE_POLICIES['illustration-entity'].locking;
const ORIG_AFTER_SAVE = SAVE_POLICIES['illustration-entity'].afterSave;
const afterSaveSpy = vi.fn((_id: string) => {});

const ENTITY_ID = 'character/hero';
const KEY = 'book1|2|3|hero|';

const store = () => useSaveSessionStore.getState();

beforeEach(() => {
  __resetHistoryBridge();
  useSaveSessionStore.setState({ sessions: new Map() });
  SAVE_POLICIES['illustration-entity'].locking = 'whole-spread';
  SAVE_POLICIES['illustration-entity'].afterSave = afterSaveSpy;
  afterSaveSpy.mockReset().mockImplementation(() => {});
  h.lock.bookId = 'book1';
  h.lock.collabPersist = true;
  h.lock.acquire.mockReset().mockResolvedValue({ ok: true });
  h.lock.save.mockReset().mockResolvedValue({ ok: true });
  h.lock.releaseAndSave.mockReset().mockResolvedValue(undefined);
  h.lock.addMyLock.mockReset();
  h.lock.removeMyLock.mockReset();
  h.lock.registerOnLost.mockReset();
  h.lock.unregisterOnLost.mockReset();
  h.snapshot.characters = [{ key: 'hero', name: 'A' }];
  h.ess.beginHold.mockReset();
  h.ess.endHold.mockReset();
  h.ess.markSaving.mockReset();
  h.ess.markSaved.mockReset();
  h.hist.beginSession.mockReset();
  h.hist.endSession.mockReset();
  h.book.currentBook = { id: 'book1' };
});

afterEach(() => {
  SAVE_POLICIES['illustration-entity'].locking = ORIG_LOCKING;
  SAVE_POLICIES['illustration-entity'].afterSave = ORIG_AFTER_SAVE;
  useSaveSessionStore.setState({ sessions: new Map() });
  maybeStopSweep(() => useSaveSessionStore.getState());
});

describe('fireAfterSave seam', () => {
  it('saveNow SUCCESS fires afterSave exactly once with the item id', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B'; // dirty
    const outcome = await store().saveNow(KEY);
    expect(outcome).toBe('saved');
    expect(afterSaveSpy).toHaveBeenCalledTimes(1);
    expect(afterSaveSpy).toHaveBeenCalledWith(ENTITY_ID);
  });

  it("saveNow 'clean' (not dirty) does NOT fire afterSave", async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    const outcome = await store().saveNow(KEY); // no mutation → clean
    expect(outcome).toBe('clean');
    expect(afterSaveSpy).not.toHaveBeenCalled();
  });

  it('saveNow rejected (save not ok) does NOT fire afterSave', async () => {
    h.lock.save.mockResolvedValue({ ok: false });
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    const outcome = await store().saveNow(KEY);
    expect(outcome).toBe('failed');
    expect(afterSaveSpy).not.toHaveBeenCalled();
  });

  it('a THROW inside afterSave is swallowed — saveNow still returns "saved"', async () => {
    afterSaveSpy.mockImplementation(() => {
      throw new Error('hook boom');
    });
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    const outcome = await store().saveNow(KEY);
    expect(outcome).toBe('saved'); // save flow intact despite the throwing hook
    expect(afterSaveSpy).toHaveBeenCalledTimes(1);
  });

  it('end() DIRTY release fires afterSave once (after the fire-and-forget persist resolves)', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    await store().end(KEY);
    await Promise.resolve(); // let the release .then settle
    expect(afterSaveSpy).toHaveBeenCalledTimes(1);
    expect(afterSaveSpy).toHaveBeenCalledWith(ENTITY_ID);
  });

  it('end() CLEAN release does NOT fire afterSave', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    await store().end(KEY); // no mutation → clean release
    await Promise.resolve();
    expect(afterSaveSpy).not.toHaveBeenCalled();
  });

  it('multi-book guard: open book differs from session book → afterSave skipped', async () => {
    await store().begin('illustration-entity', ENTITY_ID); // captured book1
    h.snapshot.characters[0].name = 'B';
    h.book.currentBook = { id: 'book2' }; // user switched tabs to another book
    const outcome = await store().saveNow(KEY);
    expect(outcome).toBe('saved'); // the SAVE still happens
    expect(afterSaveSpy).not.toHaveBeenCalled(); // but the recompute is guarded off
  });
});
