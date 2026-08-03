// spread-pool-row.tsx — one row of the Spread Pool list.
//
// index · pool toggle (is_true) · thumbnail · original-language title input · DEFAULT
// checkbox (is_default). Toggle OFF → title input + checkbox are disabled + greyed but
// KEEP their real DB value (never hidden — [feedback: never hide disabled UI]).
//
// Title input is a controlled DRAFT: it syncs from the store while unfocused and commits
// on blur/Enter only (no per-keystroke write). All other controls are DERIVED from the
// store — commits are BATCHED store mutations persisted by autosave/flush (see panel).

import * as React from 'react';
import { AlertTriangle, Image as ImageIcon } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/utils/utils';
import { resolveTitleText, originalTitleText } from './spread-pool-helpers';
import type { PoolToggleLockReason } from './spread-pool-helpers';
import type { SpreadPool, SpreadTitle } from '@/types/spread-types';

export interface SpreadPoolRowData {
  spreadId: string;
  index: number; // 1-based, array order
  pool: SpreadPool | null;
  title: SpreadTitle | null;
  thumbnailUrl: string | null;
  /** P3 lock: branch/section spreads can't join the pool (design §1.3). */
  poolLockedReason?: PoolToggleLockReason | null;
}

interface SpreadPoolRowProps {
  data: SpreadPoolRowData;
  originalLanguage: string;
  /** Thumbnail job running — greys ALL edits: a whole-snapshot flush mid-job would
   *  clobber the `thumbnail_url`s the BE job already wrote. */
  editsLocked?: boolean;
  /** Optimistic thumbnail from a running `spread_thumbnail` job's step_details. */
  thumbnailOverride?: string;
  onToggle: (next: boolean) => void;
  onDefaultChange: (next: boolean) => void;
  onTitleCommit: (text: string) => void; // blur/Enter — NOT per-keystroke
}

export function SpreadPoolRow({
  data,
  originalLanguage,
  editsLocked = false,
  thumbnailOverride,
  onToggle,
  onDefaultChange,
  onTitleCommit,
}: SpreadPoolRowProps) {
  const { index, pool, title, thumbnailUrl } = data;
  const poolLockedReason = data.poolLockedReason ?? null;
  const isPooled = pool?.is_true ?? false;
  const isDefault = pool?.is_default ?? false;
  const label = resolveTitleText(title, originalLanguage, index);

  // Controlled draft: track focus so the store can re-sync the input while unfocused.
  const storeText = originalTitleText(title, originalLanguage);
  const [draft, setDraft] = React.useState(storeText);
  const [focused, setFocused] = React.useState(false);

  // Sync from store when the input is not being edited (peer edits become visible).
  // Derive during render (no effect+setState — React 19); keep local draft while focused.
  if (!focused && draft !== storeText) {
    setDraft(storeText);
  }

  const commit = React.useCallback(() => {
    if (draft !== storeText) onTitleCommit(draft);
  }, [draft, storeText, onTitleCommit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur(); // triggers onBlur → commit
    }
  };

  // P3: branch/section spreads may never join the pool (greyed + tooltip, never hidden).
  const controlsDisabled = editsLocked || poolLockedReason != null;
  const metaDisabled = !isPooled || editsLocked; // title + DEFAULT greyed when not pooled
  // Data already in violation (pool ON on a branch/section spread) — warn, don't hide.
  const showViolationBadge = poolLockedReason != null && isPooled;
  const displayThumbnail = thumbnailOverride ?? thumbnailUrl;

  const toggleEl = (
    <Switch
      checked={isPooled}
      disabled={controlsDisabled}
      onCheckedChange={onToggle}
      aria-label={`Include ${label} in the spread pool`}
    />
  );

  return (
    <div className="flex flex-col gap-1 border-b py-2.5">
      <div className="flex items-center gap-3">
        {/* index */}
        <div className="flex w-8 shrink-0 items-center justify-end gap-1 text-xs text-muted-foreground">
          <span>{index}</span>
        </div>

        {/* pool toggle — tooltip only when P3-locked (disabled control needs a span trigger) */}
        {poolLockedReason ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{toggleEl}</span>
              </TooltipTrigger>
              <TooltipContent>Branch/section spreads can't join the pool</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          toggleEl
        )}

        {/* thumbnail (plain img — SpreadThumbnail re-renders the whole canvas, too heavy) */}
        <div className="flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40 transition-transform hover:scale-110">
          {displayThumbnail ? (
            <img src={displayThumbnail} alt={label} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-4 w-4 text-muted-foreground/60" aria-label="No thumbnail" />
          )}
        </div>

        {/* original-language title input */}
        <Input
          value={draft}
          disabled={metaDisabled}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={handleKeyDown}
          placeholder="Untitled"
          aria-label={`Title for spread ${index} (${originalLanguage})`}
          className={cn('h-8 flex-1 text-sm', metaDisabled && 'opacity-50')}
        />

        {/* DEFAULT checkbox — disabled+grey when not pooled, but shows the real DB value */}
        <div className="flex w-16 shrink-0 justify-center">
          <Checkbox
            checked={isDefault}
            disabled={metaDisabled}
            onCheckedChange={onDefaultChange}
            aria-label={`Mark ${label} as the default pool spread`}
          />
        </div>
      </div>

      {/* P3 violation warning — pooled spread that is also a branch/section anchor */}
      {showViolationBadge && (
        <div className="ml-11 flex items-start gap-1.5 text-[11px] leading-tight text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>
            This spread will be excluded from the main story and may break a branch/section —
            remove it from the pool or turn DEFAULT on
          </span>
        </div>
      )}
    </div>
  );
}
