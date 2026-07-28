// parametric-value-row.tsx — ONE row of the VALUES sidebar (design README §3, mock
// screenshots/parametric-slot-modal.png). Presentational: label + DEFAULT badge + version
// count + ⋮ overflow menu ("Set as default" / "Clear images"). The shell owns every write.
//
// ⚠ Radix coupling (memory radix_dropdown_modal_*): the ⋮ menu is a Popover, which PORTALS
// to <body> — outside the modal's DialogContent. Two consequences handled here:
//   1. CSS custom properties do NOT reach the portaled node → SWAP_MODAL_TOKENS must be
//      re-spread on the content's `style`, and the surface needs an OPAQUE bg
//      (--swap-modal-card-bg), otherwise the menu renders transparent over the canvas.
//   2. The content z-index must clear the full-screen modal (Z_INDEX.selectDropdown = 4100);
//      the shell additionally registers `[data-radix-popper-content-wrapper]` in its ILS
//      `dropdownSelectors` so clicking an item is not routed as a click-outside.

import { MoreVertical, Star, TriangleAlert } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import { PARAMETRIC_PORTAL_MENU_STYLE } from './parametric-slot-modal-constants';
import type { ParametricValueRowData } from './parametric-slot-utils';

const log = createLogger('Editor', 'ParametricValueRow');

/** Row height — shared with the shell's scroll math. */
export const VALUE_ROW_HEIGHT_PX = 40;

const MENU_ITEM_CLASS =
  'flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-[var(--swap-modal-text-secondary)] transition-colors hover:bg-[var(--swap-modal-surface-hover)] hover:text-[var(--swap-modal-text-primary)] disabled:cursor-not-allowed disabled:opacity-40';

export interface ParametricValueRowProps {
  row: ParametricValueRowData;
  isSelected: boolean;
  /** Menu open state is lifted so only ONE row menu can be open at a time. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** Collab/busy gate — false ⇒ the mutating menu items render disabled, never hidden. */
  canEdit: boolean;
  onSelect: (value: string) => void;
  onSetDefault: (value: string) => void;
  onClearImages: (value: string) => void;
}

export function ParametricValueRow({
  row,
  isSelected,
  menuOpen,
  onMenuOpenChange,
  canEdit,
  onSelect,
  onSetDefault,
  onClearImages,
}: ParametricValueRowProps) {
  // "Set as default" on a dangling value would make the item default to a value the reader
  // config can never produce → disabled (still shown, per never-hide-disabled-UI).
  const canSetDefault = canEdit && !row.isDefault && !row.isDangling;
  const canClear = canEdit && row.count > 0;

  return (
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      // Scroll anchor for the shell's ↑/↓ navigation (see parametric-values-sidebar.tsx).
      data-value={row.value}
      onClick={() => onSelect(row.value)}
      style={{ height: VALUE_ROW_HEIGHT_PX }}
      className={cn(
        'group flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm transition-colors',
        isSelected
          ? 'border-[var(--swap-modal-accent)] bg-[var(--swap-modal-selection)] text-[var(--swap-modal-text-primary)]'
          : 'border-transparent bg-[var(--swap-modal-surface)] text-[var(--swap-modal-text-secondary)] hover:bg-[var(--swap-modal-surface-hover)]',
      )}
    >
      {row.isDangling && (
        <TriangleAlert
          className="h-3.5 w-3.5 shrink-0 text-amber-400"
          aria-label="Giá trị không còn trong config"
        />
      )}
      <span className="min-w-0 flex-1 truncate" title={row.label}>
        {row.label}
      </span>

      {row.count > 0 && (
        <span className="shrink-0 text-xs text-[var(--swap-modal-text-muted)]">
          ({row.count})
        </span>
      )}

      {row.isDefault && (
        <span
          aria-label="giá trị mặc định"
          className="shrink-0 rounded bg-[var(--swap-modal-accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
        >
          Default
        </span>
      )}

      <Popover open={menuOpen} onOpenChange={onMenuOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${row.label}`}
            onClick={(e) => e.stopPropagation()}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--swap-modal-text-muted)] opacity-0 transition-opacity hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] focus:opacity-100 focus:outline-none group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="bottom"
          style={PARAMETRIC_PORTAL_MENU_STYLE}
          onClick={(e) => e.stopPropagation()}
          className="w-48 border-[var(--swap-modal-border)] p-1 text-[var(--swap-modal-text-primary)]"
        >
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            disabled={!canSetDefault}
            onClick={() => {
              log.debug('onSetDefault', 'menu action', { value: row.value });
              onSetDefault(row.value);
              onMenuOpenChange(false);
            }}
          >
            <Star className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Set as default
          </button>
          <button
            type="button"
            className={cn(MENU_ITEM_CLASS, 'text-red-400 hover:text-red-300')}
            disabled={!canClear}
            onClick={() => {
              log.debug('onClearImages', 'menu action', { value: row.value, count: row.count });
              onClearImages(row.value);
              onMenuOpenChange(false);
            }}
          >
            Clear images
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
