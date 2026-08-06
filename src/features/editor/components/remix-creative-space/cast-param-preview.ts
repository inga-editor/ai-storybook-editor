// cast-param-preview.ts — Derive the DISPLAY-ONLY ParamPreview for a Cast-tab
// row (⚡2026-08-06 per-param personalize). `remix_config` NEVER stores
// name/gender/age/zodiac VALUES — they derive-at-execution from `human_id`. This
// preview is a read-only mirror of what the execution layer WILL resolve, shown
// as chips next to the row. Pure — no store, no persist.
//
//   - `enabled` per param = the BOOK gate (`bookChar.params.{p}.is_enabled`);
//     only enabled params render a chip.
//   - `value`   = derived from the chosen human/profile; null (chip "—") until a
//     human (and, for `age`, a visual profile) is picked. The execution layer
//     falls back to the character's ORIGINAL value in that case.

import { normalizeParams, ZODIAC_SIGNS } from '@/constants/config-constants';
import type { Human } from '@/types/human';
import type { RemixCharacterEntry } from '@/types/editor';
import type { RemixCharacterChoice } from '@/types/remix';

/** Display-only preview of the 4 personalize params (visual has no value chip —
 *  it is the trait cluster). Never persisted into `remix_config`. */
export interface ParamPreview {
  name: { enabled: boolean; value: string | null };
  gender: { enabled: boolean; value: string | null };
  age: { enabled: boolean; value: number | null };
  zodiac: { enabled: boolean; value: string | null };
}

/** Map `humans.gender` (0/1/null) → label; null (unspecified) → null (chip "—"). */
function genderLabel(gender: Human['gender']): string | null {
  if (gender === 0) return 'Female';
  if (gender === 1) return 'Male';
  return null;
}

/**
 * Build the ParamPreview for one cast row.
 *
 * @param bookEntry  book character (per-param gates); undefined → all-on (legacy).
 * @param entry      draft choice (human_id / visual); undefined → nothing picked.
 * @param humans     live humans cache.
 */
export function buildParamPreview(
  bookEntry: RemixCharacterEntry | undefined,
  entry: RemixCharacterChoice | undefined,
  humans: Human[],
): ParamPreview {
  const params = normalizeParams(bookEntry ?? {});

  const human = entry?.human_id
    ? (humans.find((h) => h.id === entry.human_id) ?? null)
    : null;
  const profile =
    human && entry?.visual
      ? (human.visualProfiles.find((vp) => vp.name === entry.visual) ?? null)
      : null;

  const zodiacValue =
    human && human.zodiac != null
      ? (ZODIAC_SIGNS.find((z) => z.value === human.zodiac)?.label ?? null)
      : null;

  return {
    // name derives from the human's source name (display_name[lang] resolves at
    // execution per language; the preview is language-agnostic → source name).
    name: { enabled: params.name.is_enabled, value: human ? human.sourceName || null : null },
    gender: { enabled: params.gender.is_enabled, value: human ? genderLabel(human.gender) : null },
    age: { enabled: params.age.is_enabled, value: profile ? profile.age : null },
    zodiac: { enabled: params.zodiac.is_enabled, value: zodiacValue },
  };
}
