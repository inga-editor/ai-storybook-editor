// collab-sketch-variant-save-helper.ts — per-resource collab save seam for the SKETCH
// VARIANT creative space (ADR-047 / Path B). The variant space is the 7th collab space;
// its grain is the WHOLE sketch ENTITY node at STEP 1 (rtype 3 character / 4 prop), which the
// gateway `_resolve_entity` maps to `sketch.<plural>[key]` — the SAME whole-node contract the
// illustration entity spaces use at step 2, so NO new rtype / resolver / migration is needed.
//
// Three consumers (⚡ updated 2026-07-16 — the space moved from eager-atomic per-gesture to
// BATCH-AT-RELEASE, ADR-043 Rev):
//   • the component held-session (`useSaveSession`) is now the PRIMARY path: the cheap
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
// ⚡ unified-item-save phase 3: `flushSketchEntityUnderLock` is now a thin seam that delegates to the
// save-session engine's `ensureSaved` (the engine owns the solo/collab fork + lock lifecycle + rebase);
// the pure `resolveSketchVariantLockTarget` / `buildSketchEntityPayload` exports (reused by the policy
// registry) are unchanged. `useSaveSessionStore` is imported DYNAMICALLY at call time to avoid the
// eval-time cycle (save-session-store → save-policies → this module).

import { type LockTarget, type ResourceType } from '@/stores/resource-lock-store';
import type { SheetKind } from '@/types/sketch';
import { makeEntityId } from '@/stores/save-session-store/entity-id';
import type { SaveOutcome } from '@/stores/save-session-store/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSketchVariantSaveHelper');

/** ⚡REV 2026-08-21 — sketch step-1 entity kind → gateway `resource_type` (3 character · 4 prop).
 *  Every character (any group) is rtype 3; stages (5) have no variant space, so they are absent. */
export const SKETCH_KIND_TO_RESOURCE_TYPE: Record<SheetKind, ResourceType> = {
  characters: 3,
  props: 4,
};

/** crud audit enum used for every variant-space save: 3 = edit (the entity node always already
 *  exists — seeded from the base import; no create/delete of the entity happens in this space). */
const ACTION_TYPE_EDIT = 3 as const;

/**
 * Build the STEP-1 LockTarget for a sketch entity node (whole-entity grain).
 * `locale` is null (entity nodes are not locale-scoped, unlike a textbox).
 */
export function resolveSketchVariantLockTarget(kind: SheetKind, entityKey: string): LockTarget {
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
  /** @deprecated IGNORED since unified-item-save phase 3 — the engine decides the lock lifecycle
   *  (held → keep; no session → one-shot acquire→save→release, replacing this flag). Kept only so the
   *  existing call sites compile unchanged. */
  releaseIfAcquired?: boolean;
}

/**
 * Persist the WHOLE sketch entity node — ⚡ unified-item-save phase 3: delegates to the save-session
 * engine's `ensureSaved('sketch-entity', …)`, which internalizes the single solo/collab fork + the
 * whole lock lifecycle (held → save-while-held + rebase baseline; no live session → one-shot
 * acquire→save→release; solo → whole-snapshot flush). The engine reads the FRESH node via the policy
 * registry, so `node` is IGNORED (the caller no longer needs to pass it — kept for signature stability).
 *
 * ⚠️ Behavior shift vs the pre-phase-3 helper: the old default (`releaseIfAcquired:false`) KEPT a lock
 * it had to acquire; the engine's one-shot ALWAYS releases when there is no live session. For a HELD
 * session (the common variant/base/stage path) this is identical — `ensureSaved` → `saveNow` keeps the
 * lock. The narrow H2 window (held-session acquire in flight when a select-crop flush lands) now runs
 * the one-shot, which the idle auto-save (60s) covers as the net (see the space's `flushEntityNow` doc).
 *
 * @returns the engine `SaveOutcome` — the CALLER maps it to a toast (this helper no longer self-toasts).
 */
export async function flushSketchEntityUnderLock(
  kind: SheetKind,
  entityKey: string,
  _node?: unknown,
  _opts?: FlushSketchEntityOptions,
): Promise<SaveOutcome> {
  const { useSaveSessionStore } = await import('@/stores/save-session-store');
  log.debug('flushSketchEntityUnderLock', 'ensureSaved (engine)', { kind, entityKey });
  return useSaveSessionStore.getState().ensureSaved('sketch-entity', makeEntityId(kind, entityKey));
}
