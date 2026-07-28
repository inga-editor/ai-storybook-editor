// Covers `runLockedSetSave` — the multi-collection write set behind the sketch-base Excel import.
// The invariants that actually protect data: acquire EVERY lock before the optimistic local
// replace, apply that replace exactly ONCE, and never leak a lock (including the partial set taken
// before a block). The store's own actions are stubbed via setState — this exercises the util's
// lifecycle, not the gateway client.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useResourceLockStore, type LockTarget, type SavePayload } from '@/stores/resource-lock-store';
import { runLockedSetSave, type CollectionSaveEntry } from './structural-lock-collection-save';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const CHARS: LockTarget = { step: 1, resource_type: 3, resource_id: 'characters', locale: null };
const PROPS: LockTarget = { step: 1, resource_type: 4, resource_id: 'props', locale: null };

const payload = (collection: string): SavePayload => ({
  action_type: 3,
  patch: [{ key: 'miu' }],
  collection,
});

const ENTRIES: CollectionSaveEntry[] = [
  { target: CHARS, save: payload('characters') },
  { target: PROPS, save: payload('props') },
];

const OK = { ok: true as const };
const HELD = { ok: false as const, code: 'LOCK_HELD' as const, holder: 'peer-1' };
const SAVE_FAILED = { ok: false as const, lost: true, forbidden: false };

let acquire: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;

beforeEach(() => {
  acquire = vi.fn(async () => OK);
  save = vi.fn(async () => OK);
  release = vi.fn(async () => undefined);
  useResourceLockStore.setState({
    bookId: 'book1',
    myUserId: 'me',
    holderNames: new Map([['peer-1', 'Peer One']]),
    acquire,
    save,
    release,
  } as never);
});

describe('runLockedSetSave', () => {
  it('acquires both, applies local ONCE, saves each collection, releases both', async () => {
    const applyLocal = vi.fn();
    const outcome = await runLockedSetSave(ENTRIES, applyLocal);

    expect(outcome).toBe('saved');
    expect(acquire.mock.calls.map((c) => c[0])).toEqual([CHARS, PROPS]);
    expect(applyLocal).toHaveBeenCalledTimes(1);
    expect(save.mock.calls.map((c) => c[1].collection)).toEqual(['characters', 'props']);
    expect(release.mock.calls.map((c) => c[0])).toEqual([CHARS, PROPS]);
  });

  it('applies local only AFTER every lock is held', async () => {
    const order: string[] = [];
    acquire.mockImplementation(async (t: LockTarget) => {
      order.push(`acquire:${t.resource_id}`);
      return OK;
    });
    const outcome = await runLockedSetSave(ENTRIES, () => order.push('applyLocal'));

    expect(outcome).toBe('saved');
    expect(order).toEqual(['acquire:characters', 'acquire:props', 'applyLocal']);
  });

  it('a peer holding the SECOND collection aborts the whole set — nothing applied, first lock released', async () => {
    acquire.mockResolvedValueOnce(OK).mockResolvedValueOnce(HELD);
    const applyLocal = vi.fn();

    const outcome = await runLockedSetSave(ENTRIES, applyLocal);

    expect(outcome).toBe('blocked');
    expect(applyLocal).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(release.mock.calls.map((c) => c[0])).toEqual([CHARS]); // only what we took
  });

  it('blocked on the FIRST acquire releases nothing', async () => {
    acquire.mockResolvedValueOnce(HELD);
    const outcome = await runLockedSetSave(ENTRIES, vi.fn());

    expect(outcome).toBe('blocked');
    expect(release).not.toHaveBeenCalled();
  });

  it('one failed save → outcome failed, the sibling collection is still attempted, local replace kept', async () => {
    save.mockResolvedValueOnce(SAVE_FAILED).mockResolvedValueOnce(OK);
    const applyLocal = vi.fn();

    const outcome = await runLockedSetSave(ENTRIES, applyLocal);

    expect(outcome).toBe('failed');
    expect(applyLocal).toHaveBeenCalledTimes(1); // save-lost semantics — a refetch reconciles
    expect(save).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('releases every held lock when a save throws', async () => {
    save.mockRejectedValueOnce(new Error('network'));

    await expect(runLockedSetSave(ENTRIES, vi.fn())).rejects.toThrow('network');
    expect(release.mock.calls.map((c) => c[0])).toEqual([CHARS, PROPS]);
  });
});
