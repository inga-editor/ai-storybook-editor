// structural-lock-collection-save.ts — shared acquire → local whole-array replace →
// save(collection-scope) → release skeleton for the sketch SPREADS Excel IMPORT (rtype 6).
// Sibling of `structural-lock-delete.ts`: same lock lifecycle, but the gateway op is a
// COLUMN-ROOT whole-array save (a LIST `patch` + `collection`) instead of a #- delete.
// NOTE the entity collections (characters/props/stages) moved OFF this lock to the lock-EXEMPT
// rtype-14 path (ADR-044 addendum 2 — `collab-sketch-base-entities-save-helper`); only the SPREADS
// import still uses this (its rtype-6 collection lock is unchanged — the multi-collection
// `runLockedSetSave` variant was removed with the base-import re-route).
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
