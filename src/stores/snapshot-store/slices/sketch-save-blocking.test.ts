// sketch-save-blocking.test.ts — T3 (ADR-047 phase-04): a DEGRADED resource must be refused on
// EVERY write path, healthy siblings must keep saving (isolation), and a blocked release must
// still unlock (never strand a lock). The gateway seam (`callImageApi`) is the mock boundary, so
// the REAL guard code in resource-lock-store + resource-lock-api runs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock supabase so importing the real stores never initialises a client.
vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
    rpc: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

// THE gateway seam: every lock/save/reorder call funnels through callImageApi.
const callImageApi = vi.fn();
vi.mock('@/apis/image-api-client', () => ({
  callImageApi: (...a: unknown[]) => callImageApi(...a),
}));

import { useResourceLockStore, type LockTarget } from '@/stores/resource-lock-store';
import { reorderResource } from '@/apis/resource-lock-api';
// Importing snapshot-store INSTALLS the write-blocker predicate (module-init side effect).
import { useSnapshotStore } from '@/stores/snapshot-store';
import { supabase } from '@/apis/supabase';
import { flushSketchBaseSheetUnderLock } from './collab-sketch-base-sheet-save-helper';

const BOOK = 'book-1';

const sheetTarget: LockTarget = { step: 1, resource_type: 11, resource_id: 'character_sheet', locale: null };
const heroTarget: LockTarget = { step: 1, resource_type: 3, resource_id: 'hero', locale: null };
const villainTarget: LockTarget = { step: 1, resource_type: 3, resource_id: 'villain', locale: null };

const degrade = (resource: string) =>
  useSnapshotStore.getState().markSketchDegraded([
    { resource: resource as never, path: resource, message: 'hỏng', sig: 's1', raw: { broken: true } },
  ]);

const payload = { action_type: 3 as const, patch: { styles: [] }, log: true };

describe('sketch save-blocking (T3 — 4 write paths + isolation + no stranded lock)', () => {
  beforeEach(() => {
    callImageApi.mockReset();
    callImageApi.mockResolvedValue({
      success: true,
      snapshot_id: 'snap-1',
      updated_at: 'now',
      log_id: 'log-1',
      lock: { holder_user_id: 'me', acquired_at: 'a', expires_at: 'e' },
      released: true,
    });
    useResourceLockStore.setState({ bookId: BOOK, collabPersist: true, myLocks: new Set() });
    useSnapshotStore.setState((s) => {
      s.sketchDegraded = [];
      s.sketchQuarantine = {};
      s.meta.bookId = BOOK;
      s.sync.isDirty = false;
      s.sync.isSaving = false;
    });
  });

  it('store.save() refuses a degraded target — nothing reaches the gateway', async () => {
    degrade('base.character_sheet');
    const res = await useResourceLockStore.getState().save(sheetTarget, payload);
    expect(res.ok).toBe(false);
    expect((res as { blocked?: boolean }).blocked).toBe(true);
    expect(callImageApi).not.toHaveBeenCalled();
  });

  it('ISOLATION: degraded characters/hero blocks hero but villain still saves', async () => {
    degrade('characters/hero');
    const blocked = await useResourceLockStore.getState().save(heroTarget, payload);
    expect(blocked.ok).toBe(false);
    expect(callImageApi).not.toHaveBeenCalled();

    const okRes = await useResourceLockStore.getState().save(villainTarget, payload);
    expect(okRes.ok).toBe(true);
    expect(callImageApi).toHaveBeenCalledTimes(1);
    expect(callImageApi.mock.calls[0][0]).toBe('/api/resource/save');
  });

  it('releaseAndSave() on a degraded target SKIPS the save but STILL unlocks (no stranded lock)', async () => {
    degrade('base.character_sheet');
    await useResourceLockStore.getState().releaseAndSave(sheetTarget, true, payload, BOOK);
    const paths = callImageApi.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain('/api/resource/save');
    expect(paths).toContain('/api/resource/unlock'); // lock released — never stranded
  });

  it('releaseAndSave() on a healthy target still saves then unlocks (guard is surgical)', async () => {
    await useResourceLockStore.getState().releaseAndSave(villainTarget, true, payload, BOOK);
    const paths = callImageApi.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(['/api/resource/save', '/api/resource/unlock']);
  });

  it('generate-job flush path (flushSketchBaseSheetUnderLock → store.save) is blocked too', async () => {
    degrade('base.character_sheet');
    // ⚡ phase-3: the helper delegates to the engine's `ensureSaved`; a degraded resource is refused
    // by the write-blocker → outcome `'blocked'` (was boolean `false` pre-phase-3), no gateway save.
    const key = `${BOOK}|1|11|character_sheet|`;
    useResourceLockStore.setState({ myLocks: new Set([key]) });
    const ok = await flushSketchBaseSheetUnderLock('characters', { styles: [] });
    expect(ok).toBe('blocked');
    expect(callImageApi.mock.calls.map((c) => c[0])).not.toContain('/api/resource/save');
  });

  it('reorderResource (store-bypass path) is refused for a degraded spread collection', async () => {
    degrade('spreads');
    const res = await reorderResource({
      bookId: BOOK,
      step: 1,
      resourceType: 6,
      resourceId: 'sp-1',
      orderedIds: ['sp-1', 'sp-2'],
    });
    expect(res.ok).toBe(false);
    expect((res as { code: string }).code).toBe('DEGRADED_BLOCKED');
    expect(callImageApi).not.toHaveBeenCalled();
  });

  it('reorderResource proceeds when nothing is degraded', async () => {
    const res = await reorderResource({
      bookId: BOOK,
      step: 1,
      resourceType: 6,
      resourceId: 'sp-1',
      orderedIds: ['sp-1', 'sp-2'],
    });
    expect(res.ok).toBe(true);
    expect(callImageApi.mock.calls[0][0]).toBe('/api/resource/reorder');
  });

  it('a degraded node-grain spread blocks the whole-collection import sentinel too', async () => {
    degrade('spreads/sp-1');
    const sentinel: LockTarget = { step: 1, resource_type: 6, resource_id: 'spreads', locale: null };
    const res = await useResourceLockStore.getState().save(sentinel, { ...payload, collection: 'spreads' });
    expect(res.ok).toBe(false);
    expect(callImageApi).not.toHaveBeenCalled();
  });

  it('a degraded node-grain spread ALSO blocks rtype 1/2 child writes (coarse, fail-safe)', async () => {
    degrade('spreads/sp-1');
    const imageChild: LockTarget = { step: 1, resource_type: 1, resource_id: 'img-uuid', locale: null };
    const res = await useResourceLockStore.getState().save(imageChild, payload);
    expect(res.ok).toBe(false);
    expect(callImageApi).not.toHaveBeenCalled();
  });

  it("root 'sketch' degradation blocks every step-1 write but NOT other steps", async () => {
    degrade('sketch');
    const step1 = await useResourceLockStore.getState().save(villainTarget, payload);
    expect(step1.ok).toBe(false);
    const step2: LockTarget = { step: 2, resource_type: 6, resource_id: 'sp-1', locale: null };
    const okRes = await useResourceLockStore.getState().save(step2, payload);
    expect(okRes.ok).toBe(true);
  });

  it('consent (resolveSketchDegraded) reopens the save path without re-installing anything', async () => {
    degrade('base.character_sheet');
    expect((await useResourceLockStore.getState().save(sheetTarget, payload)).ok).toBe(false);
    useSnapshotStore.getState().resolveSketchDegraded(['base.character_sheet']);
    expect((await useResourceLockStore.getState().save(sheetTarget, payload)).ok).toBe(true);
  });
});

describe('whole-snapshot writes under degraded state (layer 2 — coarse)', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockClear();
    useResourceLockStore.setState({ bookId: BOOK, collabPersist: false });
    useSnapshotStore.setState((s) => {
      s.sketchDegraded = [];
      s.sketchQuarantine = {};
      s.meta.bookId = BOOK;
      s.sync.isDirty = true;
      s.sync.isSaving = false;
    });
  });

  it('autoSaveSnapshot is suppressed while ANY sketch resource is degraded (phase-04 I2)', async () => {
    degrade('base.character_sheet');
    await useSnapshotStore.getState().autoSaveSnapshot();
    expect(supabase.from).not.toHaveBeenCalled(); // no whole-column write ever started
    expect(useSnapshotStore.getState().sync.isDirty).toBe(true); // nothing pretended to save
  });

  it('saveSnapshot (manual publish) is suppressed too', async () => {
    degrade('props');
    await useSnapshotStore.getState().saveSnapshot();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
