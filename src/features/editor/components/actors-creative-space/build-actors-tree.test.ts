// build-actors-tree.test.ts — 4-level tree derive: shared pair across presets,
// uncast row, unassigned bucket, dangling orphan, and axis/preset ordering.

import { describe, expect, it } from 'vitest';
import type { BookCastingSlot } from '@/types/editor';
import type { ActorPair } from '@/types/actors';
import { buildActorsTree } from './build-actors-tree';
import castingSlotJson from './__fixtures__/casting-slot.json';
import actorPairsJson from './__fixtures__/actor-pairs.json';

const castingSlot = castingSlotJson as BookCastingSlot;
const actorPairs = actorPairsJson as ActorPair[];

describe('buildActorsTree', () => {
  const tree = buildActorsTree(castingSlot, actorPairs);

  it('preserves axis then preset order from casting_slot', () => {
    expect(tree.axes.map((a) => a.axisId)).toEqual(['axis-1', 'axis-2']);
    expect(tree.axes[0].presets.map((p) => p.presetId)).toEqual([
      'preset-cat',
      'preset-dog',
      'preset-bird',
    ]);
  });

  it('reuses the SAME pairId for a pair shared across two presets', () => {
    const [cat, dog] = tree.axes[0].presets;
    const catSidekick = cat.actants.find((g) => g.actantId === 'act-sidekick');
    const dogSidekick = dog.actants.find((g) => g.actantId === 'act-sidekick');
    const catRow = catSidekick!.rows[0];
    const dogRow = dogSidekick!.rows[0];
    expect(catRow.kind).toBe('pair');
    expect(dogRow.kind).toBe('pair');
    // Cross-preset unification: identical pairId → coverage/select stay unified.
    expect(catRow.kind === 'pair' && catRow.pairId).toBe('pair-shared');
    expect(dogRow.kind === 'pair' && dogRow.pairId).toBe('pair-shared');
  });

  it('renders an uncast row (mapping with no actors row) with a full prefill', () => {
    const bird = tree.axes[0].presets.find((p) => p.presetId === 'preset-bird')!;
    const group = bird.actants.find((g) => g.actantId === 'act-uncast')!;
    const row = group.rows[0];
    expect(row.kind).toBe('uncast');
    if (row.kind !== 'uncast') throw new Error('expected uncast');
    expect(row.actorId).toBe('tweety_bird');
    // Not the actant's default (act-uncast is absent from the default preset) →
    // still swappable, [+ Add] stays enabled.
    expect(row.isDefaultActor).toBe(false);
    expect(row.prefill).toMatchObject({
      axisId: 'axis-1',
      presetId: 'preset-bird',
      actantId: 'act-uncast',
      actorId: 'tweety_bird',
      actorType: 1,
    });
  });

  it('flags an uncast row as isDefaultActor when its actor is the actant default', () => {
    // Default preset binds role→kid but NO actors row exists yet ⇒ uncast row
    // whose actor IS the story default ⇒ nothing to swap.
    const slot: BookCastingSlot = {
      casting_axes: [
        {
          id: 'ax',
          name: 'Main',
          actants: [{ id: 'role', name: 'Hero' }],
          presets: [
            {
              id: 'p-def',
              name: 'Boy',
              is_default: true,
              actants: [{ actant_id: 'role', actor_id: 'kid', actor_type: 1 }],
            },
          ],
        },
      ],
    } as BookCastingSlot;

    const t = buildActorsTree(slot, []);
    const group = t.axes[0].presets[0].actants.find((g) => g.actantId === 'role')!;
    const row = group.rows[0];
    expect(row.kind).toBe('uncast');
    if (row.kind !== 'uncast') throw new Error('expected uncast');
    expect(row.isDefaultActor).toBe(true);
  });

  it('places a pair referenced by no preset into the axis unassigned bucket', () => {
    const axis1 = tree.axes[0];
    expect(axis1.unassigned.map((r) => r.pairId)).toEqual(['pair-orphan']);
    // Used pairs must never leak into unassigned.
    expect(axis1.unassigned.map((r) => r.pairId)).not.toContain('pair-shared');
  });

  it('collects a pair whose actant is in no axis as a dangling orphan', () => {
    expect(tree.danglingOrphans.map((r) => r.pairId)).toEqual(['pair-dangling']);
    expect(tree.danglingOrphans[0].kind).toBe('dangling');
  });
});
