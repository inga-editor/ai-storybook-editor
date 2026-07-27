// actor-select.tsx — Grouped actor dropdown for column 3 of the Casting Slot
// panel. Deliberately Radix `Select` (not the config-space `SearchableDropdown`)
// because CHARACTERS / PROPS group headers are a hard requirement of design §2.4
// and that primitive has no group support; search is not required (per-book
// entity lists are small). Validation S1 Q2.
//
// The Select value is a string, so (actor_type, actor_id) is encoded into one
// key. "None" uses the `__none__` sentinel — Radix treats '' as "no value" and
// would render the placeholder instead of a selectable item.

import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ActorOption } from '../casting-slot-helpers';
import { cn } from '@/utils/utils';

const ACTOR_NONE_VALUE = '__none__';

function encodeActorValue(option: ActorOption): string {
  return `${option.actor_type}:${option.actor_id}`;
}

interface ActorSelectProps {
  options: ActorOption[];
  value: ActorOption | null;
  isDisabled: boolean;
  /** Non-null ⇒ the stored assignment points at an entity that no longer exists. */
  danglingActorId: string | null;
  onChange: (next: ActorOption | null) => void;
}

export function ActorSelect({
  options,
  value,
  isDisabled,
  danglingActorId,
  onChange,
}: ActorSelectProps) {
  const groups = React.useMemo(
    () => ({
      characters: options.filter((o) => o.group === 'characters'),
      props: options.filter((o) => o.group === 'props'),
    }),
    [options],
  );

  const selectedValue =
    danglingActorId != null || !value ? ACTOR_NONE_VALUE : encodeActorValue(value);

  const handleValueChange = (next: string) => {
    if (next === ACTOR_NONE_VALUE) {
      onChange(null);
      return;
    }
    // Resolve back through the option list instead of parsing the key, so
    // actor_type never drifts from its literal union.
    onChange(options.find((o) => encodeActorValue(o) === next) ?? null);
  };

  return (
    <Select value={selectedValue} onValueChange={handleValueChange} disabled={isDisabled}>
      <SelectTrigger
        className={cn(
          'h-7 max-w-[60%] shrink-0 gap-1 border-0 bg-transparent px-0 text-sm font-medium shadow-none',
          'hover:text-foreground focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0',
          isDisabled && 'opacity-50',
        )}
        aria-label="Actor"
      >
        {danglingActorId != null ? (
          <span className="truncate text-xs text-muted-foreground">
            ⚠ Missing actor ({danglingActorId})
          </span>
        ) : (
          <SelectValue placeholder="None" />
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ACTOR_NONE_VALUE} className="text-xs">
          None
        </SelectItem>
        {groups.characters.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-xs">CHARACTERS</SelectLabel>
            {groups.characters.map((o) => (
              <SelectItem key={encodeActorValue(o)} value={encodeActorValue(o)} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {groups.props.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-xs">PROPS</SelectLabel>
            {groups.props.map((o) => (
              <SelectItem key={encodeActorValue(o)} value={encodeActorValue(o)} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
