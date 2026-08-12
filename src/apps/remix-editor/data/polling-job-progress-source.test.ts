// polling-job-progress-source.test.ts — the polling loop: stop-on-terminal,
// missing→terminal, 20-id cap, and 429 Retry-After backoff. Fake timers + a fake
// authorizedFetch returning real Response objects.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPollingJobProgressSource } from './polling-job-progress-source';
import type { BackgroundJob } from '@/stores/background-jobs-store';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const BASE = 'https://swap.test';

beforeEach(() => {
  vi.stubEnv('VITE_REMIX_SWAP_SERVICE_BASE_URL', BASE);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface EntrySeed {
  id: string;
  status: BackgroundJob['status'];
  updated_at: string;
  type?: string;
}

function jobsResponse(jobs: EntrySeed[], missing: string[] = []): Response {
  const body = {
    success: true,
    data: {
      jobs: jobs.map((j) => ({ type: 'remix_mix_swap', ...j })),
      missing,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('polling loop', () => {
  it('emits updates and STOPS once every job is terminal', async () => {
    const af = vi
      .fn()
      .mockResolvedValueOnce(jobsResponse([{ id: 'j1', status: 'running', updated_at: '2026-01-01T00:00:01Z' }]))
      .mockResolvedValueOnce(jobsResponse([{ id: 'j1', status: 'completed', updated_at: '2026-01-01T00:00:02Z' }]));

    const onUpdate = vi.fn();
    const source = createPollingJobProgressSource(af);
    source.watch(['j1'], onUpdate);

    // First tick (scheduled at 0ms).
    await vi.advanceTimersByTimeAsync(1);
    expect(af).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'j1', status: 'running' }));

    // Second tick after the 2500ms interval → completed → loop stops.
    await vi.advanceTimersByTimeAsync(2500);
    expect(af).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'j1', status: 'completed' }));

    // No further polling after terminal.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(af).toHaveBeenCalledTimes(2);
  });

  it('skips a non-advancing updated_at (monotonic guard)', async () => {
    const af = vi
      .fn()
      .mockResolvedValueOnce(jobsResponse([{ id: 'j1', status: 'running', updated_at: '2026-01-01T00:00:01Z' }]))
      .mockResolvedValueOnce(jobsResponse([{ id: 'j1', status: 'running', updated_at: '2026-01-01T00:00:01Z' }]))
      .mockResolvedValue(jobsResponse([{ id: 'j1', status: 'completed', updated_at: '2026-01-01T00:00:03Z' }]));
    const onUpdate = vi.fn();
    createPollingJobProgressSource(af).watch(['j1'], onUpdate);

    await vi.advanceTimersByTimeAsync(1); // running (emit)
    await vi.advanceTimersByTimeAsync(2500); // same updated_at → NO emit
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500); // advanced → emit completed
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('treats missing[] ids as terminal (failed) and stops', async () => {
    const af = vi.fn().mockResolvedValue(jobsResponse([], ['ghost']));
    const onUpdate = vi.fn();
    createPollingJobProgressSource(af).watch(['ghost'], onUpdate);

    await vi.advanceTimersByTimeAsync(1);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'ghost', status: 'failed' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(af).toHaveBeenCalledTimes(1); // stopped — ghost dropped from active set
  });

  it('caps the request at 20 ids', async () => {
    const af = vi.fn().mockResolvedValue(jobsResponse([]));
    const ids = Array.from({ length: 25 }, (_, i) => `j${i}`);
    createPollingJobProgressSource(af).watch(ids, vi.fn());

    await vi.advanceTimersByTimeAsync(1);
    const url = new URL(af.mock.calls[0][0] as string);
    const idsParam = url.searchParams.get('ids') ?? '';
    expect(idsParam.split(',')).toHaveLength(20);
  });

  it('honors 429 Retry-After before the next poll', async () => {
    const af = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '5' } }))
      .mockResolvedValueOnce(jobsResponse([{ id: 'j1', status: 'completed', updated_at: '2026-01-01T00:00:02Z' }]));
    createPollingJobProgressSource(af).watch(['j1'], vi.fn());

    await vi.advanceTimersByTimeAsync(1); // first tick → 429
    expect(af).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000); // < 5000ms Retry-After → not yet
    expect(af).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500); // cross the 5000ms Retry-After
    expect(af).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe halts the loop', async () => {
    const af = vi.fn().mockResolvedValue(jobsResponse([{ id: 'j1', status: 'running', updated_at: '2026-01-01T00:00:01Z' }]));
    const stop = createPollingJobProgressSource(af).watch(['j1'], vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    expect(af).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(af).toHaveBeenCalledTimes(1);
  });
});
