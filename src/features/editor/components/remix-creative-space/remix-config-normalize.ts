// remix-config-normalize.ts — WYSIWYG trait normalization for the create-remix
// config modal (product call 2026-06-10).
//
// PROBLEM: the modal seeds every trait `is_enabled: true` and only DISPLAY-masks
// the checkbox (`checked = is_enabled ∧ bookGate ∧ profileSupported`), so the
// persisted remix_config could claim traits the user never saw checked (e.g. a
// trait the picked visual profile has no description for). Downstream readers
// (swap-config review modal, backend sprite_swap_resolver) then over-report.
//
// FIX (two layers):
//   1. On human/visual change the traits RESET to the maximum checkable set
//      for that profile (`maxTraitChoicesFor`) — product call 2026-06-10:
//      prior ticks are intentionally discarded, the default is "everything
//      this profile can swap".
//   2. Save still normalizes (`normalizeRemixConfigTraits`) as the WYSIWYG
//      safety net — persist exactly the displayed checkbox state.
//
// This module is the SINGLE SOURCE for the two display predicates (book gate +
// profile support) — CharacterConfigRow / CharactersSection import them, so
// display and persistence cannot drift apart.

import { TRAIT_TYPES } from '@/constants/trait-constants';
import type { Human, TraitType } from '@/types/human';
import type { BookRemix, CastingAxis, RemixCharacterEntry } from '@/types/editor';
import type {
  BranchSpreadOption,
  PoolSpreadOption,
  RemixBranchChoice,
  RemixConfig,
  RemixPoolSpreadChoice,
  RemixPresetChoice,
  RemixTraitChoice,
} from '@/types/remix';
import { resolveDefaultPreset } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'RemixConfigNormalize');

/** Book-level gate per trait — a trait the book disabled cannot be configured.
 *  Missing entry defaults to enabled (mirrors the DB reader rule). */
export function bookTraitGate(
  bookChar: RemixCharacterEntry | undefined,
  type: TraitType,
): boolean {
  // Reshape 2026-08-06 (phase 03): trait gates moved to params.visual.traits.
  return bookChar?.params.visual.traits.find((t) => t.type === type)?.is_enabled ?? true;
}

/** Trait types the picked visual profile can configure = traits with a
 *  non-empty description. Null when no human/visual is picked yet (→ no
 *  masking, mirrors the create modal's display). */
export function supportedTraitSetFor(
  humans: Human[],
  humanId: string | null,
  visualName: string | null,
): Set<TraitType> | null {
  if (!humanId || !visualName) return null;
  const profile = humans
    .find((h) => h.id === humanId)
    ?.visualProfiles.find((vp) => vp.name === visualName);
  if (!profile) return null;
  return new Set(
    profile.traits
      .filter((t) => typeof t.description === 'string' && t.description.length > 0)
      .map((t) => t.type),
  );
}

/** Maximum checkable trait set for a (book character, profile) pair —
 *  `is_enabled = bookGate ∧ profileSupported`. Used to RESET traits whenever
 *  the human or visual changes (default = tick everything the profile can
 *  swap; prior user ticks are discarded by design). `supported = null` (no
 *  profile resolved) → only the book gate applies. */
export function maxTraitChoicesFor(
  bookChar: RemixCharacterEntry | undefined,
  supported: Set<TraitType> | null,
): RemixTraitChoice[] {
  return TRAIT_TYPES.map((type) => ({
    type,
    is_enabled:
      bookTraitGate(bookChar, type) && (supported ? supported.has(type) : true),
  }));
}

/** Collapse a draft RemixConfig to its DISPLAYED trait state (WYSIWYG):
 *  `is_enabled' = is_enabled ∧ bookGate ∧ profileSupported`. Pure — props /
 *  voices / languages pass through untouched. */
export function normalizeRemixConfigTraits(
  config: RemixConfig,
  bookChars: RemixCharacterEntry[],
  humans: Human[],
): RemixConfig {
  const bookByKey = new Map(bookChars.map((c) => [c.key, c]));
  return {
    ...config,
    characters: config.characters.map((entry) => {
      // ⚡2026-08-06 — a text-only personalize entry carries NO `traits` key
      // (presence = visual-availability marker). Leave it untouched — there is
      // no visual swap surface to mask.
      if (entry.traits == null) return entry;
      const bookChar = bookByKey.get(entry.key);
      const supported = supportedTraitSetFor(humans, entry.human_id, entry.visual);
      const traits: RemixTraitChoice[] = TRAIT_TYPES.map((type) => {
        // `?? false` mirrors the checkbox render (CharacterConfigRow), NOT the
        // DB-reader `?? true` — WYSIWYG persists what the user saw.
        const raw = entry.traits?.find((t) => t.type === type)?.is_enabled ?? false;
        return {
          type,
          is_enabled:
            raw &&
            bookTraitGate(bookChar, type) &&
            (supported ? supported.has(type) : true),
        };
      });
      return { ...entry, traits };
    }),
  };
}

// ── Full config normalization (create-remix save) ────────────────────────────

export interface NormalizeRemixConfigContext {
  bookRemix: BookRemix;
  castingAxes: CastingAxis[];
  branchSpreads: BranchSpreadOption[];
  poolSpreads: PoolSpreadOption[];
  humans: Human[];
}

/** Normalize the full draft before `onSave` (create-remix):
 *  1. `story.presets`  — one entry per LIVE casting axis (keep the chosen preset
 *     when it still exists, else the axis default). Axes that vanished while the
 *     modal was open are dropped naturally (we map over the current axes); axes
 *     with zero presets contribute nothing.
 *  2. `story.branches` — same rule over the live branch spreads.
 *  2b.`story.pool_spreads` — fill each LIVE pool spread by `spread_id` (missing →
 *     `is_enabled = option.is_default`); entries pointing at a spread no longer in
 *     options are DROPPED (dangling). Materialize-always: every option gets an entry.
 *  3. `characters`     — WYSIWYG trait mask (`normalizeRemixConfigTraits`);
 *     entries OUTSIDE the effective cast are KEPT (createRemix purges later).
 *  4. `memories` / `voices` / `languages` — passed through untouched.
 *  5. `props`          — NEVER emitted (reshape 2026-07-31).
 *  Pure — does not mutate `draft`. */
export function normalizeRemixConfig(
  draft: RemixConfig,
  ctx: NormalizeRemixConfigContext,
): RemixConfig {
  const { bookRemix, castingAxes, branchSpreads, poolSpreads, humans } = ctx;

  // 1. Story presets — fill/resolve over the current axes (drops vanished axes).
  const presets: RemixPresetChoice[] = [];
  for (const axis of castingAxes) {
    const existing = draft.story.presets.find((p) => p.axis_id === axis.id);
    const stillValid =
      existing !== undefined &&
      axis.presets.some((pr) => pr.id === existing.preset_id);
    const presetId = stillValid ? existing.preset_id : resolveDefaultPreset(axis)?.id;
    if (!presetId) continue; // axis with zero presets → no entry
    presets.push({ axis_id: axis.id, preset_id: presetId });
  }

  // 2. Story branches — same fill/resolve over the current branch spreads.
  const branches: RemixBranchChoice[] = [];
  for (const bs of branchSpreads) {
    const existing = draft.story.branches.find((b) => b.spread_id === bs.spread_id);
    const stillValid =
      existing !== undefined &&
      bs.branches.some((br) => br.section_id === existing.section_id);
    const sectionId = stillValid
      ? existing.section_id
      : (bs.branches.find((b) => b.is_default)?.section_id ??
        bs.branches[0]?.section_id);
    if (!sectionId) continue; // branch spread with zero branches → no entry
    branches.push({ spread_id: bs.spread_id, section_id: sectionId });
  }

  // 2b. Pool spreads — fill each live option (missing → default); dangling dropped
  //     naturally (we map over the current options, not the draft entries).
  const pool_spreads: RemixPoolSpreadChoice[] = [];
  for (const option of poolSpreads) {
    const existing = draft.story.pool_spreads.find((p) => p.spread_id === option.spread_id);
    pool_spreads.push({
      spread_id: option.spread_id,
      is_enabled: existing ? existing.is_enabled : option.is_default,
    });
  }

  // 3. Character traits — WYSIWYG mask; entries preserved (no purge here).
  const traitsNormalized = normalizeRemixConfigTraits(
    { ...draft, story: { presets, branches, pool_spreads } },
    bookRemix.characters,
    humans,
  );

  log.info('normalizeRemixConfig', 'normalized draft', {
    presetCount: presets.length,
    branchCount: branches.length,
    poolSpreadCount: pool_spreads.length,
    characterCount: traitsNormalized.characters.length,
  });

  // 5. props intentionally omitted — build the result explicitly (no spread of props).
  return {
    story: { presets, branches, pool_spreads },
    characters: traitsNormalized.characters,
    memories: traitsNormalized.memories,
    voices: traitsNormalized.voices,
    languages: traitsNormalized.languages,
  };
}
