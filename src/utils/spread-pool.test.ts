// spread-pool.test.ts — Truth table for the default-story pool predicate + filter.
import { describe, it, expect } from 'vitest';
import { isSpreadInDefaultStory, filterDefaultStorySpreads } from './spread-pool';
import type { SpreadPool } from '@/types/spread-types';

function spread(pool?: SpreadPool | null, id = 's') {
  return { id, pool };
}

describe('isSpreadInDefaultStory', () => {
  it('absent pool → in default story', () => {
    expect(isSpreadInDefaultStory(spread(undefined))).toBe(true);
  });

  it('null pool → in default story', () => {
    expect(isSpreadInDefaultStory(spread(null))).toBe(true);
  });

  it('is_true=false → in default story (not a pool member)', () => {
    expect(isSpreadInDefaultStory(spread({ is_true: false, is_default: false }))).toBe(true);
  });

  it('is_true=true + is_default=true → in default story (the default member)', () => {
    expect(isSpreadInDefaultStory(spread({ is_true: true, is_default: true }))).toBe(true);
  });

  it('is_true=true + is_default=false → HIDDEN alternate (dropped)', () => {
    expect(isSpreadInDefaultStory(spread({ is_true: true, is_default: false }))).toBe(false);
  });

  it('is_true=true + is_default absent → in default story (only meaningful when is_true)', () => {
    // is_default missing on a pool member — predicate treats it as not-hidden.
    expect(isSpreadInDefaultStory(spread({ is_true: true } as SpreadPool))).toBe(true);
  });
});

describe('filterDefaultStorySpreads', () => {
  it('drops only the hidden alternate and preserves order', () => {
    const spreads = [
      spread(undefined, 'a'),
      spread({ is_true: true, is_default: false }, 'b'), // hidden alternate
      spread({ is_true: true, is_default: true }, 'c'),
    ];
    const kept = filterDefaultStorySpreads(spreads);
    expect(kept.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('returns all when none are hidden', () => {
    const spreads = [spread(undefined, 'a'), spread({ is_true: false, is_default: false }, 'b')];
    expect(filterDefaultStorySpreads(spreads)).toHaveLength(2);
  });
});
