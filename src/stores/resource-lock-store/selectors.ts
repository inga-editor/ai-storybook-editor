// resource-lock-store/selectors.ts — Reactive read-side hooks for grey-out UX.
//
// EVERY selector returns a PRIMITIVE (boolean | string | null). Returning a Map /
// object / freshly-.map()-ed array here would loop forever under zustand's default
// Object.is compare (memory feedback_zustand_useshallow_nested_arrays). The 15s
// prune tick mutates `registry`, forcing a re-run so an expired lock flips back to
// editable without a realtime event.

import { keyOf, FALLBACK_HOLDER_NAME, type LockTarget, type ResourceType, type Step } from './types';
import { useResourceLockStore, type ResourceLockState } from './index';

/** Is a live lock on `target` held by SOMEONE ELSE (not me, not expired)?
 *  @deprecated for ENTITY spaces (ADR-044 addendum 2 — lockless). Still used by the SPREAD spaces
 *  (sketch spreads / scene / retouch objects), which keep their peer-lock veil. */
export function useIsLockedByOther(target: LockTarget): boolean {
  return useResourceLockStore((s: ResourceLockState) => {
    if (!s.bookId) return false;
    const entry = s.registry.get(keyOf(s.bookId, target));
    if (!entry) return false;
    if (entry.holder_user_id === s.myUserId) return false;
    return new Date(entry.expires_at).getTime() > Date.now();
  });
}

/** Display name of the OTHER holder for a tooltip; null when free / mine / expired.
 *  @deprecated for ENTITY spaces (ADR-044 addendum 2 — lockless). Still used by the SPREAD spaces. */
export function useLockHolderName(target: LockTarget): string | null {
  return useResourceLockStore((s: ResourceLockState) => {
    if (!s.bookId) return null;
    const entry = s.registry.get(keyOf(s.bookId, target));
    if (!entry) return null;
    if (entry.holder_user_id === s.myUserId) return null;
    if (new Date(entry.expires_at).getTime() <= Date.now()) return null;
    return s.holderNames.get(entry.holder_user_id) ?? FALLBACK_HOLDER_NAME;
  });
}

/** Peer-lock holder name for a WHOLE-SPREAD collab lock — SCENE (step 2 / rtype 6) or RETOUCH
 *  (step 3 / rtype 10). Returns the OTHER holder's display name when someone else holds this
 *  spread's lock (live), else null (free / mine / expired). `step`/`resourceType` undefined ⇒
 *  always null, so non-collab canvases (preview/dummy) that reuse CanvasSpreadView pass through
 *  cleanly. Unlike `useIsSpreadLockedByOther` (sketch: step 1, scans child image/textbox keys),
 *  the whole spread is ONE lock here, so this is an exact single-key lookup. Primitive return
 *  (string|null) → Object.is-stable. */
export function useSpreadPeerLockName(
  spreadId: string,
  step: number | undefined,
  resourceType: number | undefined,
): string | null {
  return useResourceLockStore((s: ResourceLockState) => {
    if (step == null || resourceType == null || !s.bookId || !spreadId) return null;
    const target: LockTarget = {
      step: step as Step,
      resource_type: resourceType as ResourceType,
      resource_id: spreadId,
      locale: null,
    };
    const entry = s.registry.get(keyOf(s.bookId, target));
    if (!entry) return null;
    if (entry.holder_user_id === s.myUserId) return null;
    if (new Date(entry.expires_at).getTime() <= Date.now()) return null;
    return s.holderNames.get(entry.holder_user_id) ?? FALLBACK_HOLDER_NAME;
  });
}

/** Spread row (sidebar) grey-out: true if the spread's structural lock (type 6)
 *  OR any of its child image locks (type 1) is held by another editor.
 *  Returns a boolean → stable under Object.is even when `childImageIds` is a fresh
 *  array each render. */
export function useIsSpreadLockedByOther(spreadId: string, childImageIds: string[]): boolean {
  return useResourceLockStore((s: ResourceLockState) => {
    const bookId = s.bookId;
    if (!bookId) return false;
    const me = s.myUserId;
    const now = Date.now();
    const heldByOther = (key: string): boolean => {
      const e = s.registry.get(key);
      return !!e && e.holder_user_id !== me && new Date(e.expires_at).getTime() > now;
    };
    // step=1, locale='' (null) for spread/image keys.
    if (heldByOther(`${bookId}|1|6|${spreadId}|`)) return true;
    for (const imageId of childImageIds) {
      if (heldByOther(`${bookId}|1|1|${imageId}|`)) return true;
    }
    return false;
  });
}

/** Generate-gate for the sketch SPREAD content-area: how many of the target spreads are
 *  generate-blocked — spread structural lock (type 6, incl. a peer generate job's advisory
 *  hold) OR any child page-image lock (type 1) held by another editor. Same per-spread rule as
 *  `useIsSpreadLockedByOther`, counted across the (bulk) target so the button can tell
 *  ALL-blocked (disable) from partially-blocked (allowed — the job skips those spreads).
 *  Returns a number → Object.is-stable even though `entries` is rebuilt each render (see file
 *  header). The job's own pre-generate lock acquire is the authoritative re-check; this gate is
 *  advisory UX only. */
export function useLockedByOtherSpreadCount(
  entries: ReadonlyArray<{ spreadId: string; imageIds: string[] }>,
): number {
  return useResourceLockStore((s: ResourceLockState) => {
    const bookId = s.bookId;
    if (!bookId || entries.length === 0) return 0;
    const me = s.myUserId;
    const now = Date.now();
    const heldByOther = (key: string): boolean => {
      const e = s.registry.get(key);
      return !!e && e.holder_user_id !== me && new Date(e.expires_at).getTime() > now;
    };
    let blocked = 0;
    for (const { spreadId, imageIds } of entries) {
      if (
        heldByOther(`${bookId}|1|6|${spreadId}|`) ||
        imageIds.some((id) => heldByOther(`${bookId}|1|1|${id}|`))
      ) {
        blocked += 1;
      }
    }
    return blocked;
  });
}
