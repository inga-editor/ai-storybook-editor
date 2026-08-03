// pool-spread-card.tsx — One pool-spread row-card in the Story tab's Pools section.
// Layout (single line): checkbox · thumbnail (~64×40, placeholder icon when null) ·
// title (truncate) · ordinal badge on the right (only when `ordinal != null`).
// Checked = green border; unchecked = muted border + muted title. Pure — holds no
// data state, only renders props. The card carries NO ordinal state: `ordinal` is
// derived by the parent section at render time (position in the checked set), it
// is never persisted.

import { ImageIcon } from 'lucide-react';
import { cn } from '@/utils/utils';
import { Checkbox } from '@/components/ui/checkbox';
import type { PoolSpreadOption } from '@/types/remix';

interface Props {
  option: PoolSpreadOption;
  checked: boolean;
  /** Position in the CHECKED set (1-based); null when unchecked → no badge. NOT persisted. */
  ordinal: number | null;
  onToggle: (next: boolean) => void;
}

export function PoolSpreadCard({ option, checked, ordinal, onToggle }: Props) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border px-3 py-2 transition-colors',
        checked
          ? 'border-green-500 bg-green-500/5'
          : 'border-border bg-muted/30',
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`Include spread ${option.spread_number} (${option.title})`}
      />

      {/* Thumbnail (~64×40) or placeholder icon. */}
      <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {option.thumbnail_url ? (
          <img
            src={option.thumbnail_url}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
        )}
      </div>

      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          !checked && 'text-muted-foreground',
        )}
      >
        {option.title}
      </span>

      {ordinal != null && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500 text-[11px] font-medium text-white">
          {ordinal}
        </span>
      )}
    </div>
  );
}
