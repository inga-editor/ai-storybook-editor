// remix-config-draft-helpers.ts — Pure reducers for the create-remix draft.
// Each takes a RemixConfig and returns a NEW RemixConfig (immutable) — no store,
// no I/O. Extracted from the modal so `remix-config-modal.tsx` stays < 500 LOC
// and the upsert logic is unit-testable in isolation.
//
// Identity keys: presets by `axis_id`, branches by `spread_id`, characters by
// `key`, voices by `key`, languages by `code`. Story choices ALWAYS resolve to a
// real id (the modal re-selects the DEFAULT preset/branch on "Choose one" —
// `null` is never stored).

import { TRAIT_TYPES } from '@/constants/trait-constants';
import type {
  RemixCharacterChoice,
  RemixConfig,
  RemixLanguageChoice,
  RemixMemoriesConfig,
  RemixVoiceChoice,
} from '@/types/remix';

/** Upsert the chosen preset for a casting axis (by `axis_id`). */
export function upsertPresetChoice(
  config: RemixConfig,
  axisId: string,
  presetId: string,
): RemixConfig {
  const presets = config.story.presets.some((p) => p.axis_id === axisId)
    ? config.story.presets.map((p) =>
        p.axis_id === axisId ? { ...p, preset_id: presetId } : p,
      )
    : [...config.story.presets, { axis_id: axisId, preset_id: presetId }];
  return { ...config, story: { ...config.story, presets } };
}

/** Upsert the chosen branch section for a branch spread (by `spread_id`). */
export function upsertBranchChoice(
  config: RemixConfig,
  spreadId: string,
  sectionId: string,
): RemixConfig {
  const branches = config.story.branches.some((b) => b.spread_id === spreadId)
    ? config.story.branches.map((b) =>
        b.spread_id === spreadId ? { ...b, section_id: sectionId } : b,
      )
    : [...config.story.branches, { spread_id: spreadId, section_id: sectionId }];
  return { ...config, story: { ...config.story, branches } };
}

/** Upsert the include flag for a pool spread (by `spread_id`). Immutable — mirrors
 *  `upsertBranchChoice`. */
export function upsertPoolSpreadChoice(
  config: RemixConfig,
  spreadId: string,
  isEnabled: boolean,
): RemixConfig {
  const pool_spreads = config.story.pool_spreads.some((p) => p.spread_id === spreadId)
    ? config.story.pool_spreads.map((p) =>
        p.spread_id === spreadId ? { ...p, is_enabled: isEnabled } : p,
      )
    : [...config.story.pool_spreads, { spread_id: spreadId, is_enabled: isEnabled }];
  return { ...config, story: { ...config.story, pool_spreads } };
}

/** Upsert a character choice (by `key`). A missing entry is initialized with all
 *  5 trait toggles enabled (book gate is re-applied by `normalizeRemixConfig` on
 *  save); the `patch` overrides any seeded field. */
export function upsertCharacterChoice(
  config: RemixConfig,
  key: string,
  patch: Partial<RemixCharacterChoice>,
): RemixConfig {
  const characters = config.characters.some((c) => c.key === key)
    ? config.characters.map((c) => (c.key === key ? { ...c, ...patch } : c))
    : [
        ...config.characters,
        {
          key,
          human_id: null,
          visual: null,
          traits: TRAIT_TYPES.map((type) => ({ type, is_enabled: true })),
          base_image_url: null,
          is_enabled: true,
          ...patch,
        },
      ];
  return { ...config, characters };
}

/** Upsert a voice choice (by `key`). Voice entries are seeded from book.voices,
 *  so a missing entry falls back to an empty-name disabled slot. */
export function upsertVoiceChoice(
  config: RemixConfig,
  key: string,
  patch: Partial<RemixVoiceChoice>,
): RemixConfig {
  const voices = config.voices.some((v) => v.key === key)
    ? config.voices.map((v) => (v.key === key ? { ...v, ...patch } : v))
    : [...config.voices, { key, name: '', voice_id: null, is_enabled: false, ...patch }];
  return { ...config, voices };
}

/** Upsert a language choice (by `code`). */
export function upsertLanguageChoice(
  config: RemixConfig,
  code: string,
  patch: Partial<RemixLanguageChoice>,
): RemixConfig {
  const languages = config.languages.some((l) => l.code === code)
    ? config.languages.map((l) => (l.code === code ? { ...l, ...patch } : l))
    : [...config.languages, { name: '', code, is_enabled: false, ...patch }];
  return { ...config, languages };
}

/** Patch the memories slice (master toggle / style; per-photo patches allowed). */
export function patchMemories(
  config: RemixConfig,
  patch: Partial<RemixMemoriesConfig>,
): RemixConfig {
  return { ...config, memories: { ...config.memories, ...patch } };
}
