// actors-store/index.ts — Standalone Zustand store for `actors` rows
// (casting-swap pipeline) + a BackgroundJobsStore consumer bridge (ADR-037).
//
// Compose-only: spreads the 5 slices into one store and registers ONE jobs
// bridge (module init, re-registered on auth user change, with an unsubscribe).
// Bảng `actors` is NOT in the realtime publication → NO channel for it; the ONLY
// realtime input is `background_jobs` via `subscribeJobs`, and sync is refetch-
// driven. Snapshot mount/reset lifecycle lives in the SPACE COMPONENT (not here).

import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { createLogger } from '@/utils/logger';
import {
  ACTOR_SWAP_TYPES,
  TERMINAL_STATUSES,
  useBackgroundJobsStore,
} from '../background-jobs-store';
import { useAuthStore } from '../auth-store';
import { createCrudSlice } from './slices/crud-slice';
import { createStageSlice } from './slices/stage-slice';
import { createJobsSlice } from './slices/jobs-slice';
import { createSyncSlice } from './slices/sync-slice';
import { createInjectSlice } from './slices/inject-slice';
import type { ActorsStore } from './types';

const log = createLogger('Store', 'ActorsStore');

export const useActorsStore = create<ActorsStore>()(
  devtools(
    subscribeWithSelector((...a) => ({
      ...createCrudSlice(...a),
      ...createStageSlice(...a),
      ...createJobsSlice(...a),
      ...createSyncSlice(...a),
      ...createInjectSlice(...a),
    })),
    { name: 'actors-store' },
  ),
);

// ── BackgroundJobsStore consumer bridge (ADR-037) ────────────────────────────
// Register a single `subscribeJobs` listener for the 3 actor stage-job types.
// On each event: upsert progress (`applyJobRow`); on a terminal transition,
// refetch the pair (server wrote `swap_results[]` — client never merges by hand)
// — parity remix `ensureRemixJobConsumer`. Re-register when the active user
// changes; the shared store clears listeners on logout teardown.

let actorJobConsumerUnsub: (() => void) | null = null;
let lastConsumerUserId: string | null = null;

function ensureActorJobConsumer(userId: string | null | undefined): void {
  if (userId === lastConsumerUserId) return;
  lastConsumerUserId = userId ?? null;

  if (actorJobConsumerUnsub) {
    actorJobConsumerUnsub();
    actorJobConsumerUnsub = null;
  }

  if (!userId) {
    log.info('ensureActorJobConsumer', 'no user — cleared jobs');
    useActorsStore.setState({ jobs: [] });
    return;
  }

  log.info('ensureActorJobConsumer', 'subscribe actor stage jobs', { userId });
  actorJobConsumerUnsub = useBackgroundJobsStore
    .getState()
    .subscribeJobs({ types: [...ACTOR_SWAP_TYPES] }, (event) => {
      const store = useActorsStore.getState();

      if (event.transition === 'removed') {
        store.dismissJob(event.job.id);
        return;
      }

      store.applyJobRow(event.job);

      if (
        event.transition === 'terminal' ||
        TERMINAL_STATUSES.has(event.job.status)
      ) {
        const pairId =
          typeof event.job.params?.pair_id === 'string'
            ? event.job.params.pair_id
            : null;
        if (pairId) {
          log.info('ensureActorJobConsumer', 'terminal → refetch pair', {
            pairId,
            jobId: event.job.id,
            status: event.job.status,
          });
          void store.refetchPair(pairId).catch((err) => {
            log.warn('ensureActorJobConsumer', 'refetch failed', {
              pairId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    });
}

// auth-store doesn't use subscribeWithSelector — read full state + diff userId.
useAuthStore.subscribe((state) => {
  ensureActorJobConsumer(state.user?.id ?? null);
});

// Register if auth is already resolved at module load time.
{
  const initialUserId = useAuthStore.getState().user?.id ?? null;
  if (initialUserId) ensureActorJobConsumer(initialUserId);
}

// ── Barrel re-export ─────────────────────────────────────────────────────────

export type {
  ActorsStore,
  ActorJob,
  InjectUiState,
  EnqueueJobOutcome,
  CropRef,
  ActorPair,
} from './types';
export * from './selectors';
