// collab-scene-save-helper.ts — per-resource collab save seam for the SCENE space STRUCTURAL ops
// (step=2 illustration scene overlays — ADR-044 P04). After the unified-item-save migration
// (2026-08-04) only the SPREAD-level structural ops remain here (rtype 6):
//   • spread create/edit → `persistSpreadCollab`         (`illustration.spreads[i]`)
//   • spread delete      → `persistSpreadDeleteCollab`
//   • spread reorder     → `persistSpreadReorderCollab`
// The former per-node scene LEAF saves (`persistSceneImageCollab` / `persistSceneTextboxCollab`
// + their deletes, rtype 1/7) were REMOVED here — a dirty scene leaf is now persisted with the rest
// of the spread's owned sub-tree by the per-spread `scene-spread` held session (save-session-store,
// rtype 6 / SCENE_OWNED_KEYS). Scene SHAPE writes (rtype 8) are RETIRED entirely — shapes are no
// longer a SCENE item (Phase 06); the OBJECTS space is the sole writer (see the note at the bottom).
//
// Sibling of `collab-entity-save-helper.ts` (characters/props/stages, rtype 3/4/5) — same
// acquire → save(node) → release lifecycle via the shared `saveImageResourceUnderLock`, kept
// separate to hold the scene grain (spread create/delete/reorder).
//
// NO-OP under the solo path (`collabPersist=false`): the whole-doc autosave owns persistence
// there, so the solo path stays byte-identical.
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
  resolveLockHolderName,
  type ImageSaveOutcome,
} from './collab-image-save-helper';
import { toastLockedByOther, toastForbiddenIllustration } from '@/utils/collab-save-toasts';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSceneSaveHelper');

/** crud audit enum for scene node-scope saves (see SavePayload): 2 create · 3 edit. */
export type SceneNodeActionType = 2 | 3;

/** Read the WHOLE spread node fresh (anti stale-closure) — null when deleted mid-flight. */
function readSpread(state: SnapshotStore, spreadId: string): BaseSpread | null {
  return state.illustration.spreads.find((s) => s.id === spreadId) ?? null;
}

/** Build the step=2 / rtype=6 LockTarget for a spread node (language-agnostic). */
function spreadLockTarget(spreadId: string): LockTarget {
  return { step: 2, resource_type: 6, resource_id: spreadId, locale: null };
}

/** Whether collab persistence is active. Solo path (false) → all helpers below no-op. */
function isCollab(): boolean {
  return useResourceLockStore.getState().collabPersist;
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

// --- Scene LEAF saves (raw_image rtype 1 / raw_textbox rtype 7) — REMOVED -----
//
// `persistSceneImageCollab` / `persistSceneImageDeleteCollab` / `persistSceneTextboxCollab` /
// `persistSceneTextboxDeleteCollab` were REMOVED here (unified-item-save, 2026-08-04): a dirty scene
// raw_image / raw_textbox now rides the per-spread `scene-spread` held session (save-session-store,
// rtype 6 / SCENE_OWNED_KEYS) — the whole owned sub-tree is persisted on release, so the old per-node
// one-shot writes from `illustration-slice` are gone (see the `Former persist*Collab … REMOVED`
// markers there).
//
// --- Scene shape (rtype 8) — RETIRED (Phase 06, 2026-08-05) -------------------
//
// `persistSceneShapeCollab` / `persistSceneShapeDeleteCollab` were REMOVED (2026-08-04) and rtype 8
// is now dead FE vocab. Shapes are NO LONGER a SCENE-space item: `spreads[].shapes[]` is a
// RETOUCH_OWNED_KEY persisted only via the OBJECTS-space per-spread `retouch-spread` held session
// (rtype 10) — the sole writer. There is no scene-space shape write path anymore.
