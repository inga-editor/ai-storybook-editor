// preset-row.tsx — Column 2 row of the Casting Slot panel. The ★ button is
// always visible (it carries the default-preset state); edit/delete reveal on
// hover. Delete has NO confirm — only axis deletion does (design §4.2).

import { Pencil, Star, Trash2 } from 'lucide-react';
import type { CastingPreset } from '@/types/editor';
import { cn } from '@/utils/utils';

interface PresetRowProps {
  preset: CastingPreset;
  isSelected: boolean;
  onSelect: () => void;
  onSetDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function PresetRow({
  preset,
  isSelected,
  onSelect,
  onSetDefault,
  onEdit,
  onDelete,
}: PresetRowProps) {
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
        'group flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors',
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-transparent bg-muted/40 hover:bg-muted/70',
      )}
    >
      <button
        type="button"
        aria-label={preset.is_default ? 'Default preset' : 'Set as default preset'}
        aria-pressed={preset.is_default}
        onClick={(e) => {
          e.stopPropagation();
          onSetDefault();
        }}
        className={cn(
          'shrink-0 rounded p-0.5 transition-all',
          preset.is_default
            ? 'text-primary'
            : 'text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
        )}
      >
        <Star className={cn('h-3.5 w-3.5', preset.is_default && 'fill-current')} />
      </button>

      <span className="min-w-0 flex-1 truncate text-sm" title={preset.name}>
        {preset.name || <span className="italic text-muted-foreground">Untitled preset</span>}
      </span>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          aria-label="Rename preset"
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
          aria-label="Delete preset"
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
  );
}
