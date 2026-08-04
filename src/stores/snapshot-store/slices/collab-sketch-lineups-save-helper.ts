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
// ⚡ unified-item-save phase 3: `flushSketchLineupsUnderLock` now delegates to the engine's
// `ensureSaved` (solo/collab fork + lock lifecycle + rebase internalized); the pure resolver/payload
// exports are unchanged. `useSaveSessionStore` is imported dynamically at call time (cycle break).

import {
  type LockTarget,
  type ResourceType,
  type SavePayload,
} from '@/stores/resource-lock-store';
import type { SketchLineupTab } from '@/types/sketch';
import type { SaveOutcome } from '@/stores/save-session-store/types';
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
  /** @deprecated IGNORED since unified-item-save phase 3 — the engine decides the lock lifecycle. */
  releaseIfAcquired?: boolean;
}

/**
 * Persist the WHOLE `sketch.lineups[]` array (rtype 12) — ⚡ unified-item-save phase 3: delegates to
 * the save-session engine's `ensureSaved('sketch-lineups', …)` (single solo/collab fork + lock
 * lifecycle; held → save + rebase; no session → one-shot acquire→save→release; solo → whole-snapshot
 * flush). The engine reads the FRESH tabs array via the policy registry, so `tabs` is IGNORED.
 *
 * @returns the engine `SaveOutcome` — the CALLER maps it to a toast (this helper no longer self-toasts).
 */
export async function flushSketchLineupsUnderLock(
  _tabs?: SketchLineupTab[],
  _opts?: FlushSketchLineupsOptions,
): Promise<SaveOutcome> {
  const { useSaveSessionStore } = await import('@/stores/save-session-store');
  log.debug('flushSketchLineupsUnderLock', 'ensureSaved (engine)');
  return useSaveSessionStore.getState().ensureSaved('sketch-lineups', LINEUP_RESOURCE_ID);
}
