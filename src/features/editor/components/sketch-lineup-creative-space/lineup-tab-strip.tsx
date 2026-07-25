// lineup-tab-strip.tsx — horizontal tab strip of SketchLineupSpace (design 02-01, 2026-07-25).
// Pills for every (effective) tab: active = primary filled + Users icon; select on click; rename
// via double-click OR the ⋯ menu; delete via the ⋯ menu only (confirm handled by the root's
// AlertDialog). `＋` at the end mirrors the sidebar-header `＋`.
//
// Disabled ≠ hidden (memory: never-hide-disabled-ui): peer-lock/greyed states render every
// control disabled with a reason tooltip. Delete is disabled on the LAST tab; `＋` at the 12-tab
// cap. The ⋯ menu is built on the existing Popover (no DropdownMenu dependency in this repo —
// deliberate: no new npm dep for a 2-item menu).
//
// A11y (README §4.5): role=tablist / role=tab + aria-selected; ←/→ move selection (the panel is
// controlled — selection IS activation); the active pill scrollIntoView on keyboard moves.

import { useRef, useState } from 'react';
import { MoreHorizontal, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { SketchLineupTab } from '@/types/sketch';
import { LINEUP_TAB_LABEL_MAX_PX, LINEUP_TAB_LIMIT } from './lineup-constants';

const log = createLogger('Editor', 'LineupTabStrip');

export interface LineupTabStripProps {
  tabs: SketchLineupTab[];
  activeTabId: string;
  /** Peer-lock / no-write context → every WRITE affordance greyed (select/zoom stay live). */
  disabled: boolean;
  onSelectTab: (tabId: string) => void;
  onRequestRenameTab: (tabId: string) => void;
  onRequestDeleteTab: (tabId: string) => void;
  onCreateTab: () => void;
}

export function LineupTabStrip({
  tabs,
  activeTabId,
  disabled,
  onSelectTab,
  onRequestRenameTab,
  onRequestDeleteTab,
  onCreateTab,
}: LineupTabStripProps) {
  const [openMenuTabId, setOpenMenuTabId] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const atCap = tabs.length >= LINEUP_TAB_LIMIT;
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
        return (
          <div key={tab.id} data-tab-id={tab.id} className="flex shrink-0 items-center">
            <button
              type="button"
              role="tab"
              id={`lineup-tab-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.name}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 truncate rounded-md px-2.5 text-sm',
                active
                  ? 'bg-primary font-medium text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
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
              {active && <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <span className="truncate">{tab.name}</span>
            </button>

            {/* ⋯ menu — active tab only keeps the strip calm; every tab is one click away. */}
            {active && (
              <Popover
                open={openMenuTabId === tab.id}
                onOpenChange={(open) => setOpenMenuTabId(open ? tab.id : null)}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Tab actions for ${tab.name}`}
                    aria-haspopup="menu"
                    disabled={disabled}
                    title={disabled ? 'Another editor is editing the Lineup' : 'Tab actions'}
                    className={cn(
                      'ml-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground',
                      disabled ? 'opacity-50' : 'hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-40 p-1" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
                    onClick={() => {
                      setOpenMenuTabId(null);
                      onRequestRenameTab(tab.id);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={lastTab}
                    aria-disabled={lastTab}
                    title={lastTab ? 'The last tab cannot be deleted' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                      lastTab ? 'cursor-not-allowed opacity-50' : 'text-destructive hover:bg-muted',
                    )}
                    onClick={() => {
                      if (lastTab) return;
                      setOpenMenuTabId(null);
                      onRequestDeleteTab(tab.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Delete
                  </button>
                </PopoverContent>
              </Popover>
            )}
          </div>
        );
      })}

      {/* ＋ new tab — disabled (never hidden) at the cap or under a peer lock. */}
      <button
        type="button"
        aria-label="New tab"
        disabled={disabled || atCap}
        title={
          disabled
            ? 'Another editor is editing the Lineup'
            : atCap
              ? `Tab limit reached (${LINEUP_TAB_LIMIT})`
              : 'New tab'
        }
        className={cn(
          'ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
          disabled || atCap ? 'opacity-50' : 'hover:bg-muted/60 hover:text-foreground',
        )}
        onClick={onCreateTab}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
