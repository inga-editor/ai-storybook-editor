// use-pool-spread-options.ts — Cross-store selector hook: derives the pool spread
// option list for the Story tab › Pools section from snapshot.illustration + book
// locale.
//
// Ref-stability discipline (zustand useShallow footgun): subscribe only the STABLE
// RAW ref (`illustration.spreads`) + the primitive `original_language`; derive the
// fresh option array in `useMemo`. NEVER return a freshly `.map()`ed array from a
// store selector (that loops under useShallow). This hook MUST return a memoized
// ref, not a new array each render.

import { useMemo } from 'react';
import { useBookStore } from '@/stores/book-store';
import { useIllustrationSpreads } from '@/stores/snapshot-store/selectors';
import type { SpreadTitle } from '@/types/spread-types';
import type { PoolSpreadOption } from '@/types/remix';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'usePoolSpreadOptions');

/** First non-empty per-language title text, in object insertion order. Null when
 *  the title map is absent or has no non-empty entry. */
function firstAvailableLanguageText(title: SpreadTitle | undefined): string | null {
  if (!title) return null;
  for (const entry of Object.values(title)) {
    if (entry?.text && entry.text.trim().length > 0) return entry.text;
  }
  return null;
}

/**
 * One `PoolSpreadOption` per spread with `pool.is_true === true`, in snapshot
 * array (walk) order. Title resolves `original_language` → first available
 * language → `Spread {index + 1}`. Non-pool spreads are skipped (unlike the
 * config space which lists every spread).
 */
export function usePoolSpreadOptions(): PoolSpreadOption[] {
  const spreads = useIllustrationSpreads(); // stable raw ref
  const lang = useBookStore((s) => s.currentBook?.original_language ?? '');

  return useMemo(() => {
    const out: PoolSpreadOption[] = [];
    spreads.forEach((spread, index) => {
      if (spread.pool?.is_true !== true) return;
      const primary = spread.title?.[lang]?.text;
      const title =
        (primary && primary.trim().length > 0 ? primary : null) ??
        firstAvailableLanguageText(spread.title) ??
        `Spread ${index + 1}`;
      out.push({
        spread_id: spread.id,
        spread_number: String(spread.pages[0]?.number ?? ''),
        title,
        thumbnail_url: spread.thumbnail_url ?? null,
        is_default: spread.pool.is_default === true,
      });
    });
    log.debug('usePoolSpreadOptions', 'derived', { count: out.length });
    return out;
  }, [spreads, lang]);
}
