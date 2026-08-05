// collab-image-save-helper.ts — SHARED acquire → save(node) → release skeleton for
// per-resource illustration/retouch collab saves (ADR-044). ONE image resource op
// (generate / edit / upload) = one lock lifecycle through the gateway `POST /api/resource/save`.
//
// Reused by BOTH image-task-slice (illustration entities + scene — P02) AND the retouch
// wiring (P03). DO NOT copy this logic — import it.
//
// Toast-free by design: the CALLER owns the UX on a 'skipped'/'failed' outcome (illustration
// toasts "another editor is editing"; retouch may toast a 403 access message). This helper only
// drives lock → save → release and reports the outcome.
//
// resource-lock-store is loaded by snapshot-store/index BEFORE the slices, so this static import
// resolves cleanly in the app. Isolated unit tests import this module directly and mock
// '@/stores/resource-lock-store' to break the slice ↔ store module cycle (the useResourceLockStore
// binding is only READ at call time, never at module-eval time — so the cycle is harmless).

import {
  useResourceLockStore,
  keyOf,
  FALLBACK_HOLDER_NAME,
  type LockTarget,
  type ResourceType,
  type SavePayload,
} from '@/stores/resource-lock-store';
import type { ImageTaskEntityType } from '@/stores/snapshot-store/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabImageSaveHelper');

/** Outcome of a per-resource collab save.
 *  - 'saved'     → gateway wrote the node under the held lock.
 *  - 'skipped'   → acquire returned 409 (another editor holds the lock); NOTHING written.
 *  - 'forbidden' → save returned 403 (actor lacks access to this resource type — e.g. a
 *                  retouch-only collaborator saving a step=2 illustration node). EXPECTED
 *                  access-gate outcome the caller surfaces distinctly (illustration-access toast).
 *  - 'failed'    → save rejected (lock/node lost 409/404, transient) OR node missing.
 *  Additive member (2026-07-09, Track C): existing callers that only branch on
 *  'skipped'/'failed' keep working — a 'forbidden' outcome falls through their generic path. */
export type ImageSaveOutcome = 'saved' | 'skipped' | 'failed' | 'forbidden';

/** Scene overlay node-kinds opened by ADR-044 P03 (step=2 illustration scene):
 *  `scene_raw_textbox` → `spreads[].raw_textboxes[]` (rtype 7, `<locale>` sub-object like a
 *  textbox). Not part of `ImageTaskEntityType` (they carry no image task) — a separate leaf-node
 *  vocabulary. NOTE: the scene-shape node-kind (rtype 8) is RETIRED (Phase 06, 2026-08-05) — shapes
 *  are no longer a SCENE item; they persist only via the OBJECTS-space rtype-10 held session. */
export type SceneNodeKind = 'scene_raw_textbox';

/** Everything `resolveImageLockTarget` can address: image-task entities + scene overlay leaves. */
export type CollabResourceKind = ImageTaskEntityType | SceneNodeKind;

/** CollabResourceKind → gateway `resource_type` (1 image · 3 character · 4 prop · 5 stage ·
 *  7 scene raw_textbox). Entities lock their WHOLE node (rtype 3/4/5); scene + retouch images
 *  (rtype 1) and scene textbox (rtype 7) lock the leaf node. (rtype 8 scene shape RETIRED —
 *  Phase 06.) */
export const ENTITY_TYPE_TO_RESOURCE_TYPE: Record<CollabResourceKind, ResourceType> = {
  character: 3,
  prop: 4,
  stage: 5,
  illustration_image: 1, // scene raw image  → illustration.spreads[].raw_images[]
  retouch_image: 1, //       retouch image → illustration.spreads[].images[]
  scene_raw_textbox: 7, //   scene raw textbox → illustration.spreads[].raw_textboxes[]
};

/** Entity kinds lock the WHOLE entity node → resource_id = entity key (not the child/leaf). */
const ENTITY_KINDS: ReadonlySet<string> = new Set(['character', 'prop', 'stage']);

/**
 * Build the step=2 LockTarget for an image/scene-overlay resource (leaf resolver).
 * - character/prop/stage → lock the entity node, resource_id = `entityKey`.
 * - illustration_image / retouch_image / scene_raw_textbox → lock the
 *   leaf node, resource_id = `childKey` (image / textbox id).
 * step is ALWAYS 2 (illustration/retouch/scene phase). `locale` is null for everything EXCEPT a
 * locale-scoped scene raw_textbox edit (mirrors rtype-2 textbox: the `<language_key>` sub-object).
 */
export function resolveImageLockTarget(
  entityType: CollabResourceKind,
  entityKey: string,
  childKey: string,
  locale: string | null = null,
): LockTarget {
  return {
    step: 2,
    resource_type: ENTITY_TYPE_TO_RESOURCE_TYPE[entityType],
    resource_id: ENTITY_KINDS.has(entityType) ? entityKey : childKey,
    locale,
  };
}

/** Imperative twin of the `useLockHolderName` selector (usable OUTSIDE React) — display name of
 *  the current OTHER holder of `target`, or FALLBACK when unknown. Used by the caller to name the
 *  editor in a "your change was not saved" toast after a 'skipped' outcome. */
export function resolveLockHolderName(target: LockTarget): string {
  const s = useResourceLockStore.getState();
  if (!s.bookId) return FALLBACK_HOLDER_NAME;
  const holderId = s.registry.get(keyOf(s.bookId, target))?.holder_user_id;
  if (!holderId) return FALLBACK_HOLDER_NAME;
  return s.holderNames.get(holderId) ?? FALLBACK_HOLDER_NAME;
}

/**
 * Acquire the resource lock, patch ONE node through the gateway save, then ALWAYS release.
 *
 * @param target     step=2 lock target (from `resolveImageLockTarget`)
 * @param patch      the FULL fresh node body to persist. Caller MUST read it via getState() at
 *                   call time (never a task-creation closure var) to avoid stale-closure writes.
 *                   `null`/`undefined` (node deleted mid-flight) → bail 'failed' (no lock churn).
 * @param actionType crud audit enum: 2 create · 3 edit · 5 upload/generate
 * @param targetRef  audit ref, identifying keys only (e.g. { spread_id, image_id } | { kind, entity })
 * @param nested     nested-node CREATE only (`action_type` 2 of a spread-CHILD): { parentId = parent
 *                   spread id, collection = target array name }. Forwarded to the gateway save body
 *                   as `parent_id`/`collection` so the gateway appends the brand-new node. OMIT for
 *                   edit/delete and for root-level creates (spread/entity) — the body then carries
 *                   neither field (byte-identical to before).
 * @returns 'saved' | 'skipped' (409 acquire) | 'failed' (save rejected / node missing)
 *
 * `log: true` → the gateway emits the node-scope content-sync event + a single audit row (no client
 * summary log needed). NEVER throws — acquire/save/release all return result objects, and any
 * unexpected error is caught → 'failed', so a fire-and-forget caller (`void …`) can't reject.
 */
export async function saveImageResourceUnderLock(
  target: LockTarget,
  patch: unknown,
  actionType: SavePayload['action_type'],
  targetRef?: Record<string, unknown>,
  nested?: { parentId: string; collection: string },
): Promise<ImageSaveOutcome> {
  if (patch == null) {
    log.warn('saveImageResourceUnderLock', 'node missing at save time — bail', {
      type: target.resource_type,
      id: target.resource_id,
    });
    return 'failed';
  }

  const rl = useResourceLockStore.getState();
  log.info('saveImageResourceUnderLock', 'acquire', {
    type: target.resource_type,
    id: target.resource_id,
    action: actionType,
  });

  try {
    const acq = await rl.acquire(target);
    if (!acq.ok) {
      log.debug('saveImageResourceUnderLock', 'blocked — another editor holds the lock', {
        type: target.resource_type,
        id: target.resource_id,
      });
      return 'skipped'; // no lock held → nothing to release
    }
    try {
      const res = await rl.save(target, {
        action_type: actionType,
        patch,
        target_ref: targetRef,
        log: true,
        // Present only on a nested-node create — maps to the gateway `parent_id`/`collection`.
        ...(nested ? { parent_id: nested.parentId, collection: nested.collection } : {}),
      });
      if (res.ok) {
        log.info('saveImageResourceUnderLock', 'saved', {
          type: target.resource_type,
          id: target.resource_id,
        });
        return 'saved';
      }
      if (res.forbidden) {
        log.warn('saveImageResourceUnderLock', 'forbidden — missing resource access', {
          type: target.resource_type,
          id: target.resource_id,
        });
        return 'forbidden';
      }
      log.warn('saveImageResourceUnderLock', 'save rejected', {
        type: target.resource_type,
        id: target.resource_id,
        lost: res.lost,
      });
      return 'failed';
    } finally {
      await rl.release(target); // release ASAP so others can edit
    }
  } catch (err) {
    log.error('saveImageResourceUnderLock', 'unexpected error', {
      type: target.resource_type,
      id: target.resource_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
