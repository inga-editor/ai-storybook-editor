// use-editor-session.ts — React binding over the (headless) editor-session-keeper.
//
// Boot flow (auth spec §2.3, rev 260812): read the `#handoff=` code + WIPE the fragment
// synchronously (before any await), then exchange it at the swap service; else RESUME from the
// stored access token — a purely LOCAL `exp` check, 0 network (auth spec §3.5); else
// `needs_admin_app`. The fragment is consumed via a MODULE-level guard so React StrictMode's
// double-invoked useState initializer cannot burn the one-time code twice (→ false
// HANDOFF_INVALID). `authorizedFetch`/`getAccessToken` are re-exported straight from the
// keeper so non-React consumers share the same token.
//
// A single ~30s interval derives `expiresSoon` (exp − now ≤ 15 min → banner "save đi") and
// `sessionExpired` (now ≥ exp). ADR-053: no refresh — expiry is one-way.
//
// Design SSOT: ai-storybook-design/component/remix-editor-app/01-editor-auth-module.md §2.2.
import { useEffect, useRef, useState } from 'react';
import { createLogger } from '@/utils/logger';
import { parseRemixEditorRoute } from '../route/parse-remix-editor-route';
import type { EditorSessionStatus } from '../types/remix-editor-status';
import { parseHandoffFragment } from './parse-handoff-fragment';
import { exchangeHandoffAssertion } from './swap-service-auth-api';
import {
  authorizedFetch,
  clearSession,
  getAccessToken,
  getAdminName,
  getExpiresAtMs,
  loadStoredSession,
  storeSession,
  subscribeSessionExpired,
  type AuthorizedFetch,
} from './editor-session-keeper';

const log = createLogger('RemixEditor', 'UseEditorSession');

const ADMIN_APP_URL: string = (import.meta.env.VITE_ADMIN_APP_URL as string | undefined) ?? '';

/** Warn this many ms BEFORE `exp` so the admin can save (banner). */
const EXPIRES_SOON_MS = 15 * 60 * 1000;
/** Timer cadence for the expiresSoon / sessionExpired check. */
const EXPIRY_TICK_MS = 30_000;

// --- One-time handoff consumption (module scope — survives StrictMode re-invocation) -----
let handoffConsumed = false;
let consumedCode: string | null = null;

/**
 * Read `#handoff=<code>` and ERASE the fragment synchronously (history.replaceState) the
 * first time it runs; subsequent calls return the cached result without re-parsing. This
 * makes the read idempotent under StrictMode's doubled useState initializer.
 */
function consumeHandoffCode(): string | null {
  if (handoffConsumed) return consumedCode;
  handoffConsumed = true;

  const parsed = parseHandoffFragment(window.location.hash);
  if (parsed) {
    // Wipe BEFORE any await so the one-time code never lingers in the URL bar/history.
    const { pathname, search } = window.location;
    window.history.replaceState(null, '', pathname + search);
    consumedCode = parsed.code;
  } else {
    consumedCode = null;
  }
  return consumedCode;
}

/** Test-only: allow a fresh handoff read on the next mount. */
export function __resetHandoffConsumedForTest(): void {
  handoffConsumed = false;
  consumedCode = null;
}

/** Build the Admin-App deeplink with return context (bookId / remixId) for re-authorize. */
export function buildAdminAppReturnUrl(): string {
  if (!ADMIN_APP_URL) return '';
  const route = parseRemixEditorRoute({
    pathname: window.location.pathname,
    search: window.location.search,
  });
  try {
    const url = new URL(ADMIN_APP_URL);
    if (route?.bookId) url.searchParams.set('return_book_id', route.bookId);
    if (route?.preselectRemixId) url.searchParams.set('return_remix_id', route.preselectRemixId);
    return url.toString();
  } catch {
    log.warn('buildReturnUrl', 'VITE_ADMIN_APP_URL is not a valid URL');
    return ADMIN_APP_URL;
  }
}

export interface UseEditorSessionResult {
  sessionStatus: EditorSessionStatus;
  sessionExpired: boolean;
  expiresSoon: boolean;
  adminDisplay: string;
  getAccessToken: () => string;
  authorizedFetch: AuthorizedFetch;
  buildAdminAppReturnUrl: () => string;
}

/**
 * Headless hook that owns editor-session acquisition + exposes the keeper's HTTP surface.
 * Boot runs exactly once (ref-guarded). Resume from storage is a synchronous local `exp`
 * check (0 network). A mid-session expiry flips `sessionExpired` WITHOUT leaving `authed`
 * (the shell overlays a modal instead of destroying dirty state).
 */
export function useEditorSession(): UseEditorSessionResult {
  // Consume the handoff code during the (lazy) initializer — pure w.r.t. React, guarded once.
  const [handoffCode] = useState<string | null>(() => consumeHandoffCode());

  const [sessionStatus, setSessionStatus] = useState<EditorSessionStatus>('booting');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [expiresSoon, setExpiresSoon] = useState(false);
  const [adminDisplay, setAdminDisplay] = useState('Admin');

  const bootStartedRef = useRef(false);

  useEffect(() => {
    if (bootStartedRef.current) return; // StrictMode re-run / genuine re-render: boot once
    bootStartedRef.current = true;

    async function boot() {
      if (handoffCode) {
        log.info('boot', 'exchanging handoff assertion', { hasHandoff: true, status: 'exchanging' });
        setSessionStatus('exchanging');
        try {
          storeSession(await exchangeHandoffAssertion(handoffCode));
          setAdminDisplay(getAdminName() ?? 'Admin');
          setSessionStatus('authed');
          log.info('boot', 'exchange ok', { status: 'authed' });
        } catch {
          setSessionStatus('needs_admin_app');
          log.warn('boot', 'exchange failed', { status: 'needs_admin_app' });
        }
        return;
      }

      // Resume = LOCAL exp check on the stored access token, 0 network (auth spec §3.5).
      if (loadStoredSession()) {
        setAdminDisplay(getAdminName() ?? 'Admin');
        setSessionStatus('authed');
        log.info('boot', 'resumed from stored token', { hasHandoff: false, status: 'authed' });
        return;
      }

      clearSession(); // scrub any stale/expired token + legacy refresh key
      setSessionStatus('needs_admin_app');
      log.info('boot', 'no handoff, no live stored token', {
        hasHandoff: false,
        status: 'needs_admin_app',
      });
    }

    void boot();
  }, [handoffCode]);

  // Mid-session 401 / past-exp read raises the overlay flag (status stays 'authed').
  useEffect(() => subscribeSessionExpired(() => setSessionExpired(true)), []);

  // Single ~30s timer: derive expiresSoon (banner) + sessionExpired (modal) from the token's
  // absolute exp. Runs only while authed; cleans up on unmount / status change.
  useEffect(() => {
    if (sessionStatus !== 'authed') return;
    const tick = () => {
      const exp = getExpiresAtMs();
      const now = Date.now();
      if (now >= exp) setSessionExpired(true);
      setExpiresSoon(exp - now <= EXPIRES_SOON_MS);
    };
    tick();
    const id = window.setInterval(tick, EXPIRY_TICK_MS);
    return () => window.clearInterval(id);
  }, [sessionStatus]);

  return {
    sessionStatus,
    sessionExpired,
    expiresSoon,
    adminDisplay,
    getAccessToken,
    authorizedFetch,
    buildAdminAppReturnUrl,
  };
}
