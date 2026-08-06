// character-parametric-row.tsx — one parametric-config block per character.
// Master toggle + 3 property checkboxes (name / gender / age) + age-range steppers.
// Controls stay mounted (never hidden): disabled + greyed when the character toggle
// is OFF, showing seed defaults as a preview (design §3.1, "disabled → grey, not hide").

import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';
import { AGE_HARD_LIMITS, DEFAULT_AGE_RANGE } from '../parametric-slot-helpers';
import { DEFAULT_ZODIAC, ZODIAC_SIGNS } from '@/constants/config-constants';
import type { ParametricCharacterEntry } from '@/types/editor';
import { cn } from '@/utils/utils';

interface CharacterParametricRowProps {
  characterName: string;
  enabled: boolean; // entry present in slot.characters[]
  entry: ParametricCharacterEntry | null; // null when disabled → preview seed defaults
  onToggle: (next: boolean) => void;
  onPropToggle: (prop: 'name' | 'gender' | 'age' | 'zodiac', next: boolean) => void;
  onAgeChange: (field: 'age_min' | 'age_max', value: number) => void;
  onZodiacChange: (value: number) => void;
}

export function CharacterParametricRow({
  characterName,
  enabled,
  entry,
  onToggle,
  onPropToggle,
  onAgeChange,
  onZodiacChange,
}: CharacterParametricRowProps) {
  // When disabled, show seed defaults (all checked, age 0..15) as a read-only preview.
  const nameChecked = enabled ? entry?.name != null : true;
  const genderChecked = enabled ? entry?.gender != null : true;
  const ageChecked = enabled ? entry?.age_min != null && entry?.age_max != null : true;
  const ageMin = enabled ? entry?.age_min ?? DEFAULT_AGE_RANGE.age_min : DEFAULT_AGE_RANGE.age_min;
  const ageMax = enabled ? entry?.age_max ?? DEFAULT_AGE_RANGE.age_max : DEFAULT_AGE_RANGE.age_max;
  const ageDisabled = !enabled || !ageChecked;
  const zodiacChecked = enabled ? entry?.zodiac != null : true;
  const zodiacValue = (enabled ? entry?.zodiac ?? DEFAULT_ZODIAC : DEFAULT_ZODIAC);
  const zodiacDisabled = !enabled || !zodiacChecked;

  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex items-center gap-3">
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={`Enable parametric config for ${characterName}`}
        />
        <span className="truncate text-sm font-medium">{characterName}</span>
      </div>

      <div className={cn('ml-12 flex flex-col gap-1.5', !enabled && 'opacity-50')}>
        <PropCheckbox
          label="name"
          checked={nameChecked}
          disabled={!enabled}
          onChange={(next) => onPropToggle('name', next)}
          ariaLabel={`Toggle name parameter for ${characterName}`}
        />
        <PropCheckbox
          label="gender"
          checked={genderChecked}
          disabled={!enabled}
          onChange={(next) => onPropToggle('gender', next)}
          ariaLabel={`Toggle gender parameter for ${characterName}`}
        />
        <div className="flex flex-wrap items-center gap-3">
          <PropCheckbox
            label="age"
            checked={ageChecked}
            disabled={!enabled}
            onChange={(next) => onPropToggle('age', next)}
            ariaLabel={`Toggle age parameter for ${characterName}`}
          />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Min</span>
            <NumberStepper
              value={ageMin}
              min={AGE_HARD_LIMITS.min}
              max={ageMax}
              step={1}
              disabled={ageDisabled}
              onChange={(v) => onAgeChange('age_min', v)}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Max</span>
            <NumberStepper
              value={ageMax}
              min={ageMin}
              max={AGE_HARD_LIMITS.max}
              step={1}
              disabled={ageDisabled}
              onChange={(v) => onAgeChange('age_max', v)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <PropCheckbox
            label="zodiac"
            checked={zodiacChecked}
            disabled={!enabled}
            onChange={(next) => onPropToggle('zodiac', next)}
            ariaLabel={`Toggle zodiac parameter for ${characterName}`}
          />
          <select
            className={cn(
              'h-7 rounded-md border border-input bg-background px-2 text-xs',
              zodiacDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            )}
            value={zodiacValue}
            disabled={zodiacDisabled}
            onChange={(e) => onZodiacChange(Number(e.target.value))}
            aria-label={`Zodiac sign for ${characterName}`}
          >
            {ZODIAC_SIGNS.map((sign) => (
              <option key={sign.value} value={sign.value}>
                {sign.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

interface PropCheckboxProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}

function PropCheckbox({ label, checked, disabled, onChange, ariaLabel }: PropCheckboxProps) {
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
