// materialize-casting.ts — Pure per-layer casting materialization for the remix
// clone. Resolves the actor a `casting_slot`-bearing image layer should render
// (5-step resolution) and COERCES that actor's flat `media_url` into a single
// `illustrations[]` entry, then DELETES the `casting_slot` from the clone.
//
// ⚠️ `casting_slot` is the SOLE authority for casting (chốt 2026-07-31). A layer
// WITHOUT a casting_slot is returned untouched — we never scan a plain layer's
// tags to infer an actor (see clone-builder.ts header + effective-cast.ts).
//
// 5-step actor resolution (illustration-structure.md → casting_slot spec):
//   1. axis   = casting_axes whose actant contains slot.actant_id
//   2. preset = resolvePresetForAxis(axis, storyPresets)  (reuse effective-cast)
//   3. cast   = preset.actants[actant_id]  (the chosen assignment)
//   4. entry  = slot.actors[cast.actor_id, cast.actor_type]  (its rendered media)
//   5. url    = entry.media_url ?? slot.actors[is_default].media_url ?? null
// Any miss → fall to the default actor media (tags then stay on the story actor).

import type { SpreadImage } from '@/types/spread-types';
import type { CastingAssignment, CastingAxis } from '@/types/editor';
import type { RemixPresetChoice } from '@/types/remix';
import type { Character } from '@/types/character-types';
import type { Illustration, Prop } from '@/types/prop-types';
import { resolvePresetForAxis } from '@/features/remix/effective-cast';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'RemixMaterializeCasting');

export interface MaterializeCastingContext {
  castingAxes: CastingAxis[];
  storyPresets: RemixPresetChoice[];
  snapshotCharacters: Character[];
  snapshotProps: Prop[];
}

export interface MaterializeCastedLayerResult {
  layer: SpreadImage;
  /** The chosen casting assignment WHEN a matching actor media entry was
   *  materialized; `null` when the layer had no casting_slot OR resolution fell
   *  back to the default actor. Drives whether tags get rewritten downstream. */
  resolvedActor: CastingAssignment | null;
}

/**
 * Materialize the casted actor onto ONE image layer in place (the layer is
 * already a structuredClone from the clone builder). Returns the resolved
 * assignment for tag rewrite, or `null` when there is nothing (or only a
 * default fallback) to rewrite to.
 */
export function materializeCastedLayer(
  layer: SpreadImage,
  ctx: MaterializeCastingContext,
): MaterializeCastedLayerResult {
  const slot = layer.casting_slot;
  if (!slot) return { layer, resolvedActor: null }; // plain layer — untouched

  const axis = ctx.castingAxes.find((a) =>
    a.actants.some((x) => x.id === slot.actant_id),
  );
  const preset = axis ? resolvePresetForAxis(axis, ctx.storyPresets) : null;
  const cast =
    preset?.actants.find((a) => a.actant_id === slot.actant_id) ?? null;
  const entry =
    cast != null
      ? slot.actors.find(
          (x) => x.id === cast.actor_id && x.actor_type === cast.actor_type,
        ) ?? null
      : null;

  if (!axis) {
    log.warn('materializeCastedLayer', 'axis not found for actant', {
      layerId: layer.id,
      actantId: slot.actant_id,
    });
  } else if (!preset) {
    log.warn('materializeCastedLayer', 'no preset for axis', {
      layerId: layer.id,
      axisId: axis.id,
    });
  } else if (!cast) {
    log.debug('materializeCastedLayer', 'preset does not cast actant → default actor', {
      layerId: layer.id,
      actantId: slot.actant_id,
    });
  } else if (!entry) {
    log.warn('materializeCastedLayer', 'actor has no media entry in slot → default actor', {
      layerId: layer.id,
      actorId: cast.actor_id,
    });
  }

  const url =
    entry?.media_url ??
    slot.actors.find((a) => a.is_default)?.media_url ??
    null;

  if (url) {
    const coerced: Illustration = {
      media_url: url,
      created_time: new Date().toISOString(),
      is_selected: true,
      type: 'created',
    };
    layer.illustrations = [coerced];
    // resolveEffectiveImageUrl prioritizes final_hires_media_url; set it so the
    // actor image wins over any stale snapshot hi-res URL carried by the clone.
    layer.final_hires_media_url = url;
  } else {
    log.warn('materializeCastedLayer', 'no actor media resolved → keep original media', {
      layerId: layer.id,
      actantId: slot.actant_id,
    });
  }

  delete layer.casting_slot;
  return { layer, resolvedActor: entry ? cast : null };
}
