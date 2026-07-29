// actor-visual-precondition.ts — PURE Crops-tab precondition (design 04 §4):
// the swap can only run when the pair's TARGET actor has resolvable artwork in
// the snapshot (the swap reference). Backend still enforces this (enqueue → 422
// REFERENCE_IMAGE_MISSING); this is a UX gate to avoid a doomed job.
//
// No React / store imports → phase-10 unit-testable in isolation.

import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { Illustration } from '@/types/prop-types';
import type { ActorPair } from '@/types/actors';

/** Minimal snapshot view the precondition needs — the two casting entity pools. */
export interface ActorVisualSnapshot {
  characters: Character[];
  props: Prop[];
}

/** True when a variant carries a resolvable illustration URL (selected → [0]). */
function variantHasImage(variant: { illustrations: Illustration[] }): boolean {
  const url =
    variant.illustrations?.find((i) => i.is_selected)?.media_url ??
    variant.illustrations?.[0]?.media_url;
  return !!url;
}

/**
 * Does the pair's actor entity have any usable visual? Resolves the entity by
 * `key` (character for actor_type 1, prop for 2). Returns false when the entity
 * is missing (deleted). Otherwise true when the base variant (type 0) OR any
 * variant has an effective-URL image.
 */
export function actorHasVisual(
  snapshot: ActorVisualSnapshot,
  pair: ActorPair,
): boolean {
  const entity =
    pair.actor_type === 1
      ? snapshot.characters.find((c) => c.key === pair.actor_id)
      : snapshot.props.find((p) => p.key === pair.actor_id);
  if (!entity) return false;
  return entity.variants.some(variantHasImage);
}
