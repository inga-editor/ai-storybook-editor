// remix-editor-app.tsx — Root shell of the Remix Editor sub-app (Vite entry #3).
//
// A pure, render-derived state machine: the route is parsed ONCE (lazy useState), and the
// render `status` is derived synchronously from (route, sessionStatus, bundleStatus) via a
// pure function — NO setState-in-effect (React 19 lint would flag it). The EditorAuthModule
// owns the session (flat 12h token exchange / local resume / authorizedFetch — ADR-053);
// Phase 06 wires the book bundle. This shell owns NO Supabase client and imports supabase-js
// nowhere.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/README.md §2, §4.2.
import { useState } from 'react';
import { createLogger } from '@/utils/logger';
import { parseRemixEditorRoute } from './route/parse-remix-editor-route';
import { deriveRemixEditorStatus } from './derive-remix-editor-status';
import { useEditorSession } from './auth/use-editor-session';
import { installRemixEditorSeams } from './bootstrap/install-remix-editor-seams';
import { useBookBundle } from './data/use-book-bundle';
import type { RemixEditorRouteParams } from './types/remix-editor-status';
import { RemixEditorLoadingState } from './states/remix-editor-loading-state';
import { NeedsAdminAppState } from './states/needs-admin-app-state';
import { ConfigMissingState } from './states/config-missing-state';
import { RemixEditorErrorState } from './states/remix-editor-error-state';
import { RemixEditorShell } from './shell/remix-editor-shell';

const log = createLogger('RemixEditor', 'RemixEditorApp');

export function RemixEditorApp() {
  // Parse the route exactly ONCE (URL is stable for the sub-app's lifetime; no router).
  const [route] = useState<RemixEditorRouteParams | null>(() =>
    parseRemixEditorRoute({
      pathname: window.location.pathname,
      search: window.location.search,
    }),
  );

  // Phase 04: real editor session (handoff exchange / silent resume).
  const {
    sessionStatus,
    sessionExpired,
    expiresSoon,
    adminDisplay,
    authorizedFetch,
    getAccessToken,
    buildAdminAppReturnUrl,
  } = useEditorSession();

  // Re-authorize via the Admin App in a NEW tab (carrying the return deeplink) so
  // the editing screen isn't lost. `buildAdminAppReturnUrl()` folds in the current
  // bookId/remixId; empty when `VITE_ADMIN_APP_URL` is unset → no-op.
  const handleOpenAdminApp = (): void => {
    const url = buildAdminAppReturnUrl();
    if (!url) {
      log.warn('openAdminApp', 'no admin app url configured');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Phase 05: install the runtime seams (gateway / job-poll / image-api / uploader)
  // the moment the session is authed — BEFORE any bundle hydration mounts. Done at
  // render time (not in an effect) so it precedes child effects: React runs child
  // effects before the parent's, and the Phase 06 bundle hook's fetch effect gates
  // on the installed gateway (the snapshot subscription fires syncFromServer through
  // it). The installer is idempotent + module-guarded, so a render-time call is safe
  // under StrictMode's doubled render.
  if (sessionStatus === 'authed') {
    installRemixEditorSeams({ authorizedFetch, getAccessToken });
  }

  // Phase 06: load + hydrate the book bundle. Gate the bookId on `authed` so the fetch
  // effect (and its store hydration) starts only AFTER the seams are installed above.
  const { bundleStatus, book, error: bundleError } = useBookBundle(
    route && sessionStatus === 'authed' ? route.bookId : null,
    authorizedFetch,
  );

  const { status, errorCode } = deriveRemixEditorStatus(
    route,
    sessionStatus,
    bundleStatus,
    bundleError?.code,
  );
  log.info('render', 'remix editor shell', {
    status,
    errorCode,
    hasRoute: route !== null,
    sessionStatus,
    bundleStatus,
    hasBook: book !== null,
  });

  switch (status) {
    case 'booting':
    case 'exchanging':
    case 'loading':
      return <RemixEditorLoadingState />;
    case 'needs_admin_app':
      return <NeedsAdminAppState />;
    case 'config_missing':
      return <ConfigMissingState />;
    case 'error':
      return (
        <RemixEditorErrorState code={errorCode} onRetry={() => window.location.reload()} />
      );
    case 'ready':
      // Bundle hydrated + book has a remix config → mount the real shell around
      // RemixCreativeSpace. `sessionExpired` (a mid-session 401 / past-exp read) raises an
      // overlay inside the shell WITHOUT tearing down the space; `expiresSoon` shows the
      // informational "save your work" banner (ADR-053 — no refresh path).
      return (
        <RemixEditorShell
          bookTitle={book?.title ?? ''}
          adminDisplay={adminDisplay}
          preselectRemixId={route?.preselectRemixId}
          sessionExpired={sessionExpired}
          expiresSoon={expiresSoon}
          onOpenAdminApp={handleOpenAdminApp}
        />
      );
  }
}
