// actant-assign-row.tsx — Column 3 row: one role of the selected axis plus the
// actor bound to it in the selected preset. The role name is read-only here —
// roles are created/renamed/deleted only in CastingAxisModal so there is exactly
// one edit surface (design §4.6). Rows are never hidden: with no preset the
// dropdown renders disabled + greyed.

import type { ActorOption } from '../casting-slot-helpers';
import { ActorSelect } from './actor-select';

interface ActantAssignRowProps {
  actantName: string;
  option: ActorOption | null;
  options: ActorOption[];
  isDisabled: boolean;
  /** Non-null ⇒ dangling assignment (entity deleted from the snapshot). */
  danglingActorId: string | null;
  onChange: (next: ActorOption | null) => void;
}

export function ActantAssignRow({
  actantName,
  option,
  options,
  isDisabled,
  danglingActorId,
  onChange,
}: ActantAssignRowProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 flex-1 truncate text-sm" title={actantName}>
        {actantName || <span className="italic text-muted-foreground">Untitled</span>}
      </span>
      <ActorSelect
        options={options}
        value={option}
        isDisabled={isDisabled}
        danglingActorId={danglingActorId}
        onChange={onChange}
      />
    </div>
  );
}
