// remix-store/register-remix-job-consumer.ts — Wires RemixStore as a CONSUMER of
// the unified BackgroundJobsStore (ADR-037): registers a `subscribeJobs` listener
// for the remix swap job types and derives the `jobs[]` projection from events.
//
// Extracted from `index.ts` (ADR-052 sub-app port) and decoupled from auth-store:
// the parameter is an OPAQUE `identity` (string | null), NOT a supabase user id.
// The editor still drives it via `useAuthStore.subscribe(user.id)` in index.ts
// (behavior unchanged); the remix-editor sub-app — which has no supabase user —
// calls this directly with its fixed editor identity so remix job progress is
// never silently dropped (the `jobs: []` landmine when there is no auth user).

import { createLogger } from '@/utils/logger';
import { REMIX_SWAP_TYPES, useBackgroundJobsStore } from '../background-jobs-store';
import { useRemixStore } from './index';

const log = createLogger('Store', 'RemixJobConsumer');

let remixJobConsumerUnsub: (() => void) | null = null;
let lastConsumerIdentity: string | null = null;

/** (Re)register the remix job consumer for `identity`. Idempotent per identity:
 *  a repeated same-identity call is a no-op; a changed identity tears down the
 *  old listener first. `null` clears the projection (`jobs: []`). */
export function ensureRemixJobConsumer(identity: string | null): void {
  if (identity === lastConsumerIdentity) return;
  lastConsumerIdentity = identity;

  if (remixJobConsumerUnsub) {
    remixJobConsumerUnsub();
    remixJobConsumerUnsub = null;
  }

  if (!identity) {
    log.info('ensureRemixJobConsumer', 'no identity — cleared jobs');
    useRemixStore.setState({ jobs: [] });
    return;
  }

  log.info('ensureRemixJobConsumer', 'subscribe remix swap jobs', { identity });
  remixJobConsumerUnsub = useBackgroundJobsStore
    .getState()
    .subscribeJobs({ types: [...REMIX_SWAP_TYPES] }, (event) =>
      useRemixStore.getState().onRemixJobEvent(event),
    );
}
