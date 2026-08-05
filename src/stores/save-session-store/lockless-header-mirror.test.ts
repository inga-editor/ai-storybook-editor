// lockless-header-mirror.test.ts — the dirty-driven header hold for lockless sessions (fix for
// "every lockless space shows a permanent Unsaved", 2026-08-05). Contract under test:
//   1. begin (clean) → NO hold — merely selecting an item must read "Saved".
//   2. first edit (dirty flip) → beginHold ONCE (header "Unsaved").
//   3. baseline rebase after saveNow (clean flip) → endHold ONCE (header back to "Saved").
//   4. locked (`locking !== 'none'`) and manageHeaderStatus:false sessions never drive the mirror.
//   5. transitions are edge-triggered — repeated reconciles at the same dirtiness are no-ops.
// Uses the same mocked-store harness as lockless-session.test.ts. The snapshot mock is a plain
// object (no `subscribe`), so tests drive `reconcileLocklessHeaderMirror` directly — in production
// the zustand subscriptions call it on every snapshot/session store write.

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
  return { lock, snapshot, ess, hist };
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
vi.mock('@/apis/resource-lock-api', () => ({ saveResource: vi.fn(async () => ({ ok: true })) }));
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
import {
  reconcileLocklessHeaderMirror,
  __resetLocklessHeaderMirror,
} from './lockless-header-mirror';

const ENTITY_ID = 'character/hero'; // illustration-entity — lockless in production
const KEY = 'book1|2|3|hero|';

const store = () => useSaveSessionStore.getState();
const reconcile = () => reconcileLocklessHeaderMirror(store);

beforeEach(() => {
  __resetHistoryBridge();
  __resetLocklessHeaderMirror();
  useSaveSessionStore.setState({ sessions: new Map() });
  h.lock.bookId = 'book1';
  h.lock.collabPersist = true;
  h.lock.save.mockReset().mockResolvedValue({ ok: true });
  h.lock.acquire.mockReset().mockResolvedValue({ ok: true });
  h.lock.releaseAndSave.mockReset().mockResolvedValue(undefined);
  h.snapshot.characters = [{ key: 'hero', name: 'A' }];
  h.ess.beginHold.mockReset();
  h.ess.endHold.mockReset();
  h.ess.markSaving.mockReset();
  h.ess.markSaved.mockReset();
});

afterEach(() => {
  useSaveSessionStore.setState({ sessions: new Map() });
  maybeStopSweep(store);
  __resetLocklessHeaderMirror();
});

describe('dirty-driven hold (lockless)', () => {
  it('clean session → no hold; first edit → beginHold once; rebase → endHold once', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    reconcile(); // production: fired by the session-store write in begin
    expect(h.ess.beginHold).not.toHaveBeenCalled(); // selection alone must read "Saved"

    h.snapshot.characters[0].name = 'B'; // user edit → dirty
    reconcile(); // production: fired by the snapshot-store write
    expect(h.ess.beginHold).toHaveBeenCalledTimes(1); // header "Unsaved"
    reconcile(); // same dirtiness again → edge-triggered, no double hold
    expect(h.ess.beginHold).toHaveBeenCalledTimes(1);
    expect(h.ess.endHold).not.toHaveBeenCalled();

    await store().saveNow(KEY); // persists + rebases baseline (its patchEntry reconciles in prod)
    reconcile();
    expect(h.ess.endHold).toHaveBeenCalledTimes(1); // clean again → header "Saved"
  });

  it('end() of a dirty session releases the mirrored hold via the dropEntry reconcile', async () => {
    await store().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B';
    reconcile();
    expect(h.ess.beginHold).toHaveBeenCalledTimes(1);
    await store().end(KEY); // dropEntry → sessions empty
    reconcile();
    expect(h.ess.endHold).toHaveBeenCalledTimes(1);
  });

  it('manageHeaderStatus:false session never drives the mirror', async () => {
    await store().begin('illustration-entity', ENTITY_ID, null, { manageHeaderStatus: false });
    h.snapshot.characters[0].name = 'B';
    reconcile();
    expect(h.ess.beginHold).not.toHaveBeenCalled();
  });

  it('locked sessions are skipped (their begin/end own the hold directly)', async () => {
    h.snapshot.illustration.spreads = [{ id: 'sp1', manuscript: 'x' }];
    await store().begin('scene-spread', 'sp1'); // locking ≠ none → begin-time beginHold (unchanged)
    h.ess.beginHold.mockReset(); // isolate the mirror from the locked begin's own hold
    h.snapshot.illustration.spreads[0].manuscript = 'edited'; // locked session dirty
    reconcile();
    expect(h.ess.beginHold).not.toHaveBeenCalled(); // mirror ignores locked sessions
  });
});
