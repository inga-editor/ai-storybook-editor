// install-remix-editor-seams.ts — Wire the 4 runtime seams to the Remix Swap
// Service (ADR-052) + start the background-jobs consumer/store, for the sub-app.
//
// ⚡ ORDERING (CRITICAL): this MUST run BEFORE the book bundle hydrates. Setting
// `snapshot.meta.id` triggers `remix-store.syncFromServer` → `gateway.listBySnapshot`,
// and an uninstalled gateway throws (fail-fast, Phase 01). The app root calls this
// synchronously the moment the session is authed, so it precedes any child effect
// that could hydrate. Idempotent — a repeated call is a no-op.

import { createLogger } from '@/utils/logger';
import { setRemixDataGateway } from '@/stores/remix-store/gateway/remix-data-gateway';
import { ensureRemixJobConsumer } from '@/stores/remix-store/register-remix-job-consumer';
import { setJobProgressSource, useBackgroundJobsStore } from '@/stores/background-jobs-store';
import {
  setImageApiAuthTokenSource,
  setImageApiBaseUrl,
  setImageApiSendApiKey,
} from '@/apis/image-api-client';
import { setImageUploader } from '@/apis/storage-api';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';
import { createHttpRemixGateway } from '../data/http-remix-gateway';
import { createHttpImageUploader } from '../data/http-image-uploader';
import { createPollingJobProgressSource } from '../data/polling-job-progress-source';

const log = createLogger('RemixEditor', 'InstallSeams');

/** Fixed opaque identity for the sub-app (no supabase user) — drives the job
 *  consumer + background-jobs store lifecycle. */
const EDITOR_IDENTITY = 'remix-editor';

export interface EditorSeamDeps {
  authorizedFetch: AuthorizedFetch;
  /** Sync token accessor (ADR-053 — no refresh). Throws SessionExpiredError past exp. */
  getAccessToken: () => string;
}

let installed = false;

/** Install every sub-app seam exactly once. Safe to call on each render (guarded). */
export function installRemixEditorSeams(deps: EditorSeamDeps): void {
  if (installed) {
    log.debug('installRemixEditorSeams', 'already installed — no-op');
    return;
  }
  installed = true;

  const swapBaseUrl =
    (import.meta.env.VITE_REMIX_SWAP_SERVICE_BASE_URL as string | undefined) ?? '';

  // 1. remixes-table gateway → HTTP swap-service (editor envelope).
  setRemixDataGateway(createHttpRemixGateway(deps.authorizedFetch));

  // 2. Job progress → polling GET /api/jobs/status (replaces Supabase realtime).
  //    Installed BEFORE `init` so the store reuses it instead of auto-installing
  //    the realtime source.
  setJobProgressSource(createPollingJobProgressSource(deps.authorizedFetch));

  // 3. image-api client → swap-service base URL, editor-session Bearer, NO X-API-Key.
  //    The image-api token source stays async; `getAccessToken` is now sync (no refresh) —
  //    just drop the await. It throws SessionExpiredError past exp, rejecting the source.
  setImageApiBaseUrl(swapBaseUrl);
  setImageApiAuthTokenSource(async () => `Bearer ${deps.getAccessToken()}`);
  setImageApiSendApiKey(false);

  // 4. Image uploader → POST /api/editor/assets (no supabase-js).
  setImageUploader(createHttpImageUploader(deps.authorizedFetch));

  // Wire the remix job consumer + start the (polling) background-jobs store under
  // the fixed editor identity — precedes any job enqueue / hydration.
  ensureRemixJobConsumer(EDITOR_IDENTITY);
  useBackgroundJobsStore.getState().init(EDITOR_IDENTITY);

  log.info('installRemixEditorSeams', 'seams installed', {
    identity: EDITOR_IDENTITY,
    swapBaseUrl,
  });
}

/** Test-only: allow a fresh install on the next call. */
export function __resetRemixEditorSeamsForTest(): void {
  installed = false;
}
