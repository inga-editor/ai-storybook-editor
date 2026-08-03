// spread-pool.ts — Pure predicate + filter for the Spread Pool "default story" view.
//
// A spread is a POOL member when `pool.is_true === true`. Among pool members exactly
// one is the DEFAULT (`pool.is_default === true`) — that one plays as the main story;
// every OTHER pool member is a hidden ALTERNATE that default-story consumers (preview
// player, PDF/video default scope) must skip. Absent `pool` = legacy spread = always
// part of the default story.
//
// This predicate drops alternates UNCONDITIONALLY — including rows that also violate
// P3 (a pooled spread anchored to a branch/section) — matching the backend decision in
// phase 01 (`filter_default_story_spreads`: "still drop + warn"). See
// ai-storybook-design/snapshot/illustration-structure.md §Spread Pool P3/P4.
//
// NOT to be confused with `filterPoolSpreads` (remix clone pipeline) — that is a
// different predicate (the remixer's per-spread choice) at a different call site.

import type { SpreadPool } from '@/types/spread-types';

/** Minimal structural shape both `BaseSpread` and `RemixSpread` satisfy. */
type PoolBearing = { pool?: SpreadPool | null };

/**
 * True when `spread` belongs to the default (main) story — i.e. it is NOT a hidden
 * pool alternate. Definition (P4):
 *   isSpreadInDefaultStory = !(pool.is_true === true && pool.is_default === false)
 * Absent/null pool, `is_true=false`, `is_default` absent, or the default member
 * (`is_default=true`) all resolve to `true`.
 */
export function isSpreadInDefaultStory(spread: PoolBearing): boolean {
  const pool = spread.pool;
  return !(pool?.is_true === true && pool.is_default === false);
}

/**
 * Keep only default-story spreads, preserving array order. Generic so the result type
 * matches the input element type (works for `BaseSpread[]` and `RemixSpread[]` alike).
 */
export function filterDefaultStorySpreads<T extends PoolBearing>(spreads: T[]): T[] {
  return spreads.filter(isSpreadInDefaultStory);
}
