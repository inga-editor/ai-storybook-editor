// remix-filter-popover.tsx — Pure controlled filter selector for sidebar.
// Empty arrays = "all checked" (no filter applied); auto-collapses back to
// empty when the user re-selects every option.
//
// Reshape 2026-07-31: book.remix dropped props[] and the RemixConfigModal no
// longer emits prop choices — the prop-filter UI is removed. `propKeys` stays on
// RemixFilterState (passed through untouched) so legacy remix rows carrying
// props[] can still be filtered by any pre-existing selection (inert branch in
// remix-creative-space.tsx). No UI can set propKeys anymore.

import { Check } from 'lucide-react';
import { cn } from '@/utils/utils';
import type { BookRemix } from '@/types/editor';
import type { RemixFilterState } from '@/types/remix';

interface Props {
  bookRemix: BookRemix;
  value: RemixFilterState;
  onChange: (next: RemixFilterState) => void;
}

export function RemixFilterPopover({ bookRemix, value, onChange }: Props) {
  const allowedChars = bookRemix.characters.filter((c) => c.is_enabled);

  const isCharChecked = (key: string) =>
    value.characterKeys.length === 0 || value.characterKeys.includes(key);

  const toggleChar = (key: string, next: boolean) => {
    const all = value.characterKeys.length === 0;
    let nextArr: string[];
    if (all && !next) {
      nextArr = allowedChars.map((c) => c.key).filter((k) => k !== key);
    } else if (!all && next) {
      nextArr = [...value.characterKeys, key];
      if (nextArr.length === allowedChars.length) nextArr = [];
    } else if (!all && !next) {
      nextArr = value.characterKeys.filter((k) => k !== key);
    } else {
      nextArr = value.characterKeys;
    }
    // propKeys passed through untouched (inert legacy filter).
    onChange({ characterKeys: nextArr, propKeys: value.propKeys });
  };

  if (allowedChars.length === 0) {
    return (
      <div className="w-60 p-3">
        <p className="text-center text-sm text-muted-foreground">
          No remixable entities. Configure in Settings.
        </p>
      </div>
    );
  }

  return (
    <div className="w-60 space-y-2 p-2">
      <div>
        <SectionLabel>Filter by Characters</SectionLabel>
        {allowedChars.map((c) => (
          <CheckboxRow
            key={c.key}
            label={c.name}
            checked={isCharChecked(c.key)}
            onChange={(v) => toggleChar(c.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 pb-1 text-xs font-semibold tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
        'hover:bg-accent',
      )}
    >
      <span
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded-sm border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
        )}
      >
        {checked && <Check className="h-3 w-3" />}
      </span>
      <span className="flex-1 truncate text-left">{label}</span>
    </button>
  );
}
