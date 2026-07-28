// item-slot-seed.ts — Seed builders for ItemSlotModal init: resolve the default
// actor and clone the item's current media into the freshly created slot.
// Pure: no React, no store, no throw. Split out of item-slot-logic.ts to stay
// under the 500-LOC file budget. Design ref: 19-item-slot-modal.md §2.4.

import type { BookCastingSlot, CastingActorType } from '@/types/editor';
import type { Illustration } from '@/types/prop-types';
import type { ItemCastingSlot, ItemParametricSlot, SpreadImage, SpreadTag } from '@/types/spread-types';
import {
  ACTOR_TYPE_CHARACTER,
  ACTOR_TYPE_PROP,
  normalizeCastingSlot,
  resolveDefaultPreset,
} from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { resolveEffectiveImageUrl } from '@/features/editor/components/shared-components/resolve-effective-image-url';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ItemSlotSeed');

/** Resolved actor used to seed a casting slot. */
export interface SlotActorRef {
  id: string;
  actor_type: CastingActorType;
}

/**
 * Default actor for a casting seed: the axis' default preset assignment, then
 * the item's first character/prop tag ("who is rendered here"), then null.
 * Runs on every render while the modal is open → `debug` only, never `warn`.
 */
export function resolveDefaultActor(
  castingSlot: BookCastingSlot | null,
  axisId: string | null,
  actantId: string | null,
  tags: SpreadTag[] | undefined,
): SlotActorRef | null {
  if (!axisId || !actantId) return null;

  const normalized = normalizeCastingSlot(castingSlot);
  const axis = normalized.casting_axes.find((a) => a.id === axisId) ?? null;
  if (!axis) {
    log.debug('resolveDefaultActor', 'axis not found', { axisId });
  }
  const preset = resolveDefaultPreset(axis);
  const cast = preset?.actants.find((a) => a.actant_id === actantId) ?? null;
  if (cast) return { id: cast.actor_id, actor_type: cast.actor_type };

  const tag = tags?.find((t) => t.type === 'character' || t.type === 'prop') ?? null;
  if (tag) {
    log.debug('resolveDefaultActor', 'fell back to item tag', { actantId, tagType: tag.type });
    return {
      id: tag.object_key,
      actor_type: tag.type === 'character' ? ACTOR_TYPE_CHARACTER : ACTOR_TYPE_PROP,
    };
  }

  log.debug('resolveDefaultActor', 'no preset cast and no usable tag', { axisId, actantId });
  return null;
}

/**
 * Seed the parametric slot with the item's current media as the default value.
 * Clones the SELECTED Illustration Entry (falling back to the first one) so
 * `type` / `original_url` / `ai_request_id` survive — provenance of the source
 * image must not be lost — but OVERRIDES `media_url` with `effectiveUrl`, which
 * resolves `final_hires_media_url` first: an upscaled item must seed the hires
 * pixels, not the pre-upscale ones. This also keeps parametric and casting seeds
 * pointing at the exact same picture (buildCastingSeed stores `effectiveUrl`
 * flat). Only when the item has no entry at all is a fresh `created` entry
 * minted from that same URL.
 *
 * `effectiveUrl` should be the SAME value the caller fed to resolveSlotBlockers,
 * so the seed can never disagree with the check that gated it; when omitted it
 * falls back to the entry's own `media_url` (and to resolveEffectiveImageUrl(item)
 * on the no-entry path).
 */
export function buildParametricSeed(
  item: SpreadImage,
  key: string,
  value: string,
  effectiveUrl?: string,
): ItemParametricSlot {
  const source =
    item.illustrations?.find((i) => i.is_selected) ?? item.illustrations?.[0] ?? null;

  let seeded: Illustration;
  if (source) {
    seeded = { ...source, media_url: effectiveUrl ?? source.media_url, is_selected: true };
  } else {
    const url = effectiveUrl ?? resolveEffectiveImageUrl(item);
    if (!url) {
      log.warn('buildParametricSeed', 'item has no media, seeding empty url', { key });
    }
    seeded = {
      type: 'created',
      media_url: url ?? '',
      created_time: new Date().toISOString(),
      is_selected: true,
    };
  }

  return { key, values: [{ value, is_default: true, illustrations: [seeded] }] };
}

/**
 * Seed the casting slot with one actor holding the item's current media.
 * `media_url` is stored FLAT (no Illustration Entry) per #casting_slot-spec.
 */
export function buildCastingSeed(
  actantId: string,
  actor: SlotActorRef,
  effectiveUrl: string,
): ItemCastingSlot {
  return {
    actant_id: actantId,
    actors: [
      { id: actor.id, actor_type: actor.actor_type, media_url: effectiveUrl, is_default: true },
    ],
  };
}
