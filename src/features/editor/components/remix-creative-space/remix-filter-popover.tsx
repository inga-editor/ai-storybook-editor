// remix-filter-popover.tsx — Pure controlled filter selector for sidebar.
// Empty arrays = "all checked" (no filter applied); auto-collapses back to
// empty when the user re-selects every option.

import { Check } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/utils/utils';
import type { BookRemix, RemixPropEntry } from '@/types/editor';
import type { RemixFilterState } from '@/types/remix';

interface Props {
  bookRemix: BookRemix;
  value: RemixFilterState;
  onChange: (next: RemixFilterState) => void;
}

export function RemixFilterPopover({ bookRemix, value, onChange }: Props) {
  const allowedChars = bookRemix.characters.filter((c) => c.is_enabled);
  // Reshape 2026-07-31: book.remix dropped props[] — prop filter section renders
  // empty (never-enabled) until the remix-space follow-up removes the plumbing.
  const allowedProps: RemixPropEntry[] = [];

  const isCharChecked = (key: string) =>
    value.characterKeys.length === 0 || value.characterKeys.includes(key);
  const isPropChecked = (key: string) =>
    value.propKeys.length === 0 || value.propKeys.includes(key);

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
    onChange({ characterKeys: nextArr, propKeys: value.propKeys });
  };

  const toggleProp = (key: string, next: boolean) => {
    const all = value.propKeys.length === 0;
    let nextArr: string[];
    if (all && !next) {
      nextArr = allowedProps.map((p) => p.key).filter((k) => k !== key);
    } else if (!all && next) {
      nextArr = [...value.propKeys, key];
      if (nextArr.length === allowedProps.length) nextArr = [];
    } else if (!all && !next) {
      nextArr = value.propKeys.filter((k) => k !== key);
    } else {
      nextArr = value.propKeys;
    }
    onChange({ characterKeys: value.characterKeys, propKeys: nextArr });
  };

  if (allowedChars.length === 0 && allowedProps.length === 0) {
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
      {allowedChars.length > 0 && (
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
      )}
      {allowedChars.length > 0 && allowedProps.length > 0 && <Separator />}
      {allowedProps.length > 0 && (
        <div>
          <SectionLabel>Filter by Props</SectionLabel>
          {allowedProps.map((p) => (
            <CheckboxRow
              key={p.key}
              label={p.name}
              checked={isPropChecked(p.key)}
              onChange={(v) => toggleProp(p.key, v)}
            />
          ))}
        </div>
      )}
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
