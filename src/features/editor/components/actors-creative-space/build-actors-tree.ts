// build-actors-tree.ts — PURE derive of the 4-level Actors sidebar tree
// (axis → preset → actant → row) from `book.casting_slot` (READ-ONLY) joined with
// the `actors` rows. No React, no store imports — phase 10 unit-tests this in
// isolation.
//
// Design ref: ai-storybook-design/component/editor-page/actors-creative-space/
//             01-actors-sidebar.md §4 + README §4.1/§4.8.
//
// Complexity: O(actants + mappings + pairs) — the pair index is a single Map so
// row → pair lookup is O(1); we never nest `find` over `actorPairs`.

import type { BookCastingSlot, CastingAssignment } from '@/types/editor';
import type { ActorPair, ActorType, AddActorInput } from '@/types/actors';
import { defaultActorOfActant } from './derive-actor-options';

/** A row backed by a real `actors` row (has a `pairId`). Shared across presets:
 *  the SAME `pairId` can appear in N preset rows — select/coverage stay unified. */
export interface PairTreeRow {
  kind: 'pair';
  pairId: string;
  actantId: string;
  /** Actant display name — rendered INLINE on the row ("Younger → Kaka"); the
   *  sidebar no longer draws a separate actant heading level (1 actant casts 1
   *  actor per preset, so the extra level was pure noise). */
  actantName: string;
  actorId: string;
  actorType: ActorType;
}

/** A casting mapping that has NO `actors` row yet — muted "(no flow)" + [+ Add].
 *  `prefill` pre-selects all 4 cascade fields in the AddActorModal (phase 07).
 *  `isDefaultActor` = this actor is the actant's story default (the axis default
 *  preset binds it) ⇒ swapping to itself is a no-op ("nothing to swap"), so the
 *  [+ Add] affordance is gated off (parity with the modal's disabled option). */
export interface UncastTreeRow {
  kind: 'uncast';
  actantId: string;
  /** Actant display name — inline row label (see PairTreeRow.actantName). */
  actantName: string;
  actorId: string;
  actorType: ActorType;
  isDefaultActor: boolean;
  prefill: AddActorInput;
}

/** A pair whose actant no longer exists in ANY axis (removed from casting config).
 *  Rendered "(deleted)" + only [🗑] — never hidden into dead data. */
export interface DanglingTreeRow {
  kind: 'dangling';
  pairId: string;
  actantId: string;
  actorId: string;
  actorType: ActorType;
}

export type ActorsTreeRow = PairTreeRow | UncastTreeRow | DanglingTreeRow;

export interface ActantGroup {
  actantId: string;
  actantName: string;
  rows: ActorsTreeRow[]; // pair | uncast
}

export interface PresetGroup {
  presetId: string;
  presetName: string;
  isDefault: boolean;
  actants: ActantGroup[];
}

export interface AxisGroup {
  axisId: string;
  axisName: string;
  presets: PresetGroup[];
  /** Pairs whose actant belongs to THIS axis but no preset mapping references
   *  the exact (actant, actor, type) — still a valid, openable pair row. */
  unassigned: PairTreeRow[];
}

export interface ActorsTree {
  axes: AxisGroup[];
  /** Pairs whose actant is in NO axis (actant removed from casting config). */
  danglingOrphans: DanglingTreeRow[];
}

/** Composite index key for a casting mapping ↔ `actors` row. */
function pairKey(actantId: string, actorId: string, actorType: ActorType): string {
  return `${actantId}|${actorId}|${actorType}`;
}

/**
 * Derive the sidebar tree. Order follows `casting_slot` (axes → presets →
 * `preset.actants[]`); pairs not referenced by any mapping fall into the axis
 * `unassigned` bucket, or `danglingOrphans` if their actant is gone entirely.
 */
export function buildActorsTree(
  castingSlot: BookCastingSlot,
  actorPairs: ActorPair[],
): ActorsTree {
  // 1) Index every actors row by (actant, actor, type) for O(1) mapping lookup.
  const pairIndex = new Map<string, ActorPair>();
  for (const p of actorPairs) {
    pairIndex.set(pairKey(p.actant_id, p.actor_id, p.actor_type), p);
  }

  const usedPairIds = new Set<string>();
  // First axis that owns each actant — decides where an unassigned pair lands.
  // Carries the actant name too so unassigned rows get their inline label.
  const actantToAxis = new Map<string, { axisId: string; actantName: string }>();

  const axes: AxisGroup[] = [];
  for (const axis of castingSlot.casting_axes) {
    const actantById = new Map(axis.actants.map((a) => [a.id, a]));
    for (const a of axis.actants) {
      if (!actantToAxis.has(a.id)) {
        actantToAxis.set(a.id, { axisId: axis.id, actantName: a.name });
      }
    }

    // Default actor per actant (memoized) — the actor the axis's DEFAULT preset
    // binds. An uncast row matching it is a self-swap ("nothing to swap"); the UI
    // greys its [+ Add]. Single source of truth: derive-actor-options helper.
    const defaultKeyCache = new Map<string, string | null>();
    const isDefaultActor = (actantId: string, actorId: string, actorType: ActorType): boolean => {
      let key = defaultKeyCache.get(actantId);
      if (key === undefined) {
        const d = defaultActorOfActant(castingSlot, axis.id, actantId);
        key = d ? `${d.actorId}|${d.actorType}` : null;
        defaultKeyCache.set(actantId, key);
      }
      return key === `${actorId}|${actorType}`;
    };

    const presets: PresetGroup[] = axis.presets.map((preset) => {
      // Group mappings by actant_id, preserving first-seen order.
      const groupsMap = new Map<string, CastingAssignment[]>();
      for (const m of preset.actants) {
        const list = groupsMap.get(m.actant_id);
        if (list) list.push(m);
        else groupsMap.set(m.actant_id, [m]);
      }

      const actantGroups: ActantGroup[] = [];
      for (const [actantId, mappings] of groupsMap) {
        const actant = actantById.get(actantId);
        if (!actant) continue; // mapping references an unknown actant — skip (normalize drops these)

        const rows: ActorsTreeRow[] = mappings.map((m) => {
          const pair = pairIndex.get(pairKey(m.actant_id, m.actor_id, m.actor_type));
          if (pair) {
            usedPairIds.add(pair.id);
            return {
              kind: 'pair',
              pairId: pair.id,
              actantId,
              actantName: actant.name,
              actorId: m.actor_id,
              actorType: m.actor_type,
            };
          }
          return {
            kind: 'uncast',
            actantId,
            actantName: actant.name,
            actorId: m.actor_id,
            actorType: m.actor_type,
            isDefaultActor: isDefaultActor(actantId, m.actor_id, m.actor_type),
            prefill: {
              axisId: axis.id,
              presetId: preset.id,
              actantId,
              actorId: m.actor_id,
              actorType: m.actor_type,
            },
          };
        });

        actantGroups.push({ actantId, actantName: actant.name, rows });
      }

      return {
        presetId: preset.id,
        presetName: preset.name,
        isDefault: preset.is_default,
        actants: actantGroups,
      };
    });

    axes.push({ axisId: axis.id, axisName: axis.name, presets, unassigned: [] });
  }

  // 2) Second pass — place pairs not referenced by any preset mapping.
  const axisById = new Map(axes.map((ax) => [ax.axisId, ax]));
  const danglingOrphans: DanglingTreeRow[] = [];
  for (const p of actorPairs) {
    if (usedPairIds.has(p.id)) continue;
    const owner = actantToAxis.get(p.actant_id);
    if (owner) {
      axisById.get(owner.axisId)!.unassigned.push({
        kind: 'pair',
        pairId: p.id,
        actantId: p.actant_id,
        actantName: owner.actantName,
        actorId: p.actor_id,
        actorType: p.actor_type,
      });
    } else {
      danglingOrphans.push({
        kind: 'dangling',
        pairId: p.id,
        actantId: p.actant_id,
        actorId: p.actor_id,
        actorType: p.actor_type,
      });
    }
  }

  return { axes, danglingOrphans };
}
