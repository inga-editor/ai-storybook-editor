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
import { useLockFirstAction } from './use-lock-first-action';

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
  /** First-click lock gate wiring: ask the owning space to acquire the lock (its lock-on-interact
   *  path, e.g. `setLockedSpreadId(selectedSpreadId)`). Required for `runWithLock` to defer —
   *  without it a not-held `runWithLock` call only warns. */
  requestLock?: () => void;
  /** Key the deferred `runWithLock` action is valid for (the space's SELECTED item id — NOT the
   *  session key, which flips null→id during the acquire itself). A change drops the pending action. */
  gateResetKey?: string | null;
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
  /** First-click lock gate (spec §4.1): run `action` synchronously when the session is HELD, else
   *  queue it (one slot, last click wins), call `requestLock`, and run it when the session reaches
   *  HELD. Dropped on blocked/lost or when `gateResetKey` changes. Actions MUST only mutate under a
   *  held session — running earlier would bake the change into the baseline (silently unsaved). */
  runWithLock: (action: () => void) => void;
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

  // Latest session key in a ref (written inside an effect) — lets `commitOnModalClose` be a STABLE
  // deps-[] callback (phase 3): it drops into a modal's `onOpenChange(false)` without churning the
  // modal's identity/memo on every spread switch (which a `serialized` dep would cause).
  const serializedRef = useRef(serialized);
  useEffect(() => {
    serializedRef.current = serialized;
  });

  // Imperative gate-cancel channel (populated by useLockFirstAction below). Blocked/lost must drop
  // a queued first-click action HERE — the rendered status can miss the 'blocked' frame entirely
  // when the space's onBlocked nulls the lock target in the same React batch (status goes straight
  // back to 'idle'), which would let the stale action flush into the NEXT successful acquire.
  const gateCancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!serialized || !id || !bookId) return;
    const key = serialized;
    let cancelled = false;
    // Order-independent teardown: the store captures bookId + drives release from its SessionEntry,
    // so this cleanup never reads myLocks/bookId (repeats the 2026-07-11 teardown-order bugfix).
    void useSaveSessionStore.getState().begin(domain, id, locale, {
      manageHeaderStatus: cbRef.current.manageHeaderStatus,
      onBlocked: (h) => {
        gateCancelRef.current();
        cbRef.current.onBlocked?.(h);
      },
      onLost: (b) => {
        gateCancelRef.current();
        cbRef.current.onLost?.(b);
      },
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

  // STABLE (deps []) — reads the key via a ref so wiring it into `onOpenChange(false)` never churns
  // the modal. Fire-and-forget saveNow: self-guards (no-op when not held / node gone / clean).
  const commitOnModalClose = useCallback((): void => {
    const key = serializedRef.current;
    if (!key) return;
    void useSaveSessionStore
      .getState()
      .saveNow(key)
      .then((outcome) => {
        if (outcome === 'failed') {
          log.warn('commitOnModalClose', 'save failed on modal close', { outcome });
        }
      });
  }, []);

  // First-click lock gate (composed from the shared primitive). requestLock resolves through cbRef
  // so the gate's runner identity stays stable; a missing wiring degrades to a warn (action would
  // otherwise queue forever).
  //
  // Lockless domains (ADR-044 addendum 2): the session reaches 'held' synchronously in `begin`, so
  // `runWithLock` degrades to a synchronous run and never actually needs a lock. `requestLock` is a
  // SILENT no-op here (no "not wired" warn — shared entity/spread components pass wiring that a
  // lockless space simply doesn't need). `onBlocked`/`onLost` handed to a lockless domain are never
  // fired (a lock-exempt session can't be blocked or lost), so they're harmless to leave wired.
  const requestLockStable = useCallback((): void => {
    if (SAVE_POLICIES[domain].locking === 'none') return;
    const requestLock = cbRef.current.requestLock;
    if (requestLock) {
      requestLock();
    } else {
      log.warn('runWithLock', 'requestLock not wired — deferred action will never run', {});
    }
  }, [domain]);

  const runWithLock = useLockFirstAction({
    isHeld: status === 'held',
    lockStatus: status,
    requestLock: requestLockStable,
    resetKey: args.gateResetKey ?? null,
    cancelRef: gateCancelRef,
  });

  return { status, saveNow, ensureSaved, commitOnModalClose, runWithLock };
}
