// polling-job-progress-source.ts — `JobProgressSource` for the sub-app: polls
// GET /api/jobs/status?ids= (spec 07) in place of Supabase realtime (the sub-app
// has no supabase user).
//
// Contract:
//   • ≤20 ids per request (server also caps — we cap client-side to never bomb it)
//   • 2500ms base interval while any watched job is active
//   • STOP when every watched job is terminal (no idle polling → no wasted quota)
//   • `missing[]` ids treated as terminal (failed) and dropped from the active set
//   • 429 → wait `Retry-After` (else exponential backoff, cap 30s); a network / HTTP
//     error backs off but never kills the loop (one blip must not stop progress)
//   • reuses `mapRowToBackgroundJob` (Phase 02) — the poll entry is snake_case and
//     carries params/book_id/current_step/total_steps so the mapper runs unchanged
//
// `watch()` is IDEMPOTENT: the store re-issues it on every active-set change; this
// source keeps ONE loop and RE-TARGETS its id set instead of spawning a 2nd timer.
//
// Envelope: `/api/jobs/status` uses the `{success,data}` editor envelope — but the
// loop reads the raw `Response` (not `callEditorApi`) because it needs the 429
// status + `Retry-After` header for backoff. All requests still go through
// `authorizedFetch`.

import { createLogger } from '@/utils/logger';
import {
  mapRowToBackgroundJob,
  TERMINAL_STATUSES,
  type BackgroundJob,
  type JobProgressSource,
  type Unsubscribe,
} from '@/stores/background-jobs-store';
import type { BackgroundJobRawRow, JobStatus } from '@/stores/background-jobs-store/types';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';

const log = createLogger('API', 'JobPolling');

const MAX_IDS = 20;
const BASE_INTERVAL_MS = 2500;
const MAX_BACKOFF_MS = 30_000;

/** Poll response entry (spec 07 — snake_case, mirrors the realtime row). */
interface JobStatusEntry {
  id: string;
  type: string;
  status: JobStatus;
  step_details?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  cancel_requested?: boolean;
  updated_at?: string | null;
  params?: Record<string, unknown> | null;
  book_id?: string | null;
  current_step?: number | null;
  total_steps?: number | null;
}

interface JobStatusResponse {
  success?: boolean;
  data?: { jobs?: JobStatusEntry[]; missing?: string[] };
}

function serviceBaseUrl(): string {
  return (import.meta.env.VITE_REMIX_SWAP_SERVICE_BASE_URL as string | undefined) ?? '';
}

/** Poll entry → BackgroundJobRawRow. Fills the two fields the poll response omits:
 *  `user_id` (no supabase user in the sub-app) and `created_at` (fall back to
 *  `updated_at`). Everything else is a direct snake_case passthrough. */
function entryToRawRow(entry: JobStatusEntry): BackgroundJobRawRow {
  return {
    id: entry.id,
    type: entry.type,
    user_id: '',
    book_id: entry.book_id ?? null,
    status: entry.status,
    cancel_requested: entry.cancel_requested ?? null,
    total_steps: entry.total_steps ?? null,
    current_step: entry.current_step ?? null,
    step_details: entry.step_details ?? null,
    params: entry.params ?? null,
    result: entry.result ?? null,
    created_at: entry.updated_at ?? '',
    updated_at: entry.updated_at ?? '',
  };
}

/** Synthetic terminal row for an id the server reports as `missing` (deleted /
 *  never existed / out of visibility) — surfaced as a failed job so any consumer
 *  waiting on it stops. */
function missingRawRow(id: string): BackgroundJobRawRow {
  const now = new Date().toISOString();
  return {
    id,
    type: '',
    user_id: '',
    book_id: null,
    status: 'failed',
    cancel_requested: null,
    total_steps: null,
    current_step: null,
    step_details: null,
    params: null,
    result: null,
    created_at: now,
    updated_at: now,
  };
}

/** Parse `Retry-After` (delta-seconds OR HTTP-date) → ms, capped. `null` when absent
 *  / unparseable so the caller falls back to exponential backoff. */
function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), MAX_BACKOFF_MS);
  return null;
}

export function createPollingJobProgressSource(
  authorizedFetch: AuthorizedFetch,
): JobProgressSource {
  let activeIds = new Set<string>();
  let onUpdate: ((job: BackgroundJob) => void) | null = null;
  const lastSeen = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ticking = false;
  let stopped = false;
  let backoffMs = BASE_INTERVAL_MS;

  function bumpBackoff(): number {
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    return backoffMs;
  }

  /** End the current tick and schedule the next — UNLESS the active set drained
   *  (all terminal) in which case the loop stops entirely. */
  function scheduleNext(delayMs: number): void {
    ticking = false;
    if (stopped) return;
    if (activeIds.size === 0) {
      log.info('poll', 'all terminal — stop polling');
      return;
    }
    timer = setTimeout(runTick, delayMs);
  }

  async function runTick(): Promise<void> {
    timer = null;
    if (stopped || activeIds.size === 0) return;
    ticking = true;

    const idsParam = Array.from(activeIds).join(',');
    const url = `${serviceBaseUrl().replace(/\/$/, '')}/api/jobs/status?ids=${encodeURIComponent(idsParam)}`;

    let res: Response;
    try {
      res = await authorizedFetch(url, { method: 'GET' });
    } catch (err) {
      log.warn('poll', 'network error — backoff', {
        message: err instanceof Error ? err.message : String(err),
      });
      scheduleNext(bumpBackoff());
      return;
    }

    if (res.status === 429) {
      const wait = parseRetryAfter(res.headers?.get?.('Retry-After')) ?? bumpBackoff();
      log.warn('poll', 'rate limited — backoff', { waitMs: wait });
      scheduleNext(wait);
      return;
    }

    if (!res.ok) {
      log.warn('poll', 'http error — backoff', { httpStatus: res.status });
      scheduleNext(bumpBackoff());
      return;
    }

    let body: JobStatusResponse;
    try {
      body = (await res.json()) as JobStatusResponse;
    } catch {
      log.warn('poll', 'malformed json — backoff');
      scheduleNext(bumpBackoff());
      return;
    }

    const jobs = body?.data?.jobs ?? [];
    const missing = body?.data?.missing ?? [];

    for (const entry of jobs) {
      const prev = lastSeen.get(entry.id);
      const updatedAt = entry.updated_at ?? '';
      // Ingest-monotonic guard: skip a row that hasn't advanced (avoids a
      // backwards tick when two polls race the same updated_at).
      if (!prev || updatedAt > prev) {
        onUpdate?.(mapRowToBackgroundJob(entryToRawRow(entry)));
        if (updatedAt) lastSeen.set(entry.id, updatedAt);
      }
      if (TERMINAL_STATUSES.has(entry.status)) activeIds.delete(entry.id);
    }

    for (const id of missing) {
      onUpdate?.(mapRowToBackgroundJob(missingRawRow(id)));
      activeIds.delete(id);
      lastSeen.delete(id);
    }

    backoffMs = BASE_INTERVAL_MS; // reset on a successful poll
    scheduleNext(BASE_INTERVAL_MS);
  }

  const unsubscribe: Unsubscribe = () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    log.info('poll', 'unsubscribed — polling stopped');
  };

  return {
    watch(jobIds: string[], cb: (job: BackgroundJob) => void): Unsubscribe {
      stopped = false;
      onUpdate = cb;

      const unique = Array.from(new Set(jobIds));
      if (unique.length > MAX_IDS) {
        log.warn('watch', 'id set exceeds cap — truncating', {
          requested: unique.length,
          cap: MAX_IDS,
        });
      }
      activeIds = new Set(unique.slice(0, MAX_IDS));

      if (activeIds.size === 0) {
        // Nothing active — cancel any scheduled tick, go idle (stay installed for
        // the next active-set change).
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        log.debug('watch', 'no active ids — idle');
        return unsubscribe;
      }

      // Kick the loop iff none is scheduled/running (idempotent re-target: a
      // re-entrant call from onUpdate→ingest→rewatch just updates activeIds).
      if (!ticking && timer === null) {
        timer = setTimeout(runTick, 0);
      }
      return unsubscribe;
    },
  };
}
