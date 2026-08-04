// collab-scene-save-helper.ts — DORMANT per-resource collab save seam for the SCENE space
// (step=2 illustration scene overlays — ADR-044 P04 wire-only). Covers the four scene write
// surfaces the gateway opened in P03:
//   • spread          → rtype 6 (`illustration.spreads[i]`)            node create/edit + collection delete + reorder
//   • raw_image       → rtype 1 (`spreads[i].raw_images[j]`)           node create/edit + collection delete
//   • scene raw_textbox → rtype 7 (`spreads[i].raw_textboxes[j][<locale>]`) node create/edit (locale-scoped) + collection delete
//   • scene shape     → rtype 8 (`spreads[i].shapes[j]`)              node create/edit + collection delete
//
// Sibling of `collab-entity-save-helper.ts` (characters/props/stages, rtype 3/4/5) — same
// acquire → save(node) → release lifecycle via the shared `saveImageResourceUnderLock`, kept
// separate to hold the scene grain (spread + leaf overlays) without bloating the entity helper.
//
// NO-OP under the solo path (`collabPersist=false`): the whole-doc autosave owns persistence
// there, so the solo path stays byte-identical. DORMANT until the scene space flips collab-on
// (P05) — every function early-returns now.
//
// Fire-and-forget from the slice mutators (`void …`) — none throw (each drives the lifecycle in
// a try/catch). The node is read FRESH via `get()` at call time (post-mutate) — never a mutator
// closure var — to avoid a stale-closure write.

import { useResourceLockStore } from '@/stores/resource-lock-store';
import type { LockTarget } from '@/stores/resource-lock-store';
import { reorderResource } from '@/apis/resource-lock-api';
import type { SnapshotStore } from '../types';
import type { BaseSpread } from '@/types/spread-types';
import {
  saveImageResourceUnderLock,
  resolveImageLockTarget,
  resolveLockHolderName,
  type ImageSaveOutcome,
} from './collab-image-save-helper';
import { toastLockedByOther, toastForbiddenIllustration } from '@/utils/collab-save-toasts';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSceneSaveHelper');

/** crud audit enum for scene node-scope saves (see SavePayload): 2 create · 3 edit. */
export type SceneNodeActionType = 2 | 3;

/** Node-level (language-agnostic) keys of a raw_textbox — anything ELSE in an `updates` patch is
 *  a `<language_key>` sub-object (locale-scoped text/typography edit). Mirrors rtype-2 textbox. */
const RESERVED_TEXTBOX_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'z-index',
  'player_visible',
  'editor_visible',
]);

/** Read the WHOLE spread node fresh (anti stale-closure) — null when deleted mid-flight. */
function readSpread(state: SnapshotStore, spreadId: string): BaseSpread | null {
  return state.illustration.spreads.find((s) => s.id === spreadId) ?? null;
}

/** Build the step=2 / rtype=6 LockTarget for a spread node (language-agnostic). */
function spreadLockTarget(spreadId: string): LockTarget {
  return { step: 2, resource_type: 6, resource_id: spreadId, locale: null };
}

/** Derive the locale of a raw_textbox edit from its `updates` patch: the first key that is NOT a
 *  node-level field is the `<language_key>` (locale-scoped). No such key → node-level edit (null).
 *  ASSUMES a SINGLE-KIND patch (all current call-sites pass either reserved-only visibility toggles
 *  OR one locale's content) — a hypothetical mixed `{ title, en_US }` or multi-locale patch would
 *  persist only the first locale's sub-object; a later whole-node edit reconciles. */
function deriveTextboxLocale(updates?: Record<string, unknown>): string | null {
  if (!updates) return null;
  for (const key of Object.keys(updates)) {
    if (!RESERVED_TEXTBOX_KEYS.has(key)) return key;
  }
  return null;
}

/** Whether collab persistence is active. Solo path (false) → all helpers below no-op. */
function isCollab(): boolean {
  return useResourceLockStore.getState().collabPersist;
}

/**
 * Nested-node CREATE params for a scene CHILD save. On `action_type` 2 the gateway inserts a
 * BRAND-NEW leaf, so it needs the parent spread id + the target array name; every scene child
 * (raw_image / raw_textbox / shape) appends under its own spread. On an EDIT (3) it addresses the
 * existing leaf by id → `undefined` (no parent/collection sent, byte-identical to pre-P04B).
 * Spread + entity creates DON'T use this — they append at the spreads/column root (handled elsewhere).
 */
function nestedCreateParams(
  actionType: SceneNodeActionType,
  spreadId: string,
  collection: string,
): { parentId: string; collection: string } | undefined {
  return actionType === 2 ? { parentId: spreadId, collection } : undefined;
}

/** Shared post-save outcome LOGGING (DRY across the scene node-save helpers). ⚡ unified-item-save
 *  phase 3: the implicit toasts were REMOVED — the caller owns the toast (spec §5). These scene node
 *  helpers are DORMANT (collab scene not flipped on) and fire-and-forget `void` from the slice
 *  mutators, so they cannot relay an outcome yet; when the scene space flips collab-on (P05) it must
 *  thread the outcome to a caller-side `toast` (mirror `toastSketchSaveOutcome`). `_target` retained
 *  for that future signature. */
function reportSaveOutcome(
  outcome: ImageSaveOutcome,
  _target: LockTarget,
  ctx: Record<string, unknown>,
): void {
  if (outcome === 'skipped') {
    log.info('reportSaveOutcome', 'skipped — locked by another editor', ctx);
  } else if (outcome === 'forbidden') {
    log.warn('reportSaveOutcome', 'forbidden — missing illustration access', ctx);
  } else if (outcome === 'failed') {
    log.warn('reportSaveOutcome', 'collab save failed', ctx);
  }
}

/**
 * COLLECTION-scope DELETE (`action_type` 4, patch `null` → gateway removes the node and
 * `#-`-shifts siblings, `scope:'collection'` sync). Generic over the scene LockTarget so the
 * four delete surfaces (spread / raw_image / raw_textbox / shape) share ONE lifecycle. NO-OP
 * under solo (callers gate first).
 */
async function deleteSceneResource(
  target: LockTarget,
  targetRef: Record<string, unknown>,
): Promise<void> {
  const rl = useResourceLockStore.getState();
  try {
    const acq = await rl.acquire(target);
    if (!acq.ok) {
      log.info('deleteSceneResource', 'skipped — locked by another editor', targetRef);
      toastLockedByOther(resolveLockHolderName(target));
      return; // no lock held → nothing to release
    }
    try {
      const res = await rl.save(target, {
        action_type: 4,
        patch: null,
        target_ref: targetRef,
        log: true,
      });
      if (res.ok) {
        log.info('deleteSceneResource', 'deleted', targetRef);
      } else if (res.forbidden) {
        log.warn('deleteSceneResource', 'forbidden — missing illustration access', targetRef);
        toastForbiddenIllustration();
      } else {
        log.warn('deleteSceneResource', 'delete save rejected', { ...targetRef, lost: res.lost });
      }
    } finally {
      await rl.release(target);
    }
  } catch (err) {
    log.error('deleteSceneResource', 'unexpected error', {
      ...targetRef,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Spread (rtype 6) --------------------------------------------------------

/** NODE-scope save of a spread (create 2 | edit 3). Whole spread node re-patched. NO-OP solo. */
export async function persistSpreadCollab(
  get: () => SnapshotStore,
  spreadId: string,
  actionType: SceneNodeActionType,
): Promise<void> {
  if (!isCollab()) {
    log.debug('persistSpreadCollab', 'solo path — whole-doc autosave owns persistence', { spreadId });
    return;
  }
  const node = readSpread(get(), spreadId);
  if (!node) {
    log.warn('persistSpreadCollab', 'spread missing at save time — skip gateway save', { spreadId });
    return;
  }
  const target = spreadLockTarget(spreadId);
  log.info('persistSpreadCollab', 'collab save', { resourceType: target.resource_type, action: actionType });
  const outcome = await saveImageResourceUnderLock(target, node, actionType, { spread_id: spreadId });
  reportSaveOutcome(outcome, target, { spreadId });
}

/** COLLECTION-scope DELETE of a spread. NO-OP solo. */
export async function persistSpreadDeleteCollab(spreadId: string): Promise<void> {
  if (!isCollab()) {
    log.debug('persistSpreadDeleteCollab', 'solo path — whole-doc autosave owns persistence', { spreadId });
    return;
  }
  log.info('persistSpreadDeleteCollab', 'collab delete', { spreadId });
  await deleteSceneResource(spreadLockTarget(spreadId), { spread_id: spreadId });
}

/**
 * COLLECTION-scope REORDER of spreads (`/api/resource/reorder`, step=2 / rtype=6 — opened by
 * P03). AFTER the local reorder, persist the new order under the dragged spread's lock. On a
 * save failure we log only (a later content-sync/refetch reconciles). NO-OP solo.
 */
export async function persistSpreadReorderCollab(
  get: () => SnapshotStore,
  draggedId: string,
  from: number,
  to: number,
): Promise<void> {
  const rl = useResourceLockStore.getState();
  if (!rl.collabPersist) {
    log.debug('persistSpreadReorderCollab', 'solo path — whole-doc autosave owns persistence', { draggedId });
    return;
  }
  const bookId = rl.bookId;
  if (!bookId) {
    log.warn('persistSpreadReorderCollab', 'no bookId — skip reorder save', { draggedId });
    return;
  }
  const target = spreadLockTarget(draggedId);
  const orderedIds = get().illustration.spreads.map((s) => s.id); // post-mutate order (FRESH)
  log.info('persistSpreadReorderCollab', 'collab reorder', { count: orderedIds.length });
  try {
    const acq = await rl.acquire(target);
    if (!acq.ok) {
      log.info('persistSpreadReorderCollab', 'skipped — locked by another editor', { draggedId });
      toastLockedByOther(resolveLockHolderName(target));
      return;
    }
    try {
      const res = await reorderResource({
        bookId,
        step: target.step,
        resourceType: target.resource_type,
        resourceId: draggedId,
        orderedIds,
        // 1-based to match the audit ordinal convention used by the sketch/entity reorders.
        targetRef: { from: from + 1, to: to + 1 },
      });
      if (res.ok) {
        log.info('persistSpreadReorderCollab', 'reordered', { draggedId });
      } else {
        log.warn('persistSpreadReorderCollab', 'reorder failed', { draggedId, code: res.code });
      }
    } finally {
      await rl.release(target);
    }
  } catch (err) {
    log.error('persistSpreadReorderCollab', 'unexpected error', {
      draggedId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Raw image (rtype 1 — reuses the illustration_image leaf path) -----------

/** NODE-scope save of a scene raw_image (create 2 | edit 3). NO-OP solo. */
export async function persistSceneImageCollab(
  get: () => SnapshotStore,
  spreadId: string,
  imageId: string,
  actionType: SceneNodeActionType,
): Promise<void> {
  if (!isCollab()) {
    log.debug('persistSceneImageCollab', 'solo path — whole-doc autosave owns persistence', { spreadId });
    return;
  }
  const node = readSpread(get(), spreadId)?.raw_images?.find((i) => i.id === imageId) ?? null;
  if (!node) {
    log.warn('persistSceneImageCollab', 'raw_image missing at save time — skip gateway save', { spreadId, imageId });
    return;
  }
  const target = resolveImageLockTarget('illustration_image', spreadId, imageId);
  log.info('persistSceneImageCollab', 'collab save', { resourceType: target.resource_type, action: actionType });
  const outcome = await saveImageResourceUnderLock(
    target,
    node,
    actionType,
    { spread_id: spreadId, image_id: imageId },
    nestedCreateParams(actionType, spreadId, 'raw_images'),
  );
  reportSaveOutcome(outcome, target, { spreadId, imageId });
}

/** COLLECTION-scope DELETE of a scene raw_image. NO-OP solo. */
export async function persistSceneImageDeleteCollab(spreadId: string, imageId: string): Promise<void> {
  if (!isCollab()) {
    log.debug('persistSceneImageDeleteCollab', 'solo path — whole-doc autosave owns persistence', { spreadId });
    return;
  }
  const target = resolveImageLockTarget('illustration_image', spreadId, imageId);
  log.info('persistSceneImageDeleteCollab', 'collab delete', { spreadId, imageId });
  await deleteSceneResource(target, { spread_id: spreadId, image_id: imageId });
}

// --- Scene raw_textbox (rtype 7 — locale-scoped like a textbox) --------------

/**
 * NODE-scope save of a scene raw_textbox (create 2 | edit 3). `updates` (present on an EDIT) is
 * inspected for a `<language_key>` → a locale-scoped text/typography edit patches the `[locale]`
 * sub-object (`resource_id=<textbox id>, locale=<key>`); a node-level edit (title/editor_visible)
 * or a CREATE (no `updates`) patches the WHOLE node with `locale=null`. NO-OP solo.
 */
export async function persistSceneTextboxCollab(
  get: () => SnapshotStore,
  spreadId: string,
  textboxId: string,
  actionType: SceneNodeActionType,
  updates?: Record<string, unknown>,
): Promise<void> {
  if (!isCollab()) {
    log.debug('persistSceneTextboxCollab', 'solo path — whole-doc autosave owns persistence', { spreadId });
    return;
  }
  const node = readSpread(get(), spreadId)?.raw_textboxes?.find((t) => t.id === textboxId) ?? null;
  if (!node) {
    log.warn('persistSceneTextboxCollab', 'raw_textbox missing at save time — skip gateway save', { spreadId, textboxId });
    return;
  }
  const locale = deriveTextboxLocale(updates);
  // locale-scoped → patch the fresh `[locale]` sub-object; node-level/create → patch whole node.
  const patch = locale ? ((node as Record<string, unknown>)[locale] ?? null) : node;
  if (patch == null) {
    log.warn('persistSceneTextboxCollab', 'locale sub-object missing — skip gateway save', { spreadId, textboxId, locale });
    return;
  }
  const target = resolveImageLockTarget('scene_raw_textbox', spreadId, textboxId, locale);
  log.info('persistSceneTextboxCollab', 'collab save', { resourceType: target.resource_type, action: actionType, hasLocale: locale != null });
  const outcome = await saveImageResourceUnderLock(
    target,
    patch,
    actionType,
    { spread_id: spreadId, textbox_id: textboxId, locale },
    // Create carries no `updates` → locale null → whole-node patch appended under the spread.
    nestedCreateParams(actionType, spreadId, 'raw_textboxes'),
  );
  reportSaveOutcome(outcome, target, { spreadId, textboxId, locale });
}

/** COLLECTION-scope DELETE of a scene raw_textbox (whole node, locale null). NO-OP solo. */
export async function persistSceneTextboxDeleteCollab(spreadId: string, textboxId: string): Promise<void> {
  if (!isCollab()) {
    log.debug('persistSceneTextboxDeleteCollab', 'solo path — whole-doc autosave owns persistence', { spreadId });
    return;
  }
  const target = resolveImageLockTarget('scene_raw_textbox', spreadId, textboxId);
  log.info('persistSceneTextboxDeleteCollab', 'collab delete', { spreadId, textboxId });
  await deleteSceneResource(target, { spread_id: spreadId, textbox_id: textboxId });
}

// --- Scene shape (rtype 8) — RE-HOMED (unified-item-save phase 3) -------------
//
// `persistSceneShapeCollab` / `persistSceneShapeDeleteCollab` were REMOVED here (2026-08-04): a scene
// shape lives under `spreads[].shapes[]`, which is now a RETOUCH_OWNED_KEY (`addressing.py`), so a
// dirty shape is persisted with the rest of the retouch sub-tree by the per-spread `retouch-spread`
// held session (rtype 10) — no more one-shot rtype-8 node writes from `retouch-slice`. ⚠️ SHIP-
// COUPLING: this FE removal deploys TOGETHER with the BE owned-key merge accepting `shapes`.
