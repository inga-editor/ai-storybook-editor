// supabase-mapping.ts — Convert raw Supabase row → Remix domain type.
// JSONB columns come back as `unknown`-shaped objects; narrow defensively.

import type {
  Remix,
  RemixCharacter,
  RemixCharacterChoice,
  RemixConfig,
  RemixIllustration,
  RemixMemoriesConfig,
  RemixMix,
  RemixProp,
  RemixSpriteEntry,
  RemixStageBatchRow,
  RemixStoryConfig,
} from '@/types/remix';
import type { Distribution } from '@/types/editor';
import { MEMORY_STYLE_DEFAULT } from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'SupabaseMapping');

interface RawRemixRow {
  id: string;
  snapshot_id: string;
  name?: string | null;
  remix_config?: unknown;
  illustration?: unknown;
  characters?: unknown;
  props?: unknown;
  mixes?: unknown;
  rmbgs?: unknown;
  upscales?: unknown;
  sprites?: unknown;
  distribution?: unknown;
  created_at: string;
  updated_at: string;
}

const EMPTY_ILLUSTRATION: RemixIllustration = { spreads: [], sections: [] };
const EMPTY_STORY: RemixStoryConfig = { presets: [], branches: [] };
const EMPTY_MEMORIES: RemixMemoriesConfig = {
  is_enabled: false,
  style: MEMORY_STYLE_DEFAULT,
  photos: [],
};
const EMPTY_CONFIG: RemixConfig = {
  story: EMPTY_STORY,
  characters: [],
  memories: EMPTY_MEMORIES,
  voices: [],
  languages: [],
};

/** Legacy seed — pre-amend rows hold the invariant roster == swappable, so a
 *  config that predates (or lost) `characters[]` reconstructs its swappable
 *  set from the cloned roster. Keeps `remix_config.characters[]` the single
 *  swap-surface authority (crop grouping, sprite scope) without starving
 *  legacy rows of every character crop. */
function seedLegacyCharacterChoices(
  roster: RemixCharacter[],
): RemixCharacterChoice[] {
  return roster.map((c) => ({
    key: c.key,
    human_id: null,
    visual: null,
    traits: [], // readers tolerate missing entries → enabled
    base_image_url: null,
    is_enabled: true,
  }));
}

/**
 * Read-time tolerance for pre-2026-07-31 `remix_config` rows. The 4-tab reshape
 * (RemixConfigModal) ADDED required `story` + `memories`; legacy rows omit both.
 * Coerce them to safe defaults at ingress so every downstream consumer sees the
 * full `RemixConfig` shape and never has to `?? default` its own reads.
 * `props` is intentionally NOT coerced — it stays optional/deprecated (new rows
 * never emit it; consumers read via `?? []`).
 * `rosterCharacters` (amend 2026-07-31): when `characters` is ABSENT (legacy /
 * invalid config) it is seeded from the row's roster — see
 * `seedLegacyCharacterChoices`. An explicit `[]` is a legitimate post-amend
 * value (empty swappable set) and is NOT reseeded.
 */
export function readRemixConfig(
  raw: unknown,
  rosterCharacters: RemixCharacter[] = [],
): RemixConfig {
  if (!raw || typeof raw !== 'object') {
    log.warn('readRemixConfig', 'missing/invalid remix_config, using EMPTY + roster-seeded characters', {
      rosterCount: rosterCharacters.length,
    });
    return {
      ...EMPTY_CONFIG,
      characters: seedLegacyCharacterChoices(rosterCharacters),
    };
  }
  const cfg = raw as Partial<RemixConfig>;
  const coercedStory = !cfg.story;
  const coercedMemories = !cfg.memories;
  const coercedCharacters = cfg.characters === undefined;
  if (coercedStory || coercedMemories) {
    log.debug('readRemixConfig', 'coerced legacy config field(s)', {
      coercedStory,
      coercedMemories,
    });
  }
  if (coercedCharacters) {
    log.warn('readRemixConfig', 'legacy config without characters — seeded from roster', {
      rosterCount: rosterCharacters.length,
    });
  }
  return {
    story: cfg.story ?? EMPTY_STORY,
    characters: cfg.characters ?? seedLegacyCharacterChoices(rosterCharacters),
    memories: cfg.memories ?? EMPTY_MEMORIES,
    voices: cfg.voices ?? [],
    languages: cfg.languages ?? [],
    props: cfg.props,
  };
}

/**
 * Read-time shim for pre-2026-06-12 JSONB rows: `crop_sheets[].crops[]` was
 * renamed to `original_crops[]` on every batch column (mixes/rmbgs/upscales/
 * sprites) with NO data migration — shape change only (DB-CHANGELOG
 * 2026-06-12). Rename the key at ingress so downstream readers never see the
 * legacy shape; the row self-heals on its next full-column persist.
 */
function normalizeLegacyCropSheets<T>(rows: unknown, column: string): T[] {
  if (!Array.isArray(rows)) return [];
  let migrated = 0;
  for (const row of rows) {
    const sheets = (row as { crop_sheets?: unknown }).crop_sheets;
    if (!Array.isArray(sheets)) continue;
    for (const sheet of sheets) {
      const s = sheet as { original_crops?: unknown; crops?: unknown };
      if (s.original_crops === undefined && Array.isArray(s.crops)) {
        s.original_crops = s.crops;
        delete s.crops;
        migrated += 1;
      }
    }
  }
  if (migrated > 0) {
    log.warn('normalizeLegacyCropSheets', 'renamed legacy crops[] key at read', {
      column,
      sheets: migrated,
    });
  }
  return rows as T[];
}

export function mapRowToRemix(row: RawRemixRow): Remix {
  const characters = (row.characters as RemixCharacter[] | null) ?? [];
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    name: row.name ?? 'New Remix',
    remix_config: readRemixConfig(row.remix_config, characters),
    illustration: (row.illustration as RemixIllustration | null) ?? EMPTY_ILLUSTRATION,
    characters,
    props: (row.props as RemixProp[] | null) ?? [],
    mixes: normalizeLegacyCropSheets<RemixMix>(row.mixes, 'mixes'),
    // Stage 2/3 pipeline columns (⚡2026-06-12) — additive JSONB; legacy rows
    // omit them. Same row shape as mixes[].
    rmbgs: normalizeLegacyCropSheets<RemixStageBatchRow>(row.rmbgs, 'rmbgs'),
    upscales: normalizeLegacyCropSheets<RemixStageBatchRow>(row.upscales, 'upscales'),
    // Sprite plane (Variants tab) — additive JSONB; legacy rows omit it.
    sprites: normalizeLegacyCropSheets<RemixSpriteEntry>(row.sprites, 'sprites'),
    // Nullable JSONB — reader coalesces to DEFAULT at render (KISS: no
    // normalize at ingress; shape is small + tolerated downstream).
    distribution: (row.distribution as Distribution | null) ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
