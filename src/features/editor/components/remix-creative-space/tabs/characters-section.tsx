// characters-section.tsx — Characters list of the Cast tab. Renders one
// CharacterConfigRow per effective-cast row (`castRows`, derived by the modal
// from the chosen story presets). Config-only (human/visual/traits) — the
// appearance swap itself is an async job triggered from the swap crop-sheet modal.
//
// Rows are DERIVED props — this section never computes the effective cast. When a
// row has no draft entry yet it inits a display-only default (all traits on);
// the first user interaction persists a real entry via `onUpsertCharacter`.

import { useMemo } from 'react';
import type { SearchableDropdownOption } from '@/components/ui/searchable-dropdown';
import type { Human, TraitType } from '@/types/human';
import type { RemixCharacterEntry } from '@/types/editor';
import type { RemixCharacterChoice } from '@/types/remix';
import { TRAIT_TYPES } from '@/constants/trait-constants';
import { createLogger } from '@/utils/logger';
import {
  maxTraitChoicesFor,
  supportedTraitSetFor,
} from '../remix-config-normalize';
import { CharacterConfigRow } from './character-config-row';
import type { RemixCastRow } from '../remix-config-modal';

const log = createLogger('Editor', 'CharactersSection');

interface Props {
  castRows: RemixCastRow[];
  humans: Human[];
  onUpsertCharacter: (key: string, patch: Partial<RemixCharacterChoice>) => void;
}

/** Display-only default choice for a row that has no draft entry yet. Mirrors the
 *  seed in `upsertCharacterChoice`; not written to the draft until the user acts. */
function initCharacterChoice(key: string): RemixCharacterChoice {
  return {
    key,
    human_id: null,
    visual: null,
    traits: TRAIT_TYPES.map((type) => ({ type, is_enabled: true })),
    base_image_url: null,
    is_enabled: true,
  };
}

/** Fallback book character when the effective-cast key is missing from
 *  book.characters (data error) — keeps the row visible instead of crashing. */
function fallbackBookChar(key: string): RemixCharacterEntry {
  return {
    key,
    name: key,
    is_enabled: true,
    traits: TRAIT_TYPES.map((type) => ({ type, is_enabled: true })),
  };
}

export function CharactersSection({ castRows, humans, onUpsertCharacter }: Props) {
  // Human picker options — derived ONCE here (deps: humans) and shared across
  // every row, so the per-row list stays allocation-free on render.
  const humanOptions = useMemo<SearchableDropdownOption[]>(
    () => humans.map((h) => ({ value: h.id, label: h.sourceName || h.id })),
    [humans],
  );

  if (castRows.length === 0) {
    log.debug('CharactersSection', 'empty effective cast', {});
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Enable characters in book remix settings first
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {castRows.map((row) => {
        const bookChar = row.bookEntry ?? fallbackBookChar(row.key);
        if (!row.bookEntry) {
          log.warn('CharactersSection', 'cast key missing from book characters', {
            key: row.key,
          });
        }
        const entry = row.draftEntry ?? initCharacterChoice(row.key);
        return (
          <CharacterConfigRow
            key={row.key}
            bookChar={bookChar}
            entry={entry}
            humans={humans}
            humanOptions={humanOptions}
            onToggle={(next) => onUpsertCharacter(row.key, { is_enabled: next })}
            // Cascade: changing the human clears the visual (its options depend on
            // the human) AND resets traits to the max checkable set (no profile yet
            // → book gate only). Prior ticks discarded by design (2026-06-10).
            onChangeHuman={(id) =>
              onUpsertCharacter(row.key, {
                human_id: id,
                visual: null,
                traits: maxTraitChoicesFor(bookChar, null),
              })
            }
            // Picking a visual resets traits to everything that profile can swap
            // (∧ book gate) — default-max, prior ticks discarded.
            onChangeVisual={(name) =>
              onUpsertCharacter(row.key, {
                visual: name,
                traits: maxTraitChoicesFor(
                  bookChar,
                  supportedTraitSetFor(humans, entry.human_id, name),
                ),
              })
            }
            onToggleTrait={(type: TraitType, next: boolean) =>
              onUpsertCharacter(row.key, {
                traits: entry.traits.map((t) =>
                  t.type === type ? { ...t, is_enabled: next } : t,
                ),
              })
            }
          />
        );
      })}
    </div>
  );
}
