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
import { CHARACTER_PARAM_LABELS } from '@/constants/config-constants';
import type { ParamPreview } from '../cast-param-preview';

const log = createLogger('Editor', 'CharacterConfigRow');

export interface CharacterConfigRowProps {
  bookChar: RemixCharacterEntry;
  /** Parent (CharactersSection) inits a default when the draft entry is absent,
   *  so this is always a concrete choice. */
  entry: RemixCharacterChoice;
  /** ⚡2026-08-06 — false = TEXT-ONLY row: no trait cluster; Human/Visual picker
   *  stays active (the profile still fixes `age`). */
  isVisualActive: boolean;
  /** ⚡2026-08-06 — display-only derived value chips (name/gender/age/zodiac). */
  paramPreview: ParamPreview;
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
  isVisualActive,
  paramPreview,
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
  const traits = entry.traits ?? [];

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
        {/* ParamPreview chips — only params with the book gate ON. Value derives
            from the picked human/profile; unpicked → "—" (execution falls back to
            the character's original value). Display-only, never persisted. */}
        <ParamPreviewChips preview={paramPreview} />
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

      {/* Trait checkboxes — canonical order, 2-layer gate (book + visual support).
          ⚡2026-08-06: rendered ONLY for a visual-active row; a text-only row
          stops at the Visual picker (no traits, presence-marker semantics). */}
      {isVisualActive && (
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
      )}
    </div>
  );
}

/** Read-only value chips for the 4 personalize params (name/gender/age/zodiac).
 *  Renders one chip per param whose BOOK gate is ON; value or "—" when unpicked.
 *  ⚡2026-08-06 — display-only, never written to `remix_config`. Exported for the
 *  read-only SwapConfigReviewModal (same chips over the frozen config). */
export function ParamPreviewChips({ preview }: { preview: ParamPreview }) {
  const chips: Array<{ key: keyof ParamPreview; value: string }> = [];
  if (preview.name.enabled) chips.push({ key: 'name', value: preview.name.value ?? '—' });
  if (preview.gender.enabled) chips.push({ key: 'gender', value: preview.gender.value ?? '—' });
  if (preview.age.enabled) {
    chips.push({ key: 'age', value: preview.age.value != null ? String(preview.age.value) : '—' });
  }
  if (preview.zodiac.enabled) chips.push({ key: 'zodiac', value: preview.zodiac.value ?? '—' });
  if (chips.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-tight text-muted-foreground">
      {chips.map((c) => (
        <span key={c.key}>
          {CHARACTER_PARAM_LABELS[c.key]}: {c.value}
        </span>
      ))}
    </div>
  );
}
