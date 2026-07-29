// seed-initial-actor-batch.ts — PURE builder for the actors Crops (mixes) stage
// batch-1 seed. Walks the playable illustration layers and lifts every layer
// whose `casting_slot` targets the pair's actant into a `CropRef` (the store's
// `addStageBatch` then packs + persists them via the shared native-px batch
// builder — DRY, one batch builder). No React / store imports → phase-10
// unit-testable in isolation.
//
// media_url priority (design 04 §4): the layer's DEFAULT casting actor media
// (the currently-shown cast) → else the layer's normal effective URL. The swap
// job resolves the TARGET actor's reference from the snapshot server-side, so the
// seed only needs the SOURCE image.
//
// SECURITY: never log media_url (crops are PII likenesses).

import type { BaseSpread } from '@/types/spread-types';
import type { ActorPair } from '@/types/actors';
import type { CropRef } from '@/stores/actors-store';
import { resolveEffectiveImageUrl } from '@/features/editor/components/shared-components';

/**
 * Build the Crops-stage seed crop-refs for `pair` from the snapshot `spreads`.
 * Returns `null` when NO playable layer casts the pair's actant (→ modal empty
 * state, never an empty batch). A layer with a matching actant but no resolvable
 * media is skipped (cannot seed a crop without a URL).
 */
export function seedInitialActorBatch(
  pair: ActorPair,
  spreads: BaseSpread[],
): CropRef[] | null {
  const refs: CropRef[] = [];

  for (const spread of spreads) {
    for (const layer of spread.images) {
      const slot = layer.casting_slot;
      if (!slot || slot.actant_id !== pair.actant_id) continue;

      const defaultEntry = slot.actors?.find((a) => a.is_default);
      const mediaUrl = defaultEntry?.media_url ?? resolveEffectiveImageUrl(layer);
      if (!mediaUrl) continue;

      refs.push({
        spread_id: spread.id,
        id: layer.id,
        media_url: mediaUrl,
        // Clone tags — the batch owns its own snapshot (never aliases the layer).
        tags: layer.tags ? [...layer.tags] : [],
        // Layer geometry is the native-piece dim estimate (composer rescales
        // defensively — packed with absolutePx:true by the store builder).
        nativeDim: { w: layer.geometry.w, h: layer.geometry.h },
      });
    }
  }

  return refs.length === 0 ? null : refs;
}
