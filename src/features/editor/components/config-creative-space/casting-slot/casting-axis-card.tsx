// casting-axis-card.tsx — Column 1 row of the Casting Slot panel. Shows the axis
// name + a read-only bullet preview of its actants (roles are edited only inside
// CastingAxisModal, design §3.1). Edit/delete reveal on hover and stop
// propagation so they never trigger the card's select.

import { Pencil, Trash2 } from 'lucide-react';
import type { CastingAxis } from '@/types/editor';
import { cn } from '@/utils/utils';

interface CastingAxisCardProps {
  axis: CastingAxis;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function CastingAxisCard({ axis, isSelected, onSelect, onEdit, onDelete }: CastingAxisCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group cursor-pointer rounded-md border p-3 transition-colors',
        isSelected ? 'border-primary bg-accent' : 'border-border hover:border-primary/60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={axis.name}>
          {axis.name || <span className="italic text-muted-foreground">Untitled axis</span>}
        </span>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            aria-label="Edit axis"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Delete axis"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {axis.actants.length > 0 && (
        <ul className="mt-1.5 list-inside list-disc space-y-0.5">
          {axis.actants.map((a) => (
            <li key={a.id} className="truncate text-xs text-muted-foreground" title={a.name}>
              {a.name || 'Untitled'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
