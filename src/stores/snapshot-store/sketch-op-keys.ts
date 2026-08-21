// sketch-op-keys.ts — the ONE definition of the sketch generate-op map keys.
//
// Lives in its own leaf module (no store imports) because both the slice that WRITES the map and
// the selectors that READ it need the exact same format. Duplicating the template literal would
// fail silently: a changed separator makes every lookup miss, so per-row spinners just stop
// appearing — no type error, no test failure unless one specifically covers it.

import type { VariantRef } from '@/types/sketch';
import type { VariantOpKey, VariantSheetGenerateOp } from './types';

/** Key for `variantSheetGenerateOps` — one op per (kind, entity, variant). ⚡REV 2026-08-21 — the key
 *  does NOT include the group (a variant is identified by kind+entity+variant), so callers that only
 *  hold those three (e.g. the per-row status selector) need not resolve the entity's group. */
export function variantOpKey(ref: Pick<VariantRef, 'kind' | 'entityKey' | 'variantKey'>): VariantOpKey {
  return `${ref.kind}|${ref.entityKey}|${ref.variantKey}`;
}

/**
 * Does this ENTITY already own an op (any of its variants)?
 *
 * Admission is per ENTITY even though the op map is keyed per variant. The persist grain is the
 * WHOLE entity node (rtype 3/4): `flushSketchEntityUnderLock` acquires one lock for the entity and
 * writes the whole node. Two variants of the same entity settling together would therefore be two
 * writers of one node — the later payload was snapshotted before the earlier one landed (whole-node
 * last-writer-wins drops a sheet), and the first chain's one-shot `releaseIfAcquired` can release
 * the shared lock out from under the second chain's in-flight save (`forbidden` → its raw sheet and
 * crops never persist, with a misleading "someone else is editing" toast).
 *
 * Keeping the map keyed per variant is still right — status/spinners resolve per row.
 */
export function hasOpForEntity(
  ops: Record<VariantOpKey, VariantSheetGenerateOp>,
  ref: Pick<VariantRef, 'kind' | 'entityKey'>,
): boolean {
  const prefix = `${ref.kind}|${ref.entityKey}|`;
  return Object.keys(ops).some((k) => k.startsWith(prefix));
}

/**
 * Ops actually RUNNING — an op that settled with an error is kept in the map only so its message can
 * be surfaced, and it is dropped by the notifications hook. Counting those would let one failure
 * permanently burn a concurrency slot (and, via the nav-guard, permanently block leaving the editor)
 * if the hook is ever unmounted.
 */
export function countActiveVariantOps(
  ops: Record<VariantOpKey, VariantSheetGenerateOp>,
): number {
  return Object.values(ops).filter((op) => !op.error).length;
}
