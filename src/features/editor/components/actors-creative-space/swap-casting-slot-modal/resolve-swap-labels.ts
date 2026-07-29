// resolve-swap-labels.ts — PURE header-label resolver for the swap-casting-slot
// modal: `{actantName} → {actorName}` + owning axis. Reads the read-only casting
// config (actant + axis names) and the snapshot pools (actor name). No React /
// store imports.

import type { BookCastingSlot } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { ActorPair } from '@/types/actors';

export interface SwapLabels {
  actantName: string;
  actorName: string;
  axisName: string;
}

/** Resolve the modal header labels. Missing entities fall back to their id. */
export function resolveSwapLabels(
  castingSlot: BookCastingSlot | null | undefined,
  characters: Character[],
  props: Prop[],
  pair: ActorPair,
): SwapLabels {
  let actantName = pair.actant_id;
  let axisName = '';
  for (const axis of castingSlot?.casting_axes ?? []) {
    const actant = axis.actants.find((a) => a.id === pair.actant_id);
    if (actant) {
      actantName = actant.name;
      axisName = axis.name;
      break;
    }
  }
  const actorName =
    pair.actor_type === 1
      ? characters.find((c) => c.key === pair.actor_id)?.name ?? pair.actor_id
      : props.find((p) => p.key === pair.actor_id)?.name ?? pair.actor_id;
  return { actantName, actorName, axisName };
}
