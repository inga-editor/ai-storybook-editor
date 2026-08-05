// scene-space-single-session.test.ts — the SCENE-space single-session contract (Phase 06,
// 2026-08-05). Shapes are NO LONGER a SCENE-space item (retired the former dual-session): the SCENE
// space mounts ONLY the per-spread rtype-6 session (SCENE_OWNED_KEYS). This test pins the surviving
// invariant from the retired dual-session suite — **the rtype-6 SCENE patch NEVER contains
// `shapes`** — so a stray shape mutation can never ride the scene save. Shapes persist only through
// the OBJECTS-space rtype-10 held session (asserted in that space's own tests). Same mocked-store
// harness as index.test.ts (engine wiring only, no real I/O).

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
  type SpreadFixture = {
    id: string;
    manuscript: string;
    raw_images: unknown[];
    pages: unknown[];
    shapes: Array<Record<string, unknown>>;
    images: unknown[];
    textboxes: unknown[];
  };
  const snapshot = {
    characters: [] as unknown[],
    props: [] as unknown[],
    stages: [] as unknown[],
    illustration: { spreads: [] as SpreadFixture[] },
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

const SPREAD_ID = 'sp1';
const SCENE_KEY = 'book1|2|6|sp1|';
const RETOUCH_KEY = 'book1|3|10|sp1|';
const SCENE_TARGET = { step: 2, resource_type: 6, resource_id: SPREAD_ID, locale: null };

const BASE_SHAPE = { id: 'shp-0', type: 'rectangle', 'z-index': 3 };
const NEW_SHAPE = { id: 'shp-1', type: 'rectangle', 'z-index': 4 };

function seedSpread() {
  h.snapshot.illustration.spreads = [
    {
      id: SPREAD_ID,
      manuscript: 'draft',
      raw_images: [],
      pages: [{ number: 0 }],
      shapes: [{ ...BASE_SHAPE }],
      images: [],
      textboxes: [],
    },
  ];
}

function spread() {
  return h.snapshot.illustration.spreads[0];
}

async function beginScene() {
  return useSaveSessionStore.getState().begin('scene-spread', SPREAD_ID);
}

beforeEach(() => {
  __resetHistoryBridge();
  useSaveSessionStore.setState({ sessions: new Map() });
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
  h.snapshot.flushSnapshot.mockReset().mockResolvedValue(undefined);
  h.ess.beginHold.mockReset();
  h.ess.endHold.mockReset();
  h.ess.markSaving.mockReset();
  h.ess.markSaved.mockReset();
  h.hist.beginSession.mockReset();
  h.hist.endSession.mockReset();
  seedSpread();
});

describe('scene space mounts ONLY the rtype-6 session (Phase 06 — no dual-session)', () => {
  it('beginning the scene session creates the rtype-6 entry and NO rtype-10 entry', async () => {
    const scene = await beginScene();
    expect(scene).toBe('held');
    expect(h.lock.acquire).toHaveBeenCalledWith(SCENE_TARGET);

    const sessions = useSaveSessionStore.getState().sessions;
    expect(sessions.get(SCENE_KEY)?.status).toBe('held');
    expect(sessions.has(RETOUCH_KEY)).toBe(false);
    expect(sessions.size).toBe(1);

    // The SCENE baseline is the SCENE_OWNED_KEYS projection — it excludes `shapes` (a RETOUCH key).
    expect(sessions.get(SCENE_KEY)?.baseline).toMatchObject({ manuscript: 'draft' });
    expect(sessions.get(SCENE_KEY)?.baseline).not.toHaveProperty('shapes');
  });
});

describe('the SCENE (rtype-6) patch NEVER contains `shapes` (surviving invariant)', () => {
  it('a scene edit saves manuscript but never carries `shapes` — even with shapes dirty', async () => {
    await beginScene();
    spread().shapes.push({ ...NEW_SHAPE });
    spread().manuscript = 'edited';

    const outcome = await useSaveSessionStore.getState().saveNow(SCENE_KEY);
    expect(outcome).toBe('saved');
    const [target, payload] = h.lock.save.mock.calls[0] as [
      typeof SCENE_TARGET,
      { patch: Record<string, unknown> },
    ];
    expect(target).toEqual(SCENE_TARGET);
    expect(payload.patch.manuscript).toBe('edited');
    expect(payload.patch).not.toHaveProperty('shapes');
  });

  it('a shape-only mutation leaves the SCENE session clean (shapes ∉ the rtype-6 diff)', async () => {
    await beginScene();
    spread().shapes.push({ ...NEW_SHAPE });
    expect(await useSaveSessionStore.getState().saveNow(SCENE_KEY)).toBe('clean');
    expect(h.lock.save).not.toHaveBeenCalled();
  });

  it('the release-save payload is likewise shapes-free', async () => {
    await beginScene();
    spread().shapes.push({ ...NEW_SHAPE });
    spread().manuscript = 'edited';

    await useSaveSessionStore.getState().end(SCENE_KEY);
    expect(h.lock.releaseAndSave).toHaveBeenCalledTimes(1);
    const [target, , payload] = h.lock.releaseAndSave.mock.calls[0] as [
      typeof SCENE_TARGET,
      boolean,
      { patch: Record<string, unknown> },
    ];
    expect(target).toEqual(SCENE_TARGET);
    expect(payload.patch.manuscript).toBe('edited');
    expect(payload.patch).not.toHaveProperty('shapes');
    expect(useSaveSessionStore.getState().sessions.size).toBe(0);
  });
});
