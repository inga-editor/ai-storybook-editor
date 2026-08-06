// display-name-helpers.ts — Helpers for resolving display name / avatar / profile counts on humans.

import type { Human } from '@/types/human';

const DEFAULT_LOCALE = 'en_US';

/**
 * Build the persisted displayName JSONB block.
 * Strips empty entries; auto-seeds en_US from sourceName if missing.
 */
export function normalizeDisplayNames(
  raw: Record<string, string>,
  fallbackSourceName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, value] of Object.entries(raw)) {
    const trimmed = (value ?? '').trim();
    if (trimmed.length > 0) out[code] = trimmed;
  }
  if (!out[DEFAULT_LOCALE]) {
    const fallback = fallbackSourceName.trim();
    if (fallback.length > 0) out[DEFAULT_LOCALE] = fallback;
  }
  return out;
}

/** Resolve display name for a given locale, falling back to en_US then sourceName. */
export function resolveDisplayName(human: Human, locale: string): string {
  const direct = human.displayName?.[locale];
  if (direct && direct.trim().length > 0) return direct;
  const en = human.displayName?.[DEFAULT_LOCALE];
  if (en && en.trim().length > 0) return en;
  return human.sourceName;
}

/**
 * Resolve avatar URL: visual profile with smallest age that has images (rawImages[0]).
 * Returns null if none.
 */
export function resolveAvatarUrl(human: Human): string | null {
  const withImages = human.visualProfiles
    .filter((p) => p.rawImages.length > 0)
    .slice()
    .sort((a, b) => a.age - b.age);
  return withImages.length > 0 ? withImages[0].rawImages[0] : null;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Format face count for row display, e.g. "2 faces". Uses em-dash for zero. */
export function formatFaceCount(human: Human): string {
  const v = human.visualProfiles.length;
  return v === 0 ? '— faces' : pluralize(v, 'face');
}
