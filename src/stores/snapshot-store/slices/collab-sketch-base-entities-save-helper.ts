// collab-sketch-base-entities-save-helper.ts — per-resource collab save seam for the SKETCH BASE
// creative space "save 1 cục" grain (rtype 14 `entity_collection`, ADR-044 addendum 2 2026-08-05).
// Grain = the WHOLE `sketch.{characters|props|stages}` array (ONE lock-exempt write covers every
// entity of a kind): the gateway path is the COLLECTION-SCOPE COLUMN-ROOT save —
// `collection:'<name>'` + a LIST patch + NO parent_id → `jsonb_set(sketch, ['<name>'], <array>)`
// (create_missing seeds the key on first save). rtype 14 is LOCK-EXEMPT (the gateway skips the lock
// precondition) and authz-gated on `access_rights.steps.sketch.resources.<collection>`.
//
// Mirror of `collab-sketch-lineups-save-helper.ts` (rtype 12) with the collection dimension made a
// parameter. ⚠️ `patch` MUST be the entity ARRAY — the gateway infers `is_collection_scope` from
// `isinstance(patch, list)`; a dict patch is rejected 400 (rtype 14 has no per-node resolver). BE
// binds `collection === resource_id` — the caller MUST NOT send a `collection` different from the
// target's `resource_id` (a collaborator with only `props` access could not widen to `characters`).
//
// ⚡ unified-item-save: `saveEntityCollection` delegates to the engine's `ensureSaved` (solo/collab
// fork + lock-exempt lifecycle + rebase of a held session internalized); the pure resolver/payload
// exports feed the policy registry. `useSaveSessionStore` is imported dynamically (cycle break).

import {
  type LockTarget,
  type ResourceType,
  type SavePayload,
} from '@/stores/resource-lock-store';
import type { BaseKind } from '@/types/sketch';
import type { SaveOutcome } from '@/stores/save-session-store/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSketchBaseEntitiesSaveHelper');

/** rtype 14 = entity_collection (whole `sketch.{collection}` array). */
export const RESOURCE_TYPE_ENTITY_COLLECTION = 14 satisfies ResourceType;

/** id domain = TÊN COLLECTION; BE ràng buộc collection === resource_id. */
export type EntityCollectionName = 'characters' | 'props' | 'stages';

/**
 * Base-space kind → the entity collection it PERSISTS INTO.
 * ⚠️ `alter_characters` is NOT its own collection (memory `alter-character-sketch-schema`): an alter
 * character is an `actor_role` flag inside `sketch.characters[]`, so it maps to `characters`. The
 * base space MUST key its rtype-14 session by this COLLECTION (never by kind), or the `characters`
 * and `alter_characters` kinds would open TWO sessions on the SAME `sketch.characters` array with
 * divergent baselines → last-write-wins data loss.
 */
export const BASE_KIND_TO_COLLECTION: Record<BaseKind, EntityCollectionName> = {
  characters: 'characters',
  props: 'props',
  alter_characters: 'characters',
};

/** 3 = edit: the save always REPLACES the whole array (create-on-first-save handled by the gateway's
 *  jsonb_set create_missing — no separate create action). */
const ACTION_TYPE_EDIT = 3 as const;

/** STEP-1 / rtype-14 LockTarget for one collection (resource_id === the collection name). */
export function resolveEntityCollectionLockTarget(collection: EntityCollectionName): LockTarget {
  return {
    step: 1,
    resource_type: RESOURCE_TYPE_ENTITY_COLLECTION,
    resource_id: collection,
    locale: null,
  };
}

/**
 * Collection-scope payload: `{ action_type: 3, patch: <entity ARRAY>, collection, target_ref:{count},
 * log: true }`. `log:true` emits the `scope:'collection'` content-sync descriptor peers use to
 * whole-replace their `sketch.{collection}` (see content-sync-store `isColumnRootCollectionSync`).
 * `target_ref.count` is the audit trail for the destructive whole-array replace (blast-radius trace).
 */
export function buildEntityCollectionPayload(
  arr: unknown[],
  collection: EntityCollectionName,
): SavePayload {
  return {
    action_type: ACTION_TYPE_EDIT,
    patch: arr,
    collection,
    target_ref: { count: arr.length },
    log: true,
  };
}

/**
 * Persist the WHOLE `sketch.{collection}` array (rtype 14) — delegates to the save-session engine's
 * `ensureSaved('sketch-base-entities', collection)`:
 *   • a HELD collection session (the active kind's, mounted by the base space) → `saveNow`
 *     (write-while-held + rebase baseline — no stale re-save afterwards);
 *   • no live session (a browsed-away / non-active collection) → ONE-SHOT lock-exempt save (NO
 *     acquire/release — rtype 14 is lock-exempt);
 *   • solo book → whole-snapshot flush.
 * The engine reads the FRESH array via the policy registry, so callers apply their mutation to the
 * snapshot store FIRST, then call this (no array argument needed).
 *
 * @returns the engine `SaveOutcome` — the CALLER maps it to a toast (this seam does not self-toast).
 */
export async function saveEntityCollection(collection: EntityCollectionName): Promise<SaveOutcome> {
  const { useSaveSessionStore } = await import('@/stores/save-session-store');
  log.debug('saveEntityCollection', 'ensureSaved (engine)', { collection });
  return useSaveSessionStore.getState().ensureSaved('sketch-base-entities', collection);
}
