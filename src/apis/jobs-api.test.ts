// jobs-api.test.ts — the corrected 409-dedup contract for detect jobs (verified vs
// swap-service 2026-08-11): detect-mix (12) + detect-rmbg (13) return HTTP 409
// JOB_ALREADY_ACTIVE and must normalize → {deduped:true}; mix-swap's 200
// {deduped:true} passes through unchanged; sprite plane is NOT normalized.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCall = vi.hoisted(() => vi.fn());
vi.mock('./image-api-client', () => ({ callImageApi: mockCall }));
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  enqueueDetectDefects,
  enqueueRemixStageJob,
  EnqueueJobError,
  enqueueBookExportPlayerMedia,
  enqueueRemixExportPlayerMedia,
  isExportPlayerMediaSkipped,
  isExportPlayerMediaDeduped,
} from './jobs-api';

beforeEach(() => {
  mockCall.mockReset();
});

/** ImageApiFailure for a 409 dedup (RemixDomainError envelope parsed by callImageApi). */
function dedup409(type: string, batchId = 'batch-9', status = 'running') {
  return {
    success: false,
    error: 'a detect job is already active for this remix',
    httpStatus: 409,
    errorCode: 'JOB_ALREADY_ACTIVE',
    errorDetails: { job_id: 'job-existing', status, type, remix_id: 'remix-1', batch_id: batchId },
  };
}

describe('enqueueDetectDefects — corrected 409-dedup contract', () => {
  it('detect-mix (12) 409 JOB_ALREADY_ACTIVE → normalized deduped result (no throw)', async () => {
    mockCall.mockResolvedValue(dedup409('remix_detect_mix_defects'));
    const data = await enqueueDetectDefects('mix', 'remix-1', { scopeId: 'batch-9' });
    expect(data).toMatchObject({
      deduped: true,
      job_id: 'job-existing',
      status: 'running',
      type: 'remix_detect_mix_defects',
      remix_id: 'remix-1',
      active_swap_key: 'batch-9',
    });
  });

  it('detect-rmbg (13) 409 JOB_ALREADY_ACTIVE → normalized deduped result', async () => {
    mockCall.mockResolvedValue(dedup409('remix_detect_rmbg_defects', 'batch-7', 'queued'));
    const data = await enqueueDetectDefects('rmbg', 'remix-1', { scopeId: 'batch-7' });
    expect(data).toMatchObject({
      deduped: true,
      type: 'remix_detect_rmbg_defects',
      status: 'queued',
      active_swap_key: 'batch-7',
    });
  });

  it('falls back to a derived type when the 409 details omit `type`', async () => {
    const failure = dedup409('remix_detect_rmbg_defects');
    delete (failure.errorDetails as { type?: string }).type;
    mockCall.mockResolvedValue(failure);
    const data = await enqueueDetectDefects('rmbg', 'remix-1', { scopeId: 'b' });
    expect((data as { type: string }).type).toBe('remix_detect_rmbg_defects');
  });

  it('sprite plane (11) is NOT normalized — a 409 still throws (never emits 409 in prod)', async () => {
    mockCall.mockResolvedValue(dedup409('remix_detect_defects'));
    await expect(enqueueDetectDefects('sprite', 'remix-1', { scopeId: 'sprite-1' })).rejects.toBeInstanceOf(
      EnqueueJobError,
    );
  });

  it('a non-409 detect failure still throws EnqueueJobError', async () => {
    mockCall.mockResolvedValue({
      success: false,
      error: 'no swap result',
      httpStatus: 422,
      errorCode: 'NO_SWAP_RESULT',
    });
    await expect(enqueueDetectDefects('mix', 'remix-1', { scopeId: 'b' })).rejects.toMatchObject({
      httpStatus: 422,
      code: 'NO_SWAP_RESULT',
    });
  });
});

describe('enqueueRemixStageJob — mix-swap 200 dedup passthrough (unchanged)', () => {
  it('returns the 200 {deduped:true} data verbatim (NOT special-cased)', async () => {
    const data = {
      job_id: 'job-1',
      status: 'running' as const,
      type: 'remix_mix_swap' as const,
      remix_id: 'remix-1',
      active_swap_key: 'batch-9',
      deduped: true as const,
    };
    mockCall.mockResolvedValue({ success: true, data });
    const out = await enqueueRemixStageJob('remix-1', 'mix-swap', { batch_id: 'batch-9' });
    expect(out).toEqual(data);
  });
});

describe('enqueueExportPlayerMedia — routes + 3-way union guards (job 18)', () => {
  it('book route: POST /api/jobs/{bookId}/export-player-media with empty body', async () => {
    mockCall.mockResolvedValue({ success: true, data: { job_id: 'j18', status: 'queued' } });
    await enqueueBookExportPlayerMedia('book-1');
    expect(mockCall).toHaveBeenCalledWith('/api/jobs/book-1/export-player-media', {});
  });

  it('remix route: POST /api/jobs/remix/{remixId}/export-player-media with empty body', async () => {
    mockCall.mockResolvedValue({ success: true, data: { job_id: 'j18', status: 'queued' } });
    await enqueueRemixExportPlayerMedia('remix-1');
    expect(mockCall).toHaveBeenCalledWith('/api/jobs/remix/remix-1/export-player-media', {});
  });

  it('narrowing guards distinguish skipped / deduped / enqueued', () => {
    const skipped = { skipped: true as const, reason: 'no_media_items', sources_found: 0 as const };
    const deduped = {
      job_id: 'j18', status: 'running' as const, type: 'export_player_media' as const,
      source: 'book' as const, book_id: 'book-1', deduped: true as const,
    };
    const enqueued = {
      job_id: 'j18', status: 'queued' as const, type: 'export_player_media' as const,
      source: 'book' as const, book_id: 'book-1', tiers: ['web'],
      total_steps: 3, sources_found: 3, estimated_duration_sec: 1,
    };
    expect(isExportPlayerMediaSkipped(skipped)).toBe(true);
    expect(isExportPlayerMediaSkipped(deduped)).toBe(false);
    expect(isExportPlayerMediaDeduped(deduped)).toBe(true);
    expect(isExportPlayerMediaDeduped(enqueued)).toBe(false);
    expect(isExportPlayerMediaSkipped(enqueued)).toBe(false);
  });
});
