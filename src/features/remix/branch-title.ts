// branch-title.ts — Pure multi-language title resolver for branch spreads /
// branch options. `BranchSetting` and `Branch` are index-signature nodes keyed
// by language code (value = { title, audio_url }) mixed with structural keys
// (`branches`, `section_id`, `is_default`, `image_url`). These helpers read the
// localized `title` safely, ignoring the structural keys.

import type { Branch, BranchSetting } from '@/types/illustration-types';

type LocalizedNode = BranchSetting | Branch;

/** Structural (non-language) keys that must never be treated as a locale entry. */
const NON_LOCALE_KEYS = new Set(['branches', 'section_id', 'is_default', 'image_url']);

/** Read `node[lang].title` if present (and `lang` is not a structural key). */
export function localizedTitle(node: LocalizedNode, lang: string): string | null {
  if (!lang || NON_LOCALE_KEYS.has(lang)) return null;
  const entry = (node as Record<string, unknown>)[lang];
  if (entry && typeof entry === 'object') {
    const title = (entry as { title?: unknown }).title;
    if (typeof title === 'string' && title.length > 0) return title;
  }
  return null;
}

/**
 * Resolve a display title with fallback chain:
 *   node[lang].title → first available language title → `fallback` → ''.
 */
export function resolveBranchTitle(
  node: LocalizedNode,
  lang: string,
  fallback: string,
): string {
  const preferred = localizedTitle(node, lang);
  if (preferred) return preferred;

  for (const [key, val] of Object.entries(node)) {
    if (NON_LOCALE_KEYS.has(key)) continue;
    if (val && typeof val === 'object') {
      const title = (val as { title?: unknown }).title;
      if (typeof title === 'string' && title.length > 0) return title;
    }
  }
  return fallback ?? '';
}
