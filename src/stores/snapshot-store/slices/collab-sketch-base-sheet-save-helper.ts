// collab-sketch-base-sheet-save-helper.ts — per-resource collab save seam for the SKETCH
// BASE creative space (ADR-043 / sketch-base collab, the 8th collab space). ⚡REV 2026-08-21 — its
// GRAIN A is the WHOLE per-GROUP base SHEET node at STEP 1 (rtype 11 base_sheet), addressed by the
// GROUP KEY as `resource_id` (`base[group_key]`). This is a NEW rtype (11) because the sheet node
// is NOT under an entity node — it is a group-level node, so the variant space's rtype-3/4 entity
// trick cannot address it (see Phase 01 backend).
//
// Mirror of `collab-sketch-variant-save-helper.ts` (grain A instead of the entity grain). Grain B
// (per-entity text: EditBaseEntityModal + import + lock-clone base variant) REUSES the variant
// helper's `flushSketchEntityUnderLock` (rtype 3/4) — it is NOT re-implemented here.
//
// Two consumers:
//   • the space held-session (`useSaveSession`, step 1 / rtype 11) drives the SHEET edits
//     (crop-edit / raw-edit / lock-style `is_selected`) — it acquires/saves/releases the whole
//     sheet node itself, using `resolveSketchBaseSheetLockTarget` + a whole-node payload.
//   • the generate JOB slice (off-render, cannot call the React `saveNow`) drives persist-after-
//     generate + persist-after-crop via `flushSketchBaseSheetUnderLock`, which saves the whole
//     sheet node UNDER an (acquired-if-needed) lock. Base generate is INLINE (05/06 do NOT read the
//     DB), so there is NO flush-BEFORE-generate — persistence is result-only.
//
// ⚡ unified-item-save phase 3: `flushSketchBaseSheetUnderLock` now delegates to the engine's
// `ensureSaved` (solo/collab fork + lock lifecycle + rebase internalized; the gateway still owns the
// rtype-11 upsert / 404-tolerance). The pure resolver/payload exports are unchanged.
// `useSaveSessionStore` is imported dynamically at call time (cycle break).

import { type LockTarget, type ResourceType } from '@/stores/resource-lock-store';
import type { SaveOutcome } from '@/stores/save-session-store/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSketchBaseSheetSaveHelper');

/** rtype 11 = base_sheet (group-level sheet node). */
const RESOURCE_TYPE_BASE_SHEET = 11 satisfies ResourceType;

/** crud audit enum for a base-sheet save: 3 = edit — the ONLY action this space ever sends.
 *  ⚡2026-07-28: the gateway UPSERTS rtype 11 (a base sheet is a fixed-key singleton that nothing
 *  mints and nothing deletes, so "not found" can only mean "never written"), which means an edit
 *  resolves even on a snapshot whose `sketch.base` lacks this sheet — or has no `base` at all.
 *  The old client-side 404 → create → re-issue repair is therefore GONE (3 round-trips → 1); do
 *  not reintroduce it, and see `api/resource/04-save.md` §rtype 11 before changing the contract. */
const ACTION_TYPE_EDIT = 3 as const;

/** crud audit enum for a base-sheet DELETE (whole group node removal): 4 = delete. */
const ACTION_TYPE_DELETE = 4 as const;

/**
 * Build the STEP-1 / rtype-11 LockTarget for a base sheet node. ⚡REV 2026-08-21 — the `resource_id`
 * IS the GROUP KEY (`base[group_key]`); the gateway derives the authz grant from the node's `kind`
 * (owner bypass). `locale` is null (the sheet node is not locale-scoped, unlike a textbox).
 */
export function resolveSketchBaseSheetLockTarget(group: string): LockTarget {
  return {
    step: 1,
    resource_type: RESOURCE_TYPE_BASE_SHEET,
    resource_id: group,
    locale: null,
  };
}

/**
 * Whole-node payload for the held-session `buildPayload`. The gateway contract for the sheet node
 * is `{ action_type: 3, patch: <whole sheet node>, log: true }` — `log:true` emits the
 * `scope:'node'` content-sync event + one audit row (peers refetch the fresh sheet). The whole
 * node ALWAYS carries the current `kind` (BE: missing kind → 422 BASE_SHEET_KIND_REQUIRED; a
 * changed kind → 422 BASE_SHEET_KIND_IMMUTABLE) — the flush never changes kind.
 */
export function buildSketchBaseSheetPayload(node: unknown): {
  action_type: 3;
  patch: unknown;
  log: true;
} {
  return { action_type: ACTION_TYPE_EDIT, patch: node, log: true };
}

export interface FlushSketchBaseSheetOptions {
  /** @deprecated IGNORED since unified-item-save phase 3 — the engine decides the lock lifecycle
   *  (held → keep; no session → one-shot). Kept only for call-site compatibility. */
  releaseIfAcquired?: boolean;
}

/**
 * Persist the WHOLE per-kind base SHEET node (rtype 11) — ⚡ unified-item-save phase 3: delegates to
 * the save-session engine's `ensureSaved('sketch-base-sheet', <sheet resource_id>)` (single solo/collab
 * fork + lock lifecycle; held → save + rebase; no session → one-shot acquire→save→release; solo →
 * whole-snapshot flush). The engine reads the FRESH sheet node via the policy registry, so `node` is
 * IGNORED. The gateway's rtype-11 upsert (404-tolerant) is unchanged — it lives in the gateway `save`.
 *
 * @returns the engine `SaveOutcome` — the CALLER maps it to a toast (this helper no longer self-toasts).
 */
export async function flushSketchBaseSheetUnderLock(
  group: string,
  _node?: unknown,
  _opts?: FlushSketchBaseSheetOptions,
): Promise<SaveOutcome> {
  const { useSaveSessionStore } = await import('@/stores/save-session-store');
  log.debug('flushSketchBaseSheetUnderLock', 'ensureSaved (engine)', { group });
  return useSaveSessionStore.getState().ensureSaved('sketch-base-sheet', group);
}

/**
 * Delete the WHOLE base sheet node for a group (rtype 11, `action_type:4`) UNDER a one-shot lock:
 * acquire → optimistic local `removeSketchBaseSheet` → gateway `save(delete)` → release.
 *
 * ⚠️ DELETE is OWNER-ONLY server-side (collaborator 403 even with the right grant) — the CALLER
 * (Phase 3 orphan cleanup / Phase 4 import) gates the UI to the book owner. A lock-403 (peer holds
 * the node) is NOT a write-permission signal: it toasts the holder and aborts without deleting.
 */
export async function deleteSketchBaseSheetViaGateway(group: string): Promise<void> {
  const [{ useResourceLockStore, FALLBACK_HOLDER_NAME }, { useSnapshotStore }, { toast }] =
    await Promise.all([
      import('@/stores/resource-lock-store'),
      import('@/stores/snapshot-store'),
      import('sonner'),
    ]);
  const target = resolveSketchBaseSheetLockTarget(group);
  const lock = useResourceLockStore.getState();

  const acq = await lock.acquire(target);
  if (!acq.ok) {
    const name = acq.holder ? lock.holderNames.get(acq.holder) ?? FALLBACK_HOLDER_NAME : FALLBACK_HOLDER_NAME;
    log.info('deleteSketchBaseSheetViaGateway', 'blocked on acquire — peer holds the group', { group });
    toast.info(`${name} đang chỉnh sửa — vui lòng thử lại sau.`);
    return;
  }
  try {
    useSnapshotStore.getState().removeSketchBaseSheet(group);
    const res = await lock.save(target, { action_type: ACTION_TYPE_DELETE, patch: null, target_ref: { group }, log: true });
    if (!res.ok) {
      log.warn('deleteSketchBaseSheetViaGateway', 'delete save failed', { group, forbidden: res.forbidden, lost: res.lost });
      toast.error('Không xoá được nhóm — vui lòng tải lại trang.');
    } else {
      log.info('deleteSketchBaseSheetViaGateway', 'deleted group node', { group });
    }
  } finally {
    await lock.release(target);
  }
}
