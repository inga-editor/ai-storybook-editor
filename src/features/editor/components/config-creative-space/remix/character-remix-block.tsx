// character-remix-block.tsx — one vertical block per character on the CAST tab.
// Master toggle + name, then a vertical list of per-param checkboxes
// (name / gender / age / zodiac / visual). The `visual` param carries the 5
// canonical trait checkboxes right after it.
//
// Disabled cascade (2 tiers, never hidden — feedback "never hide disabled UI"):
//   - master OFF (!checked)              → grey + disable the whole param column.
//   - visual param OFF (!params.visual.is_enabled) → grey + disable ONLY the traits.
// Renamed 2026-08-06 from character-remix-row.tsx (single-row + 5 traits) → block.

import { Switch } from '@/components/ui/switch';
import { CHARACTER_PARAM_KEYS, CHARACTER_PARAM_LABELS } from '@/constants/config-constants';
import { TRAIT_TYPES, TRAIT_LABELS } from '@/constants/trait-constants';
import type { CharacterParamKey, RemixCharacterParams } from '@/types/editor';
import type { TraitType } from '@/types/human';
import { cn } from '@/utils/utils';

interface CharacterRemixBlockProps {
  name: string;
  checked: boolean; // master row toggle (is_enabled)
  params: RemixCharacterParams; // normalized (5 params; visual has 5 traits)
  onToggle: (next: boolean) => void;
  onParamToggle: (key: CharacterParamKey, next: boolean) => void;
  onTraitToggle: (type: TraitType, next: boolean) => void;
}

export function CharacterRemixBlock({
  name,
  checked,
  params,
  onToggle,
  onParamToggle,
  onTraitToggle,
}: CharacterRemixBlockProps) {
  const masterOff = !checked;
  const visualOn = params.visual.is_enabled;
  // Traits are greyed when the master OR the visual param is off (tier-2 cascade).
  const traitsDisabled = masterOff || !visualOn;

  return (
    <div className="flex flex-col gap-1.5 border-b py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <Switch checked={checked} onCheckedChange={onToggle} aria-label={`Toggle remix for ${name}`} />
        <span className="truncate text-sm font-medium">{name}</span>
      </div>

      <div className={cn('ml-12 flex flex-col gap-1.5', masterOff && 'opacity-50')}>
        {CHARACTER_PARAM_KEYS.map((key) => {
          if (key === 'visual') {
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <ParamCheckbox
                  label={CHARACTER_PARAM_LABELS.visual}
                  checked={visualOn}
                  disabled={masterOff}
                  onChange={(next) => onParamToggle('visual', next)}
                  ariaLabel={`Toggle visual parameter for ${name}`}
                />
                <div
                  className={cn(
                    'ml-6 flex flex-wrap items-center gap-x-4 gap-y-1',
                    !masterOff && !visualOn && 'opacity-50',
                  )}
                >
                  {TRAIT_TYPES.map((type) => {
                    const traitChecked = params.visual.traits.find((t) => t.type === type)?.is_enabled ?? true;
                    return (
                      <ParamCheckbox
                        key={type}
                        label={TRAIT_LABELS[type]}
                        checked={traitChecked}
                        disabled={traitsDisabled}
                        onChange={(next) => onTraitToggle(type, next)}
                        ariaLabel={`${TRAIT_LABELS[type]} trait for ${name}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          }
          return (
            <ParamCheckbox
              key={key}
              label={CHARACTER_PARAM_LABELS[key]}
              checked={params[key].is_enabled}
              disabled={masterOff}
              onChange={(next) => onParamToggle(key, next)}
              ariaLabel={`Toggle ${key} parameter for ${name}`}
            />
          );
        })}
      </div>
    </div>
  );
}

interface ParamCheckboxProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}

function ParamCheckbox({ label, checked, disabled, onChange, ariaLabel }: ParamCheckboxProps) {
  return (
    <label
      className={cn(
        'flex w-fit items-center gap-1.5 text-xs',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      {label}
    </label>
  );
}
