// collab-sketch-base-sheet-save-helper.ts — per-resource collab save seam for the SKETCH
// BASE creative space (ADR-043 / sketch-base collab, the 8th collab space). Its GRAIN A is the
// WHOLE per-kind base SHEET node at STEP 1 (rtype 11 base_sheet), which the gateway resolver maps
// to `sketch.base.{kind}_sheet` (resource_id `character_sheet` / `prop_sheet`). This is a NEW
// rtype (11) because the sheet node is NOT under an entity node — it is a kind-level node, so the
// variant space's rtype-3/4 entity trick cannot address it (see Phase 01 backend).
//
// Mirror of `collab-sketch-variant-save-helper.ts` (grain A instead of the entity grain). Grain B
// (per-entity text: EditBaseEntityModal + import + lock-clone base variant) REUSES the variant
// helper's `flushSketchEntityUnderLock` (rtype 3/4) — it is NOT re-implemented here.
//
// Two consumers:
//   • the space held-session (`useHeldResourceSession`, step 1 / rtype 11) drives the SHEET edits
//     (crop-edit / raw-edit / lock-style `is_selected`) — it acquires/saves/releases the whole
//     sheet node itself, using `resolveSketchBaseSheetLockTarget` + a whole-node payload.
//   • the generate JOB slice (off-render, cannot call the React `saveNow`) drives persist-after-
//     generate + persist-after-crop via `flushSketchBaseSheetUnderLock`, which saves the whole
//     sheet node UNDER an (acquired-if-needed) lock. Base generate is INLINE (05/06 do NOT read the
//     DB), so there is NO flush-BEFORE-generate — persistence is result-only.
//
// NO-OP under solo (`collabPersist=false`): the whole-doc autosave owns persistence there, so
// `flushSketchBaseSheetUnderLock` returns `true` (nothing to do) and the caller keeps its legacy
// `autoSaveSnapshot` path byte-identical.
//
// resource-lock-store is a LEAF store (loaded before the snapshot slices) so its static import
// resolves cleanly; this module does NOT import snapshot-store (the caller reads the fresh sheet
// node and passes it in) → no slice ↔ store cycle.

import {
  useResourceLockStore,
  keyOf,
  type LockTarget,
  type ResourceType,
} from '@/stores/resource-lock-store';
import type { BaseKind } from '@/types/sketch';
import { BASE_SHEET_ID } from '@/types/sketch';
import { toastLockedByOther } from '@/utils/collab-save-toasts';
import { resolveLockHolderName } from './collab-image-save-helper';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSketchBaseSheetSaveHelper');

/** step-1 rtype-11 `resource_id` per kind → the whole `sketch.base.{kind}_sheet` node the gateway
 *  resolver writes (character_sheet → `characters` grant · prop_sheet → `props` grant ·
 *  ⚡ alter_character_sheet → `characters` grant, 2026-07-28). Stage (5) has NO base sheet, so only
 *  the base kinds are addressable here. COPIED from `BASE_SHEET_ID` (the one kind→sheet mapping)
 *  rather than aliased: exporting the SAME object under two public names would let a mutation
 *  through either name silently rewrite lock routing everywhere. */
export const SKETCH_KIND_TO_SHEET_RESOURCE_ID: Record<BaseKind, string> = { ...BASE_SHEET_ID };

/** rtype 11 = base_sheet (kind-level sheet node). */
const RESOURCE_TYPE_BASE_SHEET = 11 satisfies ResourceType;

/** crud audit enum for a base-sheet save: 3 = edit — the ONLY action this space ever sends.
 *  ⚡2026-07-28: the gateway UPSERTS rtype 11 (a base sheet is a fixed-key singleton that nothing
 *  mints and nothing deletes, so "not found" can only mean "never written"), which means an edit
 *  resolves even on a snapshot whose `sketch.base` lacks this sheet — or has no `base` at all.
 *  The old client-side 404 → create → re-issue repair is therefore GONE (3 round-trips → 1); do
 *  not reintroduce it, and see `api/resource/04-save.md` §rtype 11 before changing the contract. */
const ACTION_TYPE_EDIT = 3 as const;

/**
 * Build the STEP-1 / rtype-11 LockTarget for a per-kind base sheet node (whole-sheet grain).
 * `locale` is null (the sheet node is not locale-scoped, unlike a textbox).
 */
export function resolveSketchBaseSheetLockTarget(kind: BaseKind): LockTarget {
  return {
    step: 1,
    resource_type: RESOURCE_TYPE_BASE_SHEET,
    resource_id: SKETCH_KIND_TO_SHEET_RESOURCE_ID[kind],
    locale: null,
  };
}

/**
 * Whole-node payload for the held-session `buildPayload`. The gateway contract for the sheet node
 * is `{ action_type: 3, patch: <whole sheet node>, log: true }` — `log:true` emits the
 * `scope:'node'` content-sync event + one audit row (peers refetch the fresh sheet).
 */
export function buildSketchBaseSheetPayload(node: unknown): {
  action_type: 3;
  patch: unknown;
  log: true;
} {
  return { action_type: ACTION_TYPE_EDIT, patch: node, log: true };
}

export interface FlushSketchBaseSheetOptions {
  /**
   * One-shot semantics: if THIS call had to `acquire` the lock (it was NOT already held by the
   * space held-session), release it after the save. Use for persists that run OUTSIDE the held-
   * session's ownership window — the RESULT of a generate/recrop whose sheet lock may have been
   * released (user switched kind during the long AI call). When the sheet IS already held, the
   * lock is KEPT (the held-session stays the releaser). Default `false` → always keep.
   */
  releaseIfAcquired?: boolean;
}

/**
 * Persist the WHOLE per-kind base SHEET node through the gateway. Baseline-independent (reads the
 * FRESH sheet node the caller passes → saves exactly that, no dirty-diff), so it can't silently drop
 * a mutation whose held-session baseline was captured late.
 *
 * Lock lifecycle:
 *   • solo (`collabPersist=false`) → no-op, returns `true` (caller owns `autoSaveSnapshot`).
 *   • already held (space held-session owns the sheet) → skip acquire, just `save`, KEEP the lock.
 *   • not held → `acquire` first (409 → toast + `false`, caller aborts / falls through); after the
 *     save, release IFF `releaseIfAcquired` (one-shot — never orphans a lock the held-session no
 *     longer owns).
 *
 * @param node the FRESH whole sheet node (read via getState() at call time — anti stale-closure).
 *             `null` (sheet vanished mid-flight) → `false`.
 * @returns `true` when persisted (or solo no-op); `false` on 409 / save-reject / missing node.
 */
export async function flushSketchBaseSheetUnderLock(
  kind: BaseKind,
  node: unknown,
  opts?: FlushSketchBaseSheetOptions,
): Promise<boolean> {
  const rl = useResourceLockStore.getState();
  if (!rl.collabPersist) {
    log.debug('flushSketchBaseSheetUnderLock', 'solo path — whole-doc autosave owns persistence', { kind });
    return true; // solo: nothing to do here; caller keeps autoSaveSnapshot
  }
  if (node == null) {
    log.warn('flushSketchBaseSheetUnderLock', 'sheet node missing at save time — skip', { kind });
    return false;
  }
  const bookId = rl.bookId;
  if (!bookId) {
    log.warn('flushSketchBaseSheetUnderLock', 'no book connected — skip', { kind });
    return false;
  }

  const target = resolveSketchBaseSheetLockTarget(kind);
  const key = keyOf(bookId, target);
  let acquiredHere = false;

  try {
    // Acquire only if the held-session has not already taken it (idempotent renew otherwise).
    if (!rl.myLocks.has(key)) {
      const acq = await rl.acquire(target);
      if (!acq.ok) {
        log.info('flushSketchBaseSheetUnderLock', 'blocked — another editor holds the sheet', { kind });
        toastLockedByOther(resolveLockHolderName(target));
        return false; // no lock held → nothing to release; caller aborts / falls through
      }
      acquiredHere = true;
    }
    const res = await rl.save(target, buildSketchBaseSheetPayload(node));
    if (res.ok) {
      log.info('flushSketchBaseSheetUnderLock', 'saved', { kind, acquiredHere });
      return true;
    }
    // ⚡2026-07-28: a 404 no longer means "the sheet node is absent" — the gateway upserts rtype 11
    // (see ACTION_TYPE_EDIT), so an absent sheet, an absent `sketch.base`, and a book predating the
    // base workspace all resolve on the first save. A 404 that survives now means a genuinely
    // unaddressable target (off-allowlist resource_id / missing book snapshot) → report, do not
    // retry: re-issuing as a create would 404 identically.
    log.warn('flushSketchBaseSheetUnderLock', 'save rejected', {
      kind,
      lost: res.lost,
      forbidden: res.forbidden,
      notFound: res.notFound ?? false,
    });
    if (res.forbidden) toastLockedByOther(resolveLockHolderName(target));
    return false;
  } catch (err) {
    log.error('flushSketchBaseSheetUnderLock', 'unexpected error', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    // One-shot: release ONLY the lock WE acquired here (the held-session never owned it) so it can't
    // linger to TTL when the held-session already released the sheet (user switched kind mid-generate).
    if (acquiredHere && opts?.releaseIfAcquired) {
      await rl.release(target);
      log.debug('flushSketchBaseSheetUnderLock', 'one-shot release (acquired here, not held-session owned)', {
        kind,
      });
    }
  }
}
