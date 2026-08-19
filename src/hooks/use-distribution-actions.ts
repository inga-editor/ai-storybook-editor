// use-distribution-actions.ts — Action surface for ConfigDistributionSettings.
// Wraps export-pdf enqueue (book + remix route) with dedup/skip/failure handling
// (toast + log), re-exposes the remix distribution persist action, and triggers
// a post-enqueue refetch so the EXPORTING leaf surfaces promptly.
//
// Field ownership (design §4.6): client writes is_enabled only; the job handler
// is single-writer of status/media_url/file_size/exported_at/job_id. This hook
// NEVER optimistic-writes those — it enqueues + refetches.

import * as React from 'react';
import { toast } from 'sonner';
import {
  enqueueBookExportPdf,
  enqueueBookExportPlayerMedia,
  enqueueBookRenderVideo,
  enqueueRemixExportPdf,
  enqueueRemixExportPlayerMedia,
  enqueueRemixRenderVideo,
  isExportPdfDeduped,
  isExportPdfSkipped,
  isExportPlayerMediaDeduped,
  isExportPlayerMediaSkipped,
  isRenderVideoDeduped,
  isRenderVideoSkipped,
  type StartExportPdfOpts,
  type StartRenderVideoOpts,
} from '@/apis/jobs-api';
import { useBookActions } from '@/stores/book-store';
import { useRemixActions } from '@/stores/remix-store';
import type { Distribution } from '@/types/editor';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'DistributionActions');

export type EnqueueExportOutcome =
  | { kind: 'enqueued'; jobId: string }
  | { kind: 'deduped'; jobId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; message: string };

export interface DistributionActions {
  /** Persist remix distribution (is_enabled toggle). Toasts on failure. */
  updateRemixDistribution: (remixId: string, dist: Distribution) => Promise<boolean>;
  startBookExportPdf: (bookId: string, opts?: StartExportPdfOpts) => Promise<EnqueueExportOutcome>;
  startRemixExportPdf: (remixId: string, opts?: StartExportPdfOpts) => Promise<EnqueueExportOutcome>;
  startBookRenderVideo: (
    bookId: string,
    opts: StartRenderVideoOpts,
  ) => Promise<EnqueueExportOutcome>;
  startRemixRenderVideo: (
    remixId: string,
    opts: StartRenderVideoOpts,
  ) => Promise<EnqueueExportOutcome>;
  startBookExportPlayerMedia: (bookId: string) => Promise<EnqueueExportOutcome>;
  startRemixExportPlayerMedia: (remixId: string) => Promise<EnqueueExportOutcome>;
}

export function useDistributionActions(): DistributionActions {
  const { refetchBookDistribution } = useBookActions();
  const { updateRemixDistribution, refetchRemix } = useRemixActions();

  const startBookExportPdf = React.useCallback(
    async (bookId: string, opts?: StartExportPdfOpts): Promise<EnqueueExportOutcome> => {
      log.info('startBookExportPdf', 'enqueue', { bookId });
      const result = await enqueueBookExportPdf(bookId, opts ?? {});
      if (!result.success) {
        log.error('startBookExportPdf', 'failed', {
          bookId,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
        });
        toast.error(`Export failed: ${result.error}`);
        return { kind: 'failed', message: result.error };
      }
      const data = result.data;
      if (isExportPdfSkipped(data)) {
        log.warn('startBookExportPdf', 'skipped', { bookId, reason: data.reason });
        toast.info('Nothing to export (no printable spreads).');
        return { kind: 'skipped', reason: data.reason };
      }
      // enqueued or deduped → job is/was active; pull the exporting leaf.
      void refetchBookDistribution(bookId);
      if (isExportPdfDeduped(data)) {
        log.info('startBookExportPdf', 'deduped', { bookId, jobId: data.job_id });
        return { kind: 'deduped', jobId: data.job_id };
      }
      log.info('startBookExportPdf', 'enqueued', { bookId, jobId: data.job_id });
      toast.success('Export started.');
      return { kind: 'enqueued', jobId: data.job_id };
    },
    [refetchBookDistribution],
  );

  const startRemixExportPdf = React.useCallback(
    async (remixId: string, opts?: StartExportPdfOpts): Promise<EnqueueExportOutcome> => {
      log.info('startRemixExportPdf', 'enqueue', { remixId });
      const result = await enqueueRemixExportPdf(remixId, opts ?? {});
      if (!result.success) {
        log.error('startRemixExportPdf', 'failed', {
          remixId,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
        });
        toast.error(`Export failed: ${result.error}`);
        return { kind: 'failed', message: result.error };
      }
      const data = result.data;
      if (isExportPdfSkipped(data)) {
        log.warn('startRemixExportPdf', 'skipped', { remixId, reason: data.reason });
        toast.info('Nothing to export (no printable spreads).');
        return { kind: 'skipped', reason: data.reason };
      }
      void refetchRemix(remixId);
      if (isExportPdfDeduped(data)) {
        log.info('startRemixExportPdf', 'deduped', { remixId, jobId: data.job_id });
        return { kind: 'deduped', jobId: data.job_id };
      }
      log.info('startRemixExportPdf', 'enqueued', { remixId, jobId: data.job_id });
      toast.success('Export started.');
      return { kind: 'enqueued', jobId: data.job_id };
    },
    [refetchRemix],
  );

  const startBookRenderVideo = React.useCallback(
    async (bookId: string, opts: StartRenderVideoOpts): Promise<EnqueueExportOutcome> => {
      log.info('startBookRenderVideo', 'enqueue', { bookId, edition: opts.edition });
      const result = await enqueueBookRenderVideo(bookId, opts);
      if (!result.success) {
        log.error('startBookRenderVideo', 'failed', {
          bookId,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
        });
        toast.error(`Render failed: ${result.error}`);
        return { kind: 'failed', message: result.error };
      }
      const data = result.data;
      if (isRenderVideoSkipped(data)) {
        log.warn('startBookRenderVideo', 'skipped', { bookId, reason: data.reason });
        toast.info('Nothing to render (empty spread sequence).');
        return { kind: 'skipped', reason: data.reason };
      }
      void refetchBookDistribution(bookId);
      if (isRenderVideoDeduped(data)) {
        log.info('startBookRenderVideo', 'deduped', { bookId, jobId: data.job_id });
        return { kind: 'deduped', jobId: data.job_id };
      }
      log.info('startBookRenderVideo', 'enqueued', { bookId, jobId: data.job_id });
      toast.success('Render started.');
      return { kind: 'enqueued', jobId: data.job_id };
    },
    [refetchBookDistribution],
  );

  const startRemixRenderVideo = React.useCallback(
    async (remixId: string, opts: StartRenderVideoOpts): Promise<EnqueueExportOutcome> => {
      log.info('startRemixRenderVideo', 'enqueue', { remixId, edition: opts.edition });
      const result = await enqueueRemixRenderVideo(remixId, opts);
      if (!result.success) {
        log.error('startRemixRenderVideo', 'failed', {
          remixId,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
        });
        toast.error(`Render failed: ${result.error}`);
        return { kind: 'failed', message: result.error };
      }
      const data = result.data;
      if (isRenderVideoSkipped(data)) {
        log.warn('startRemixRenderVideo', 'skipped', { remixId, reason: data.reason });
        toast.info('Nothing to render (empty spread sequence).');
        return { kind: 'skipped', reason: data.reason };
      }
      void refetchRemix(remixId);
      if (isRenderVideoDeduped(data)) {
        log.info('startRemixRenderVideo', 'deduped', { remixId, jobId: data.job_id });
        return { kind: 'deduped', jobId: data.job_id };
      }
      log.info('startRemixRenderVideo', 'enqueued', { remixId, jobId: data.job_id });
      toast.success('Render started.');
      return { kind: 'enqueued', jobId: data.job_id };
    },
    [refetchRemix],
  );

  const startBookExportPlayerMedia = React.useCallback(
    async (bookId: string): Promise<EnqueueExportOutcome> => {
      log.info('startBookExportPlayerMedia', 'enqueue', { bookId });
      const result = await enqueueBookExportPlayerMedia(bookId);
      if (!result.success) {
        log.error('startBookExportPlayerMedia', 'failed', {
          bookId,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
        });
        toast.error(`Export failed: ${result.error}`);
        return { kind: 'failed', message: result.error };
      }
      const data = result.data;
      if (isExportPlayerMediaSkipped(data)) {
        log.warn('startBookExportPlayerMedia', 'skipped', { bookId, reason: data.reason });
        toast.info('Nothing to export.');
        return { kind: 'skipped', reason: data.reason };
      }
      void refetchBookDistribution(bookId);
      if (isExportPlayerMediaDeduped(data)) {
        log.info('startBookExportPlayerMedia', 'deduped', { bookId, jobId: data.job_id });
        return { kind: 'deduped', jobId: data.job_id };
      }
      log.info('startBookExportPlayerMedia', 'enqueued', { bookId, jobId: data.job_id });
      toast.success('Export started.');
      return { kind: 'enqueued', jobId: data.job_id };
    },
    [refetchBookDistribution],
  );

  const startRemixExportPlayerMedia = React.useCallback(
    async (remixId: string): Promise<EnqueueExportOutcome> => {
      log.info('startRemixExportPlayerMedia', 'enqueue', { remixId });
      const result = await enqueueRemixExportPlayerMedia(remixId);
      if (!result.success) {
        log.error('startRemixExportPlayerMedia', 'failed', {
          remixId,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
        });
        toast.error(`Export failed: ${result.error}`);
        return { kind: 'failed', message: result.error };
      }
      const data = result.data;
      if (isExportPlayerMediaSkipped(data)) {
        log.warn('startRemixExportPlayerMedia', 'skipped', { remixId, reason: data.reason });
        toast.info('Nothing to export.');
        return { kind: 'skipped', reason: data.reason };
      }
      void refetchRemix(remixId);
      if (isExportPlayerMediaDeduped(data)) {
        log.info('startRemixExportPlayerMedia', 'deduped', { remixId, jobId: data.job_id });
        return { kind: 'deduped', jobId: data.job_id };
      }
      log.info('startRemixExportPlayerMedia', 'enqueued', { remixId, jobId: data.job_id });
      toast.success('Export started.');
      return { kind: 'enqueued', jobId: data.job_id };
    },
    [refetchRemix],
  );

  const updateRemixDistributionWrapped = React.useCallback(
    async (remixId: string, dist: Distribution): Promise<boolean> => {
      const ok = await updateRemixDistribution(remixId, dist);
      if (!ok) toast.error('Could not save changes.');
      return ok;
    },
    [updateRemixDistribution],
  );

  return {
    updateRemixDistribution: updateRemixDistributionWrapped,
    startBookExportPdf,
    startRemixExportPdf,
    startBookRenderVideo,
    startRemixRenderVideo,
    startBookExportPlayerMedia,
    startRemixExportPlayerMedia,
  };
}
