// ensure-saved.test.ts — the tri-state `ensureSaved` (unified-item-save-spec §4.2). Held → saveNow;
// no session → one-shot acquire→save→release (create-fallback for client-mint nodes). The resource-
// lock / snapshot / status stores are mocked so the engine's wiring is asserted without real I/O
// (same seam as index.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const lock = {
    bookId: 'book1' as string | null,
    collabPersist: true,
    myLocks: new Set<string>(),
    acquire: vi.fn(async (_t: unknown) => ({ ok: true }) as { ok: boolean; holder?: string }),
    save: vi.fn(
      async (_t: unknown, _p: unknown) =>
        ({ ok: true }) as { ok: boolean; blocked?: boolean; lost?: boolean; forbidden?: boolean },
    ),
    release: vi.fn(async (_t: unknown) => {}),
    releaseAndSave: vi.fn(async () => {}),
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
    sketch: { characters: [], props: [], stages: [], base: {}, lineups: [], spreads: [] },
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

import { useSaveSessionStore, SAVE_POLICIES } from './index';
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
  h.lock.acquire.mockReset().mockResolvedValue({ ok: true });
  h.lock.save.mockReset().mockResolvedValue({ ok: true });
  h.lock.release.mockReset().mockResolvedValue(undefined);
  h.lock.releaseAndSave.mockReset().mockResolvedValue(undefined);
  h.lock.addMyLock.mockReset();
  h.lock.removeMyLock.mockReset();
  h.lock.registerOnLost.mockReset();
  h.lock.unregisterOnLost.mockReset();
  h.snapshot.characters = [{ key: 'hero', name: 'A' }];
  h.snapshot.flushSnapshot.mockReset().mockResolvedValue(undefined);
});

describe('ensureSaved — held branch', () => {
  it('held + dirty → saveNow (gateway save), returns "saved"', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    h.snapshot.characters[0].name = 'B'; // dirty
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('saved');
    expect(h.lock.save).toHaveBeenCalledWith(TARGET, {
      action_type: 3,
      patch: { key: 'hero', name: 'B' },
      log: true,
    });
    // No one-shot acquire — the held session's saveNow was used.
    expect(h.lock.acquire).toHaveBeenCalledTimes(1); // only the begin()'s acquire
    expect(h.lock.release).not.toHaveBeenCalled();
  });

  it('held + clean → "clean", no gateway save', async () => {
    await useSaveSessionStore.getState().begin('illustration-entity', ENTITY_ID);
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('clean');
    expect(h.lock.save).not.toHaveBeenCalled();
  });
});

describe('ensureSaved — one-shot (no session)', () => {
  it('acquire → save → release, returns "saved", and creates NO session entry', async () => {
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('saved');
    expect(h.lock.acquire).toHaveBeenCalledWith(TARGET);
    expect(h.lock.save).toHaveBeenCalledWith(TARGET, {
      action_type: 3,
      patch: { key: 'hero', name: 'A' },
      log: true,
    });
    expect(h.lock.release).toHaveBeenCalledWith(TARGET); // ALWAYS release
    // One-shot must NOT leave a SessionEntry (no lock kept, never swept).
    expect(useSaveSessionStore.getState().sessions.size).toBe(0);
  });

  it('one-shot always writes even when not dirty (no baseline to diff — parity with runLockedResourceSave)', async () => {
    // No begin() → no baseline. Even with an unchanged node, the one-shot persists once.
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('saved');
    expect(h.lock.save).toHaveBeenCalledTimes(1);
  });

  it('acquire 409 → "blocked", never saves, no session entry', async () => {
    h.lock.acquire.mockResolvedValue({ ok: false, holder: 'peer' });
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('blocked');
    expect(h.lock.save).not.toHaveBeenCalled();
    expect(h.lock.release).not.toHaveBeenCalled(); // no lock held → nothing to release
    expect(useSaveSessionStore.getState().sessions.size).toBe(0);
  });

  it('degraded/blocked save (ADR-047) → "blocked", still releases', async () => {
    h.lock.save.mockResolvedValue({ ok: false, blocked: true });
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('blocked');
    expect(h.lock.release).toHaveBeenCalledWith(TARGET);
  });

  it('save rejected (not blocked) → "failed", still releases', async () => {
    h.lock.save.mockResolvedValue({ ok: false, lost: true });
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('failed');
    expect(h.lock.release).toHaveBeenCalledWith(TARGET);
  });

  it('solo (collabPersist=false) → whole-snapshot flush, no acquire/save', async () => {
    h.lock.collabPersist = false;
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('saved');
    expect(h.snapshot.flushSnapshot).toHaveBeenCalledTimes(1);
    expect(h.lock.acquire).not.toHaveBeenCalled();
    expect(h.lock.save).not.toHaveBeenCalled();
  });
});

describe('ensureSaved — one-shot create-fallback (client-mint node)', () => {
  // sketch-image is the phase-4 domain that carries a `createFallback` (a generated spread page image
  // is minted client-side → a one-shot EDIT 404s → retry as a nested CREATE). Its `getNode` is a
  // phase-4 stub (null), so this test supplies a node + parses the parent from a composite id, exactly
  // as the phase-4 spread canvas will thread it — proving the engine attaches `create_fallback`.
  const COMPOSITE_ID = 'spread1/img1'; // "{parentSpreadId}/{imageId}"

  it('attaches create_fallback { parent_id, collection } to the one-shot save payload', async () => {
    const policy = SAVE_POLICIES['sketch-image'];
    const origGetNode = policy.getNode;
    policy.getNode = () => ({ id: 'img1', type: 'left' });
    try {
      const outcome = await useSaveSessionStore.getState().ensureSaved('sketch-image', COMPOSITE_ID);
      expect(outcome).toBe('saved');
      // The save payload carries the client-only create_fallback retry hint.
      const [, payload] = h.lock.save.mock.calls[0] as [unknown, { create_fallback?: unknown }];
      expect(payload.create_fallback).toEqual({ parent_id: 'spread1', collection: 'images' });
    } finally {
      policy.getNode = origGetNode;
    }
  });
});

describe('regression — auto-save during generate + rebase order (spec §4.4/§6)', () => {
  it('mid-generate auto-save persists the CURRENT node; a post-apply rebase then leaves it clean (no release double-write)', async () => {
    const store = useSaveSessionStore.getState();
    await store.begin('illustration-entity', ENTITY_ID);

    // 1. User edited text → dirty. An idle-sweep auto-save (saveNow) persists the node it sees NOW
    //    under the held lock — not a stale snapshot — so a tick landing mid-generate is safe.
    h.snapshot.characters[0].name = 'edited';
    expect(await store.saveNow(KEY)).toBe('saved');
    expect(h.lock.save).toHaveBeenLastCalledWith(TARGET, {
      action_type: 3,
      patch: { key: 'hero', name: 'edited' },
      log: true,
    });

    // 2. Generate result applied to the SAME node (the BE save_resource directive already wrote it;
    //    the FE mirrors the new version locally) → the node now differs from the baseline.
    h.snapshot.characters[0] = { key: 'hero', name: 'edited', version: 2 } as unknown as {
      key: string;
      name: string;
    };
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(true);

    // 3. FE rebases after apply (image-task-slice) → baseline == current → NOT dirty.
    useSaveSessionStore.getState().rebaseBaseline(KEY);
    expect(useSaveSessionStore.getState().isDirty(KEY)).toBe(false);

    // 4. end() therefore release-saves CLEAN — the generate result is not double-written.
    h.lock.save.mockClear();
    h.lock.releaseAndSave.mockClear();
    await useSaveSessionStore.getState().end(KEY);
    expect(h.lock.releaseAndSave).toHaveBeenCalledWith(TARGET, false, undefined, 'book1');
    expect(h.lock.save).not.toHaveBeenCalled();
  });
});

describe('ensureSaved — guards', () => {
  it('no book connected → "clean" (nothing to persist)', async () => {
    h.lock.bookId = null;
    expect(await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID)).toBe(
      'clean',
    );
  });

  it('one-shot with a missing local node → "failed" (never generate on a missing anchor)', async () => {
    h.snapshot.characters = []; // node gone
    const outcome = await useSaveSessionStore.getState().ensureSaved('illustration-entity', ENTITY_ID);
    expect(outcome).toBe('failed');
    expect(h.lock.acquire).not.toHaveBeenCalled();
  });
});
