// use-playable-book.ts — State machine over PlayerDataSource. The sub-app reads only
// `{ payload, dataStatus, error, reload }`; all fetch/abort/race handling stays here.
//
// Fetch triggers: token null→value, or `reload()`. Token-replacement rules (auth spec §6):
//   • currently `ready`            → do NOT refetch (keep the payload we have).
//   • `error` + code TOKEN_EXPIRED → auto-retry with the new token (the ONLY retryable code).
//   • otherwise (was loading/error) → supersede: abort the old request, fetch the new token.
// Races are guarded by an AbortController + a monotonic sequence nonce.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '@/utils/logger';
import type { PlayerErrorCode } from '../embed/player-messages';
import { createTokenDataSource } from './player-api';
import { PlayerApiError, type PlayableBookPayload } from './player-types';

const log = createLogger('Player', 'PlayableBook');

export type PlayerDataStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PlayerDataError {
  code: PlayerErrorCode;
  message: string;
  /** From `Retry-After` on RATE_LIMITED — UI countdown hint. */
  retryAfterSeconds?: number;
}

export interface UsePlayableBookResult {
  payload: PlayableBookPayload | null;
  dataStatus: PlayerDataStatus;
  error: PlayerDataError | null;
  reload: () => void;
}

/**
 * Load the playable book for `token`. Pass `null` while the token is still being acquired
 * (stays `idle`). Re-fetches on token acquisition or `reload()`, never redundantly.
 */
export function usePlayableBook(token: string | null): UsePlayableBookResult {
  const [payload, setPayload] = useState<PlayableBookPayload | null>(null);
  const [dataStatus, setDataStatus] = useState<PlayerDataStatus>('idle');
  const [error, setError] = useState<PlayerDataError | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Refs reflect the OUTCOME of the last settled load; read when the token changes to
  // decide whether a replacement should refetch. Written only in effects/callbacks.
  const statusRef = useRef<PlayerDataStatus>('idle');
  const errorCodeRef = useRef<PlayerErrorCode | null>(null);
  const prevTokenRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // Fetch orchestration runs inside an inline async IIFE so every setState is reached only
  // AFTER an await — never synchronously in the effect body (react-hooks set-state-in-effect).
  // The leading microtask yield covers the idle/skip branches too. Ordering across rapid
  // token/reload changes is guarded by the `seq` nonce + AbortController; `cancelled` drops
  // a superseded run's writes.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await Promise.resolve(); // defer all setState out of the synchronous effect path
      if (cancelled) return;

      // No token yet → idle. Abort anything in flight.
      if (token === null) {
        abortRef.current?.abort();
        abortRef.current = null;
        prevTokenRef.current = null;
        if (statusRef.current !== 'idle') {
          statusRef.current = 'idle';
          errorCodeRef.current = null;
          setPayload(null);
          setError(null);
          setDataStatus('idle');
        }
        return;
      }

      // Token REPLACEMENT decision (skip on first load or reload() with same token).
      const replaced = prevTokenRef.current !== null && prevTokenRef.current !== token;
      if (replaced) {
        if (statusRef.current === 'ready') {
          prevTokenRef.current = token; // keep existing payload; no refetch
          log.debug('load', 'token replaced while ready — no refetch', { tokenLen: token.length });
          return;
        }
        if (statusRef.current === 'error' && errorCodeRef.current !== 'TOKEN_EXPIRED') {
          prevTokenRef.current = token; // only TOKEN_EXPIRED auto-retries
          return;
        }
        // else fall through → refetch (expired retry, or was still loading)
      }
      prevTokenRef.current = token;

      // Start a fresh request; supersede any in-flight one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++seqRef.current;

      setError(null);
      setDataStatus('loading');
      statusRef.current = 'loading';
      log.info('load', 'loading', { tokenLen: token.length });

      try {
        const result = await createTokenDataSource(token).loadPlayableBook(controller.signal);
        if (cancelled || seq !== seqRef.current) return; // stale — superseded
        setPayload(result);
        setError(null);
        setDataStatus('ready');
        statusRef.current = 'ready';
        errorCodeRef.current = null;
        log.info('load', 'ready', {
          spreadCount: result.snapshot?.illustration?.spreads?.length ?? 0,
        });
      } catch (err) {
        if (cancelled || seq !== seqRef.current || controller.signal.aborted) return; // stale/aborted
        const code: PlayerErrorCode = err instanceof PlayerApiError ? err.code : 'SERVER';
        const retryAfterSeconds = err instanceof PlayerApiError ? err.retryAfterSeconds : undefined;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setPayload(null);
        setError({ code, message, retryAfterSeconds });
        setDataStatus('error');
        statusRef.current = 'error';
        errorCodeRef.current = code;
        log.error('load', 'error', { errorCode: code });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, reloadNonce]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { payload, dataStatus, error, reload };
}
