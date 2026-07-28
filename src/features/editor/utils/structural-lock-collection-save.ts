// structural-lock-collection-save.ts — shared acquire → local whole-array replace →
// save(collection-scope) → release skeleton for the sketch Excel IMPORT (entity + spread
// spaces). Sibling of `structural-lock-delete.ts`: same lock lifecycle, but the gateway
// op is a COLUMN-ROOT whole-array save (a LIST `patch` + `collection`) instead of a #- delete.
//
// The lock is COARSE: the caller acquires it on a SENTINEL resource_id (the collection
// name), which does NOT block a concurrent per-entity edit by another collaborator. That
// coarse-vs-fine race is accepted — import is a destructive bulk-replace (the confirm
// dialog already warns "replaces all… generated sheets lost, cannot be undone"), mirroring
// the `animations` whole-array precedent (backend Change 1).
//
// Imperative store access (getState): this drives the lock lifecycle, it does not render
// off store state.

import { toast } from 'sonner';
import {
  useResourceLockStore,
  FALLBACK_HOLDER_NAME,
  type LockTarget,
  type SavePayload,
} from '@/stores/resource-lock-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'StructuralLockCollectionSave');

export type CollectionSaveOutcome = 'saved' | 'blocked' | 'failed';

/** One (lock target → collection-scope payload) pair of a multi-collection write set. */
export interface CollectionSaveEntry {
  target: LockTarget;
  save: SavePayload;
}

/**
 * Acquire the coarse collection lock, apply the optimistic LOCAL whole-array replace, then
 * persist it via the gateway `save` (collection-scope: a `collection` name + a LIST `patch`),
 * then ALWAYS release.
 *
 * - acquire blocked → NOTHING applied, holder-named toast, returns 'blocked'.
 * - save failed → local replace is KEPT (save-lost semantics — a refetch reconciles),
 *   returns 'failed' (caller decides the toast, since the success message carries a count).
 * - ok → returns 'saved'.
 *
 * @param target      coarse lock target (resource_id = collection-name sentinel)
 * @param save        collection-scope payload ({ action_type, patch: <full array>, collection })
 * @param applyLocal  replaces the whole array in the snapshot store + clears local selection
 */
export async function runLockedCollectionSave(
  target: LockTarget,
  save: SavePayload,
  applyLocal: () => void,
): Promise<CollectionSaveOutcome> {
  const store = useResourceLockStore.getState();
  log.info('runLockedCollectionSave', 'acquire', {
    type: target.resource_type,
    id: target.resource_id,
    collection: save.collection,
  });

  const acq = await store.acquire(target);
  if (!acq.ok) {
    const name = acq.holder
      ? store.holderNames.get(acq.holder) ?? FALLBACK_HOLDER_NAME
      : FALLBACK_HOLDER_NAME;
    log.info('runLockedCollectionSave', 'blocked on acquire — another editor holds it', {
      type: target.resource_type,
      hasHolder: !!acq.holder,
    });
    toast.info(`${name} đang chỉnh sửa — vui lòng thử lại sau.`);
    return 'blocked';
  }

  try {
    applyLocal();
    const res = await store.save(target, save);
    if (!res.ok) {
      log.warn('runLockedCollectionSave', 'save failed after local apply', {
        type: target.resource_type,
        collection: save.collection,
        lost: res.lost,
      });
      return 'failed';
    }
    log.info('runLockedCollectionSave', 'saved', {
      type: target.resource_type,
      collection: save.collection,
    });
    return 'saved';
  } finally {
    await store.release(target);
  }
}

/**
 * Multi-collection variant: acquire EVERY target first, apply the optimistic local replace ONCE,
 * then persist each collection-scope payload, then ALWAYS release everything acquired.
 *
 * Acquire-all-first is the point: the base Excel import replaces `sketch.characters` AND
 * `sketch.props` as one user-visible operation, so a peer holding either collection must abort the
 * WHOLE import with nothing applied — not leave the store showing a cast that only half-persisted.
 * The saves themselves are still two independent gateway writes (the gateway has no multi-target
 * write): if one fails after the other landed, the outcome is 'failed' and the caller tells the
 * user to reload — the local replace is KEPT (save-lost semantics, a refetch reconciles).
 *
 * @param entries    one { target, save } pair per collection, applied in order
 * @param applyLocal optimistic local replace, run ONCE after every lock is held
 */
export async function runLockedSetSave(
  entries: readonly CollectionSaveEntry[],
  applyLocal: () => void,
): Promise<CollectionSaveOutcome> {
  const store = useResourceLockStore.getState();
  const acquired: LockTarget[] = [];
  log.info('runLockedSetSave', 'acquire set', {
    count: entries.length,
    collections: entries.map((e) => e.save.collection).join(','),
  });

  try {
    for (const { target } of entries) {
      const acq = await store.acquire(target);
      if (!acq.ok) {
        const name = acq.holder
          ? store.holderNames.get(acq.holder) ?? FALLBACK_HOLDER_NAME
          : FALLBACK_HOLDER_NAME;
        log.info('runLockedSetSave', 'blocked on acquire — another editor holds one collection', {
          type: target.resource_type,
          id: target.resource_id,
          hasHolder: !!acq.holder,
        });
        toast.info(`${name} đang chỉnh sửa — vui lòng thử lại sau.`);
        return 'blocked'; // nothing applied; the finally below releases what we did take
      }
      acquired.push(target);
    }

    applyLocal();

    let failed = false;
    for (const { target, save } of entries) {
      const res = await store.save(target, save);
      if (!res.ok) {
        failed = true;
        log.warn('runLockedSetSave', 'save failed after local apply', {
          type: target.resource_type,
          collection: save.collection,
          lost: res.lost,
        });
        continue; // best-effort: a sibling collection can still land
      }
      log.debug('runLockedSetSave', 'collection saved', {
        type: target.resource_type,
        collection: save.collection,
      });
    }
    if (failed) return 'failed';
    log.info('runLockedSetSave', 'set saved', { count: entries.length });
    return 'saved';
  } finally {
    for (const target of acquired) await store.release(target);
  }
}
