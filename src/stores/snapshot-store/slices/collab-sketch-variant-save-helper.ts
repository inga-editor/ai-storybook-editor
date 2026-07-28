// collab-sketch-variant-save-helper.ts — per-resource collab save seam for the SKETCH
// VARIANT creative space (ADR-047 / Path B). The variant space is the 7th collab space;
// its grain is the WHOLE sketch ENTITY node at STEP 1 (rtype 3 character / 4 prop), which the
// gateway `_resolve_entity` maps to `sketch.<plural>[key]` — the SAME whole-node contract the
// illustration entity spaces use at step 2, so NO new rtype / resolver / migration is needed.
//
// Three consumers (⚡ updated 2026-07-16 — the space moved from eager-atomic per-gesture to
// BATCH-AT-RELEASE, ADR-043 Rev):
//   • the component held-session (`useHeldResourceSession`) is now the PRIMARY path: the cheap
//     edits (text / edit-crop) only mutate the store under the hold, and the session
//     acquires/saves/releases the whole node ONCE at release — using `resolveSketchVariantLockTarget`
//     for the target + a whole-node payload (`buildSketchEntityPayload`).
//   • the JOB slice (off-render, cannot call the React `saveNow`) drives flush-before-generate +
//     persist-after for BOTH chains (generate→auto-cut AND the raw-edit→re-cut) via
//     `flushSketchEntityUnderLock` — AI output must not wait for a release.
//   • `handleSelectCrop` (space root) direct-flushes THIS helper for the single pick gesture: it
//     mutates synchronously with the acquire, so the held-session baseline is captured too late to
//     ever see it (H2) — see the `releaseIfAcquired` doc below.
//
// NO-OP under solo (`collabPersist=false`): the whole-doc autosave owns persistence there,
// so `flushSketchEntityUnderLock` returns `true` (nothing to do) and the caller keeps its
// legacy `autoSaveSnapshot`/`flushSnapshot` path byte-identical.
//
// resource-lock-store is a LEAF store (loaded before the snapshot slices) so its static import
// resolves cleanly; this module does NOT import snapshot-store (the caller reads the fresh node
// and passes it in) → no slice ↔ store cycle.

import {
  useResourceLockStore,
  keyOf,
  type LockTarget,
  type ResourceType,
} from '@/stores/resource-lock-store';
import type { BaseKind } from '@/types/sketch';
import { toastLockedByOther } from '@/utils/collab-save-toasts';
import { resolveLockHolderName } from './collab-image-save-helper';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSketchVariantSaveHelper');

/** Sketch step-1 entity kind → gateway `resource_type` (3 character · 4 prop). Stage (5) has NO
 *  variant space, so it is deliberately absent — only the two variant kinds are addressable here. */
export const SKETCH_KIND_TO_RESOURCE_TYPE: Record<BaseKind, ResourceType> = {
  characters: 3,
  props: 4,
  // ⚡ 2026-07-28: an alter character IS a `characters[]` entity — same rtype 3, same grant, and
  // `resource_id` (the entity key) is unique across the whole collection, so the two never collide.
  alter_characters: 3,
};

/** crud audit enum used for every variant-space save: 3 = edit (the entity node always already
 *  exists — seeded from the base import; no create/delete of the entity happens in this space). */
const ACTION_TYPE_EDIT = 3 as const;

/**
 * Build the STEP-1 LockTarget for a sketch entity node (whole-entity grain).
 * `locale` is null (entity nodes are not locale-scoped, unlike a textbox).
 */
export function resolveSketchVariantLockTarget(kind: BaseKind, entityKey: string): LockTarget {
  return {
    step: 1,
    resource_type: SKETCH_KIND_TO_RESOURCE_TYPE[kind],
    resource_id: entityKey,
    locale: null,
  };
}

/**
 * Whole-node payload for the held-session `buildPayload`. The gateway contract for an entity
 * node is `{ action_type: 3, patch: <whole node>, log: true }` — `log:true` emits the
 * `scope:'node'` content-sync event + one audit row (peers refetch the fresh node).
 */
export function buildSketchEntityPayload(node: unknown): {
  action_type: 3;
  patch: unknown;
  log: true;
} {
  return { action_type: ACTION_TYPE_EDIT, patch: node, log: true };
}

export interface FlushSketchEntityOptions {
  /**
   * One-shot semantics: if THIS call had to `acquire` the lock (it was NOT already held by the
   * component held-session), release it after the save. Use for persists that run OUTSIDE the
   * held-session's ownership window — the RESULT of a generate whose entity may have been released
   * (user browsed away during the long AI call) and every "single-gesture" edit (select-crop) whose
   * held-session baseline is captured too late to catch the mutation. When the entity IS already
   * held, the lock is KEPT (the held-session stays the releaser). Default `false` → always keep
   * (used ONLY by flush-BEFORE-generate, where the caller has just adopted the entity via
   * `activeLockEntity`, so the held-session is guaranteed to own + eventually release it).
   */
  releaseIfAcquired?: boolean;
}

/**
 * Persist the WHOLE sketch entity node through the gateway. Baseline-independent (reads the FRESH
 * node the caller passes → saves exactly that, no dirty-diff), so it can't silently drop a mutation
 * whose held-session baseline was captured late.
 *
 * Lock lifecycle:
 *   • solo (`collabPersist=false`) → no-op, returns `true` (caller owns `autoSaveSnapshot`).
 *   • already held (held-session adopted the entity) → skip acquire, just `save`, KEEP the lock.
 *   • not held → `acquire` first (409 → toast + `false`, caller aborts / falls through); after the
 *     save, release IFF `releaseIfAcquired` (one-shot — never orphans a lock the held-session no
 *     longer owns). With `releaseIfAcquired:false` (flush-before) the caller guarantees the
 *     held-session adopts + releases it, so keeping is safe.
 *
 * @param node the FRESH whole entity node (read via getState() at call time — anti stale-closure).
 *             `null` (entity vanished mid-flight) → `false`.
 * @returns `true` when persisted (or solo no-op); `false` on 409 / save-reject / missing node.
 */
export async function flushSketchEntityUnderLock(
  kind: BaseKind,
  entityKey: string,
  node: unknown,
  opts?: FlushSketchEntityOptions,
): Promise<boolean> {
  const rl = useResourceLockStore.getState();
  if (!rl.collabPersist) {
    log.debug('flushSketchEntityUnderLock', 'solo path — whole-doc autosave owns persistence', { kind });
    return true; // solo: nothing to do here; caller keeps autoSaveSnapshot
  }
  if (node == null) {
    log.warn('flushSketchEntityUnderLock', 'node missing at save time — skip', { kind, entityKey });
    return false;
  }
  const bookId = rl.bookId;
  if (!bookId) {
    log.warn('flushSketchEntityUnderLock', 'no book connected — skip', { kind, entityKey });
    return false;
  }

  const target = resolveSketchVariantLockTarget(kind, entityKey);
  const key = keyOf(bookId, target);
  let acquiredHere = false;

  try {
    // Acquire only if the held-session has not already taken it (idempotent renew otherwise).
    if (!rl.myLocks.has(key)) {
      const acq = await rl.acquire(target);
      if (!acq.ok) {
        log.info('flushSketchEntityUnderLock', 'blocked — another editor holds the entity', { kind, entityKey });
        toastLockedByOther(resolveLockHolderName(target));
        return false; // no lock held → nothing to release; caller aborts / falls through
      }
      acquiredHere = true;
    }
    const res = await rl.save(target, buildSketchEntityPayload(node));
    if (res.ok) {
      log.info('flushSketchEntityUnderLock', 'saved', { kind, entityKey, acquiredHere });
      return true;
    }
    log.warn('flushSketchEntityUnderLock', 'save rejected', {
      kind,
      entityKey,
      lost: res.lost,
      forbidden: res.forbidden,
    });
    if (res.forbidden) toastLockedByOther(resolveLockHolderName(target));
    return false;
  } catch (err) {
    log.error('flushSketchEntityUnderLock', 'unexpected error', {
      kind,
      entityKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    // One-shot: release ONLY the lock WE acquired here (the held-session never owned it) so it can't
    // linger to TTL when the held-session already released the entity (user browsed away mid-generate).
    if (acquiredHere && opts?.releaseIfAcquired) {
      await rl.release(target);
      log.debug('flushSketchEntityUnderLock', 'one-shot release (acquired here, not held-session owned)', {
        kind,
        entityKey,
      });
    }
  }
}
