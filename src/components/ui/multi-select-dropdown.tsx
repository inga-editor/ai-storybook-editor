// multi-select-dropdown.tsx - Multi-select dropdown with tag display and checkbox list.
// Lists all options; with `searchable` a search box filters the list by label.
// Used for theme/genre selection in config panels + the NewLocalizationModal
// Country/Languages fields (design 09 §3.1 calls it `MultiSelectCombobox` — we extend
// this existing component with `searchable`/`searchPlaceholder` instead of adding a new
// file, per the DRY reuse rule; the name divergence is intentional).
// Supports optional is_primary: ★ badge, primary-first sort, click tag to set primary.

import * as React from 'react';
import { ChevronDown, X, Check, Star, Search } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('UI', 'MultiSelectDropdown');

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectDropdownProps {
  options: MultiSelectOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Value of the item currently marked as primary */
  primaryValue?: string;
  /** Called when user clicks a non-primary tag body to set it as primary */
  onPrimaryChange?: (value: string) => void;
  /** ⚡ Show a search box in the panel that filters options by label (default off — no
   *  behavior change for existing callers). */
  searchable?: boolean;
  /** ⚡ Placeholder for the search box (only when `searchable`). */
  searchPlaceholder?: string;
  /** ⚡ Values that cannot be removed: their chip has NO ✕, their panel item is disabled
   *  (click no-op, ✓ still shown), and `onChange` defensively re-adds any dropped locked
   *  value. Default `undefined` ⇒ zero behavior change for existing callers. */
  lockedValues?: string[];
}

export function MultiSelectDropdown({
  options,
  selectedValues,
  onChange,
  placeholder = 'Select...',
  className,
  disabled = false,
  primaryValue,
  onPrimaryChange,
  searchable = false,
  searchPlaceholder = 'Search...',
  lockedValues,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const lockedSet = React.useMemo(() => new Set(lockedValues ?? []), [lockedValues]);

  // Defensive emit: never surface a selection that dropped a locked value (re-add any
  // missing locked value, preserving current order + appending the recovered ones).
  const emitChange = React.useCallback(
    (next: string[]) => {
      if (lockedSet.size === 0) {
        onChange(next);
        return;
      }
      const missing = [...lockedSet].filter((v) => !next.includes(v));
      if (missing.length > 0) {
        log.warn('emitChange', 're-adding dropped locked value(s)', { recovered: missing.length });
        onChange([...next, ...missing]);
        return;
      }
      onChange(next);
    },
    [onChange, lockedSet],
  );

  // Reset the query when the panel closes (event handler, not effect — React 19 safe).
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (disabled) return;
      if (!next) setQuery('');
      setOpen(next);
    },
    [disabled],
  );

  const visibleOptions = React.useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, searchable, query]);

  const selectedLabels = React.useMemo(() => {
    const mapped = selectedValues
      .map((v) => options.find((o) => o.value === v))
      .filter(Boolean) as MultiSelectOption[];

    // Primary item always first
    if (primaryValue) {
      const primaryIdx = mapped.findIndex((i) => i.value === primaryValue);
      if (primaryIdx > 0) {
        const [primary] = mapped.splice(primaryIdx, 1);
        mapped.unshift(primary);
      }
    }
    return mapped;
  }, [options, selectedValues, primaryValue]);

  const handleToggle = React.useCallback(
    (value: string) => {
      if (lockedSet.has(value)) return; // locked items are non-interactive
      const isSelected = selectedValues.includes(value);
      const next = isSelected
        ? selectedValues.filter((v) => v !== value)
        : [...selectedValues, value];
      log.info('handleToggle', 'selection changed', { value, selected: !isSelected, total: next.length });
      emitChange(next);
    },
    [selectedValues, emitChange, lockedSet]
  );

  const handleRemoveTag = React.useCallback(
    (e: React.MouseEvent, value: string) => {
      e.stopPropagation();
      const next = selectedValues.filter((v) => v !== value);
      log.info('handleRemoveTag', 'tag removed', { value, remaining: next.length });
      emitChange(next);
    },
    [selectedValues, emitChange]
  );

  const handleTagClick = React.useCallback(
    (e: React.MouseEvent, value: string) => {
      // Only fire for non-primary items when onPrimaryChange is wired
      if (!onPrimaryChange || value === primaryValue) return;
      e.stopPropagation();
      log.info('handleTagClick', 'set primary', { value });
      onPrimaryChange(value);
    },
    [onPrimaryChange, primaryValue]
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full min-h-9 h-auto justify-between items-start flex-wrap gap-1 py-1.5 px-3',
            className
          )}
        >
          <span className="flex flex-wrap gap-1 flex-1">
            {selectedLabels.length > 0 ? (
              selectedLabels.map((item) => {
                const isPrimary = item.value === primaryValue;
                const isLocked = lockedSet.has(item.value);
                return (
                  <span
                    key={item.value}
                    onClick={(e) => handleTagClick(e, item.value)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
                      isPrimary
                        ? 'bg-primary/15 font-semibold cursor-default'
                        : 'bg-accent font-medium cursor-pointer hover:bg-accent/80'
                    )}
                  >
                    {isPrimary && <Star className="h-3 w-3 fill-current text-primary" />}
                    {item.label}
                    {/* Locked value → no ✕ (cannot be removed). */}
                    {!isLocked && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => handleRemoveTag(e, item.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            const next = selectedValues.filter((v) => v !== item.value);
                            log.info('handleRemoveTag', 'tag removed via keyboard', {
                              value: item.value,
                              remaining: next.length,
                            });
                            emitChange(next);
                          }
                        }}
                        className="inline-flex cursor-pointer items-center text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring rounded"
                        aria-label={`Remove ${item.label}`}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    )}
                  </span>
                );
              })
            ) : (
              <span className="text-sm font-normal text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronDown
            className={cn(
              'ml-1 mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-180'
            )}
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[--radix-popover-trigger-width] p-0"
      >
        {searchable && (
          <div className="relative border-b p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-8"
              aria-label={searchPlaceholder}
            />
          </div>
        )}
        <div className={cn('overflow-y-auto py-1', searchable ? 'max-h-[280px]' : 'max-h-[220px]')}>
          {options.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No options</p>
          ) : visibleOptions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No results</p>
          ) : (
            visibleOptions.map((option) => {
              const isSelected = selectedValues.includes(option.value);
              const isPrimary = option.value === primaryValue;
              const isLocked = lockedSet.has(option.value);
              return (
                <div
                  key={option.value}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isLocked || undefined}
                  onClick={() => handleToggle(option.value)}
                  className={cn(
                    'flex items-center justify-between rounded-sm px-2 py-1.5 text-sm',
                    isLocked ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-accent',
                    isSelected && 'font-medium'
                  )}
                >
                  <span className="flex items-center gap-1">
                    {isPrimary && <Star className="h-3 w-3 fill-current text-primary shrink-0" />}
                    {option.label}
                  </span>
                  {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
