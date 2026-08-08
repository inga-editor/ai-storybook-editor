// use-player-token.ts — Acquire + hold the opaque player token (fragment ∨ postMessage).
//
// The token is OPAQUE to the client: never decoded, verified, or persisted. In-memory
// only (no localStorage/sessionStorage/cookie). Source precedence:
//   1. URL fragment `#token=…` (deep-link) — wiped from the URL right after read.
//   2. `player:init` / `player:token-refresh` postMessage — applied via `applyToken`.
// If neither arrives within 10s → `token_missing`, but a LATE `applyToken` still flips
// back to `has_token` (playback can start whenever the parent finally initializes).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '@/utils/logger';
import { parseTokenFragment } from './parse-token-fragment';
import type { PlayerInitOptions } from '../embed/player-messages';

const log = createLogger('Player', 'AuthModule');

/** How long to wait for a token before declaring it missing (auth spec §3.5). */
const TOKEN_WAIT_TIMEOUT_MS = 10_000;

export type PlayerAuthStatus = 'has_token' | 'waiting_token' | 'token_missing';

export interface UsePlayerTokenResult {
  token: string | null;
  options: PlayerInitOptions | null;
  authStatus: PlayerAuthStatus;
  /** Apply a token from postMessage. `options` undefined ⇒ keep prior (token-refresh). */
  applyToken: (token: string, options?: PlayerInitOptions) => void;
}

interface TokenState {
  token: string | null;
  options: PlayerInitOptions | null;
  authStatus: PlayerAuthStatus;
}

/**
 * Headless hook that owns the player token lifecycle. Returns the token (opaque),
 * any init options, the auth status, and `applyToken` for the embed bridge to call.
 */
export function usePlayerToken(): UsePlayerTokenResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lazy init reads the fragment once (pure read — no side effect). The fragment wipe
  // + timeout arming happen in the effect below (those ARE side effects).
  const [state, setState] = useState<TokenState>(() => {
    const parsed = parseTokenFragment(window.location.hash);
    if (parsed) {
      log.info('init', 'token acquired from fragment', { tokenLen: parsed.token.length });
      return { token: parsed.token, options: {}, authStatus: 'has_token' };
    }
    log.debug('init', 'no fragment token; waiting for parent init');
    return { token: null, options: null, authStatus: 'waiting_token' };
  });

  // Snapshot of whether the token came from the fragment (stable across the mount).
  const cameFromFragmentRef = useRef(state.authStatus === 'has_token');

  useEffect(() => {
    if (cameFromFragmentRef.current) {
      // Wipe `#token=…` from the URL bar to reduce leakage on copy/screenshot.
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', pathname + search);
      log.debug('init', 'fragment wiped from url');
      return;
    }

    // Waiting on the parent: arm the 10s missing-token timeout.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setState((prev) =>
        prev.authStatus === 'waiting_token'
          ? { ...prev, authStatus: 'token_missing' }
          : prev,
      );
      log.warn('init', 'token wait timed out');
    }, TOKEN_WAIT_TIMEOUT_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const applyToken = useCallback((newToken: string, newOptions?: PlayerInitOptions) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    log.info('applyToken', 'token applied from postMessage', {
      tokenLen: newToken.length,
      hasOptions: newOptions !== undefined,
    });
    setState((prev) => ({
      token: newToken,
      options: newOptions !== undefined ? newOptions : prev.options,
      authStatus: 'has_token',
    }));
  }, []);

  return {
    token: state.token,
    options: state.options,
    authStatus: state.authStatus,
    applyToken,
  };
}
