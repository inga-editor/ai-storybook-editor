import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SKETCH_KIND_TO_RESOURCE_TYPE,
  resolveSketchVariantLockTarget,
  buildSketchEntityPayload,
  flushSketchEntityUnderLock,
} from './collab-sketch-variant-save-helper';

// Mutable lock-store state so each test drives collabPersist / myLocks / acquire·save outcomes.
// vi.hoisted → available inside the hoisted vi.mock factory.
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

// keyOf mirrors the real composite key so myLocks.has() checks resolve the same string.
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.state },
  keyOf: (bookId: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${bookId}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
}));
vi.mock('@/utils/collab-save-toasts', () => ({ toastLockedByOther: vi.fn() }));
vi.mock('./collab-image-save-helper', () => ({ resolveLockHolderName: () => 'Peer' }));

const NODE = { key: 'kid', variants: [{ key: 'hero' }] };

beforeEach(() => {
  h.state.collabPersist = false;
  h.state.bookId = 'book-1';
  h.state.myLocks = new Set();
  h.state.acquire.mockReset().mockResolvedValue({ ok: true });
  h.state.save.mockReset().mockResolvedValue({ ok: true });
  h.state.release.mockReset().mockResolvedValue(undefined);
});

describe('resolveSketchVariantLockTarget', () => {
  it('maps character → step 1 / rtype 3, whole-node target', () => {
    expect(resolveSketchVariantLockTarget('characters', 'kid')).toEqual({
      step: 1,
      resource_type: 3,
      resource_id: 'kid',
      locale: null,
    });
  });
  it('maps prop → step 1 / rtype 4', () => {
    expect(resolveSketchVariantLockTarget('props', 'sword')).toEqual({
      step: 1,
      resource_type: 4,
      resource_id: 'sword',
      locale: null,
    });
  });
  it('maps alter_characters → step 1 / rtype 3 (same node type as a character)', () => {
    // An alter IS a `characters[]` entity: same rtype, same grant; the entity key disambiguates.
    expect(resolveSketchVariantLockTarget('alter_characters', 'kid_alt')).toEqual({
      step: 1,
      resource_type: 3,
      resource_id: 'kid_alt',
      locale: null,
    });
  });
  it('constant matches the resolver (char 3 · prop 4 · alter 3)', () => {
    expect(SKETCH_KIND_TO_RESOURCE_TYPE).toEqual({ characters: 3, props: 4, alter_characters: 3 });
  });
});

describe('buildSketchEntityPayload', () => {
  it('wraps the whole node as an edit (action_type 3) with log:true', () => {
    expect(buildSketchEntityPayload(NODE)).toEqual({ action_type: 3, patch: NODE, log: true });
  });
});

describe('flushSketchEntityUnderLock', () => {
  it('solo (collabPersist=false) → no-op true, never touches the gateway', async () => {
    const ok = await flushSketchEntityUnderLock('characters', 'kid', NODE);
    expect(ok).toBe(true);
    expect(h.state.acquire).not.toHaveBeenCalled();
    expect(h.state.save).not.toHaveBeenCalled();
  });

  it('collab + NOT already held → acquires then saves the whole node, KEEPS the lock (no release)', async () => {
    h.state.collabPersist = true;
    const ok = await flushSketchEntityUnderLock('characters', 'kid', NODE);
    expect(ok).toBe(true);
    expect(h.state.acquire).toHaveBeenCalledTimes(1);
    // save carries the whole-node edit payload for the step-1/rtype-3 target.
    expect(h.state.save).toHaveBeenCalledWith(
      { step: 1, resource_type: 3, resource_id: 'kid', locale: null },
      { action_type: 3, patch: NODE, log: true },
    );
  });

  it('collab + already held (myLocks has the key) → skips acquire, just saves, KEEPS the lock', async () => {
    h.state.collabPersist = true;
    h.state.myLocks = new Set(['book-1|1|3|kid|']);
    const ok = await flushSketchEntityUnderLock('characters', 'kid', NODE, { releaseIfAcquired: true });
    expect(ok).toBe(true);
    expect(h.state.acquire).not.toHaveBeenCalled();
    expect(h.state.save).toHaveBeenCalledTimes(1);
    expect(h.state.release).not.toHaveBeenCalled(); // held-session owns it → do NOT release
  });

  it('default (no opts) + NOT held → acquires + saves + KEEPS the lock (flush-before generate)', async () => {
    h.state.collabPersist = true;
    const ok = await flushSketchEntityUnderLock('characters', 'kid', NODE);
    expect(ok).toBe(true);
    expect(h.state.acquire).toHaveBeenCalledTimes(1);
    expect(h.state.release).not.toHaveBeenCalled(); // caller (flush-before) keeps it for the held-session
  });

  it('releaseIfAcquired + NOT held → one-shot: acquires + saves + RELEASES (no lingering lock, H1)', async () => {
    h.state.collabPersist = true;
    const ok = await flushSketchEntityUnderLock('characters', 'kid', NODE, { releaseIfAcquired: true });
    expect(ok).toBe(true);
    expect(h.state.acquire).toHaveBeenCalledTimes(1);
    expect(h.state.save).toHaveBeenCalledTimes(1);
    expect(h.state.release).toHaveBeenCalledWith({ step: 1, resource_type: 3, resource_id: 'kid', locale: null });
  });

  it('releaseIfAcquired + save REJECTED after acquire → still releases (no leak on the error path)', async () => {
    h.state.collabPersist = true;
    h.state.save.mockResolvedValueOnce({ ok: false, lost: true, forbidden: false });
    const ok = await flushSketchEntityUnderLock('characters', 'kid', NODE, { releaseIfAcquired: true });
    expect(ok).toBe(false);
    expect(h.state.release).toHaveBeenCalledTimes(1); // finally-block release even on reject
  });

  it('collab + acquire 409 (peer holds) → false, no save (caller aborts generate)', async () => {
    h.state.collabPersist = true;
    h.state.acquire.mockResolvedValueOnce({ ok: false, holder: 'peer-id' });
    const ok = await flushSketchEntityUnderLock('characters', 'kid', NODE);
    expect(ok).toBe(false);
    expect(h.state.save).not.toHaveBeenCalled();
  });

  it('collab + save rejected → false', async () => {
    h.state.collabPersist = true;
    h.state.save.mockResolvedValueOnce({ ok: false, lost: true, forbidden: false });
    const ok = await flushSketchEntityUnderLock('props', 'sword', NODE);
    expect(ok).toBe(false);
  });

  it('collab + null node → false (nothing to persist)', async () => {
    h.state.collabPersist = true;
    const ok = await flushSketchEntityUnderLock('characters', 'kid', null);
    expect(ok).toBe(false);
    expect(h.state.acquire).not.toHaveBeenCalled();
  });
});
