// background-jobs-store/job-progress-source.ts — I/O seam (ADR-052 sub-app port).
// The unified BackgroundJobsStore no longer talks to Supabase Realtime directly:
// it feeds through a swappable `JobProgressSource`. The editor installs the
// default `RealtimeJobProgressSource` (single Supabase channel + top-up); the
// remix-editor sub-app installs a polling source (Phase 05) that has no supabase
// user. The store's ingest path / selectors / `subscribeJobs` are unchanged.

import { createLogger } from '@/utils/logger';
import type { BackgroundJob } from './types';

const log = createLogger('Store', 'JobProgressSource');

export type Unsubscribe = () => void;

/**
 * Source of job-progress updates for the BackgroundJobsStore.
 *
 * ⚡ `jobIds` is a HINT, NOT a filter. The default realtime source deliberately
 * IGNORES it and ingests ALL of the user's `background_jobs` rows so the ADR-037
 * global toast feed (export / render / transcode / thumbnail jobs) keeps working
 * — those never appear in any single consumer's active-set. Only a polling source
 * (Phase 05) uses `jobIds` to bound its per-job status fan-out. Do NOT "fix" the
 * realtime impl to filter by `jobIds` — that silently drops the non-remix feed.
 *
 * `watch()` MUST be idempotent: called again on every active-set change, it must
 * NOT tear down + reopen its transport (channel churn). Repeated calls return a
 * stable handle and (for realtime) keep the SAME single channel open.
 */
export interface JobProgressSource {
  watch(jobIds: string[], onUpdate: (job: BackgroundJob) => void): Unsubscribe;
}

// ── Registry (module-scope singleton) ────────────────────────────────────────
// Kept out of zustand state — swapping the source never triggers a re-render.

let currentSource: JobProgressSource | null = null;

/** Install the active job-progress source. Editor: default realtime (auto-installed
 *  by the store's `init`). Sub-app: polling source, installed at bootstrap BEFORE
 *  `init` so the store reuses it instead of auto-installing realtime. */
export function setJobProgressSource(impl: JobProgressSource): void {
  log.info('setJobProgressSource', 'source installed', { hadPrevious: currentSource !== null });
  currentSource = impl;
}

/** True when a source has been installed (by the store's `init` or externally). */
export function hasJobProgressSource(): boolean {
  return currentSource !== null;
}

/** Active source. Throws if none installed — callers must guard with
 *  `hasJobProgressSource()` (the store only calls this after `init` installs one). */
export function getJobProgressSource(): JobProgressSource {
  if (!currentSource) {
    log.error('getJobProgressSource', 'no source installed');
    throw new Error('JobProgressSource not installed — call setJobProgressSource() or store.init() first');
  }
  return currentSource;
}

/** Test-only: reset the registry so each test starts from a clean slate. */
export function __resetJobProgressSourceForTest(): void {
  currentSource = null;
}
