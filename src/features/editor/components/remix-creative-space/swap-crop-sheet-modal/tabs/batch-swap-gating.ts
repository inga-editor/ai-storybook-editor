// batch-swap-gating.ts — Pure swap-precondition resolver for the Batches tab.
//
// Extracted from batches-tab.tsx so the gating logic (which characters in a
// batch's lineup still lack a generated visual_swap_url) is unit-testable
// without rendering. The tab wires the read-only `useRemixVariants` projection
// into these pure functions.
//
// CONTRACT (spec §7.1/§7.2): a batch can only be swapped when EVERY enabled
// CHARACTER token in its lineup already has a persisted `visual_swap_url`
// (generated in the Variants tab). Props and disabled subjects do NOT gate —
// only enabled characters of the remix projection count.

import type { RemixBatch, RemixVariantEntity } from '@/types/remix';
import { batchLineupTokens } from '@/types/remix';

/** Split a lineup token `${object_key}/${variant_key}` at the FIRST slash.
 *  object/variant keys are slugs that never contain `/`. */
function splitToken(token: string): { objectKey: string; variantKey: string } | null {
  const slash = token.indexOf('/');
  if (slash < 0) return null;
  return { objectKey: token.slice(0, slash), variantKey: token.slice(slash + 1) };
}

/** True when a lineup token references a SWAPPABLE CHARACTER of the remix —
 *  the variant projection (`useRemixVariants`) only spans the swappable set
 *  (`remix_config.characters[]` membership; amend 2026-07-31 — the roster
 *  itself is wider). Props / unknown keys → false (they don't gate the swap). */
export function isEnabledCharacterToken(
  token: string,
  entities: RemixVariantEntity[],
): boolean {
  const parts = splitToken(token);
  if (!parts) return false;
  return entities.some((e) => e.type === 'character' && e.key === parts.objectKey);
}

/** Resolve the persisted `visual_swap_url` for a lineup token via
 *  entity → variant. Returns `null` when the entity/variant is unknown or the
 *  variant has not been generated yet. */
export function resolveVisualSwapUrl(
  token: string,
  entities: RemixVariantEntity[],
): string | null {
  const parts = splitToken(token);
  if (!parts) return null;
  const entity = entities.find((e) => e.key === parts.objectKey);
  if (!entity) return null;
  const node = entity.variants.find((v) => v.variantKey === parts.variantKey);
  return node?.visualSwapUrl ?? null;
}

/** The enabled-CHARACTER lineup tokens of a batch that still lack a generated
 *  visual_swap_url. Empty → the character precondition for swap is satisfied.
 *  Props and disabled subjects are excluded (they never appear here). */
export function missingCharRefs(
  batch: RemixBatch,
  entities: RemixVariantEntity[],
): string[] {
  return batchLineupTokens(batch)
    .filter((t) => isEnabledCharacterToken(t, entities))
    .filter((t) => resolveVisualSwapUrl(t, entities) == null);
}
