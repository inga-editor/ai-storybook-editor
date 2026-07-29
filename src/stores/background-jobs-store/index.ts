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
import { classifyTransition, mapRowToBackgroundJob, matches } from './ingest';
import { openBackgroundJobsChannel, type ChannelHandle } from './channel';
import { topUpSync } from './top-up';
import {
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
  init: (userId: string) => void;
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
let channelHandle: ChannelHandle | null = null;
let activeUserId: string | null = null;

export const useBackgroundJobsStore = create<BackgroundJobsState>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      jobsById: {},
      isChannelLive: false,

      init: (userId) => {
        if (activeUserId === userId && channelHandle) {
          log.debug('init', 'already live for user — no-op', { userId });
          return;
        }
        if (channelHandle) {
          log.info('init', 'user changed — tear down previous channel', { prev: activeUserId, next: userId });
          channelHandle.teardown();
          channelHandle = null;
        }
        activeUserId = userId;
        set({ jobsById: {}, isChannelLive: false });

        log.info('init', 'open channel', { userId });
        channelHandle = openBackgroundJobsChannel({
          userId,
          onRow: (row) => get().ingest([mapRowToBackgroundJob(row)]),
          onDelete: (id) => get().removeJob(id),
          onLive: () => set({ isChannelLive: true }),
          onDown: () => set({ isChannelLive: false }),
          onPoll: () => {
            void topUpSync(userId, (rows) => get().ingest(rows));
          },
        });

        // Catch jobs that started before this mount.
        void topUpSync(userId, (rows) => get().ingest(rows));
      },

      teardown: () => {
        log.info('teardown', 'close store', { userId: activeUserId });
        if (channelHandle) {
          channelHandle.teardown();
          channelHandle = null;
        }
        listeners.clear();
        activeUserId = null;
        set({ jobsById: {}, isChannelLive: false });
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
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from './types';
export { mapRowToBackgroundJob } from './ingest';
export * from './selectors';
