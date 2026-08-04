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
import type { BaseKind } from '@/types/sketch';
import { BASE_SHEET_ID } from '@/types/sketch';
import type { SaveOutcome } from '@/stores/save-session-store/types';
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
  kind: BaseKind,
  _node?: unknown,
  _opts?: FlushSketchBaseSheetOptions,
): Promise<SaveOutcome> {
  const { useSaveSessionStore } = await import('@/stores/save-session-store');
  log.debug('flushSketchBaseSheetUnderLock', 'ensureSaved (engine)', { kind });
  return useSaveSessionStore
    .getState()
    .ensureSaved('sketch-base-sheet', SKETCH_KIND_TO_SHEET_RESOURCE_ID[kind]);
}
