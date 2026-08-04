// use-save-session — the React surface over `save-session-store` (unified-item-save-spec §4,
// store design §5). Replaces the two fork hooks (`use-held-resource-session` /
// `use-resource-lock-session`) with ONE policy-driven session hook. Phase 1 wires the held
// lifecycle + saveNow; `ensureSaved`/`commitOnModalClose` are declared here but only their held
// branches are live (one-shot + modal-close wiring land in phases 2/3).
//
// React-19 discipline (identical to the old held hook): the acquire effect keys on the STRING
// session key only (never the LockTarget object), a local `cancelled` flag guards the async
// begin, latest callbacks live in a ref written inside an effect, and status is DERIVED in render
// from a PRIMITIVE store selector — no set-state-in-effect, no ref.current in the render body.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createLogger } from '@/utils/logger';
import { useResourceLockStore, keyOf, type SessionStatus } from '@/stores/resource-lock-store';
import { useSaveSessionStore, SAVE_POLICIES } from '@/stores/save-session-store';
import { useSessionStatus } from '@/stores/save-session-store/selectors';
import type { SaveDomain, SaveOutcome } from '@/stores/save-session-store';

const log = createLogger('Editor', 'useSaveSession');

export interface UseSaveSessionArgs {
  domain: SaveDomain;
  /** Domain-scoped item id (composite `"{kind}/{key}"` for the entity domains). null ⇒ no session. */
  id: string | null;
  locale?: string | null;
  /** 409 on acquire → another editor holds it. Caller toasts; does NOT acquire. */
  onBlocked?: (holder: string) => void;
  /** Heartbeat 409 → lock stolen mid-edit. Receives the pre-edit baseline. */
  onLost?: (baseline: unknown) => void;
  /** Drive the shared header save-label (default true). false only for a session with its own label. */
  manageHeaderStatus?: boolean;
}

export interface UseSaveSessionResult {
  status: SessionStatus;
  /** Explicit save while STILL holding (rebases baseline). */
  saveNow: () => Promise<SaveOutcome>;
  /** Save-before-continue (held branches live in phase 1; one-shot in phase 2). */
  ensureSaved: () => Promise<SaveOutcome>;
  /** Fire-and-forget saveNow for spread-level modal close (spec §4.2). No-op when clean/not held.
   *  Declared in phase 1; wired into modals in phase 3. */
  commitOnModalClose: () => void;
}

export function useSaveSession(args: UseSaveSessionArgs): UseSaveSessionResult {
  const { domain, id, locale = null } = args;
  const bookId = useResourceLockStore((s) => s.bookId);

  // Latest args in a ref (written inside an effect — never the render body).
  const cbRef = useRef(args);
  useEffect(() => {
    cbRef.current = args;
  });

  // STRING session key (keyOf) — the effect + selector dep. null ⇒ no session (idle).
  const serialized = useMemo(
    () => (id && bookId ? keyOf(bookId, SAVE_POLICIES[domain].resolveTarget(id, locale)) : null),
    [id, bookId, domain, locale],
  );

  useEffect(() => {
    if (!serialized || !id || !bookId) return;
    const key = serialized;
    let cancelled = false;
    // Order-independent teardown: the store captures bookId + drives release from its SessionEntry,
    // so this cleanup never reads myLocks/bookId (repeats the 2026-07-11 teardown-order bugfix).
    void useSaveSessionStore.getState().begin(domain, id, locale, {
      manageHeaderStatus: cbRef.current.manageHeaderStatus,
      onBlocked: (h) => cbRef.current.onBlocked?.(h),
      onLost: (b) => cbRef.current.onLost?.(b),
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
      void useSaveSessionStore.getState().end(key);
    };
    // STRING dep only (+ domain) — object dep would churn acquire→release (React-19).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, domain]);

  // Status DERIVED in render from a primitive selector (no useShallow on an object).
  const status = useSessionStatus(serialized);

  const saveNow = useCallback(async (): Promise<SaveOutcome> => {
    if (!serialized) return 'clean';
    return useSaveSessionStore.getState().saveNow(serialized);
  }, [serialized]);

  const ensureSaved = useCallback(async (): Promise<SaveOutcome> => {
    if (!id) return 'clean';
    return useSaveSessionStore.getState().ensureSaved(domain, id, locale);
  }, [domain, id, locale]);

  const commitOnModalClose = useCallback((): void => {
    if (!serialized) return;
    void useSaveSessionStore
      .getState()
      .saveNow(serialized)
      .then((outcome) => {
        if (outcome === 'failed') {
          log.warn('commitOnModalClose', 'save failed on modal close', { outcome });
        }
      });
  }, [serialized]);

  return { status, saveNow, ensureSaved, commitOnModalClose };
}
