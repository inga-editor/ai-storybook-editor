// effective-cast.ts — Pure computation of a remix's EFFECTIVE character cast
// given the chosen casting presets. SHARED by the RemixConfigModal (CAST tab
// rows) and the createRemix clone pipeline — ONE export (`effectiveCastKeys`),
// so modal preview and clone can never drift.
//
// ⚠️ NO appearance-check (chốt 2026-07-31). The design's old "scan plain-layer
// tags before dropping a replaced default actor" mechanism is REMOVED: an item's
// tags[] only ever reference the story's ORIGINAL actor, never a preset's actor,
// so a tag scan can't enumerate an actor's images. `book.casting_slot` is the
// SOLE authority for casting; a missing casting_slot is an admin data bug fixed
// upstream, never patched here. DO NOT re-add an `appearsInPlainLayers` param or
// any tag-scanning variant.

import type { BookRemix } from '@/types/editor';
import type { CastingAxis, CastingPreset } from '@/types/editor';
import type { RemixPresetChoice } from '@/types/remix';
import {
  ACTOR_TYPE_CHARACTER,
  resolveDefaultPreset,
} from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'RemixEffectiveCast');

/**
 * Resolve the preset applied to an axis for a given set of story choices.
 * Falls back to the axis default preset when the choice entry is missing or its
 * `preset_id` no longer exists (dangling). `null` only when the axis has zero
 * presets.
 */
export function resolvePresetForAxis(
  axis: CastingAxis,
  storyPresets: RemixPresetChoice[],
): CastingPreset | null {
  const entry = storyPresets.find((p) => p.axis_id === axis.id);
  const chosen = axis.presets.find((p) => p.id === entry?.preset_id);
  if (!chosen) {
    log.debug('resolvePresetForAxis', 'preset entry missing/dangling → default', {
      axisId: axis.id,
      hasEntry: entry !== undefined,
    });
    return resolveDefaultPreset(axis);
  }
  return chosen;
}

export interface CollectCastResult {
  /** Actor keys cast by the chosen presets (actor_type=1 only, dangling skipped). */
  chosenActors: string[];
  /** Default-preset actor keys displaced because a different actor was chosen
   *  for the same actant — removed from the cast UNCONDITIONALLY. */
  replacedDefaults: string[];
}

/**
 * Walk every axis with its chosen preset, collecting the character actors it
 * casts and the default actors those choices displace. Prop actors
 * (actor_type=2) are ignored (props are not remix-swappable). An actor whose key
 * is absent from the snapshot is skipped with a `warn` (soft-fail — never blocks
 * remix creation).
 */
export function collectCastActors(
  castingAxes: CastingAxis[],
  storyPresets: RemixPresetChoice[],
  snapshotCharacterKeys: string[],
): CollectCastResult {
  const keySet = new Set(snapshotCharacterKeys);
  const chosenActors: string[] = [];
  const replacedDefaults: string[] = [];

  for (const axis of castingAxes) {
    const chosen = resolvePresetForAxis(axis, storyPresets);
    if (!chosen) continue; // axis with zero presets
    const def = resolveDefaultPreset(axis);
    for (const cast of chosen.actants) {
      if (cast.actor_type !== ACTOR_TYPE_CHARACTER) continue;
      if (!keySet.has(cast.actor_id)) {
        log.warn('collectCastActors', 'dangling actor, skipped', {
          axisId: axis.id,
          presetId: chosen.id,
          actorId: cast.actor_id,
        });
        continue; // soft-fail — a bad slot must not block the whole remix
      }
      chosenActors.push(cast.actor_id);
      const defCast = def?.actants.find((a) => a.actant_id === cast.actant_id);
      if (defCast && defCast.actor_id !== cast.actor_id) {
        replacedDefaults.push(defCast.actor_id); // dropped VÔ ĐIỀU KIỆN
      }
    }
  }
  return { chosenActors, replacedDefaults };
}

export interface EffectiveCastInput {
  storyPresets: RemixPresetChoice[];
  castingAxes: CastingAxis[];
  bookRemix: BookRemix;
  /** Order source — `snapshot.characters[].key` in snapshot order. */
  snapshotCharacterKeys: string[];
}

/**
 * The effective character cast for a remix: the book-enabled characters that
 * survive the chosen presets, in `snapshot.characters[]` order (dedupe natural).
 *
 * candidate = (snapshotKeys − replacedDefaults) ∪ chosenActors
 * result    = snapshotKeys.filter(k => enabled(k) ∧ candidate(k))
 */
export function effectiveCastKeys(input: EffectiveCastInput): string[] {
  const { storyPresets, castingAxes, bookRemix, snapshotCharacterKeys } = input;
  const enabled = new Set(
    bookRemix.characters.filter((c) => c.is_enabled).map((c) => c.key),
  );
  const { chosenActors, replacedDefaults } = collectCastActors(
    castingAxes,
    storyPresets,
    snapshotCharacterKeys,
  );
  const replaced = new Set(replacedDefaults);
  const chosen = new Set(chosenActors);
  // Iterate snapshot order → preserves order + dedupes (each key appears once).
  const keys = snapshotCharacterKeys.filter(
    (k) => enabled.has(k) && (!replaced.has(k) || chosen.has(k)),
  );
  log.debug('effectiveCastKeys', 'computed', {
    axisCount: castingAxes.length,
    enabledCount: enabled.size,
    chosenCount: chosen.size,
    replacedCount: replaced.size,
    resultCount: keys.length,
  });
  return keys;
}
