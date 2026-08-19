// use-export-job-watcher.ts — Distribution background-job watcher. CONSUMER of
// the unified BackgroundJobsStore (ADR-037): no own channel/reheal/poll — it
// subscribes to EXPORT_TYPES (export_pdf + render_book_video + transcode_video
// + export_player_media)
// via `subscribeJobs` and refetches the affected source's distribution so the
// EXPORTING → UPDATED badge surfaces.
//
// Auto-chain (07 render → 08 transcode): both jobs land on the same single
// channel (08 inherits the owner's user_id). On 07 terminal we refetch, which
// pulls sd/hd/fhd leaves now carrying job_id=08 ('exporting') into the registry;
// 08's own events then resolve to the same source and refetch again. No
// re-subscribe, no extra user action.
//
// Drive-badge model = refetch-once (Validation S1): first running event per job
// → one refetch (parity with the legacy seenRunning gate); terminal → debounced
// refetch + registry rebuild. Overlay (0-refetch via step_details) is deferred.

import * as React from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useBookActions, useBookStore } from '@/stores/book-store';
import { useRemixActions, useRemixStore } from '@/stores/remix-store';
import {
  EXPORT_TYPES,
  TERMINAL_STATUSES,
  useBackgroundJobsStore,
  type JobEvent,
} from '@/stores/background-jobs-store';
import { coalesceDistribution } from '@/features/editor/components/config-creative-space/distribution-helpers';
import {
  rebuildRegistryForSource,
  resolveSource,
  type LeafRef,
  type ResolvedSource,
} from './export-job-registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ExportJobWatcher');

const EXPORT_TYPE_SET = new Set<string>(EXPORT_TYPES);
const TERMINAL_DEBOUNCE_MS = 250;
const REBUILD_DELAY_MS = 300; // let the refetch land before rescanning leaves

interface ExportJobWatcherArgs {
  bookId: string | null;
  remixIds: string[];
}

/** Subscribe to distribution export jobs; refetch the affected source on
 *  running/terminal transitions + self-heal stuck EXPORTING leaves on mount. */
export function useExportJobWatcher({ bookId, remixIds }: ExportJobWatcherArgs): void {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const { refetchBookDistribution } = useBookActions();
  const { refetchRemix } = useRemixActions();

  // Latest targets + actions in refs so the subscription effect only re-runs on
  // userId change (not on remix-list / action ref churn). Assign in an effect —
  // the repo lints ref writes in the render body.
  const bookIdRef = React.useRef(bookId);
  const remixIdsRef = React.useRef(remixIds);
  const refetchBookRef = React.useRef(refetchBookDistribution);
  const refetchRemixRef = React.useRef(refetchRemix);
  React.useEffect(() => {
    bookIdRef.current = bookId;
    remixIdsRef.current = remixIds;
    refetchBookRef.current = refetchBookDistribution;
    refetchRemixRef.current = refetchRemix;
  });

  React.useEffect(() => {
    if (!userId) {
      log.debug('subscribe', 'no user — skip');
      return;
    }
    log.info('subscribe', 'open distribution job watcher (consumer)', { userId });

    const registry = new Map<string, LeafRef[]>();
    const refetchedForJob = new Set<string>(); // first-running refetch gate (parity seenRunning)
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const refetchSource = (src: ResolvedSource) => {
      if (src.kind === 'remix') void refetchRemixRef.current(src.id);
      else void refetchBookRef.current(src.id);
    };

    const refetchDebounced = (src: ResolvedSource) => {
      const key = `${src.kind}:${src.id}`;
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        key,
        setTimeout(() => {
          debounceTimers.delete(key);
          refetchSource(src);
          // Rebuild the registry after the refetch has had time to land so the
          // newest leaf statuses (incl. auto-chain 08 leaves) are captured.
          setTimeout(() => rebuildRegistry(src), REBUILD_DELAY_MS);
        }, TERMINAL_DEBOUNCE_MS),
      );
    };

    const distributionFor = (src: ResolvedSource) => {
      if (src.kind === 'book') {
        return coalesceDistribution(useBookStore.getState().currentBook?.distribution);
      }
      const remix = useRemixStore.getState().remixes.find((r) => r.id === src.id);
      return coalesceDistribution(remix?.distribution);
    };

    const rebuildRegistry = (src: ResolvedSource) => {
      rebuildRegistryForSource(registry, src.kind, src.id, distributionFor(src));
    };

    const onJobEvent = (e: JobEvent) => {
      const src = resolveSource(e.job, bookIdRef.current, remixIdsRef.current);
      if (!src) return;

      if (e.transition === 'terminal') {
        log.info('onJobEvent', 'terminal → refetch source', {
          jobId: e.job.id,
          type: e.job.type,
          src,
        });
        refetchDebounced(src);
        return;
      }

      // Non-terminal drive badge: refetch once on the first running observation
      // per job (queued is skipped — leaf not written yet). Overlay deferred.
      if (e.job.status !== 'running') return;
      if (refetchedForJob.has(e.job.id)) return;
      refetchedForJob.add(e.job.id);
      log.info('onJobEvent', 'first running → refetch source', {
        jobId: e.job.id,
        type: e.job.type,
        src,
      });
      refetchSource(src);
      setTimeout(() => rebuildRegistry(src), REBUILD_DELAY_MS);
    };

    const unsubscribe = useBackgroundJobsStore
      .getState()
      .subscribeJobs({ types: [...EXPORT_TYPES] }, onJobEvent);

    // Mount reconcile (Validation S1): the store already topped-up jobsById, so
    // seed the registry from current distributions + self-heal any job that went
    // terminal while the user was away (leaf stuck 'exporting').
    const seedSources: ResolvedSource[] = [];
    if (bookIdRef.current) seedSources.push({ kind: 'book', id: bookIdRef.current });
    for (const id of remixIdsRef.current) seedSources.push({ kind: 'remix', id });
    for (const src of seedSources) rebuildRegistry(src);

    const jobsById = useBackgroundJobsStore.getState().jobsById;
    for (const job of Object.values(jobsById)) {
      if (!EXPORT_TYPE_SET.has(job.type)) continue;
      const src = resolveSource(job, bookIdRef.current, remixIdsRef.current);
      if (!src) continue;
      if (TERMINAL_STATUSES.has(job.status)) {
        log.info('mountReconcile', 'terminal-while-away → self-heal refetch', {
          jobId: job.id,
          src,
        });
        refetchDebounced(src);
      }
    }

    return () => {
      log.info('subscribe', 'close distribution job watcher', { userId });
      unsubscribe();
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      registry.clear();
      refetchedForJob.clear();
    };
  }, [userId]);
}
