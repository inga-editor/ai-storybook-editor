// scene-retouch-dual-session.test.ts — the SCENE-space dual-session contract (ADR-044 addendum
// 2026-08-05): a spread's SCENE (rtype 6) and RETOUCH (rtype 10) sessions coexist on the SAME
// spreadId as independent entries, and every save projects ONLY its own owned-key partition.
// Pins the defect fix "shapes edited from the scene space are silently dropped": the shapes diff
// must land in the rtype-10 patch and must NEVER appear in the rtype-6 patch. Same mocked-store
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
const RETOUCH_TARGET = { step: 3, resource_type: 10, resource_id: SPREAD_ID, locale: null };

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

async function beginBoth(opts?: { onLostRetouch?: (baseline: unknown) => void }) {
  const store = useSaveSessionStore.getState();
  const scene = await store.begin('scene-spread', SPREAD_ID);
  const retouch = await store.begin('retouch-spread', SPREAD_ID, null, {
    onLost: opts?.onLostRetouch,
  });
  return { scene, retouch };
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

describe('dual-session coexistence (same spreadId, two grains)', () => {
  it('scene + retouch sessions hold simultaneously as DISTINCT entries', async () => {
    const { scene, retouch } = await beginBoth();
    expect(scene).toBe('held');
    expect(retouch).toBe('held');
    const sessions = useSaveSessionStore.getState().sessions;
    expect(sessions.get(SCENE_KEY)?.status).toBe('held');
    expect(sessions.get(RETOUCH_KEY)?.status).toBe('held');
    expect(h.lock.acquire).toHaveBeenCalledWith(SCENE_TARGET);
    expect(h.lock.acquire).toHaveBeenCalledWith(RETOUCH_TARGET);
    // Baselines are partition projections of the SAME node.
    expect(sessions.get(SCENE_KEY)?.baseline).toMatchObject({ manuscript: 'draft' });
    expect(sessions.get(SCENE_KEY)?.baseline).not.toHaveProperty('shapes');
    expect(sessions.get(RETOUCH_KEY)?.baseline).toMatchObject({ shapes: [BASE_SHAPE] });
    expect(sessions.get(RETOUCH_KEY)?.baseline).not.toHaveProperty('manuscript');
  });
});

describe('shapes persist through the RETOUCH patch only (the defect fix)', () => {
  it('a shape add lands in the rtype-10 saveNow patch, intact', async () => {
    await beginBoth();
    spread().shapes.push({ ...NEW_SHAPE });
    const outcome = await useSaveSessionStore.getState().saveNow(RETOUCH_KEY);
    expect(outcome).toBe('saved');
    expect(h.lock.save).toHaveBeenCalledTimes(1);
    const [target, payload] = h.lock.save.mock.calls[0] as [
      typeof RETOUCH_TARGET,
      { action_type: number; patch: Record<string, unknown>; log: boolean },
    ];
    expect(target).toEqual(RETOUCH_TARGET);
    expect(payload.patch.shapes).toEqual([BASE_SHAPE, NEW_SHAPE]);
    // Partition purity: the retouch patch never carries scene keys.
    expect(payload.patch).not.toHaveProperty('manuscript');
    expect(payload.patch).not.toHaveProperty('raw_images');
  });

  it('the SCENE patch NEVER contains `shapes` — even when both partitions are dirty', async () => {
    await beginBoth();
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

  it('a shape-only edit leaves the SCENE session clean (no rtype-6 save fires)', async () => {
    await beginBoth();
    spread().shapes.push({ ...NEW_SHAPE });
    expect(await useSaveSessionStore.getState().saveNow(SCENE_KEY)).toBe('clean');
    expect(h.lock.save).not.toHaveBeenCalled();
  });

  it('a scene-only edit (manuscript) leaves the RETOUCH session clean', async () => {
    await beginBoth();
    spread().manuscript = 'edited';
    expect(await useSaveSessionStore.getState().saveNow(RETOUCH_KEY)).toBe('clean');
    expect(h.lock.save).not.toHaveBeenCalled();
    expect(await useSaveSessionStore.getState().saveNow(SCENE_KEY)).toBe('saved');
  });
});

describe('LOST isolation per partition', () => {
  it('retouch LOST hands back ONLY the retouch baseline and leaves the scene session held', async () => {
    const onLostRetouch = vi.fn();
    await beginBoth({ onLostRetouch });
    spread().shapes.push({ ...NEW_SHAPE });
    spread().manuscript = 'edited';

    h.lock._lostCbs[RETOUCH_KEY]();

    // The revert callback receives the RETOUCH projection captured at begin — no scene keys —
    // so the space's revertRetouchOwnedSubtree(...) can never clobber scene edits.
    expect(onLostRetouch).toHaveBeenCalledTimes(1);
    const baseline = onLostRetouch.mock.calls[0][0] as Record<string, unknown>;
    expect(baseline.shapes).toEqual([BASE_SHAPE]);
    expect(baseline).not.toHaveProperty('manuscript');

    const sessions = useSaveSessionStore.getState().sessions;
    expect(sessions.get(RETOUCH_KEY)?.status).toBe('lost');
    expect(sessions.get(SCENE_KEY)?.status).toBe('held');
    // Scene keeps working: its dirty diff still saves.
    void useSaveSessionStore.getState().saveNow(SCENE_KEY);
  });
});

describe('release coupling — leaving the spread ends both sessions independently', () => {
  it('two end() calls → two independent release-saves with partition-pure payloads', async () => {
    await beginBoth();
    spread().shapes.push({ ...NEW_SHAPE });
    spread().manuscript = 'edited';
    const store = useSaveSessionStore.getState();
    await store.end(SCENE_KEY);
    await store.end(RETOUCH_KEY);
    expect(h.lock.releaseAndSave).toHaveBeenCalledTimes(2);
    const payloads = h.lock.releaseAndSave.mock.calls.map(
      (c) => [c[0], c[2]] as [typeof SCENE_TARGET, { patch: Record<string, unknown> }],
    );
    const scenePayload = payloads.find(([t]) => t.resource_type === 6)?.[1];
    const retouchPayload = payloads.find(([t]) => t.resource_type === 10)?.[1];
    expect(scenePayload?.patch.manuscript).toBe('edited');
    expect(scenePayload?.patch).not.toHaveProperty('shapes');
    expect(retouchPayload?.patch.shapes).toEqual([BASE_SHAPE, NEW_SHAPE]);
    expect(retouchPayload?.patch).not.toHaveProperty('manuscript');
    expect(useSaveSessionStore.getState().sessions.size).toBe(0);
  });
});
