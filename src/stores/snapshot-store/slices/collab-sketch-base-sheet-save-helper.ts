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

/** crud audit enum for a base-sheet save: 3 = edit. The sheet node is normally seeded empty at
 *  snapshot CREATION (`emptyBase()` → all three sheets), so an edit always resolves. See
 *  `flushSketchBaseSheetUnderLock` for the one case where it does not (a book whose snapshot
 *  predates a sheet) and the create-repair that heals it. */
const ACTION_TYPE_EDIT = 3 as const;

/** crud audit enum 2 = create — used ONLY by the seed repair below, never by a normal save. */
const ACTION_TYPE_CREATE = 2 as const;

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

/**
 * Repair a base-sheet save that 404'd because the sheet node is ABSENT in the stored snapshot.
 *
 * Why this exists: the ONLY production seeder of `sketch.base` is snapshot CREATION
 * (`emptyBase()` in `sketch-normalize.ts`, written by `build-snapshot-from-parsed.ts`), and it
 * seeds exactly the sheets that existed when the book was created. `normalizeSketch` back-fills a
 * missing sheet CLIENT-side, but under collab the whole-doc autosave is suppressed, so that
 * in-memory default is never written back — the gateway keeps 404-ing the very first save of the
 * new sheet. One create heals it permanently.
 *
 * Audit policy mirrors `resource-lock-store#saveWithCreateFallback`: the create is infrastructure
 * repair, not a user action → `log:false` (no audit row, no content-sync event), then the ORIGINAL
 * edit is re-issued so the audit row and the server-built `metadata.sync` descriptor name the real
 * action. If the re-issue fails the data is already saved, so the create's success is reported.
 *
 * LIMIT: `jsonb_set` cannot create intermediate keys, so this heals a snapshot whose `sketch.base`
 * OBJECT exists but lacks this sheet. A snapshot with NO `sketch.base` at all (books predating the
 * base workspace entirely) is not addressable by rtype 11 — that pre-existing gap affects all
 * three sheets equally and is out of scope here.
 */
async function seedAbsentSheetNode(
  rl: ReturnType<typeof useResourceLockStore.getState>,
  target: LockTarget,
  kind: BaseKind,
  node: unknown,
): Promise<boolean> {
  log.info('seedAbsentSheetNode', 'sheet node absent server-side — seeding with a create', {
    kind,
    sheet: target.resource_id,
  });
  const created = await rl.save(target, {
    action_type: ACTION_TYPE_CREATE,
    patch: node,
    log: false, // infrastructure repair — never audited as a user "create"
  });
  if (!created.ok) {
    log.warn('seedAbsentSheetNode', 'seed create rejected', {
      kind,
      lost: created.lost,
      forbidden: created.forbidden,
      notFound: created.notFound ?? false,
    });
    return false;
  }
  const relogged = await rl.save(target, buildSketchBaseSheetPayload(node));
  if (!relogged.ok) {
    log.warn('seedAbsentSheetNode', 'audit re-issue failed — data already saved by the seed create', {
      kind,
      sheet: target.resource_id,
    });
  }
  return true;
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
    // 404 = the sheet node is ABSENT in the stored snapshot (the gateway refuses an EDIT of a node
    // it cannot address). Books created since the sheet existed are seeded at snapshot creation
    // (`emptyBase()` writes all three sheets), so this only happens on a book whose snapshot
    // predates the sheet — for `alter_character_sheet` that is every book created before
    // 2026-07-28. Repair it in-band with ONE create (the gateway skips the exists-check for
    // action_type 2 and jsonb_set create_missing adds the key under the existing `base` object).
    if (res.notFound) {
      const seeded = await seedAbsentSheetNode(rl, target, kind, node);
      if (seeded) return true;
    }
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
