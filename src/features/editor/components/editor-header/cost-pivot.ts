// cost-pivot.ts — Turn the sparse `(action × model)` cell matrix of ONE scope into the
// 2-level group/leaf list the CostBreakdownModal renders.
//
// Spec: ai-storybook-design/component/editor-page/01-01-cost-breakdown-modal.md §1.3
//
// The two group modes are exact transposes of the SAME cells — that is why switching the
// "By model / By action" select never refetches: this function runs again on data already in
// memory (see modal §4.1).
//
// Two invariants this file exists to protect:
//   1. `group.costUsd === Σ group.children[].costUsd` — to the cent, in BOTH modes.
//   2. A group ALWAYS carries its children, even a single one. Repeated labels
//      (`Remove BG` group → `Remove BG` child) are the truth of the data, not a render bug
//      (§1.3). No special-casing of 1-child groups.

import { createLogger } from '@/utils/logger';
import type { CostCell, CostGroup, CostGroupBy, CostGroupChild } from '@/types/cost';

const log = createLogger('Editor', 'CostPivot');

/**
 * Money is summed in integer cents, never in floats.
 *
 * Every `costUsd` coming from the API is already rounded to 2 decimals AT THE CELL, so cents
 * are lossless. Summing `4.2 + 1.2` as floats yields `5.4000000000000004`, which would break
 * invariant #1 the moment a test (or an ops-minded user) compares a group against its children.
 */
function toCents(costUsd: number): number {
  if (!Number.isFinite(costUsd)) {
    log.warn('toCents', 'non-finite costUsd, counted as 0', { costUsd: String(costUsd) });
    return 0;
  }
  return Math.round(costUsd * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/** Labels are server-provided and i18n-ready; an empty one degrades to the stable key rather
 *  than rendering a blank row. */
function resolveLabel(label: string | undefined, key: string): string {
  return label && label.trim() ? label : key;
}

/** Internal accumulator — mirrors `CostGroupChild` but keeps money in cents while summing. */
interface LeafAccumulator {
  key: string;
  label: string;
  cents: number;
  callCount: number;
}

interface GroupAccumulator {
  key: string;
  label: string;
  cents: number;
  children: Map<string, LeafAccumulator>;
}

/**
 * Sort contract (§1.3): `costUsd DESC`, tie → `label ASC`, final tie → `key ASC`.
 *
 * The key tie-break is what makes the order independent of the order the API happened to send
 * the cells in — two rows with the same cost AND the same label would otherwise land in
 * arrival order. `localeCompare(_, 'en')` pins the collation so the result does not drift with
 * the user's locale.
 */
function compareByCostThenLabel(
  a: { cents: number; label: string; key: string },
  b: { cents: number; label: string; key: string },
): number {
  if (b.cents !== a.cents) return b.cents - a.cents;
  const byLabel = a.label.localeCompare(b.label, 'en');
  if (byLabel !== 0) return byLabel;
  return a.key.localeCompare(b.key, 'en');
}

/**
 * Pivot the leaf cells of one scope into groups.
 *
 * @param cells    `CostScope.cells` — sparse `(action × model)` matrix, already aggregated server-side.
 * @param groupBy  Which dimension becomes the group row; the other becomes the leaf rows.
 * @returns        Groups sorted DESC by cost, each with its children sorted the same way.
 *                 Empty input → `[]` (the modal renders its empty state and still shows Total).
 */
export function pivot(cells: CostCell[], groupBy: CostGroupBy): CostGroup[] {
  if (!cells || cells.length === 0) {
    log.debug('pivot', 'no cells, empty result', { groupBy });
    return [];
  }

  const groupByAction = groupBy === 'action';
  const groups = new Map<string, GroupAccumulator>();

  for (const cell of cells) {
    const groupKey = groupByAction ? cell.actionKey : cell.modelKey;
    const groupLabel = resolveLabel(
      groupByAction ? cell.actionLabel : cell.modelLabel,
      groupKey,
    );
    const leafKey = groupByAction ? cell.modelKey : cell.actionKey;
    const leafLabel = resolveLabel(
      groupByAction ? cell.modelLabel : cell.actionLabel,
      leafKey,
    );
    const cents = toCents(cell.costUsd);
    const callCount = Number.isFinite(cell.callCount) ? cell.callCount : 0;

    let group = groups.get(groupKey);
    if (!group) {
      group = { key: groupKey, label: groupLabel, cents: 0, children: new Map() };
      groups.set(groupKey, group);
    }
    group.cents += cents;

    // The API guarantees one cell per `(action, model)` pair, but accumulating instead of
    // overwriting keeps the invariant intact if a duplicate ever slips through.
    const leaf = group.children.get(leafKey);
    if (leaf) {
      leaf.cents += cents;
      leaf.callCount += callCount;
    } else {
      group.children.set(leafKey, { key: leafKey, label: leafLabel, cents, callCount });
    }
  }

  const result: CostGroup[] = Array.from(groups.values())
    .sort(compareByCostThenLabel)
    .map((group) => {
      const children: CostGroupChild[] = Array.from(group.children.values())
        .sort(compareByCostThenLabel)
        .map((leaf) => ({
          key: leaf.key,
          label: leaf.label,
          costUsd: fromCents(leaf.cents),
          callCount: leaf.callCount,
        }));
      return {
        key: group.key,
        label: group.label,
        costUsd: fromCents(group.cents),
        children,
      };
    });

  log.debug('pivot', 'pivoted cells', {
    groupBy,
    cellCount: cells.length,
    groupCount: result.length,
  });

  return result;
}
