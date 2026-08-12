// sync-slice-has-synced-once.test.ts — Unit tests for the `hasSyncedOnce` flag
// added for the Remix Editor sub-app preselect gate (Phase 07).
//
// The slice factory is driven with a controlled `set`/`get` over an in-memory
// state; the `RemixDataGateway` seam is a fake so the load can be made to succeed
// (empty snapshot → remixes=[]) or fail (injected error → early return).
import { describe, it, expect, beforeEach } from 'vitest';
import type { StateCreator } from 'zustand';

import { createSyncSlice } from './sync-slice';
import {
  createFakeRemixGateway,
  type FakeRemixGateway,
} from '../gateway/fake-remix-gateway';
import { setRemixDataGateway } from '../gateway/remix-data-gateway';
import type { RemixStore } from '../types';

let gw: FakeRemixGateway;

/** Build the sync slice over a controlled in-memory state. */
function setup() {
  let state = { remixes: [], jobs: [], hasSyncedOnce: false } as unknown as RemixStore;
  const get = (() => state) as unknown as () => RemixStore;
  const set = ((updater: unknown) => {
    const partial =
      typeof updater === 'function'
        ? (updater as (s: RemixStore) => Partial<RemixStore>)(state)
        : updater;
    state = { ...state, ...(partial as Partial<RemixStore>) };
  }) as never;
  const slice = (
    createSyncSlice as unknown as StateCreator<RemixStore, [], [], RemixStore>
  )(set, get as never, {} as never);
  return { slice, getState: () => state };
}

beforeEach(() => {
  gw = createFakeRemixGateway();
  setRemixDataGateway(gw);
});

describe('remix-store hasSyncedOnce', () => {
  it('initial slice value is false', () => {
    const { slice } = setup();
    expect(slice.hasSyncedOnce).toBe(false);
  });

  it('flips true after a successful (empty) sync', async () => {
    const { slice, getState } = setup();
    await slice.syncFromServer('snap-1');
    expect(getState().hasSyncedOnce).toBe(true);
    expect(getState().remixes).toEqual([]);
  });

  it('stays false when the gateway load fails (early return)', async () => {
    const { slice, getState } = setup();
    gw.failNext();
    await slice.syncFromServer('snap-1');
    expect(getState().hasSyncedOnce).toBe(false);
  });

  it('clearAll resets the flag back to false', async () => {
    const { slice, getState } = setup();
    await slice.syncFromServer('snap-1');
    expect(getState().hasSyncedOnce).toBe(true);
    slice.clearAll();
    expect(getState().hasSyncedOnce).toBe(false);
  });
});
