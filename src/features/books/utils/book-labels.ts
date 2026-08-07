// Pure label helpers for the book row (04-book-row § 2.3 / § 3.1).
// Reuses the single code→name maps from config-constants (SUPPORTED_LANGUAGES /
// getCountryName) — do NOT redefine a parallel map here (bài học project-language.ts).
// Unknown codes fall back to the raw code (render something, never throw).

import { SUPPORTED_LANGUAGES, getCountryName } from '@/constants/config-constants';

/** `vi_VN` → "Tiếng Việt". Unknown/empty code → raw code (fallback, no throw). */
export function languageLabel(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/** `vi_VN` → "VI" (2-char avatar initials). Empty/missing code → "?". */
export function languageInitials(code: string): string {
  if (!code) return '?';
  return code.slice(0, 2).toUpperCase();
}

/** `VN` → "Vietnam". Reuses getCountryName; unknown → raw code, empty → "". */
export function countryLabel(code: string): string {
  return getCountryName(code);
}

/**
 * Edition badge label (04-book-row § 2.3):
 * - international            → "International"
 * - 0 countries             → "Localization"
 * - 1 country               → "Localization - {Country}"
 * - N countries (N>1)       → "Localization - {firstCountry} +{N-1}"
 */
export function editionLabel(
  isInternational: boolean,
  countries: Array<{ code: string }>,
): string {
  if (isInternational) return 'International';
  const list = countries ?? [];
  if (list.length === 0) return 'Localization';
  const first = countryLabel(list[0].code);
  if (list.length === 1) return `Localization - ${first}`;
  return `Localization - ${first} +${list.length - 1}`;
}
