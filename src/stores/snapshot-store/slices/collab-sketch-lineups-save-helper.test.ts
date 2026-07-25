import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LINEUP_LOCK_TARGET,
  LINEUP_RESOURCE_ID,
  resolveLineupsLockTarget,
  buildSketchLineupsPayload,
  flushSketchLineupsUnderLock,
} from './collab-sketch-lineups-save-helper';
import type { SketchLineupTab } from '@/types/sketch';

// Mutable lock-store state so each test drives collabPersist / myLocks / acquire·save outcomes.
const h = vi.hoisted(() => {
  const state = {
    collabPersist: false as boolean,
    bookId: 'book-1' as string | null,
    myLocks: new Set<string>(),
    acquire: vi.fn(async (_t: unknown) => ({ ok: true }) as { ok: boolean; holder?: string }),
    save: vi.fn(async (_t: unknown, _p: unknown) => ({ ok: true }) as { ok: boolean; lost?: boolean; forbidden?: boolean }),
    release: vi.fn(async (_t: unknown) => {}),
  };
  return { state };
});

vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.state },
  keyOf: (bookId: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${bookId}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
}));
vi.mock('@/utils/collab-save-toasts', () => ({ toastLockedByOther: vi.fn() }));
vi.mock('./collab-image-save-helper', () => ({ resolveLockHolderName: () => 'Peer' }));

const TABS: SketchLineupTab[] = [
  { id: 't1', name: 'Lineup', entries: [{ kind: 'characters', entity_key: 'elara', variant_key: 'base' }] },
];

beforeEach(() => {
  h.state.collabPersist = false;
  h.state.bookId = 'book-1';
  h.state.myLocks = new Set();
  h.state.acquire.mockReset().mockResolvedValue({ ok: true });
  h.state.save.mockReset().mockResolvedValue({ ok: true });
  h.state.release.mockReset().mockResolvedValue(undefined);
});

describe('resolveLineupsLockTarget', () => {
  it('maps to step 1 / rtype 12 / sentinel resource_id "lineups" / no locale', () => {
    expect(resolveLineupsLockTarget()).toEqual({
      step: 1,
      resource_type: 12,
      resource_id: 'lineups',
      locale: null,
    });
    expect(LINEUP_LOCK_TARGET).toEqual(resolveLineupsLockTarget());
    expect(LINEUP_RESOURCE_ID).toBe('lineups');
  });
});

describe('buildSketchLineupsPayload', () => {
  it('is COLLECTION-SCOPE: LIST patch + collection "lineups" + action_type 3 + log:true', () => {
    const p = buildSketchLineupsPayload(TABS);
    expect(p).toEqual({ action_type: 3, patch: TABS, collection: 'lineups', log: true });
    // The gateway infers collection scope from isinstance(patch, list) — a dict patch is a 400.
    expect(Array.isArray(p.patch)).toBe(true);
    // NO parent_id — its presence would route the save off the column-root path.
    expect('parent_id' in p).toBe(false);
  });
});

describe('flushSketchLineupsUnderLock', () => {
  it('solo (collabPersist=false) → no-op true, never touches the gateway', async () => {
    const ok = await flushSketchLineupsUnderLock(TABS);
    expect(ok).toBe(true);
    expect(h.state.acquire).not.toHaveBeenCalled();
    expect(h.state.save).not.toHaveBeenCalled();
  });

  it('collab + NOT already held → acquires then saves the whole array, KEEPS the lock (default)', async () => {
    h.state.collabPersist = true;
    const ok = await flushSketchLineupsUnderLock(TABS);
    expect(ok).toBe(true);
    expect(h.state.acquire).toHaveBeenCalledTimes(1);
    expect(h.state.save).toHaveBeenCalledWith(
      { step: 1, resource_type: 12, resource_id: 'lineups', locale: null },
      { action_type: 3, patch: TABS, collection: 'lineups', log: true },
    );
    expect(h.state.release).not.toHaveBeenCalled();
  });

  it('collab + already held → skips acquire, just saves, KEEPS the lock', async () => {
    h.state.collabPersist = true;
    h.state.myLocks = new Set(['book-1|1|12|lineups|']);
    const ok = await flushSketchLineupsUnderLock(TABS, { releaseIfAcquired: true });
    expect(ok).toBe(true);
    expect(h.state.acquire).not.toHaveBeenCalled();
    expect(h.state.save).toHaveBeenCalledTimes(1);
    expect(h.state.release).not.toHaveBeenCalled(); // held-session owns it → never release
  });

  it('collab + acquire 409 (peer holds) → false, mutation-side save NEVER issued', async () => {
    h.state.collabPersist = true;
    h.state.acquire.mockResolvedValueOnce({ ok: false, holder: 'peer-id' });
    const ok = await flushSketchLineupsUnderLock(TABS);
    expect(ok).toBe(false);
    expect(h.state.save).not.toHaveBeenCalled();
  });

  it('collab + save forbidden → false (+ toast path)', async () => {
    h.state.collabPersist = true;
    h.state.save.mockResolvedValueOnce({ ok: false, forbidden: true });
    const ok = await flushSketchLineupsUnderLock(TABS);
    expect(ok).toBe(false);
  });

  it('releaseIfAcquired + NOT held → one-shot: acquires + saves + RELEASES', async () => {
    h.state.collabPersist = true;
    const ok = await flushSketchLineupsUnderLock(TABS, { releaseIfAcquired: true });
    expect(ok).toBe(true);
    expect(h.state.release).toHaveBeenCalledWith(
      { step: 1, resource_type: 12, resource_id: 'lineups', locale: null },
    );
  });

  it('no bookId while collab → false (defensive)', async () => {
    h.state.collabPersist = true;
    h.state.bookId = null;
    const ok = await flushSketchLineupsUnderLock(TABS);
    expect(ok).toBe(false);
    expect(h.state.acquire).not.toHaveBeenCalled();
  });

  it('an EMPTY tabs array still saves (uncheck-to-empty is a legitimate write)', async () => {
    h.state.collabPersist = true;
    const ok = await flushSketchLineupsUnderLock([]);
    expect(ok).toBe(true);
    expect(h.state.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ patch: [] }),
    );
  });
});
