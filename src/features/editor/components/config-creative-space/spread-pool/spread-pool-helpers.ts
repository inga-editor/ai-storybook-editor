// spread-pool-helpers.ts — pure logic for the Spread Pool config section.
//
// Writes go to the SNAPSHOT (`illustration.spreads[]`) OWNER-DIRECT (store mutation +
// whole-snapshot flush — chốt 2026-08-03), NOT the `books` table and NOT the lock/collab
// gateway: config space never mounts a collab session, so the former rtype-6 one-shot
// lock always failed ("another editor" toast). Merge helpers below still build the
// per-spread sub-object patches so a store update never drops sibling pool/title keys.

import type { BaseSpread, SpreadPool, SpreadTitle } from '@/types/spread-types';
import type { Section } from '@/types/illustration-types';
import { deepEqual } from '../explicit-save/draft-utils';

/** Why a spread's pool toggle is locked (invariant P3: pool ⊥ branch/section). */
export type PoolToggleLockReason = 'branch' | 'section';

/** Sub-object patch persisted per spread — NEVER the whole node (plan trap #4). */
export type SpreadPoolPatch = Partial<Pick<BaseSpread, 'pool' | 'title' | 'thumbnail_url'>>;

// === Explicit-save draft (⚡rev 2026-08-04) ===============================
// Edits live in a LOCAL draft (`useConfigSectionDraft`) — the store is only touched on
// [Save]. Draft carries ONLY the two owner-editable fields (`pool` + `title`);
// `thumbnail_url` is a BE leaf-write (thumbnail job) and stays OUT of the draft so a
// whole-snapshot flush never clobbers it.

/** One draft entry per spread — the sub-object this section owns. */
export interface SpreadPoolDraftEntry {
  pool?: SpreadPool | null;
  title?: SpreadTitle | null;
}

/** draft/source shape: spreadId → editable pool/title (thumbnail_url excluded). */
export type SpreadPoolDraft = Record<string, SpreadPoolDraftEntry>;

/** A spread whose draft diverged from source → the minimal patch to persist. */
export interface SpreadPoolDiffEntry {
  spreadId: string;
  patch: SpreadPoolPatch;
}

/**
 * Project the store's spreads into the draft baseline — `pool` + `title` ONLY
 * (never `thumbnail_url`). Both keys are always present (null when absent) so a
 * shallow `{ ...prev[id], ...patch }` merge never resurrects a dropped sibling key,
 * and `deepEqual` isDirty comparisons stay symmetric. Pure — memoize on `spreads`.
 */
export function projectPoolFields(spreads: readonly BaseSpread[]): SpreadPoolDraft {
  const out: SpreadPoolDraft = {};
  for (const s of spreads) {
    out[s.id] = { pool: s.pool ?? null, title: s.title ?? null };
  }
  return out;
}

/**
 * Diff a draft against its source baseline → one entry per changed spread, each with a
 * MINIMAL sub-object patch (`pool` and/or `title`, only the keys that actually changed).
 *
 * - PRUNES ids no longer present in `source` (spread deleted in another space while the
 *   draft still held it) — iterate `source` keys, skip when the draft lacks the id.
 * - Only NON-NULL values are emitted (`updateIllustrationSpread` takes real objects; the
 *   UI never sets a pool/title back to null once materialized, so a null-vs-object diff
 *   is a no-op rather than a destructive delete).
 */
export function diffPoolDraft(
  draft: SpreadPoolDraft,
  source: SpreadPoolDraft,
): SpreadPoolDiffEntry[] {
  const diffs: SpreadPoolDiffEntry[] = [];
  for (const spreadId of Object.keys(source)) {
    const d = draft[spreadId];
    if (!d) continue; // id gone from the draft (pruned/never seeded) — nothing to persist
    const s = source[spreadId];
    const patch: SpreadPoolPatch = {};
    if (d.pool != null && !deepEqual(d.pool, s.pool ?? null)) {
      patch.pool = d.pool;
    }
    if (d.title != null && !deepEqual(d.title, s.title ?? null)) {
      patch.title = d.title;
    }
    if (patch.pool !== undefined || patch.title !== undefined) {
      diffs.push({ spreadId, patch });
    }
  }
  return diffs;
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
