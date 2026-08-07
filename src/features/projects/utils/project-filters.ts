// project-filters.ts — Client-side search over project rows (title + description).
// Pure; empty needle returns the SAME array reference so callers' useMemo/memo
// chains do not break on identity.

import type { ProjectOverviewRow } from '../types';

/**
 * Filter rows whose title OR description contains `search` (case-insensitive).
 * Empty/whitespace search → the original array (reference preserved).
 */
export function applySearch(
  rows: ProjectOverviewRow[],
  search: string,
): ProjectOverviewRow[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return rows;

  return rows.filter((row) => {
    const haystack = `${row.title} ${row.description ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}
