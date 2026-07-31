// use-branch-spread-options.ts — Cross-store selector hook: derives the branch
// spread option list for the Story tab from snapshot.illustration + book locale.
//
// Ref-stability discipline (zustand useShallow footgun): subscribe only STABLE
// RAW refs (`illustration.spreads`, `illustration.sections`) + the primitive
// `original_language`; derive the fresh option array in `useMemo`. Never return a
// freshly `.map()`ed array from a store selector (that loops under useShallow).

import { useMemo } from 'react';
import { useBookStore } from '@/stores/book-store';
import { useIllustrationSpreads, useSections } from '@/stores/snapshot-store/selectors';
import { resolveBranchTitle } from '@/features/remix/branch-title';
import type { BranchSpreadOption } from '@/types/remix';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'useBranchSpreadOptions');

/**
 * One `BranchSpreadOption` per spread carrying a `branch_setting`, in array
 * (walk) order. Titles resolve `original_language` → first available language →
 * section title → ''. Spreads whose `branches[]` is empty are skipped with a
 * `warn` (data error — the clone walker falls back to next_spread_id/array order).
 */
export function useBranchSpreadOptions(): BranchSpreadOption[] {
  const spreads = useIllustrationSpreads(); // stable raw ref
  const sections = useSections(); // stable raw ref
  const lang = useBookStore((s) => s.currentBook?.original_language ?? '');

  return useMemo(() => {
    const sectionTitleOf = (id: string): string =>
      sections.find((sec) => sec.id === id)?.title ?? '';

    const out: BranchSpreadOption[] = [];
    for (const spread of spreads) {
      const branchSetting = spread.branch_setting;
      if (!branchSetting) continue;
      if (!branchSetting.branches || branchSetting.branches.length === 0) {
        log.warn('useBranchSpreadOptions', 'branch_setting has no branches, skipped', {
          spreadId: spread.id,
        });
        continue;
      }
      out.push({
        spread_id: spread.id,
        spread_number: String(spread.pages[0]?.number ?? ''),
        title: resolveBranchTitle(branchSetting, lang, ''),
        branches: branchSetting.branches.map((b) => ({
          section_id: b.section_id,
          title: resolveBranchTitle(b, lang, sectionTitleOf(b.section_id)),
          is_default: b.is_default,
        })),
      });
    }
    log.debug('useBranchSpreadOptions', 'derived', { count: out.length });
    return out;
  }, [spreads, sections, lang]);
}
