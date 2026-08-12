// job-progress-source.test.ts — I/O seam (ADR-052): registry, RealtimeJobProgressSource
// idempotency (channel opens counted once), ingest-ALL (jobIds hint ignored), and
// store `rewatch` re-issuing watch with the correct active-id set. Channel + top-up
// + supabase I/O are mocked away.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Count channel opens + capture the wired args. `openBackgroundJobsChannel` is the
// only real I/O the realtime source performs — mock it so watch() never touches a
// live client and we can assert "opened exactly once" across rewatches.
const openChannelMock = vi.fn();
const teardownMock = vi.fn();
vi.mock('../channel', () => ({
  openBackgroundJobsChannel: (args: unknown) => {
    openChannelMock(args);
    return { teardown: teardownMock };
  },
}));
vi.mock('../top-up', () => ({ topUpSync: vi.fn().mockResolvedValue(undefined) }));

// Store index pulls these transitively — stub so importing never hits a client.
vi.mock('@/apis/supabase', () => ({
  supabase: {
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
    from: vi.fn(),
  },
}));
vi.mock('@/apis/supabase-realtime', () => ({ ensureRealtimeAuth: vi.fn() }));
vi.mock('@/apis/jobs-api', () => ({ cancelJobRemote: vi.fn() }));

import {
  setJobProgressSource,
  getJobProgressSource,
  hasJobProgressSource,
  __resetJobProgressSourceForTest,
  type JobProgressSource,
} from '../job-progress-source';
import { createRealtimeJobProgressSource } from '../realtime-job-progress-source';
import { useBackgroundJobsStore } from '../index';
import type { BackgroundJob, BackgroundJobRawRow } from '../types';

const store = () => useBackgroundJobsStore.getState();

function job(over: Partial<BackgroundJob> = {}): BackgroundJob {
  const now = new Date().toISOString();
  return {
    id: 'j1',
    type: 'remix_audio_swap',
    bookId: 'b1',
    userId: 'u1',
    status: 'queued',
    currentStep: 0,
    totalSteps: 3,
    stepDetails: null,
    params: { remix_id: 'r1' },
    result: null,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function rawRow(over: Partial<BackgroundJobRawRow> = {}): BackgroundJobRawRow {
  const now = new Date().toISOString();
  return {
    id: 'x',
    type: 'export_pdf',
    user_id: 'u1',
    book_id: 'b1',
    status: 'running',
    cancel_requested: false,
    total_steps: 1,
    current_step: 0,
    step_details: null,
    params: null,
    result: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

const noopHooks = { onDelete: vi.fn(), onLive: vi.fn(), onDown: vi.fn() };

beforeEach(() => {
  store().teardown(); // clears jobsById + listeners + progressHandle + lastActiveKey
  __resetJobProgressSourceForTest();
  openChannelMock.mockClear();
  teardownMock.mockClear();
  noopHooks.onDelete.mockClear();
  noopHooks.onLive.mockClear();
  noopHooks.onDown.mockClear();
});

describe('registry', () => {
  it('throws when no source installed; set/get/has round-trip', () => {
    expect(hasJobProgressSource()).toBe(false);
    expect(() => getJobProgressSource()).toThrow();

    const fake: JobProgressSource = { watch: () => () => {} };
    setJobProgressSource(fake);
    expect(hasJobProgressSource()).toBe(true);
    expect(getJobProgressSource()).toBe(fake);
  });
});

describe('RealtimeJobProgressSource idempotency', () => {
  it('opens the channel exactly once across repeated watch() calls', () => {
    const source = createRealtimeJobProgressSource('u1', noopHooks);
    const onUpdate = vi.fn();

    const unsub1 = source.watch([], onUpdate);
    const unsub2 = source.watch(['a', 'b'], onUpdate); // active-set "changed" → still no reopen
    const unsub3 = source.watch(['c'], onUpdate);

    expect(openChannelMock).toHaveBeenCalledTimes(1); // ⚡ no channel churn
    expect(unsub1).toBe(unsub2);
    expect(unsub2).toBe(unsub3); // stable handle
  });

  it('unsubscribe closes the channel; a later watch reopens', () => {
    const source = createRealtimeJobProgressSource('u1', noopHooks);
    const onUpdate = vi.fn();

    const unsub = source.watch([], onUpdate);
    expect(openChannelMock).toHaveBeenCalledTimes(1);

    unsub();
    expect(teardownMock).toHaveBeenCalledTimes(1);

    source.watch([], onUpdate);
    expect(openChannelMock).toHaveBeenCalledTimes(2);
  });

  it('ingests ALL rows — jobIds is a hint, not a filter', () => {
    const source = createRealtimeJobProgressSource('u1', noopHooks);
    const onUpdate = vi.fn();

    source.watch(['only-this-remix-id'], onUpdate); // hint says one remix job
    const args = openChannelMock.mock.calls[0][0] as {
      onRow: (row: BackgroundJobRawRow) => void;
    };

    // A row OUTSIDE the hint AND outside REMIX_SWAP_TYPES (export) must still ingest.
    args.onRow(rawRow({ id: 'export-1', type: 'export_pdf' }));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const ingested = onUpdate.mock.calls[0][0] as BackgroundJob;
    expect(ingested.id).toBe('export-1');
    expect(ingested.type).toBe('export_pdf'); // proves the global toast feed survives
  });
});

describe('store rewatch via fake source', () => {
  it('re-issues watch with the active-id set only when membership changes', () => {
    const watchCalls: string[][] = [];
    // Holder (not a bare `let`) so TS control-flow doesn't narrow the callback-
    // assigned value to `never` at the call site below.
    const captured: { onUpdate: ((j: BackgroundJob) => void) | null } = { onUpdate: null };
    const fakeUnsub = vi.fn();
    const fake: JobProgressSource = {
      watch: (ids, onUpdate) => {
        watchCalls.push([...ids]);
        captured.onUpdate = onUpdate;
        return fakeUnsub;
      },
    };
    setJobProgressSource(fake); // installed BEFORE init → store reuses it (no default)

    store().init('editor-identity');
    expect(watchCalls).toEqual([[]]); // first rewatch: no active jobs

    // Active job appears → active-set → ['a'].
    store().ingest([job({ id: 'a', status: 'running' })]);
    expect(watchCalls[watchCalls.length - 1]).toEqual(['a']);

    // Job completes → active-set empties.
    store().ingest([job({ id: 'a', status: 'completed' })]);
    expect(watchCalls[watchCalls.length - 1]).toEqual([]);

    // A progress tick that does NOT change active membership → NO extra watch.
    const before = watchCalls.length;
    store().ingest([job({ id: 'a', status: 'completed', currentStep: 2 })]);
    expect(watchCalls.length).toBe(before);

    // The onUpdate closure feeds the store's ingest path.
    captured.onUpdate?.(job({ id: 'z', status: 'running' }));
    expect(store().jobsById['z']).toBeDefined();
  });
});
