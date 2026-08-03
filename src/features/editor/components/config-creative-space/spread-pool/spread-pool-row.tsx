// spread-pool-row.tsx — one row of the Spread Pool list.
//
// index · pool toggle (is_true) · thumbnail · original-language title input · DEFAULT
// checkbox (is_default). Toggle OFF → title input + checkbox are disabled + greyed but
// KEEP their real DB value (never hidden — [feedback: never hide disabled UI]).
//
// Title input is a controlled DRAFT: it syncs from the store while unfocused (a peer's
// edit shows immediately) and commits on blur/Enter only (no per-keystroke save).
// All other controls are DERIVED from the store so a `blocked` save (no optimistic apply)
// leaves the UI consistent with the DB.

import * as React from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/utils/utils';
import { resolveTitleText, originalTitleText } from './spread-pool-helpers';
import type { SpreadPool, SpreadTitle } from '@/types/spread-types';

export interface SpreadPoolRowData {
  spreadId: string;
  index: number; // 1-based, array order
  pool: SpreadPool | null;
  title: SpreadTitle | null;
  thumbnailUrl: string | null;
}

interface SpreadPoolRowProps {
  data: SpreadPoolRowData;
  originalLanguage: string;
  saving: boolean;
  onToggle: (next: boolean) => void;
  onDefaultChange: (next: boolean) => void;
  onTitleCommit: (text: string) => void; // blur/Enter — NOT per-keystroke
}

export function SpreadPoolRow({
  data,
  originalLanguage,
  saving,
  onToggle,
  onDefaultChange,
  onTitleCommit,
}: SpreadPoolRowProps) {
  const { index, pool, title, thumbnailUrl } = data;
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

  const controlsDisabled = saving;
  const metaDisabled = !isPooled || saving; // title + DEFAULT greyed when not pooled

  return (
    <div className="flex items-center gap-3 border-b py-2.5">
      {/* index + saving spinner */}
      <div className="flex w-8 shrink-0 items-center justify-end gap-1 text-xs text-muted-foreground">
        {saving && <Loader2 className="h-3 w-3 animate-spin" aria-label="Saving" />}
        <span>{index}</span>
      </div>

      {/* pool toggle */}
      <Switch
        checked={isPooled}
        disabled={controlsDisabled}
        onCheckedChange={onToggle}
        aria-label={`Include ${label} in the spread pool`}
      />

      {/* thumbnail (plain img — SpreadThumbnail re-renders the whole canvas, too heavy) */}
      <div className="flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40 transition-transform hover:scale-110">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt={label} className="h-full w-full object-cover" />
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
  );
}
