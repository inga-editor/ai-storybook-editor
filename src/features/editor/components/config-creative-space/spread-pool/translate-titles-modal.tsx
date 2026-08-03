// translate-titles-modal.tsx — bulk-translate spread pool titles into the book's
// non-original languages.
//
// Tabs = book languages MINUS the original. A modal-wide draft (Record<spreadId,
// SpreadTitle>) persists across tabs and is seeded from the current spread titles at
// open. Save diffs the draft against the store and commits ONLY changed spreads (parent
// runs them sequentially, per-spread error toast). Close/backdrop discards everything
// (no confirm — modal unmounts, draft is lost by design §3.2).

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/utils/utils';
import { mergeTitle, originalTitleText } from './spread-pool-helpers';
import type { SpreadPoolRowData } from './spread-pool-row';
import type { Language } from '@/types/editor';
import type { SpreadTitle } from '@/types/spread-types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'TranslateTitlesModal');

interface TranslateTitlesModalProps {
  spreads: SpreadPoolRowData[]; // all spreads (any row is translatable)
  originalLanguage: string;
  languages: Language[]; // book languages MINUS original
  onSave: (changes: Record<string, SpreadTitle>) => void; // spreadId → merged title
  onClose: () => void;
}

/** Stable serialization for change-detection (key order independent). */
function normalizeTitle(title: SpreadTitle | null | undefined): string {
  if (!title) return '';
  const sorted: Record<string, { text: string }> = {};
  for (const key of Object.keys(title).sort()) sorted[key] = title[key];
  return JSON.stringify(sorted);
}

export function TranslateTitlesModal({
  spreads,
  originalLanguage,
  languages,
  onSave,
  onClose,
}: TranslateTitlesModalProps) {
  // Seed the modal-wide draft ONCE from the current titles (deep copy per spread).
  const [draft, setDraft] = React.useState<Record<string, SpreadTitle>>(() => {
    const seed: Record<string, SpreadTitle> = {};
    for (const s of spreads) seed[s.spreadId] = { ...(s.title ?? {}) };
    return seed;
  });
  const [activeCode, setActiveCode] = React.useState(languages[0]?.code ?? '');

  const setDraftText = React.useCallback(
    (spreadId: string, code: string, text: string) => {
      setDraft((prev) => ({
        ...prev,
        [spreadId]: mergeTitle(prev[spreadId], code, text),
      }));
    },
    [],
  );

  const handleSave = React.useCallback(() => {
    const changes: Record<string, SpreadTitle> = {};
    for (const s of spreads) {
      const before = normalizeTitle(s.title);
      const after = normalizeTitle(draft[s.spreadId]);
      if (before !== after) changes[s.spreadId] = draft[s.spreadId];
    }
    log.info('handleSave', 'diff computed', { changed: Object.keys(changes).length });
    onSave(changes);
  }, [spreads, draft, onSave]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Translate Titles</DialogTitle>
        </DialogHeader>

        {/* Language tabs */}
        <div className="flex gap-1 border-b pb-2">
          {languages.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => setActiveCode(lang.code)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors',
                activeCode === lang.code
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {lang.name}
            </button>
          ))}
        </div>

        {/* Rows: original (read-only) | translation input */}
        <div className="flex max-h-[50vh] flex-col overflow-y-auto">
          <div className="flex items-center gap-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="w-6 shrink-0" />
            <span className="flex-1">Spread Title ({originalLanguage})</span>
            <span className="flex-1">Translation</span>
          </div>
          {spreads.map((s) => {
            const original = originalTitleText(s.title, originalLanguage);
            const value = draft[s.spreadId]?.[activeCode]?.text ?? '';
            return (
              <div key={s.spreadId} className="flex items-center gap-3 border-b py-2">
                <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">
                  {s.index}
                </span>
                <span
                  className={cn(
                    'flex-1 truncate text-sm',
                    !original && 'italic text-muted-foreground',
                  )}
                >
                  {original || '—'}
                </span>
                <Input
                  value={value}
                  onChange={(e) => setDraftText(s.spreadId, activeCode, e.target.value)}
                  placeholder="Translation"
                  aria-label={`Translation of spread ${s.index} into ${activeCode}`}
                  className="h-8 flex-1 text-sm"
                />
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
