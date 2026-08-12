// use-book-bundle.ts — State machine over the single book-bundle read. The sub-app
// consumes `{ bundleStatus, book, error, reload }`; all fetch/abort/race/hydrate
// handling stays here.
//
// Fetch triggers: bookId null→value, or `reload()`. `bookId` is stable for the
// sub-app's lifetime, so the only rerun paths are the initial load and an explicit
// `reload()` — no token-replacement branching (unlike use-playable-book). Races are
// guarded by an AbortController + a monotonic sequence nonce; a stale run's writes
// (incl. hydration) are dropped by the seq check BEFORE any store is touched.
//
// On success we hydrate the stores, then gate `config_missing` off the normalized
// book.remix (helper reused from the remix-creative-space leaf — NOT rewritten).
// Hydration still runs for a config-missing book so the shell header has the title.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '@/utils/logger';
import { isBookRemixEmpty } from '@/features/editor/components/remix-creative-space/default-config-builder';
import type { Book } from '@/types/editor';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';
import type { BundleStatus, RemixEditorErrorCode } from '../types/remix-editor-status';
import { BookBundleApiError, fetchBookBundle } from './book-bundle-api';
import { hydrateRemixEditorStores } from '../hydration/hydrate-remix-editor-stores';

const log = createLogger('RemixEditor', 'UseBookBundle');

export interface BookBundleError {
  code: RemixEditorErrorCode;
  message: string;
}

export interface UseBookBundleResult {
  bundleStatus: BundleStatus;
  book: Book | null;
  error: BookBundleError | null;
  reload: () => void;
}

function toBundleError(err: unknown): BookBundleError {
  if (err instanceof BookBundleApiError) return { code: err.code, message: err.message };
  return { code: 'SERVER', message: err instanceof Error ? err.message : 'Unknown error' };
}

/**
 * Load + hydrate the book bundle for `bookId`. Pass `null` until the session is authed
 * and the bookId is known (stays `idle`). Re-runs on bookId acquisition or `reload()`.
 */
export function useBookBundle(
  bookId: string | null,
  authorizedFetch: AuthorizedFetch,
): UseBookBundleResult {
  const [bundleStatus, setBundleStatus] = useState<BundleStatus>('idle');
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<BookBundleError | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // Orchestration runs in an inline async IIFE so every setState is reached only AFTER
  // an await — never synchronously in the effect body (react-hooks set-state-in-effect).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await Promise.resolve(); // defer setState out of the synchronous effect path
      if (cancelled) return;

      // No bookId yet → idle. Abort anything in flight.
      if (bookId === null) {
        abortRef.current?.abort();
        abortRef.current = null;
        setBook(null);
        setError(null);
        setBundleStatus('idle');
        return;
      }

      // Start a fresh request; supersede any in-flight one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++seqRef.current;

      setError(null);
      setBook(null);
      setBundleStatus('loading');
      log.info('load', 'loading', { bookId });

      try {
        const bundle = await fetchBookBundle(bookId, authorizedFetch, controller.signal);
        if (cancelled || seq !== seqRef.current) return; // stale — superseded (no hydrate)

        // Hydrate ONLY for the winning run — a stale run must never write stores.
        const hydratedBook = hydrateRemixEditorStores(bundle);
        const remixEmpty = isBookRemixEmpty(hydratedBook.remix);
        setBook(hydratedBook);
        setBundleStatus(remixEmpty ? 'config_missing' : 'ready');
        log.info('load', 'hydrated', { bookId, status: remixEmpty ? 'config_missing' : 'ready' });
      } catch (err) {
        if (cancelled || seq !== seqRef.current || controller.signal.aborted) return; // stale/aborted
        const bundleError = toBundleError(err);
        setBook(null);
        setError(bundleError);
        setBundleStatus('error');
        log.error('load', 'error', { bookId, errorCode: bundleError.code });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bookId, authorizedFetch, reloadNonce]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { bundleStatus, book, error, reload };
}
