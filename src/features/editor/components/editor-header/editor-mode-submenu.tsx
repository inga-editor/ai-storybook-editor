// editor-mode-submenu.tsx — READ-ONLY submenu hanging off the header menu's "Editor Mode" row.
//
// Spec: ai-storybook-design/component/editor-page/01-editor-header.md §3.6.2
//
// The chevron in the mock does NOT open write access. `books.type` decides the mode; changing it
// would flip pipeline + creative-space visibility and needs its own confirm/owner-only flow. So
// BOTH options render disabled with a ✓ on the active one — the submenu only makes the current
// state *visible*.
//
// Disabled items are rendered greyed + a reason tooltip, never filtered out: a hidden item reads
// as "this feature does not exist", a greyed one answers "why can't I change this?" (project rule).
//
// ⚠️ Implemented with a nested Radix `Popover`, NOT `DropdownMenu.Sub`: the parent menu is a
// Popover (Sub only works inside a `DropdownMenu.Root`) and `@radix-ui/react-dropdown-menu` is not
// a dependency of this app. Radix layers dismissal (Escape closes the topmost layer first), so
// nothing here is hand-rolled.

import { useState } from 'react';
import { Check, ChevronRight, Layers } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { EditorMode } from '@/types/editor';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'EditorModeSubmenu');

/** Both modes always listed — the inactive one is shown disabled, not hidden (§3.6.2). */
const MODE_OPTIONS: { value: EditorMode; label: string }[] = [
  { value: 'book', label: 'Book' },
  { value: 'asset', label: 'Asset' },
];

const READ_ONLY_REASON = "Editor mode is set by the book type and can't be changed here.";

interface EditorModeSubmenuProps {
  /** Derived from `books.type` by EditorPage — display only. */
  editorMode: EditorMode;
}

export function EditorModeSubmenu({ editorMode }: EditorModeSubmenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleOpenChange = (open: boolean) => {
    log.debug('handleOpenChange', 'editor mode submenu toggled', { open, editorMode });
    setIsOpen(open);
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          // ⚠️ Click-only, deliberately — the spec says "hover/click" but hover-to-open is wrong
          // HERE: this row sits between "Home" and "Clone this book", so every pointer travelling
          // to Clone crosses it. Radix focuses the submenu content on mount, so a hover-open would
          // yank focus out of the main menu (killing its arrow-key nav) on a pass-through, and the
          // submenu would stay parked open because closing is left to click-outside/Escape.
          // Click-open is also how Radix's own DropdownMenu.Sub behaves for pointer users.
          className="flex w-full items-center gap-2 px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:bg-accent"
        >
          <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>Editor Mode</span>
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="right"
        align="start"
        sideOffset={4}
        role="menu"
        aria-label="Editor mode"
        className="w-48 p-1"
      >
        {MODE_OPTIONS.map((option) => (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              {/* `aria-disabled` (not the `disabled` attribute): a truly disabled control swallows
                  pointer events, so the tooltip explaining WHY it is disabled would never show. */}
              {/* `menuitemradio` + `aria-checked`, not a bare `menuitem`: the ✓ is the ONLY
                  signal of the active mode and an opacity class says nothing to a screen
                  reader. The role also keeps these out of the parent menu's `[role="menuitem"]`
                  roving-focus query (they are portaled out of it either way). */}
              <div
                role="menuitemradio"
                aria-checked={option.value === editorMode}
                aria-disabled="true"
                tabIndex={-1}
                className="flex cursor-not-allowed items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground/60"
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    'h-4 w-4 shrink-0',
                    option.value === editorMode ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <span>{option.label}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">{READ_ONLY_REASON}</TooltipContent>
          </Tooltip>
        ))}
      </PopoverContent>
    </Popover>
  );
}
