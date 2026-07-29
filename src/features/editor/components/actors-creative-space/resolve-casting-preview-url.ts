// resolve-casting-preview-url.ts — PURE preview-URL resolver for the Actors
// display canvas (phase 06). No React / store imports so it stays unit-testable
// in isolation (phase 10).
//
// Given ONE playable image layer + the currently selected actor pair, decide:
//   1. Which media URL to show (the pair's casted actor media vs the layer's
//      normal effective URL).
//   2. Whether the layer is highlighted (belongs to the pair's actant).
//   3. The casting status badge to surface.
//
// 3 branches (design 02 §4.1–4.2):
//   - has entry     → actor already casted for this layer → entry.media_url, 'cast'
//   - no entry      → actant matches but actor not yet injected → default URL, 'not_generated'
//   - not highlighted (dangling / mismatched / no pair) → default URL, 'not_highlighted'
//
// `casting_slot.actors[].media_url` is a FLAT direct URL — no illustration chain
// (see spread-types.ts ItemCastingSlotActor).

import type { SpreadImage } from '@/types/spread-types';
import type { ActorPair } from '@/types/actors';
import { resolveEffectiveImageUrl } from '@/features/editor/components/shared-components';

/** Casting preview status for a single layer (badge state). 'error' is applied by
 *  the renderer on <img> load failure — never returned by this pure resolver. */
export type CastingPreviewStatus =
  | 'cast'
  | 'not_generated'
  | 'not_highlighted'
  | 'error';

export interface CastingPreviewResult {
  /** The URL to render in `<img src>`. May be undefined when the layer has no media at all. */
  url: string | undefined;
  status: CastingPreviewStatus;
  /** True only when the layer's casting actant matches the selected pair's actant
   *  → the overlay (dashed outline + chip) is drawn. */
  isHighlighted: boolean;
}

/**
 * Resolve the preview URL + status for one image layer against the selected pair.
 * Pure — no side effects, no React, no store access.
 */
export function resolveCastingPreviewUrl(
  layer: SpreadImage,
  selectedPair: ActorPair | null,
): CastingPreviewResult {
  const defaultUrl = resolveEffectiveImageUrl(layer);

  // No pair selected → plain canvas, nothing highlighted.
  if (!selectedPair) {
    return { url: defaultUrl, status: 'not_highlighted', isHighlighted: false };
  }

  const slot = layer.casting_slot;

  // Layer has no casting actant, or its actant differs from the pair → dangling /
  // mismatched → treat as not-casting (no highlight, normal effective URL).
  if (!slot || slot.actant_id !== selectedPair.actant_id) {
    return { url: defaultUrl, status: 'not_highlighted', isHighlighted: false };
  }

  // Layer belongs to the pair's actant → highlighted. Find the actor entry for
  // this exact (actor_id, actor_type). Present + has media → 'cast', else 'not_generated'.
  const entry = slot.actors?.find(
    (a) => a.id === selectedPair.actor_id && a.actor_type === selectedPair.actor_type,
  );

  if (entry?.media_url) {
    return { url: entry.media_url, status: 'cast', isHighlighted: true };
  }

  return { url: defaultUrl, status: 'not_generated', isHighlighted: true };
}
