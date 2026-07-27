import { describe, expect, it } from 'vitest';
import { pivot } from './cost-pivot';
import type { CostCell, CostGroup } from '@/types/cost';

/**
 * The example dataset of design §1.3 — the ONE fixture both group modes must agree on.
 * Sum = $12.50 by construction; that number is the contract the whole modal hangs on.
 */
function cell(
  actionKey: string,
  actionLabel: string,
  modelKey: string,
  modelLabel: string,
  costUsd: number,
  callCount = 1,
): CostCell {
  return {
    actionKey,
    actionLabel,
    modelKey,
    modelLabel,
    provider: 'replicate',
    costUsd,
    callCount,
  };
}

const SPEC_CELLS: CostCell[] = [
  cell('generate', 'Generate', 'nano-banana', 'Nano Banana', 4.2, 12),
  cell('generate', 'Generate', 'qwen', 'Qwen', 1.2, 4),
  cell('regenerate', 'Regenerate', 'nano-banana', 'Nano Banana', 2.6, 7),
  cell('regenerate', 'Regenerate', 'qwen', 'Qwen', 0.6, 2),
  cell('remove-bg', 'Remove BG', 'remove-bg', 'Remove BG', 2.1, 21),
  cell('segment', 'Segment', 'sam-3', 'SAM 3', 1.8, 9),
];

const TOTAL_CENTS = 1250; // $12.50

/** Money comparisons are done in cents — the invariant the pivot promises is "to the cent". */
function cents(usd: number): number {
  return Math.round(usd * 100);
}

function sumCents(groups: CostGroup[]): number {
  return groups.reduce((acc, g) => acc + cents(g.costUsd), 0);
}

function labelsOf(groups: CostGroup[]): string[] {
  return groups.map((g) => g.label);
}

function childLabelsOf(groups: CostGroup[], groupLabel: string): string[] {
  const group = groups.find((g) => g.label === groupLabel);
  return group ? group.children.map((c) => c.label) : [];
}

describe('pivot — spec §1.3 example dataset', () => {
  it('both views total $12.50', () => {
    expect(sumCents(pivot(SPEC_CELLS, 'action'))).toBe(TOTAL_CENTS);
    expect(sumCents(pivot(SPEC_CELLS, 'model'))).toBe(TOTAL_CENTS);
  });

  it('by action → the exact groups + amounts of the spec table', () => {
    const groups = pivot(SPEC_CELLS, 'action');

    expect(labelsOf(groups)).toEqual(['Generate', 'Regenerate', 'Remove BG', 'Segment']);
    expect(groups.map((g) => cents(g.costUsd))).toEqual([540, 320, 210, 180]);

    expect(childLabelsOf(groups, 'Generate')).toEqual(['Nano Banana', 'Qwen']);
    expect(childLabelsOf(groups, 'Regenerate')).toEqual(['Nano Banana', 'Qwen']);
  });

  it('by model → the exact groups + amounts of the spec table', () => {
    const groups = pivot(SPEC_CELLS, 'model');

    // DESC by cost; Qwen and SAM 3 both sit at $1.80 → tie broken by label ASC, so Qwen first.
    // (The §2.4 mock draws SAM 3 above Qwen; §1.3's sort rule is the authority — mock is stale.)
    expect(labelsOf(groups)).toEqual(['Nano Banana', 'Remove BG', 'Qwen', 'SAM 3']);
    expect(groups.map((g) => cents(g.costUsd))).toEqual([680, 210, 180, 180]);

    expect(childLabelsOf(groups, 'Nano Banana')).toEqual(['Generate', 'Regenerate']);
    expect(childLabelsOf(groups, 'Qwen')).toEqual(['Generate', 'Regenerate']);
  });
});

describe('pivot — invariant: group === Σ children', () => {
  it.each(['action', 'model'] as const)('holds to the cent in the %s view', (groupBy) => {
    const groups = pivot(SPEC_CELLS, groupBy);

    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const childSum = group.children.reduce((acc, c) => acc + cents(c.costUsd), 0);
      expect(childSum).toBe(cents(group.costUsd));
    }
  });

  it('survives float-hostile amounts (0.07 + 0.07 + 0.01)', () => {
    const groups = pivot(
      [
        cell('generate', 'Generate', 'a', 'A', 0.07),
        cell('generate', 'Generate', 'b', 'B', 0.07),
        cell('generate', 'Generate', 'c', 'C', 0.01),
      ],
      'action',
    );

    expect(cents(groups[0].costUsd)).toBe(15);
    const childSum = groups[0].children.reduce((acc, c) => acc + cents(c.costUsd), 0);
    expect(childSum).toBe(cents(groups[0].costUsd));
  });
});

describe('pivot — single-child groups still emit their child', () => {
  it('Remove BG → [Remove BG] and SAM 3 → [Segment]', () => {
    const byAction = pivot(SPEC_CELLS, 'action');
    // Repeated label is correct: the action Remove BG only ever ran on the model Remove BG.
    expect(childLabelsOf(byAction, 'Remove BG')).toEqual(['Remove BG']);
    expect(childLabelsOf(byAction, 'Segment')).toEqual(['SAM 3']);

    const byModel = pivot(SPEC_CELLS, 'model');
    expect(childLabelsOf(byModel, 'SAM 3')).toEqual(['Segment']);
    expect(childLabelsOf(byModel, 'Remove BG')).toEqual(['Remove BG']);
  });

  it('never collapses a 1-child group to zero children', () => {
    for (const groupBy of ['action', 'model'] as const) {
      for (const group of pivot(SPEC_CELLS, groupBy)) {
        expect(group.children.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('pivot — sort is DESC(cost) then label ASC, independent of input order', () => {
  const SHUFFLED: CostCell[] = [
    SPEC_CELLS[5],
    SPEC_CELLS[1],
    SPEC_CELLS[4],
    SPEC_CELLS[3],
    SPEC_CELLS[0],
    SPEC_CELLS[2],
  ];
  const REVERSED: CostCell[] = [...SPEC_CELLS].reverse();

  it.each(['action', 'model'] as const)('%s view is identical for 3 input orders', (groupBy) => {
    const fromSpecOrder = pivot(SPEC_CELLS, groupBy);
    expect(pivot(SHUFFLED, groupBy)).toEqual(fromSpecOrder);
    expect(pivot(REVERSED, groupBy)).toEqual(fromSpecOrder);
  });

  it('equal cost + equal label falls back to key ASC (fully deterministic)', () => {
    const ties: CostCell[] = [
      cell('z-action', 'Same', 'm1', 'Zed', 1.0),
      cell('a-action', 'Same', 'm2', 'Alpha', 1.0),
    ];

    expect(pivot(ties, 'action').map((g) => g.key)).toEqual(['a-action', 'z-action']);
    expect(pivot([...ties].reverse(), 'action').map((g) => g.key)).toEqual([
      'a-action',
      'z-action',
    ]);
    // Same cost, different labels → label ASC wins before key.
    expect(pivot(ties, 'model').map((g) => g.label)).toEqual(['Alpha', 'Zed']);
  });
});

describe('pivot — edge cases', () => {
  it('empty input → []', () => {
    expect(pivot([], 'action')).toEqual([]);
    expect(pivot([], 'model')).toEqual([]);
  });

  it('empty label degrades to the stable key instead of a blank row', () => {
    const groups = pivot([cell('other', '', 'unknown-model', '', 0.5)], 'action');
    expect(groups[0].label).toBe('other');
    expect(groups[0].children[0].label).toBe('unknown-model');
  });

  it('duplicate (action, model) cells accumulate instead of overwriting', () => {
    const groups = pivot(
      [
        cell('generate', 'Generate', 'nano-banana', 'Nano Banana', 1.0, 3),
        cell('generate', 'Generate', 'nano-banana', 'Nano Banana', 2.0, 5),
      ],
      'action',
    );

    expect(groups).toHaveLength(1);
    expect(cents(groups[0].costUsd)).toBe(300);
    expect(groups[0].children).toHaveLength(1);
    expect(cents(groups[0].children[0].costUsd)).toBe(300);
    expect(groups[0].children[0].callCount).toBe(8);
  });

  it('a non-finite costUsd counts as 0 rather than poisoning the group with NaN', () => {
    const groups = pivot(
      [
        cell('generate', 'Generate', 'nano-banana', 'Nano Banana', Number.NaN),
        cell('generate', 'Generate', 'qwen', 'Qwen', 1.25),
      ],
      'action',
    );

    expect(cents(groups[0].costUsd)).toBe(125);
  });
});
