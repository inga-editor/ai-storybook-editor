// background-jobs-store/realtime-job-progress-source.ts — Default (editor)
// JobProgressSource. Wraps the existing single Supabase channel
// (`openBackgroundJobsChannel`) + reconnect top-up (`topUpSync`) unchanged, so
// editor behavior is identical: ONE channel, ingest-ALL, reheal + poll fallback.
//
// Idempotency contract: `watch()` is called again on every active-set change.
// The FIRST call opens the channel + does an initial top-up; every subsequent
// call is a no-op that returns the SAME stable unsubscribe (NO channel churn —
// the classic realtime-store bug of tear-down+reopen per active-set delta). The
// `jobIds` hint is deliberately IGNORED here (see JobProgressSource docs): the
// channel already streams ALL of the user's rows, which is what keeps the
// ADR-037 global toast feed (export/render/thumbnail) alive.

import { createLogger } from '@/utils/logger';
import { openBackgroundJobsChannel, type ChannelHandle } from './channel';
import { topUpSync } from './top-up';
import { mapRowToBackgroundJob } from './ingest';
import type { JobProgressSource, Unsubscribe } from './job-progress-source';
import type { BackgroundJob } from './types';

const log = createLogger('Store', 'RealtimeJobProgressSource');

/** Realtime-only side hooks the seam interface can't carry (delete events +
 *  channel liveness). Supplied by the store's `init` — a polling source has no
 *  equivalent and simply omits them. */
export interface RealtimeSourceHooks {
  onDelete: (id: string) => void;
  onLive: () => void;
  onDown: () => void;
}

/** Build the editor's default realtime source for a supabase `identity` (user id).
 *  `hooks` wire the realtime-only delete + liveness signals back into the store. */
export function createRealtimeJobProgressSource(
  identity: string,
  hooks: RealtimeSourceHooks,
): JobProgressSource {
  let channelHandle: ChannelHandle | null = null;
  // Latest ingest callback from watch(); refreshed on re-watch so onRow/onPoll
  // always dispatch through the current closure.
  let onUpdate: ((job: BackgroundJob) => void) | null = null;

  const unsubscribe: Unsubscribe = () => {
    if (!channelHandle) return;
    log.info('unsubscribe', 'close channel', { identity });
    channelHandle.teardown();
    channelHandle = null;
    onUpdate = null;
  };

  const watch = (_jobIds: string[], nextOnUpdate: (job: BackgroundJob) => void): Unsubscribe => {
    // Refresh the dispatch closure regardless — cheap, keeps ingest current.
    onUpdate = nextOnUpdate;

    // Idempotent: already open → return the SAME handle, do NOT reopen (no churn).
    if (channelHandle) {
      log.debug('watch', 'already live — reuse channel', { identity });
      return unsubscribe;
    }

    log.info('watch', 'open channel + initial top-up', { identity });
    channelHandle = openBackgroundJobsChannel({
      userId: identity,
      // ingest-ALL: every row streams through, jobIds hint ignored by design.
      onRow: (row) => onUpdate?.(mapRowToBackgroundJob(row)),
      onDelete: (id) => hooks.onDelete(id),
      onLive: () => hooks.onLive(),
      onDown: () => hooks.onDown(),
      onPoll: () => {
        void topUpSync(identity, (rows) => {
          for (const row of rows) onUpdate?.(row);
        });
      },
    });

    // Catch jobs that started before this mount (parity with legacy init top-up).
    void topUpSync(identity, (rows) => {
      for (const row of rows) onUpdate?.(row);
    });

    return unsubscribe;
  };

  return { watch };
}
