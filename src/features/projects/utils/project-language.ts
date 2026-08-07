// project-language.ts — Pure language-label helpers for project rows.
// Reuses REMIX_LANGUAGES (config-constants) as the single code→name map — do NOT
// redefine a parallel map here (design §1.4).

import { REMIX_LANGUAGES } from '@/constants/config-constants';
import type { ProjectOverviewRow } from '../types';

/**
 * Human-readable name for a language code (`vi_VN` → "Vietnamese"). Unknown codes
 * fall back to the raw key so a backfilled/foreign code still renders something.
 */
export function languageLabel(key: string | null): string {
  if (!key) return '';
  const match = REMIX_LANGUAGES.find((l) => l.code === key);
  return match ? match.name : key;
}

/**
 * Short codes (`vi_VN` → `vi`) for the support-language rollup, with the project's
 * original language hoisted to the front. Deduped; preserves remaining RPC order.
 */
export function shortCodes(
  supportLanguages: ProjectOverviewRow['support_languages'],
  originalLanguage: string | null,
): string[] {
  if (!supportLanguages) return [];
  const toShort = (code: string) => code.split('_')[0];

  const keys = Object.keys(supportLanguages);
  const originalShort = originalLanguage ? toShort(originalLanguage) : null;

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (short: string) => {
    if (short && !seen.has(short)) {
      seen.add(short);
      ordered.push(short);
    }
  };

  if (originalShort) push(originalShort);
  for (const key of keys) push(toShort(key));

  return ordered;
}
