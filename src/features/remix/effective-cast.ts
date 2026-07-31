// effective-cast.ts — Pure computation of a remix's cast sets given the chosen
// casting presets. SHARED by the RemixConfigModal (CAST tab rows) and the
// createRemix clone pipeline — ONE resolver (`resolveRemixCastSets`), so modal
// preview and clone can never drift.
//
// ⚠️ Remixable ⊥ casting_slot (amend 2026-07-31): the swap gate
// (`book.remix.characters[].is_enabled`) and casting are ORTHOGONAL axes, so
// the resolver returns TWO sets:
//   - visualCastKeys: who is visually present after casting (NO gate) — clones
//     `remixes.characters[]` (the content roster; tags/filters always resolve).
//   - swappableKeys:  enabledKeys ∩ visualCastKeys — the swap surface (CAST tab
//     rows, `remix_config.characters[]` purge, crop grouping, sprite seed).
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

export interface RemixCastSetsInput {
  storyPresets: RemixPresetChoice[];
  castingAxes: CastingAxis[];
  bookRemix: BookRemix;
  /** Order source — `snapshot.characters[].key` in snapshot order. */
  snapshotCharacterKeys: string[];
}

export interface RemixCastSets {
  /** Visual content roster — who is depicted after casting, NO swap gate.
   *  Clones `remixes.characters[]`. Snapshot order, deduped. */
  visualCastKeys: string[];
  /** `enabledKeys ∩ visualCastKeys` — the swap surface (CAST tab rows,
   *  `remix_config.characters[]` purge, crop grouping, sprite seed). */
  swappableKeys: string[];
}

/**
 * Resolve both cast sets for a remix, in `snapshot.characters[]` order
 * (dedupe natural).
 *
 * visual    = (snapshotKeys − replacedDefaults) ∪ chosenActors
 * swappable = visual.filter(enabled)
 */
export function resolveRemixCastSets(input: RemixCastSetsInput): RemixCastSets {
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
  const visualCastKeys = snapshotCharacterKeys.filter(
    (k) => !replaced.has(k) || chosen.has(k),
  );
  const swappableKeys = visualCastKeys.filter((k) => enabled.has(k));
  log.debug('resolveRemixCastSets', 'computed', {
    axisCount: castingAxes.length,
    enabledCount: enabled.size,
    chosenCount: chosen.size,
    replacedCount: replaced.size,
    visualCount: visualCastKeys.length,
    swappableCount: swappableKeys.length,
  });
  return { visualCastKeys, swappableKeys };
}

/** Convenience for the modal (CAST tab rows) — swap surface only. */
export function swappableCastKeys(input: RemixCastSetsInput): string[] {
  return resolveRemixCastSets(input).swappableKeys;
}

/**
 * Map each chosen actor key to the NARRATIVE name of the role it plays — the
 * name of the default actor it displaced. Casting only changes visuals, so the
 * story text still uses the displaced default's name; the text-swap engine uses
 * this map to pick the correct swap source for an actor row. Actants that keep
 * their default actor produce no entry (source = the character's own name).
 * Computed in-memory at create time — never persisted (text swap runs once).
 */
export function buildCastingNameMap(
  storyPresets: RemixPresetChoice[],
  castingAxes: CastingAxis[],
  snapshotCharacters: ReadonlyArray<{ key: string; name: string }>,
): Record<string, string> {
  const nameByKey = new Map(snapshotCharacters.map((c) => [c.key, c.name]));
  const map: Record<string, string> = {};
  for (const axis of castingAxes) {
    const chosenPreset = resolvePresetForAxis(axis, storyPresets);
    if (!chosenPreset) continue;
    const def = resolveDefaultPreset(axis);
    for (const cast of chosenPreset.actants) {
      if (cast.actor_type !== ACTOR_TYPE_CHARACTER) continue;
      const defCast = def?.actants.find((a) => a.actant_id === cast.actant_id);
      if (!defCast || defCast.actor_id === cast.actor_id) continue;
      const narrativeName = nameByKey.get(defCast.actor_id);
      if (!narrativeName) {
        log.warn('buildCastingNameMap', 'displaced default has no snapshot entry — skipped', {
          axisId: axis.id,
          actantId: cast.actant_id,
          defaultActorId: defCast.actor_id,
        });
        continue;
      }
      if (map[cast.actor_id] && map[cast.actor_id] !== narrativeName) {
        log.warn('buildCastingNameMap', 'actor cast into multiple roles — last write wins', {
          actorId: cast.actor_id,
          kept: narrativeName,
          dropped: map[cast.actor_id],
        });
      }
      map[cast.actor_id] = narrativeName;
    }
  }
  log.debug('buildCastingNameMap', 'built', {
    axisCount: castingAxes.length,
    entryCount: Object.keys(map).length,
  });
  return map;
}
