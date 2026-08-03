// spread-pool-helpers.ts — pure logic for the Spread Pool config section.
//
// Writes go to the SNAPSHOT (`illustration.spreads[]`) through the save-by-resource
// gateway (rtype-6, STEP 2 — scene owned-key MERGE), NOT the `books` table. The lock
// target constant lives here so the mandatory `step: 2` (owned-key merge, keeps other
// spread keys) can be pinned + asserted in one place — `step: 1` would take the
// whole-node path and DROP sibling keys (design §4.1 / plan trap #3).

import type { LockTarget } from '@/stores/resource-lock-store/types';
import type { BaseSpread, SpreadPool, SpreadTitle } from '@/types/spread-types';
import type { Section } from '@/types/illustration-types';

/** Why a spread's pool toggle is locked (invariant P3: pool ⊥ branch/section). */
export type PoolToggleLockReason = 'branch' | 'section';

/** Owned-key sub-object persisted per spread — NEVER the whole node (plan trap #4). */
export type SpreadPoolPatch = Partial<Pick<BaseSpread, 'pool' | 'title' | 'thumbnail_url'>>;

/** Illustration step — spread pool metadata is scene-side data (step 2). */
export const SPREAD_POOL_LOCK_STEP = 2 as const;
/** Spread resource type in the lock/save gateway vocab. */
export const SPREAD_POOL_RESOURCE_TYPE = 6 as const;
/** Gateway crud audit enum for an EDIT (design §4.1, sketch-spread art-direction precedent). */
export const SPREAD_POOL_ACTION_TYPE = 3 as const;

/**
 * Lock target for one spread's pool metadata. `step: 2` + `resource_type: 6` route the
 * gateway down the scene OWNED-KEY merge (pool/title/thumbnail_url only), so a concurrent
 * retouch edit on the same spread never clobbers these keys and vice-versa.
 */
export function buildSpreadPoolLockTarget(spreadId: string): LockTarget {
  return {
    step: SPREAD_POOL_LOCK_STEP,
    resource_type: SPREAD_POOL_RESOURCE_TYPE,
    resource_id: spreadId,
    locale: null,
  };
}

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
