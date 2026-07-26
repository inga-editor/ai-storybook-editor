// lineup-tab-strip.tsx — horizontal tab strip of SketchLineupSpace (design 02-01; 2026-07-26 rework).
// Pills for every (effective) tab: active = subtle muted box (NO icon, per mock 2026-07-26);
// inactive = plain muted text. Select on click. Each tab carries an inline ✕ (delete, confirm
// handled by the root's AlertDialog) to the RIGHT of its name; rename is via DOUBLE-CLICK on the
// name only (the ⋯ menu was removed — 2026-07-26 user request).
//
// The `＋` (new tab) lives ONLY in the sidebar header now (2026-07-26) — it is NOT mirrored here.
//
// Disabled ≠ hidden (memory: never-hide-disabled-ui): peer-lock/greyed states render the ✕
// disabled with a reason tooltip. Delete is disabled on the LAST tab (a book always keeps ≥1 tab).
//
// A11y (README §4.5): role=tablist / role=tab + aria-selected; ←/→ move selection (the panel is
// controlled — selection IS activation); the active pill scrollIntoView on keyboard moves.

import { useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { SketchLineupTab } from '@/types/sketch';
import { LINEUP_TAB_LABEL_MAX_PX } from './lineup-constants';

const log = createLogger('Editor', 'LineupTabStrip');

export interface LineupTabStripProps {
  tabs: SketchLineupTab[];
  activeTabId: string;
  /** Peer-lock / no-write context → every WRITE affordance greyed (select/zoom stay live). */
  disabled: boolean;
  onSelectTab: (tabId: string) => void;
  onRequestRenameTab: (tabId: string) => void;
  onRequestDeleteTab: (tabId: string) => void;
}

export function LineupTabStrip({
  tabs,
  activeTabId,
  disabled,
  onSelectTab,
  onRequestRenameTab,
  onRequestDeleteTab,
}: LineupTabStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  const lastTab = tabs.length <= 1;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    if (idx === -1) return;
    const next = event.key === 'ArrowLeft' ? Math.max(0, idx - 1) : Math.min(tabs.length - 1, idx + 1);
    if (next === idx) return;
    event.preventDefault();
    const nextId = tabs[next].id;
    log.debug('handleKeyDown', 'keyboard tab move', { direction: event.key, tabId: nextId });
    onSelectTab(nextId);
    // Keyboard moves can land on an off-screen pill — bring it into the scrollable strip.
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(nextId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Lineup tabs"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        // Last tab cannot be deleted; a peer lock greys every ✕. Reason feeds the tooltip.
        const deleteReason = disabled
          ? 'Another editor is editing the Lineup'
          : lastTab
            ? 'The last tab cannot be deleted'
            : null;
        const deleteDisabled = deleteReason != null;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className={cn(
              'flex shrink-0 items-center gap-0.5 rounded-md pr-1',
              active
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <button
              type="button"
              role="tab"
              id={`lineup-tab-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.name}
              className={cn(
                'inline-flex h-8 items-center truncate rounded-md pl-2.5 pr-1 text-sm',
                active && 'font-medium',
              )}
              style={{ maxWidth: LINEUP_TAB_LABEL_MAX_PX }}
              onClick={() => {
                if (active) return;
                log.info('onSelectTab', 'tab selected', { tabId: tab.id });
                onSelectTab(tab.id);
              }}
              onDoubleClick={() => {
                if (disabled) return;
                log.debug('onDoubleClick', 'rename via double-click', { tabId: tab.id });
                onRequestRenameTab(tab.id);
              }}
            >
              <span className="truncate">{tab.name}</span>
            </button>

            {/* ✕ delete — one per tab, right of the name (design 02, 2026-07-26). Never hidden:
                greyed with a reason on the last tab or under a peer lock. */}
            <button
              type="button"
              aria-label={`Delete tab ${tab.name}`}
              disabled={deleteDisabled}
              title={deleteReason ?? 'Delete tab'}
              className={cn(
                'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground',
                deleteDisabled ? 'opacity-40' : 'hover:bg-foreground/10 hover:text-foreground',
              )}
              onClick={() => {
                if (deleteDisabled) return;
                log.debug('onRequestDeleteTab', 'delete requested via ✕', { tabId: tab.id });
                onRequestDeleteTab(tab.id);
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
