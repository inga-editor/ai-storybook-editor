// collab-sketch-stage-save-helper.ts — per-resource collab save seam for the SKETCH STAGES
// creative space (9th collab space, ADR-043 lineage). ONE grain only: the WHOLE stage node at
// STEP 1 / rtype 5, which the gateway resolver maps to `sketch.stages[key]` — base.styles[] AND
// every variant live INSIDE that node, so a single lock covers the entire stage (no new rtype,
// unlike the base space's rtype 11; the derived variants[base] clone is the SAME node → no
// second lock, no contention).
//
// Mirror of collab-sketch-variant-save-helper.ts with the kind dimension removed (stages are
// keyed by stageKey alone). Three consumers (batch-at-release model, ADR-043 Rev 2026-07-16):
//   • the component held-session (use-stage-lock-session) — cheap edits (text / pick / crop edit)
//     mutate the store under the hold; the session saves the whole node ONCE at release.
//   • the STAGE JOB slice (off-render) — flush-before-generate (API 12 is snapshot-reading) +
//     persist-after for every generate/re-cut chain (AI output must not wait for a release).
//   • `handleSelectCrop` (space root) — single-gesture pick whose held-session baseline is
//     captured too late to see it (H2) → direct flush, `releaseIfAcquired` default FALSE.
//
// ⚡ unified-item-save phase 3: `flushSketchStageUnderLock` now delegates to the engine's `ensureSaved`
// (solo/collab fork + lock lifecycle + rebase internalized); the pure resolver/payload exports are
// unchanged. `useSaveSessionStore` is imported dynamically at call time (cycle break).

import { type LockTarget } from '@/stores/resource-lock-store';
import type { SaveOutcome } from '@/stores/save-session-store/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CollabSketchStageSaveHelper');

/** Gateway resource_type for a sketch stage node — resolver `(step=1, rtype=5) → sketch.stages[key]`
 *  pre-exists in 04-save. ⚠️ Authz: the `stages` grant key exists under BOTH the sketch AND the
 *  illustration step → backend `assert_access_rights` must pin `steps.sketch.resources.stages`
 *  (verify in the 2-tab smoke — memory *rtype-authz-step-pin*). */
const STAGE_RESOURCE_TYPE = 5 as const;

/** crud audit enum: 3 = edit (stage nodes always pre-exist — seeded by import; the space never
 *  creates/deletes a stage). */
const ACTION_TYPE_EDIT = 3 as const;

/** STEP-1 LockTarget for one stage node (whole-node grain, not locale-scoped). */
export function resolveSketchStageLockTarget(stageKey: string): LockTarget {
  return { step: 1, resource_type: STAGE_RESOURCE_TYPE, resource_id: stageKey, locale: null };
}

/** Whole-node payload for the held-session `buildPayload` — `{action_type:3, patch, log:true}`
 *  (`log:true` emits the scope:'node' content-sync event so peers refetch the fresh node). */
export function buildSketchStagePayload(node: unknown): {
  action_type: 3;
  patch: unknown;
  log: true;
} {
  return { action_type: ACTION_TYPE_EDIT, patch: node, log: true };
}

export interface FlushSketchStageOptions {
  /** @deprecated IGNORED since unified-item-save phase 3 — the engine decides the lock lifecycle
   *  (held → keep; no session → one-shot). Kept only for call-site compatibility. */
  releaseIfAcquired?: boolean;
}

/**
 * Persist the WHOLE stage node — ⚡ unified-item-save phase 3: delegates to the save-session engine's
 * `ensureSaved('sketch-stage', stageKey)` (single solo/collab fork + lock lifecycle; held → save +
 * rebase; no session → one-shot acquire→save→release; solo → whole-snapshot flush). The engine reads
 * the FRESH node via the policy registry, so `node` is IGNORED. See the variant helper for the H2 note.
 *
 * @returns the engine `SaveOutcome` — the CALLER maps it to a toast (this helper no longer self-toasts).
 */
export async function flushSketchStageUnderLock(
  stageKey: string,
  _node?: unknown,
  _opts?: FlushSketchStageOptions,
): Promise<SaveOutcome> {
  const { useSaveSessionStore } = await import('@/stores/save-session-store');
  log.debug('flushSketchStageUnderLock', 'ensureSaved (engine)', { stageKey });
  return useSaveSessionStore.getState().ensureSaved('sketch-stage', stageKey);
}
