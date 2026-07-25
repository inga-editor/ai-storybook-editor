// photo-parametric-row.tsx — one horizontal row per photo slot: per-slot Switch +
// read-only auto key label (photo_N) + 3 variant-mode checkboxes (original / real /
// styled) + delete. Toggle OFF greys the checkboxes but shows the REAL persisted
// flags (config is kept — unlike CharacterParametricRow's seed preview); delete
// stays active so a disabled slot can still be removed (design §3.2).

import { Switch } from '@/components/ui/switch';
import { Trash2 } from 'lucide-react';
import type { ParametricPhotoEntry } from '@/types/editor';
import { cn } from '@/utils/utils';

export type PhotoFlag = 'original' | 'real' | 'styled';

const PHOTO_FLAGS: ReadonlyArray<PhotoFlag> = ['original', 'real', 'styled'];

interface PhotoParametricRowProps {
  entry: ParametricPhotoEntry;
  onToggle: (next: boolean) => void;
  onFlagToggle: (flag: PhotoFlag, next: boolean) => void;
  onDelete: () => void;
}

export function PhotoParametricRow({ entry, onToggle, onFlagToggle, onDelete }: PhotoParametricRowProps) {
  const disabled = !entry.is_enabled;

  return (
    <div className="flex items-center gap-3 py-2">
      <Switch
        checked={entry.is_enabled}
        onCheckedChange={onToggle}
        aria-label={`Enable photo slot ${entry.key}`}
      />
      <span className={cn('w-20 truncate text-sm font-medium', disabled && 'opacity-50')}>
        {entry.key}
      </span>

      <div className={cn('flex flex-1 flex-wrap items-center gap-3', disabled && 'opacity-50')}>
        {PHOTO_FLAGS.map((flag) => (
          <label
            key={flag}
            className={cn(
              'flex items-center gap-1.5 text-xs',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer',
            )}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={entry[flag]}
              disabled={disabled}
              onChange={(e) => onFlagToggle(flag, e.target.checked)}
              aria-label={`Toggle ${flag} mode for ${entry.key}`}
            />
            {flag}
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete photo slot ${entry.key}`}
        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
