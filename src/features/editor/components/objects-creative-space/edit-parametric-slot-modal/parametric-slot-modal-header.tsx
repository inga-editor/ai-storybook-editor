// parametric-slot-modal-header.tsx — Header band of EditParametricSlotModal (design §1.1):
// title (left) · tab bar (center, roving tabindex) · [⋯] overflow + [✕] (right).
// Presentational — every decision (can I switch tab? am I busy?) is made by the shell.
//
// Art Text renders DISABLED + "Coming soon" and is skipped by ←/→ navigation; it is never
// filtered out of the registry (project rule never-hide-disabled-UI).

import { MoreHorizontal, Trash2, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import {
  COMING_SOON_TOOLTIP,
  HEADER_HEIGHT_PX,
  PARAMETRIC_PORTAL_MENU_STYLE,
  type ParametricSlotTabContract,
  type ParametricSlotTabKey,
} from './parametric-slot-modal-constants';

const log = createLogger('Editor', 'EditParametricSlotModalHeader');

export interface ParametricSlotModalHeaderProps {
  titleId: string;
  activeTab: ParametricSlotTabKey;
  tabs: ParametricSlotTabContract[];
  onTabChange: (tab: ParametricSlotTabKey) => void;
  onClose: () => void;
  onRemoveSlot: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** isBusy — blocks tab switching, the overflow menu and close. */
  disabled: boolean;
  /** Collab gate: false ⇒ Remove slot disabled (shown, greyed). */
  canEdit: boolean;
}

export function ParametricSlotModalHeader({
  titleId,
  activeTab,
  tabs,
  onTabChange,
  onClose,
  onRemoveSlot,
  menuOpen,
  onMenuOpenChange,
  disabled,
  canEdit,
}: ParametricSlotModalHeaderProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const selectable = tabs.filter((t) => t.enabled);
    const curIdx = selectable.findIndex((t) => t.key === activeTab);
    if (curIdx === -1) return;
    const nextIdx =
      e.key === 'ArrowLeft' ? Math.max(0, curIdx - 1) : Math.min(selectable.length - 1, curIdx + 1);
    if (nextIdx === curIdx) return;
    log.debug('handleKeyDown', 'arrow navigate tab', { from: activeTab, to: selectable[nextIdx].key });
    onTabChange(selectable[nextIdx].key);
  };

  return (
    <header
      className="flex shrink-0 items-center justify-between border-b border-[var(--swap-modal-border)] bg-[var(--swap-modal-surface)] px-4"
      style={{ height: HEADER_HEIGHT_PX }}
    >
      <h2
        id={titleId}
        className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--swap-modal-text-primary)]"
      >
        Parametric Slot
      </h2>

      <div
        role="tablist"
        aria-label="Parametric slot tabs"
        className="flex items-center gap-0.5 rounded-lg bg-[var(--swap-modal-surface-hover)] p-1"
      >
        {tabs.map(({ key, label, icon: Icon, enabled }) => {
          const isActive = key === activeTab;
          const isDisabled = !enabled || disabled;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-disabled={isDisabled}
              title={enabled ? undefined : COMING_SOON_TOOLTIP}
              tabIndex={isActive ? 0 : -1}
              onClick={() => {
                if (isDisabled || isActive) return;
                onTabChange(key);
              }}
              onKeyDown={handleKeyDown}
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors',
                isActive
                  ? 'bg-white font-semibold text-[#0a0d18] shadow-sm'
                  : 'text-[var(--swap-modal-text-muted)] hover:text-[var(--swap-modal-text-primary)]',
                !enabled && 'cursor-not-allowed opacity-40 hover:text-[var(--swap-modal-text-muted)]',
                enabled && disabled && 'cursor-not-allowed',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-1 items-center justify-end gap-1">
        <Popover open={menuOpen} onOpenChange={onMenuOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              disabled={disabled}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--swap-modal-text-muted)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--swap-modal-accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="bottom"
            style={PARAMETRIC_PORTAL_MENU_STYLE}
            className="w-60 border-[var(--swap-modal-border)] p-1 text-[var(--swap-modal-text-primary)]"
          >
            <button
              type="button"
              disabled={!canEdit}
              title={canEdit ? undefined : 'Bạn chưa giữ quyền chỉnh sửa spread này'}
              onClick={() => {
                onMenuOpenChange(false);
                onRemoveSlot();
              }}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-red-400 transition-colors hover:bg-[var(--swap-modal-surface-hover)] hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Remove Parametric Slot
            </button>
          </PopoverContent>
        </Popover>

        <button
          type="button"
          aria-label="Close"
          disabled={disabled}
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--swap-modal-text-muted)] transition-colors hover:bg-[var(--swap-modal-surface-hover-strong)] hover:text-[var(--swap-modal-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--swap-modal-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
