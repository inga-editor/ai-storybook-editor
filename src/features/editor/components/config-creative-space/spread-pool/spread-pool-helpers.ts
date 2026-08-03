// spread-pool-helpers.ts — pure logic for the Spread Pool config section.
//
// Writes go to the SNAPSHOT (`illustration.spreads[]`) OWNER-DIRECT (store mutation +
// whole-snapshot flush — chốt 2026-08-03), NOT the `books` table and NOT the lock/collab
// gateway: config space never mounts a collab session, so the former rtype-6 one-shot
// lock always failed ("another editor" toast). Merge helpers below still build the
// per-spread sub-object patches so a store update never drops sibling pool/title keys.

import type { BaseSpread, SpreadPool, SpreadTitle } from '@/types/spread-types';
import type { Section } from '@/types/illustration-types';

/** Why a spread's pool toggle is locked (invariant P3: pool ⊥ branch/section). */
export type PoolToggleLockReason = 'branch' | 'section';

/** Sub-object patch persisted per spread — NEVER the whole node (plan trap #4). */
export type SpreadPoolPatch = Partial<Pick<BaseSpread, 'pool' | 'title' | 'thumbnail_url'>>;

/**
 * Merge a partial pool flag change onto the current pool object. Absent current pool
 * seeds `{ is_true: false, is_default: false }`; `is_default` is preserved across a
 * toggle so re-enabling never loses the default flag (design §4.2).
 */
export function mergePool(
  current: SpreadPool | null | undefined,
  partial: Partial<SpreadPool>,
): SpreadPool {
  const base: SpreadPool = current ?? { is_true: false, is_default: false };
  return { ...base, ...partial };
}

/**
 * True when a pool toggle should NOT write anything: a spread that never had a `pool`
 * object AND is only being toggled OFF (no `is_default` change) — absent is a valid
 * legacy state, so we avoid materializing an all-false object (design §4.2 / plan trap #8).
 */
export function shouldSkipPoolWrite(
  current: SpreadPool | null | undefined,
  partial: Partial<SpreadPool>,
): boolean {
  return current == null && partial.is_true === false && partial.is_default === undefined;
}

/**
 * Merge a per-language title. Empty/whitespace text DROPS the language key entirely
 * (no `{ text: '' }` residue — plan trap #8 / §1.3).
 */
export function mergeTitle(
  current: SpreadTitle | null | undefined,
  languageKey: string,
  text: string,
): SpreadTitle {
  const next: SpreadTitle = { ...(current ?? {}) };
  const trimmed = text.trim();
  if (trimmed === '') {
    delete next[languageKey];
  } else {
    next[languageKey] = { text: trimmed };
  }
  return next;
}

/** First non-empty language text in the title object (object insertion order). */
function firstAvailableLanguageText(title: SpreadTitle | null | undefined): string | undefined {
  if (!title) return undefined;
  for (const entry of Object.values(title)) {
    const t = entry?.text?.trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Human display label for a spread: original-language title → any other language →
 * `Spread {index}` (1-based). Used for accessible labels / display fallback, never persisted.
 */
export function resolveTitleText(
  title: SpreadTitle | null | undefined,
  originalLanguage: string,
  index: number,
): string {
  return (
    title?.[originalLanguage]?.text?.trim() ||
    firstAvailableLanguageText(title) ||
    `Spread ${index}`
  );
}

/**
 * Whether a spread's pool toggle must be LOCKED (disabled) to enforce invariant P3
 * — "pool ⊥ branch/section" (design §1.3, chốt 2026-08-03). A branch spread or a
 * section anchor may NOT join the pool, else the original-consumer array filter
 * (`isSpreadInDefaultStory`) would drop it BEFORE the branch walk and dangle its
 * `next_spread_id` navigation. Returns `'branch'` (takes precedence) when the spread
 * carries `branch_setting`; `'section'` when its id is a section `start/end/next`
 * anchor; else `null`. Pure — unit-tested independently.
 */
export function isPoolToggleLocked(
  spread: Pick<BaseSpread, 'id' | 'branch_setting'>,
  sections: readonly Section[],
): PoolToggleLockReason | null {
  if (spread.branch_setting) return 'branch';
  for (const sec of sections) {
    if (
      sec.start_spread_id === spread.id ||
      sec.end_spread_id === spread.id ||
      sec.next_spread_id === spread.id
    ) {
      return 'section';
    }
  }
  return null;
}

/** Original-language raw text for a controlled input (empty string when absent). */
export function originalTitleText(
  title: SpreadTitle | null | undefined,
  originalLanguage: string,
): string {
  return title?.[originalLanguage]?.text ?? '';
}
