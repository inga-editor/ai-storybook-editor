import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useResourceLockStore } from './index';
import {
  useLockedByOtherSpreadCount,
  useSpreadPeerLockName,
} from './selectors';
import { FALLBACK_HOLDER_NAME, type LockEntry } from './types';

// Reactive-selector harness: seed bookId / myUserId / registry via setState (no channel),
// then renderHook the selector. Mirrors imperative-guards.test.ts (same store, imperative twin).

const BOOK = 'book1';
const ME = 'me';
const OTHER = 'other';

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function entry(holder: string, expires: string): LockEntry {
  return { holder_user_id: holder, acquired_at: past(), expires_at: expires };
}

function seed(pairs: Array<[string, LockEntry]>): void {
  useResourceLockStore.setState({ bookId: BOOK, myUserId: ME, registry: new Map(pairs) });
}

beforeEach(() => {
  useResourceLockStore.setState({ bookId: BOOK, myUserId: ME, registry: new Map() });
});

describe('useLockedByOtherSpreadCount', () => {
  const entriesOf = (...pairs: Array<[string, string[]]>) =>
    pairs.map(([spreadId, imageIds]) => ({ spreadId, imageIds }));

  it('empty entries → 0 (nothing to gate)', () => {
    const { result } = renderHook(() => useLockedByOtherSpreadCount([]));
    expect(result.current).toBe(0);
  });

  it('free spreads → 0', () => {
    const { result } = renderHook(() =>
      useLockedByOtherSpreadCount(entriesOf(['sp1', ['img1']], ['sp2', []])),
    );
    expect(result.current).toBe(0);
  });

  it('spread structural lock (type 6) held by another → counted', () => {
    seed([[`${BOOK}|1|6|sp1|`, entry(OTHER, future())]]);
    const { result } = renderHook(() =>
      useLockedByOtherSpreadCount(entriesOf(['sp1', []], ['sp2', []])),
    );
    expect(result.current).toBe(1);
  });

  it('child page-image lock (type 1) held by another → counted', () => {
    seed([[`${BOOK}|1|1|img1|`, entry(OTHER, future())]]);
    const { result } = renderHook(() => useLockedByOtherSpreadCount(entriesOf(['sp1', ['img1']])));
    expect(result.current).toBe(1);
  });

  it('lock held by ME → not counted (own generate job never gates my own button)', () => {
    seed([[`${BOOK}|1|6|sp1|`, entry(ME, future())]]);
    const { result } = renderHook(() => useLockedByOtherSpreadCount(entriesOf(['sp1', ['img1']])));
    expect(result.current).toBe(0);
  });

  it('expired lock → not counted (prune-aware expiry)', () => {
    seed([[`${BOOK}|1|6|sp1|`, entry(OTHER, past())]]);
    const { result } = renderHook(() => useLockedByOtherSpreadCount(entriesOf(['sp1', []])));
    expect(result.current).toBe(0);
  });

  it('mixed batch counts ONLY the blocked spreads (partial → button stays enabled)', () => {
    seed([
      [`${BOOK}|1|6|sp1|`, entry(OTHER, future())],
      [`${BOOK}|1|1|img2|`, entry(OTHER, future())],
    ]);
    const { result } = renderHook(() =>
      useLockedByOtherSpreadCount(entriesOf(['sp1', []], ['sp2', ['img2']], ['sp3', []])),
    );
    expect(result.current).toBe(2);
  });

  it('no book connected → 0', () => {
    useResourceLockStore.setState({ bookId: null });
    const { result } = renderHook(() => useLockedByOtherSpreadCount(entriesOf(['sp1', ['img1']])));
    expect(result.current).toBe(0);
  });
});

describe('useSpreadPeerLockName', () => {
  const SPREAD = 'sp1';
  // SCENE whole-spread lock key: step 2 / rtype 6 / locale ''. RETOUCH: step 3 / rtype 10.
  const SCENE_KEY = `${BOOK}|2|6|${SPREAD}|`;
  const RETOUCH_KEY = `${BOOK}|3|10|${SPREAD}|`;

  function seedWithNames(pairs: Array<[string, LockEntry]>, names: Array<[string, string]>): void {
    useResourceLockStore.setState({
      bookId: BOOK,
      myUserId: ME,
      registry: new Map(pairs),
      holderNames: new Map(names),
    });
  }

  beforeEach(() => {
    useResourceLockStore.setState({ holderNames: new Map() });
  });

  it('free spread → null', () => {
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 2, 6));
    expect(result.current).toBeNull();
  });

  it('held by another editor with a resolved name → that name', () => {
    seedWithNames([[SCENE_KEY, entry(OTHER, future())]], [[OTHER, 'Alice']]);
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 2, 6));
    expect(result.current).toBe('Alice');
  });

  it('held by another editor whose name is not resolved yet → fallback', () => {
    seedWithNames([[SCENE_KEY, entry(OTHER, future())]], []);
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 2, 6));
    expect(result.current).toBe(FALLBACK_HOLDER_NAME);
  });

  it('held by ME → null (own lock never shows a peer badge)', () => {
    seedWithNames([[SCENE_KEY, entry(ME, future())]], [[ME, 'Me']]);
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 2, 6));
    expect(result.current).toBeNull();
  });

  it('expired lock → null (prune-aware expiry)', () => {
    seedWithNames([[SCENE_KEY, entry(OTHER, past())]], [[OTHER, 'Alice']]);
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 2, 6));
    expect(result.current).toBeNull();
  });

  it('RETOUCH lock (step 3 / rtype 10) resolves for the retouch query', () => {
    seedWithNames([[RETOUCH_KEY, entry(OTHER, future())]], [[OTHER, 'Bob']]);
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 3, 10));
    expect(result.current).toBe('Bob');
  });

  it('lock coords are scoped — a RETOUCH lock does not surface on the SCENE query', () => {
    seedWithNames([[RETOUCH_KEY, entry(OTHER, future())]], [[OTHER, 'Bob']]);
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 2, 6));
    expect(result.current).toBeNull();
  });

  it('step/resourceType undefined → null (non-collab canvas passthrough)', () => {
    seedWithNames([[SCENE_KEY, entry(OTHER, future())]], [[OTHER, 'Alice']]);
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, undefined, undefined));
    expect(result.current).toBeNull();
  });

  it('no book connected → null', () => {
    useResourceLockStore.setState({ bookId: null });
    const { result } = renderHook(() => useSpreadPeerLockName(SPREAD, 2, 6));
    expect(result.current).toBeNull();
  });
});
