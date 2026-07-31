// resolve-preview-casting.ts — PURE build-time casting resolver for Preview.
// No React / no store imports so it stays unit-testable in isolation.
//
// The Preview player renders `book.casting_slot` presets by resolving casting at
// the DATA layer (when we build `playableSpreads`), NOT in the render layer. That
// keeps PlayerCanvas / EditableImage / preload / GSAP casting-agnostic — the
// promise the spec calls "layer-agnostic".
//
// COLLAPSE-CHAIN decision (do not "fix" this later):
//   The render layer reads a layer's URL in two inconsistent places —
//     • EditableImage → resolveEffectiveImageUrl(image):
//         final_hires_media_url → illustrations[is_selected] → illustrations[0] → media_url
//     • preload (collect-spread-media) → reads ONLY img.media_url
//   To push a cast URL to BOTH without touching either layer, the build clone
//   writes the cast URL into `media_url` AND `final_hires_media_url` and clears
//   `illustrations`. This clone lives ONLY inside `playableSpreads` (never store /
//   never DB); the source SpreadImage object is left untouched.
//
// Resolution rule (spec: illustration-structure.md#casting_slot-spec) is 5 steps;
// a miss at ANY step falls back to the item's default actor media, and if that's
// missing too we return null → caller keeps the layer's normal effective-URL chain.
// Casting NEVER blanks a layer.

import type { CastingAxis } from '@/types/editor';
import type {
  BaseSpread,
  ItemCastingSlot,
  SpreadImage,
} from '@/types/spread-types';
import type { PlayableSpread } from '@/types/playable-types';
import { resolveDefaultPreset, findAssignment } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'PreviewCasting');

/** axisId → presetId. Only axes that resolve to a preset are present. */
export type EffectiveCastSelection = Record<string, string>;

// ── Effective selection (which preset is active per axis) ─────────────────────

/**
 * Resolve the effective preset per axis for the current play session.
 * Returns null (= "no casting") when the source is a remix OR no axes exist.
 * Axes with zero presets are skipped. Per axis: a valid user override wins,
 * else the axis default preset. `userSelectedPresets` is an OVERRIDE map (partial,
 * ephemeral) — never mutated here.
 */
export function resolveEffectiveCastSelection(
  activeRemixId: string | null,
  castingAxes: CastingAxis[],
  userSelectedPresets: Record<string, string>,
): EffectiveCastSelection | null {
  // Casting is frozen inside a remix (remix already materialized its cast).
  if (activeRemixId !== null) return null;
  if (castingAxes.length === 0) return null;

  const out: EffectiveCastSelection = {};
  for (const axis of castingAxes) {
    if (axis.presets.length === 0) continue; // nothing to resolve
    const overrideId = userSelectedPresets[axis.id];
    const override = overrideId
      ? axis.presets.find((p) => p.id === overrideId)
      : undefined;
    if (overrideId && !override) {
      // Stale override (preset deleted in Config). Silent fallback, no state prune.
      log.debug('resolveEffectiveCastSelection', 'stale override → default', {
        axisId: axis.id,
      });
    }
    const preset = override ?? resolveDefaultPreset(axis);
    if (preset) out[axis.id] = preset.id;
  }
  return out;
}

/**
 * Canonical, order-independent key for a selection. Sort by axisId, join
 * `<axisId>=<presetId>` with commas. Feeds `sessionId` so the same effective
 * cast always yields the same session (and a collaborator flipping is_default in
 * Config re-keys the session correctly).
 */
export function castKeyOf(
  selection: EffectiveCastSelection | null,
): string | null {
  if (!selection) return null;
  const keys = Object.keys(selection);
  if (keys.length === 0) return null;
  return keys
    .sort()
    .map((axisId) => `${axisId}=${selection[axisId]}`)
    .join(',');
}

// ── Actant → axis index (built once per build) ────────────────────────────────

/**
 * `actant_id` is unique per book, so an item's casting_slot only stores it (no
 * axis id). Build the reverse index once to avoid O(spreads × images × axes ×
 * actants) scanning.
 */
export function buildActantAxisIndex(
  castingAxes: CastingAxis[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const axis of castingAxes) {
    for (const actant of axis.actants) map.set(actant.id, axis.id);
  }
  return map;
}

/** Reader tolerance: the item's default actor media, else null (spec allows ONLY
 *  default fallback — never actors[0]). null ⇒ caller keeps normal chain. */
function fallbackDefaultActorUrl(slot: ItemCastingSlot): string | null {
  return slot.actors.find((a) => a.is_default)?.media_url ?? null;
}

/**
 * Resolve the casted media URL for one image's casting_slot against the effective
 * selection (5-step rule). Returns null when casting does not apply / cannot be
 * resolved → caller keeps the item's normal effective-URL chain.
 */
export function resolveCastedImageUrl(
  slot: ItemCastingSlot | undefined,
  actantAxisIndex: Map<string, string>,
  axisById: Map<string, CastingAxis>,
  selection: EffectiveCastSelection | null,
): string | null {
  if (!slot || selection === null) return null;

  const axisId = actantAxisIndex.get(slot.actant_id);
  if (!axisId) {
    log.warn('resolveCastedImageUrl', 'dangling actant → default actor', {
      actantId: slot.actant_id,
    });
    return fallbackDefaultActorUrl(slot);
  }

  const presetId = selection[axisId];
  const preset = axisById.get(axisId)?.presets.find((p) => p.id === presetId);
  if (!preset) return fallbackDefaultActorUrl(slot);

  const cast = findAssignment(preset, slot.actant_id);
  if (!cast) return fallbackDefaultActorUrl(slot); // preset does not cast this role

  const entry = slot.actors.find(
    (a) => a.id === cast.actor_id && a.actor_type === cast.actor_type,
  );
  if (!entry?.media_url) return fallbackDefaultActorUrl(slot); // actor not rendered yet

  return entry.media_url;
}

// ── Build playable spreads with casting applied ───────────────────────────────

/** Normalize a source spread into a PlayableSpread (animations always present).
 *  Matches the legacy inline map behavior when casting does not apply. */
function toBasePlayable(spread: BaseSpread): PlayableSpread {
  return { ...spread, animations: spread.animations ?? [] } as PlayableSpread;
}

/**
 * Build `playableSpreads` with casting collapsed into each image's URL fields.
 * When `selection === null` this is EXACTLY the legacy behavior (only normalize
 * `animations`). Only images whose URL actually changes are cloned; unchanged
 * images/spreads keep their reference to reduce churn for downstream memos.
 */
export function applyCastingToSpreads(
  spreads: BaseSpread[],
  castingAxes: CastingAxis[],
  selection: EffectiveCastSelection | null,
): PlayableSpread[] {
  if (selection === null) return spreads.map(toBasePlayable);

  const actantAxisIndex = buildActantAxisIndex(castingAxes);
  const axisById = new Map(castingAxes.map((a) => [a.id, a] as const));

  return spreads.map((spread) => {
    const images = spread.images;
    if (!images || images.length === 0) return toBasePlayable(spread);

    let changed = false;
    const nextImages = images.map((img) => {
      if (!img.casting_slot) return img;
      if (img.parametric_slot) {
        // Mutual exclusion is enforced on write; if both are present casting wins.
        log.warn('applyCastingToSpreads', 'both slots — casting wins', {
          imageId: img.id,
        });
      }
      const url = resolveCastedImageUrl(
        img.casting_slot,
        actantAxisIndex,
        axisById,
        selection,
      );
      if (!url) return img; // keep normal effective-URL chain
      changed = true;
      // COLLAPSE effective-URL chain (see file header). Write both URL fields and
      // drop illustrations so render + preload both see the cast URL.
      const next: SpreadImage = {
        ...img,
        media_url: url,
        final_hires_media_url: url,
        illustrations: undefined,
      };
      log.debug('applyCastingToSpreads', 'casted image', {
        imageId: img.id,
        hasUrl: true,
      });
      return next;
    });

    if (!changed) return toBasePlayable(spread);
    return { ...toBasePlayable(spread), images: nextImages };
  });
}
