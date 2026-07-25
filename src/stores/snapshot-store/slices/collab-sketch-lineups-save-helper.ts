// collab-sketch-lineups-save-helper.ts — per-resource collab save seam for the SKETCH LINEUP
// creative space (rtype 12 `lineup`, ADR-043 §Mở rộng 2026-07-25). Grain = the WHOLE
// `sketch.lineups[]` array (ONE lock covers every tab): the gateway write path is the
// COLLECTION-SCOPE COLUMN-ROOT save — `collection:'lineups'` + a LIST patch + NO parent_id →
// `jsonb_set(sketch, ['lineups'], <array>)` (create_missing seeds the key on first save).
//
// Mirror of `collab-sketch-base-sheet-save-helper.ts` with the kind dimension removed and the
// payload switched from whole-NODE to whole-ARRAY collection scope. ⚠️ `patch` MUST be the tabs
// ARRAY — the gateway infers `is_collection_scope` from `isinstance(patch, list)`; a dict patch
// is rejected 400 (rtype 12 has no per-node resolver).
//
// NO-OP under solo (`collabPersist=false`): setters already marked sync.isDirty, the whole-doc
// autosave owns persistence (memory *new-pipeline-space-collab-flow*: never call autoSaveSnapshot
// from the space).
//
// LEAF module: does NOT import snapshot-store (callers read the fresh tabs and pass them in).

import {
  useResourceLockStore,
  keyOf,
  type LockTarget,
  type ResourceType,
  type SavePayload,
} from '@/stores/resource-lock-store';
import type { SketchLineupTab } from '@/types/sketch';
import { toastLockedByOther } from '@/utils/collab-save-toasts';
import { resolveLockHolderName } from './collab-image-save-helper';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSketchLineupsSaveHelper');

/** rtype 12 = lineup (whole `sketch.lineups[]` array). */
const RESOURCE_TYPE_LINEUP = 12 satisfies ResourceType;

/** Coarse sentinel resource_id — one lock for ALL tabs (mirrors the import sentinels). */
export const LINEUP_RESOURCE_ID = 'lineups';

/** Gateway collection name for the column-root whole-array save. */
const LINEUP_COLLECTION = 'lineups';

/** 3 = edit: the save always REPLACES the whole array (create-on-first-save is handled by the
 *  gateway's jsonb_set create_missing — no separate create action). */
const ACTION_TYPE_EDIT = 3 as const;

/** STEP-1 / rtype-12 LockTarget — a MODULE-LEVEL constant shape (build once per call is fine for
 *  the store, but UI hooks should use the exported `LINEUP_LOCK_TARGET` to keep referential
 *  stability across renders). */
export function resolveLineupsLockTarget(): LockTarget {
  return {
    step: 1,
    resource_type: RESOURCE_TYPE_LINEUP,
    resource_id: LINEUP_RESOURCE_ID,
    locale: null,
  };
}

/** Stable singleton target for render-time consumers (useIsLockedByOther etc.). */
export const LINEUP_LOCK_TARGET: LockTarget = resolveLineupsLockTarget();

/**
 * Collection-scope payload: `{ action_type: 3, patch: <tabs ARRAY>, collection: 'lineups',
 * log: true }`. `log:true` emits the `scope:'collection'` content-sync descriptor peers use to
 * whole-replace their `sketch.lineups` (see content-sync-store `isLineupCollectionSync`).
 */
export function buildSketchLineupsPayload(tabs: SketchLineupTab[]): SavePayload {
  return { action_type: ACTION_TYPE_EDIT, patch: tabs, collection: LINEUP_COLLECTION, log: true };
}

export interface FlushSketchLineupsOptions {
  /** One-shot semantics (mirrors the base-sheet helper): release after the save IFF this call
   *  had to acquire (the held-session never owned it). Default false → keep. */
  releaseIfAcquired?: boolean;
}

/**
 * Persist the WHOLE `sketch.lineups[]` array through the gateway, baseline-independent (the
 * caller reads the FRESH tabs via getState() and passes them) — closes the held-session
 * late-baseline race that would swallow the FIRST save after acquire (plan phase-03 Insight #3).
 *
 * Lock lifecycle:
 *   • solo (`collabPersist=false`) → no-op `true` (whole-doc autosave owns persistence).
 *   • already held (space session owns rtype 12) → skip acquire, save, KEEP the lock.
 *   • not held → acquire first (409 → toast + `false`); release after IFF `releaseIfAcquired`.
 */
export async function flushSketchLineupsUnderLock(
  tabs: SketchLineupTab[],
  opts?: FlushSketchLineupsOptions,
): Promise<boolean> {
  const rl = useResourceLockStore.getState();
  if (!rl.collabPersist) {
    log.debug('flushSketchLineupsUnderLock', 'solo path — whole-doc autosave owns persistence', {
      tabCount: tabs.length,
    });
    return true;
  }
  const bookId = rl.bookId;
  if (!bookId) {
    log.warn('flushSketchLineupsUnderLock', 'no book connected — skip', { tabCount: tabs.length });
    return false;
  }

  const target = resolveLineupsLockTarget();
  const key = keyOf(bookId, target);
  let acquiredHere = false;

  try {
    if (!rl.myLocks.has(key)) {
      const acq = await rl.acquire(target);
      if (!acq.ok) {
        log.info('flushSketchLineupsUnderLock', 'blocked — another editor holds the lineups');
        toastLockedByOther(resolveLockHolderName(target));
        return false;
      }
      acquiredHere = true;
    }
    const res = await rl.save(target, buildSketchLineupsPayload(tabs));
    if (res.ok) {
      log.info('flushSketchLineupsUnderLock', 'saved', { tabCount: tabs.length, acquiredHere });
      return true;
    }
    log.warn('flushSketchLineupsUnderLock', 'save rejected', {
      lost: res.lost,
      forbidden: res.forbidden,
    });
    if (res.forbidden) toastLockedByOther(resolveLockHolderName(target));
    return false;
  } catch (err) {
    log.error('flushSketchLineupsUnderLock', 'unexpected error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    if (acquiredHere && opts?.releaseIfAcquired) {
      await rl.release(target);
      log.debug('flushSketchLineupsUnderLock', 'one-shot release (acquired here)');
    }
  }
}
