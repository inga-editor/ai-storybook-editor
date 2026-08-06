// default-config-builder.ts — Pure helper to derive a fresh RemixConfig draft
// from 5 lookup sources: book.remix (gates), book.casting_slot (axes/presets),
// snapshot.illustration (branch spreads), book.parametric_slot (photo slots),
// and snapshot.characters (order source for the effective cast).
//
// Reshape 2026-07-31 (4-tab): + story (materialize-always) + memories; props no
// longer emitted (RemixConfig keeps the field optional so old rows still parse).

import type { BookRemix, CastingAxis, ParametricPhotoEntry } from '@/types/editor';
import type {
  BranchSpreadOption,
  PoolSpreadOption,
  RemixBranchChoice,
  RemixConfig,
  RemixPresetChoice,
} from '@/types/remix';
import { normalizeRemixTraits, MEMORY_STYLE_DEFAULT } from '@/constants/config-constants';
import { resolveDefaultPreset } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { resolveRemixCastSets } from '@/features/remix/effective-cast';
import { createLogger } from '@/utils/logger';

const log = createLogger('Util', 'RemixDefaultConfig');

export interface DefaultConfigInput {
  bookRemix: BookRemix;
  castingAxes: CastingAxis[];
  branchSpreads: BranchSpreadOption[];
  poolSpreads: PoolSpreadOption[];
  parametricPhotos: ParametricPhotoEntry[];
  /** `snapshot.characters[].key` in snapshot order — effective-cast order source. */
  snapshotCharacterKeys: string[];
}

/**
 * Build the initial RemixConfig draft opened by the create-remix modal.
 *
 * - `story` is seeded to defaults ALWAYS (materialize-always), even when the book
 *   gate is OFF — the clone pipeline still needs a full preset/branch selection.
 * - `characters` follow the EFFECTIVE cast of the default presets (not the raw
 *   book gate) so the CAST tab matches what will actually be cloned.
 * - `memories.photos` is the enabled ∩ present subset of `parametric_slot.photos`.
 * - `props` is intentionally NOT emitted.
 */
export function defaultConfigFromBookRemix(input: DefaultConfigInput): RemixConfig {
  const { bookRemix, castingAxes, branchSpreads, poolSpreads, parametricPhotos, snapshotCharacterKeys } = input;

  // 1. story.presets — one entry per axis with a resolvable default; axis with
  //    zero presets contributes no entry.
  const presets: RemixPresetChoice[] = [];
  for (const axis of castingAxes) {
    const def = resolveDefaultPreset(axis);
    if (!def) {
      log.debug('defaultConfigFromBookRemix', 'axis has no preset, skipped', { axisId: axis.id });
      continue;
    }
    presets.push({ axis_id: axis.id, preset_id: def.id });
  }

  // 2. story.branches — one entry per branch spread (default branch, else first).
  const branches: RemixBranchChoice[] = [];
  for (const bs of branchSpreads) {
    const section_id =
      bs.branches.find((b) => b.is_default)?.section_id ?? bs.branches[0]?.section_id;
    if (!section_id) {
      log.debug('defaultConfigFromBookRemix', 'branch spread has no branch, skipped', {
        spreadId: bs.spread_id,
      });
      continue;
    }
    branches.push({ spread_id: bs.spread_id, section_id });
  }

  // 2b. story.pool_spreads — one entry per pool spread, seeded to `pool.is_default`
  //     (materialize-always: seeded even when the spread_pool gate is OFF).
  const pool_spreads = poolSpreads.map((p) => ({
    spread_id: p.spread_id,
    is_enabled: p.is_default,
  }));

  const story = { presets, branches, pool_spreads };

  // 3. characters — PERSONALIZE set of the default presets (⚡2026-08-06: every
  // char with ≥1 param on gets a draft entry, not just the swap surface). Only
  // the VISUAL-swappable subset carries `traits` (+ dead `base_image_url`); a
  // text-only entry omits both (presence of `traits` = visual-availability marker).
  const bookCharByKey = new Map(bookRemix.characters.map((c) => [c.key, c]));
  const { personalizeKeys, swappableKeys } = resolveRemixCastSets({
    storyPresets: presets,
    castingAxes,
    bookRemix,
    snapshotCharacterKeys,
  });
  const swappable = new Set(swappableKeys);
  const characters = personalizeKeys.map((key) => {
    const base = { key, human_id: null, visual: null, is_enabled: true };
    if (!swappable.has(key)) return base; // text-only — no traits, no base_image_url
    return {
      ...base,
      base_image_url: null,
      // Clone the book character's trait gate (5 canonical entries); missing → true.
      // Reshape 2026-08-06 (phase 03): trait gates live under params.visual.traits.
      traits: normalizeRemixTraits(bookCharByKey.get(key)?.params.visual.traits).map((t) => ({
        type: t.type,
        is_enabled: t.is_enabled,
      })),
    };
  });

  // 4. memories — enabled ∩ present photo slots; style global default; url null.
  const photoKeys = new Set(parametricPhotos.map((p) => p.key));
  const memories = {
    is_enabled: bookRemix.memories.is_enabled,
    style: MEMORY_STYLE_DEFAULT,
    photos: bookRemix.memories.photos
      .filter((p) => p.is_enabled && photoKeys.has(p.key))
      .map((p) => ({ key: p.key, is_enabled: true, media_url: null })),
  };

  // 5. voices / languages — unchanged (enabled book entries, voice_id chosen later).
  const voices = bookRemix.voices
    .filter((v) => v.is_enabled)
    .map((v) => ({ key: v.key, name: v.name, voice_id: null, is_enabled: true }));
  const languages = bookRemix.languages
    .filter((l) => l.is_enabled)
    .map((l) => ({ name: l.name, code: l.code, is_enabled: true }));

  log.info('defaultConfigFromBookRemix', 'built draft', {
    presetCount: presets.length,
    branchCount: branches.length,
    poolSpreadCount: pool_spreads.length,
    characterCount: characters.length,
    memoryPhotoCount: memories.photos.length,
    voiceCount: voices.length,
    languageCount: languages.length,
  });

  // NOTE: props intentionally NOT emitted (reshape 2026-07-31).
  return { story, characters, memories, voices, languages };
}

export function isBookRemixEmpty(book: BookRemix | null): boolean {
  if (!book) return true;
  // Reshape 2026-07-31: story + memories gates now count toward "configured".
  return (
    !book.story.preset.is_enabled &&
    !book.story.branch.is_enabled &&
    !book.story.spread_pool.is_enabled &&
    !book.memories.is_enabled &&
    book.voices.every((v) => !v.is_enabled) &&
    book.characters.every((c) => !c.is_enabled) &&
    book.languages.every((l) => !l.is_enabled)
  );
}
