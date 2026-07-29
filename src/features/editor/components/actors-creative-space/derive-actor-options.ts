// derive-actor-options.ts — PURE derive of the actor dropdown options for the
// AddActorModal cascade (axis → preset → actant → actor). No React, no store —
// phase 10 unit-tests this in isolation.
//
// READ-ONLY over `casting_slot`: a combination absent from every preset never
// appears. Options carry a disabled reason so the UI greys them out (never hides
// — project rule never-hide-disabled-UI).
//
// Design ref: ai-storybook-design/component/editor-page/actors-creative-space/
//             03-add-actor-modal.md §4/§7 + README §3.3.

import type { BookCastingSlot, CastingActorType } from '@/types/editor';
import type { ActorPair, ActorType } from '@/types/actors';

/** Minimal entity shape for name resolution — satisfied by snapshot
 *  `Character[]` / `Prop[]` (both carry `key` + `name`). Kept structural so the
 *  helper stays decoupled from the concrete snapshot types. */
export interface ActorEntityRef {
  key: string;
  name: string;
}

export type ActorOptionDisabledReason =
  | 'already_added'
  | 'current_default'
  | 'deleted';

export interface ActorOption {
  actorId: string;
  actorType: ActorType;
  /** Resolved entity name, or the `@key` fallback when the entity is gone. */
  label: string;
  /** null when the entity resolves; 'deleted' when it does not. */
  resolved: boolean;
  /** Presets (names) that contain this mapping — shown as chips in All-presets
   *  mode. Empty for the single-preset path. */
  sourcePresets: string[];
  disabledReason: ActorOptionDisabledReason | null;
}

export const ACTOR_OPTION_DISABLED_LABEL: Record<ActorOptionDisabledReason, string> = {
  already_added: 'Already added',
  current_default: 'Current default, nothing to swap',
  deleted: '(deleted)',
};

const ACTOR_TYPE_CHARACTER: CastingActorType = 1;

function resolveEntity(
  characters: ActorEntityRef[],
  props: ActorEntityRef[],
  actorId: string,
  actorType: ActorType,
): ActorEntityRef | undefined {
  const pool = actorType === ACTOR_TYPE_CHARACTER ? characters : props;
  return pool.find((e) => e.key === actorId);
}

/**
 * The actor a preset binds to `actantId`. V2 source (Validation Session 1) =
 * the axis's DEFAULT preset mapping for this actant. `null` when the default
 * preset does not cast this actant (edge — V2 skipped for it).
 */
export function defaultActorOfActant(
  castingSlot: BookCastingSlot,
  axisId: string,
  actantId: string,
): { actorId: string; actorType: ActorType } | null {
  const axis = castingSlot.casting_axes.find((a) => a.id === axisId);
  if (!axis) return null;
  const defaultPreset =
    axis.presets.find((p) => p.is_default) ?? axis.presets[0] ?? null;
  if (!defaultPreset) return null;
  const mapping = defaultPreset.actants.find((m) => m.actant_id === actantId);
  return mapping
    ? { actorId: mapping.actor_id, actorType: mapping.actor_type }
    : null;
}

/**
 * Derive the actor options for one (axis, preset, actant) selection.
 * - `presetId != null` → the actant's mapping in THAT preset only (≤ 1 option).
 * - `presetId == null` ("All presets", default) → union of the actant's mapping
 *   across every preset, deduped by (actor_id, actor_type).
 */
export function deriveActorOptions(args: {
  castingSlot: BookCastingSlot;
  axisId: string | null;
  presetId: string | null;
  actantId: string | null;
  actorPairs: ActorPair[];
  characters: ActorEntityRef[];
  props: ActorEntityRef[];
}): ActorOption[] {
  const { castingSlot, axisId, presetId, actantId, actorPairs, characters, props } = args;
  if (!axisId || !actantId) return [];

  const axis = castingSlot.casting_axes.find((a) => a.id === axisId);
  if (!axis) return [];

  const dflt = defaultActorOfActant(castingSlot, axisId, actantId);

  // Collect candidate mappings + which presets contain each (union path).
  interface Candidate {
    actorId: string;
    actorType: ActorType;
    sourcePresets: string[];
  }
  const byKey = new Map<string, Candidate>();
  const presetScope =
    presetId != null
      ? axis.presets.filter((p) => p.id === presetId)
      : axis.presets;

  for (const preset of presetScope) {
    for (const m of preset.actants) {
      if (m.actant_id !== actantId) continue;
      const key = `${m.actor_id}|${m.actor_type}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.sourcePresets.push(preset.name);
      } else {
        byKey.set(key, {
          actorId: m.actor_id,
          actorType: m.actor_type,
          // Single-preset path carries no chips; union path lists sources.
          sourcePresets: presetId != null ? [] : [preset.name],
        });
      }
    }
  }

  return Array.from(byKey.values(), (c) => {
    const entity = resolveEntity(characters, props, c.actorId, c.actorType);
    const hasRow = actorPairs.some(
      (p) =>
        p.actant_id === actantId &&
        p.actor_id === c.actorId &&
        p.actor_type === c.actorType,
    );
    const isDefault =
      dflt != null && dflt.actorId === c.actorId && dflt.actorType === c.actorType;

    let disabledReason: ActorOptionDisabledReason | null = null;
    if (!entity) disabledReason = 'deleted';
    else if (hasRow) disabledReason = 'already_added';
    else if (isDefault) disabledReason = 'current_default';

    return {
      actorId: c.actorId,
      actorType: c.actorType,
      label: entity?.name?.trim() ? entity.name : `@${c.actorId}`,
      resolved: !!entity,
      sourcePresets: c.sourcePresets,
      disabledReason,
    };
  });
}
