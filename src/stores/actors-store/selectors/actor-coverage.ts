// actors-store/selectors/actor-coverage.ts — Coverage badge derive (README §4.4).
// For each pair: `total` = # illustration image layers whose casting_slot targets
// the pair's actant; `injected` = those whose casting_slot.actors[] already holds
// this pair's actor (id + type) with a non-empty media_url.
//
// PURE `computeActorCoverage` (O(spreads·images), indexes layers by actant once)
// + `useActorCoverage` hook that useMemos on the two STABLE raw store refs
// (illustration spreads + actorPairs) — never a freshly `.map()`-ed array
// (memory feedback_zustand_useshallow_nested_arrays).

import { useMemo } from 'react';
import type { BaseSpread } from '@/types/spread-types';
import type { ActorCoverage, ActorPair } from '@/types/actors';
import { useIllustrationSpreads } from '@/stores/snapshot-store/selectors';
import { useActorPairs } from '../selectors';

type ItemCastingSlot = NonNullable<BaseSpread['images'][number]['casting_slot']>;

/** Pure coverage compute. Reads `casting_slot` on illustration image layers. */
export function computeActorCoverage(
  spreads: BaseSpread[],
  pairs: ActorPair[],
): Record<string, ActorCoverage> {
  // Index casting-slot image layers by actant_id ONCE (avoid O(n·m)).
  const byActant = new Map<string, ItemCastingSlot[]>();
  for (const spread of spreads) {
    for (const image of spread.images) {
      const slot = image.casting_slot;
      if (!slot) continue;
      const list = byActant.get(slot.actant_id);
      if (list) list.push(slot);
      else byActant.set(slot.actant_id, [slot]);
    }
  }

  const result: Record<string, ActorCoverage> = {};
  for (const pair of pairs) {
    const slots = byActant.get(pair.actant_id) ?? [];
    let injected = 0;
    for (const slot of slots) {
      const hit = slot.actors.some(
        (a) =>
          a.id === pair.actor_id &&
          a.actor_type === pair.actor_type &&
          !!a.media_url,
      );
      if (hit) injected += 1;
    }
    result[pair.id] = { injected, total: slots.length };
  }
  return result;
}

/** Coverage per pair — memoized on the two stable raw refs. */
export function useActorCoverage(): Record<string, ActorCoverage> {
  const spreads = useIllustrationSpreads();
  const pairs = useActorPairs();
  return useMemo(() => computeActorCoverage(spreads, pairs), [spreads, pairs]);
}
