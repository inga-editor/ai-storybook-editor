// character-config-row.tsx — One flat character row in the Cast tab (config-only).
// Layout (single non-wrapping row @ 900px):
//   [Switch] [Name over @key] [Human ▼] [Visual ▼] [5 trait checkboxes]
//
// The synchronous live-swap action was removed (2026-06-08): appearance swap is
// now an async background job (api/jobs/02 sprite-swap) driven from the swap
// crop-sheet modal, NOT from this create-remix modal. This row only captures the
// per-character config (human/visual/traits) persisted into RemixConfig — the
// accordion / SwapBody / preview of the old CharacterSwapRow are gone.
//
// Enable chain: Human → Visual → Traits. Traits render in canonical TRAIT_TYPES
// order under a 2-layer gate (book gate + visual-support gate).
//
// `visualOptions` / `supportedTraits` are derived here via `useMemo` (deps:
// human_id, visual, humans) — NOT in the parent list — so the parent does not
// allocate a fresh array per row on every render.

import { useMemo } from 'react';
import { Switch } from '@/components/ui/switch';
import {
  SearchableDropdown,
  type SearchableDropdownOption,
} from '@/components/ui/searchable-dropdown';
import {
  VisualProfileDropdown,
  type VisualProfileOption,
} from './visual-profile-dropdown';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import { TRAIT_TYPES, TRAIT_LABELS } from '@/constants/trait-constants';
import type { Human, TraitType } from '@/types/human';
import type { RemixCharacterEntry } from '@/types/editor';
import type { RemixCharacterChoice } from '@/types/remix';
import { bookTraitGate, supportedTraitSetFor } from '../remix-config-normalize';

const log = createLogger('Editor', 'CharacterConfigRow');

export interface CharacterConfigRowProps {
  bookChar: RemixCharacterEntry;
  /** Parent (CharactersSection) inits a default when the draft entry is absent,
   *  so this is always a concrete choice. */
  entry: RemixCharacterChoice;
  humans: Human[];
  /** Shared human picker options — derived ONCE in the parent (deps: humans). */
  humanOptions: SearchableDropdownOption[];
  onToggle: (next: boolean) => void;
  onChangeHuman: (id: string | null) => void;
  onChangeVisual: (name: string | null) => void;
  onToggleTrait: (type: TraitType, next: boolean) => void;
}

export function CharacterConfigRow({
  bookChar,
  entry,
  humans,
  humanOptions,
  onToggle,
  onChangeHuman,
  onChangeVisual,
  onToggleTrait,
}: CharacterConfigRowProps) {
  const enabled = entry.is_enabled;
  const humanId = entry.human_id;
  const visual = entry.visual;
  const traits = entry.traits;

  // Visual options for the picked human — cascade source. Derived here (not in
  // parent) so the parent list doesn't allocate one array per row per render.
  const visualOptions = useMemo<VisualProfileOption[]>(() => {
    if (!humanId) return [];
    const human = humans.find((h) => h.id === humanId);
    if (!human) {
      // Stale human_id (removed from library) — render orphan, do NOT auto-reset
      // in render (React 19: no setState in render/effect). Reset happens when the
      // user re-picks, or in normalize-on-save.
      log.warn('visualOptions', 'stale human_id — not in library', {
        key: bookChar.key,
        humanId,
      });
      return [];
    }
    return human.visualProfiles.map((vp) => ({
      value: vp.name,
      label: vp.name,
      thumbnail: vp.convertedImage ?? vp.nobgImage ?? vp.rawImages[0] ?? null,
    }));
  }, [humanId, humans, bookChar.key]);

  // Traits the picked visual can swap (non-empty description); null = no visual.
  // Shared predicate (remix-config-normalize) — the same set masks traits when the
  // draft is normalized on save (WYSIWYG). Derived here for the same reason as
  // visualOptions.
  const supportedTraits = useMemo(
    () => supportedTraitSetFor(humans, humanId, visual),
    [humans, humanId, visual],
  );

  const traitsInteractive = enabled && !!humanId && !!visual;
  const visualSupports = (type: TraitType) =>
    supportedTraits ? supportedTraits.has(type) : true;

  return (
    <div
      className={cn(
        'flex flex-nowrap items-center gap-2 rounded-md border p-3',
        !enabled && 'opacity-40',
      )}
    >
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={`Toggle ${bookChar.name}`}
        role="switch"
        aria-checked={enabled}
      />

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">
          {bookChar.name}
        </div>
        <div className="truncate text-xs leading-tight text-muted-foreground">
          @{bookChar.key}
        </div>
      </div>

      <SearchableDropdown
        options={humanOptions}
        value={humanId}
        onChange={onChangeHuman}
        placeholder="Choose human"
        disabled={!enabled}
        className="w-[108px] shrink-0"
      />
      <VisualProfileDropdown
        options={visualOptions}
        value={visual}
        onChange={onChangeVisual}
        placeholder={humanId ? 'Choose visual' : 'Pick human'}
        disabled={!enabled || !humanId}
        className="w-[108px] shrink-0"
      />

      {/* Trait checkboxes — canonical order, 2-layer gate (book + visual support). */}
      <div className="flex shrink-0 items-center gap-x-2.5">
        {TRAIT_TYPES.map((type) => {
          const gated = bookTraitGate(bookChar, type);
          const supported = visualSupports(type);
          const checked = traits.find((t) => t.type === type)?.is_enabled ?? false;
          const disabled = !traitsInteractive || !gated || !supported;
          const title = !gated
            ? 'Disabled in book settings'
            : traitsInteractive && !supported
              ? 'No data for this trait'
              : undefined;
          return (
            <label
              key={type}
              className={cn(
                'flex items-center gap-1 text-xs',
                disabled && 'opacity-50',
              )}
              title={title}
            >
              <input
                type="checkbox"
                role="checkbox"
                checked={checked && gated && supported}
                disabled={disabled}
                aria-disabled={disabled}
                aria-label={TRAIT_LABELS[type]}
                onChange={(e) => onToggleTrait(type, e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              {TRAIT_LABELS[type]}
            </label>
          );
        })}
      </div>
    </div>
  );
}
