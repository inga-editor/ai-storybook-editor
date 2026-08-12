// background-jobs-store/index.ts — Unified BackgroundJobsStore (ADR-037). Single
// source of truth for every `background_jobs` row of the user: owns ONE realtime
// channel + ONE ingest path, exposes an imperative `subscribeJobs` API + reactive
// selectors. Domain-agnostic: NO RemixStore/BookStore import, NO domain refetch.
// Consumers wire side-effects through `subscribeJobs`.
//
// Compose-only file: state + actions here, pure helpers in `ingest.ts`, channel
// in `channel.ts`, top-up in `top-up.ts`, read-side hooks in `selectors.ts`.

import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { createLogger } from '@/utils/logger';
import { cancelJobRemote } from '@/apis/jobs-api';
import { classifyTransition, matches } from './ingest';
import {
  createRealtimeJobProgressSource,
  type RealtimeSourceHooks,
} from './realtime-job-progress-source';
import {
  getJobProgressSource,
  hasJobProgressSource,
  setJobProgressSource,
  type Unsubscribe,
} from './job-progress-source';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  TOP_UP_WINDOW_MS,
  type BackgroundJob,
  type JobEvent,
  type JobListener,
  type JobPredicate,
} from './types';

const log = createLogger('Store', 'BackgroundJobsStore');

export interface BackgroundJobsState {
  jobsById: Record<string, BackgroundJob>;
  isChannelLive: boolean;

  // Lifecycle (app-root singleton — init at auth resolve, teardown at logout).
  // `identity` is opaque (editor: supabase user id; sub-app: fixed token, e.g.
  // 'remix-editor') so the store no longer hard-depends on a supabase user.
  init: (identity: string) => void;
  teardown: () => void;

  // Ingest (1 path: realtime + poll + top-up + seed).
  ingest: (rows: BackgroundJob[]) => void;
  seed: (partial: BackgroundJob) => void;
  removeJob: (id: string) => void;

  // Generic actions.
  cancelJob: (id: string) => Promise<void>;

  // Imperative subscribe API.
  subscribeJobs: (predicate: JobPredicate, listener: JobListener) => () => void;
}

// ── Module-scope (non-reactive): listener registry + channel handle + user ───
// Kept out of zustand state so registering a listener / channel churn never
// triggers a component re-render.

interface ListenerEntry {
  predicate: JobPredicate;
  listener: JobListener;
}
const listeners = new Set<ListenerEntry>();

// Active JobProgressSource watch handle (realtime channel closer OR polling stop).
let progressHandle: Unsubscribe | null = null;
let activeIdentity: string | null = null;
// Signature of the current active-job id set — `watch()` is only re-issued when
// this changes, so a progress tick that doesn't alter membership never churns.
let lastActiveKey = '';
// Track whether WE auto-installed the default realtime source (vs an external
// sub-app source): only our own default gets replaced on identity change.
let sourceIsDefault = false;
let defaultSourceIdentity: string | null = null;

/** Active id set (sorted) + its join key. */
function computeActiveIds(jobsById: Record<string, BackgroundJob>): { ids: string[]; key: string } {
  const ids = Object.keys(jobsById)
    .filter((id) => ACTIVE_STATUSES.has(jobsById[id].status))
    .sort();
  return { ids, key: ids.join(',') };
}

/** Re-issue `watch()` against the current active set. Idempotent for realtime
 *  (same handle, no channel reopen); re-targets ids for a polling source. Skipped
 *  when no source is installed (e.g. unit tests ingesting without `init`). */
function rewatch(get: () => BackgroundJobsState): void {
  if (!hasJobProgressSource()) return;
  const { ids, key } = computeActiveIds(get().jobsById);
  if (progressHandle && key === lastActiveKey) return; // active-set unchanged — no re-watch
  lastActiveKey = key;
  progressHandle = getJobProgressSource().watch(ids, (job) => get().ingest([job]));
}

export const useBackgroundJobsStore = create<BackgroundJobsState>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      jobsById: {},
      isChannelLive: false,

      init: (identity) => {
        if (activeIdentity === identity && progressHandle) {
          log.debug('init', 'already live for identity — no-op', { identity });
          return;
        }
        // Identity changed (or first init): drop the previous watch handle. For
        // the default realtime source this closes the old channel.
        if (progressHandle) {
          log.info('init', 'identity changed — tear down previous watch', { prev: activeIdentity, next: identity });
          progressHandle();
          progressHandle = null;
        }
        lastActiveKey = '';

        // Install the default realtime source UNLESS one is already installed
        // externally (sub-app polling source, set before init). Replace our OWN
        // default when the identity changed (new user ⇒ new channel).
        const needDefault =
          !hasJobProgressSource() || (sourceIsDefault && defaultSourceIdentity !== identity);
        if (needDefault) {
          const hooks: RealtimeSourceHooks = {
            onDelete: (id) => get().removeJob(id),
            onLive: () => set({ isChannelLive: true }),
            onDown: () => set({ isChannelLive: false }),
          };
          setJobProgressSource(createRealtimeJobProgressSource(identity, hooks));
          sourceIsDefault = true;
          defaultSourceIdentity = identity;
        }

        activeIdentity = identity;
        set({ jobsById: {}, isChannelLive: false });

        // Single open per session — `rewatch` opens the channel via the source;
        // subsequent active-set changes reuse it (idempotent, no churn).
        log.info('init', 'open channel', { identity });
        rewatch(get);
      },

      teardown: () => {
        log.info('teardown', 'close store', { identity: activeIdentity });
        if (progressHandle) {
          progressHandle();
          progressHandle = null;
        }
        listeners.clear();
        activeIdentity = null;
        lastActiveKey = '';
        set({ jobsById: {}, isChannelLive: false });
        // Intentionally does NOT clear the installed source registry: an
        // externally-installed sub-app source must survive logout/teardown; a
        // re-init reuses it. Our own default source's channel is already closed
        // above via progressHandle().
      },

      ingest: (rows) => {
        if (rows.length === 0) return;
        const prevById = get().jobsById;
        const nextById = { ...prevById };
        const events: JobEvent[] = [];

        for (const row of rows) {
          const prev = prevById[row.id] ?? null;
          const transition = classifyTransition(prev, row);
          nextById[row.id] = row;
          events.push({ job: row, prev, transition });
        }

        // Generic retention GC: drop terminal jobs older than the top-up window
        // (active jobs always kept; domain prune lives in consumers). Each dropped
        // job also fans a 'removed' event so materialized consumers (remix jobs[])
        // don't keep an orphaned copy — parity with the legacy server-replace sync.
        const cutoffMs = Date.now() - TOP_UP_WINDOW_MS;
        for (const id of Object.keys(nextById)) {
          const j = nextById[id];
          if (TERMINAL_STATUSES.has(j.status) && new Date(j.updatedAt).getTime() < cutoffMs) {
            delete nextById[id];
            events.push({ job: j, prev: j, transition: 'removed' });
          }
        }

        set({ jobsById: nextById });

        // Active-set may have changed (new active id / terminal transition / GC
        // drop) — re-issue watch (idempotent for realtime; re-targets polling).
        rewatch(get);

        // Fan-out AFTER state commit so a listener reading getState() sees fresh.
        for (const event of events) {
          for (const entry of listeners) {
            if (!matches(entry.predicate, event.job)) continue;
            try {
              entry.listener(event);
            } catch (err) {
              log.error('ingest', 'listener threw', {
                jobId: event.job.id,
                transition: event.transition,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      },

      seed: (partial) => {
        log.debug('seed', 'optimistic insert', { jobId: partial.id, type: partial.type });
        get().ingest([partial]);
      },

      removeJob: (id) => {
        const cur = get().jobsById[id];
        if (!cur) return;
        log.debug('removeJob', 'remove', { id });
        const next = { ...get().jobsById };
        delete next[id];
        set({ jobsById: next });
        // Removing an active job shrinks the active set — re-issue watch.
        rewatch(get);
        // Fan out a 'removed' event so materialized consumers (remix jobs[])
        // drop their copy — covers DELETE events + 30s auto-dismiss.
        for (const entry of listeners) {
          if (!matches(entry.predicate, cur)) continue;
          try {
            entry.listener({ job: cur, prev: cur, transition: 'removed' });
          } catch (err) {
            log.error('removeJob', 'listener threw', {
              id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },

      cancelJob: async (id) => {
        log.info('cancelJob', 'request', { id });
        const cur = get().jobsById[id];
        // Optimistic cancelRequested via ingest so consumers (remix jobs[]) get
        // an 'updated' fan-out and reflect the flag immediately.
        if (cur) get().ingest([{ ...cur, cancelRequested: true }]);

        const result = await cancelJobRemote(id);
        if (!result.success) {
          log.error('cancelJob', 'failed — rollback flag', {
            id,
            httpStatus: result.httpStatus,
          });
          const c = get().jobsById[id];
          if (c) get().ingest([{ ...c, cancelRequested: false }]);
          throw new Error(result.error);
        }
        log.debug('cancelJob', 'flag set', { id, status: result.data.current_status });
      },

      subscribeJobs: (predicate, listener) => {
        const entry: ListenerEntry = { predicate, listener };
        listeners.add(entry);
        log.debug('subscribeJobs', 'listener added', {
          types: predicate.types,
          remixId: predicate.remixId,
          total: listeners.size,
        });
        return () => {
          listeners.delete(entry);
        };
      },
    })),
    { name: 'background-jobs-store' },
  ),
);

export type { BackgroundJob, JobEvent, JobPredicate, JobTransition } from './types';
export {
  REMIX_SWAP_TYPES,
  ACTOR_SWAP_TYPES,
  EXPORT_TYPES,
  SPREAD_THUMBNAIL_TYPES,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from './types';
export { mapRowToBackgroundJob } from './ingest';
export * from './selectors';

// I/O seam (ADR-052): sub-app bootstrap installs a polling source before init;
// editor auto-installs the realtime source via `init`.
export {
  setJobProgressSource,
  getJobProgressSource,
  hasJobProgressSource,
  type JobProgressSource,
  type Unsubscribe,
} from './job-progress-source';
export {
  createRealtimeJobProgressSource,
  type RealtimeSourceHooks,
} from './realtime-job-progress-source';
