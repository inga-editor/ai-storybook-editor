// book-row.tsx — One book line in BooksList: language-initials avatar + title +
// language name + 3 badges (edition / status / N spreads) + updated-ago + actions
// (Open Editor · 👁 details · 🗑 delete). Row body click → onOpenDetails
// (low-commitment quick view); `Open Editor` → onOpenEditor (/editor/:id).
// Every action stops propagation so it never re-triggers the row-body handler.
// 🗑 is disabled (guard) when this international book still has localizations.
// Wrapped in React.memo (key = book.id) — list rows are otherwise pure.

import { memo } from 'react';
import { Clock, Trash2 } from 'lucide-react';
import { cn } from '@/utils/utils';
import { Button } from '@/components/ui/button';
import { EditionBadge, StatusBadge } from '@/features/books/components/book-badges';
import { deriveBookStatus } from '@/features/books/utils/book-content-status';
import { languageLabel, languageInitials } from '@/features/books/utils/book-labels';
import { PILL_BASE, SPREADS_BADGE_CLASS } from '@/features/books/constants';
import { formatRelativeTime } from '@/utils/format-relative-time';
import type { ProjectBookItem } from '@/features/books/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'BookRow');

interface BookRowProps {
  book: ProjectBookItem;
  onOpenDetails: (book: ProjectBookItem) => void;
  onOpenEditor: (book: ProjectBookItem) => void;
  onDelete: (book: ProjectBookItem) => void;
  /** international book still has localization siblings → 🗑 disabled (list derives). */
  isDeleteBlocked?: boolean;
}

/** Language-initials avatar (VI / EN / JA) — square, muted; aria-hidden (name is text). */
function LanguageAvatar({ code }: { code: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-primary"
    >
      {languageInitials(code)}
    </div>
  );
}

function BookRowImpl({
  book,
  onOpenDetails,
  onOpenEditor,
  onDelete,
  isDeleteBlocked,
}: BookRowProps) {
  const status = deriveBookStatus(book.spread_count, book.step);

  const openDetails = () => {
    log.debug('openDetails', 'row open', { id: book.id });
    onOpenDetails(book);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDetails();
    }
  };

  const handleOpenEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug('handleOpenEditor', 'open editor clicked', { id: book.id });
    onOpenEditor(book);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDeleteBlocked) return; // guard: disabled button shouldn't act
    log.debug('handleDelete', 'delete clicked', { id: book.id });
    onDelete(book);
  };

  const updatedLabel = formatRelativeTime(book.updated_at);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${book.title} details`}
      onClick={openDetails}
      onKeyDown={handleKeyDown}
      className="group flex cursor-pointer items-center gap-4 py-4 hover:bg-accent/40"
    >
      <LanguageAvatar code={book.original_language} />

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground">{book.title}</p>
        <p className="truncate text-sm text-muted-foreground">
          {languageLabel(book.original_language)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <EditionBadge
            isInternational={book.is_international}
            countries={book.support_countries}
          />
          <StatusBadge status={status} />
          <span className={cn(PILL_BASE, SPREADS_BADGE_CLASS)}>
            {book.spread_count} spreads
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-muted-foreground">
        <span
          className="flex items-center gap-1 text-xs"
          title={new Date(book.updated_at).toLocaleString()}
        >
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          {updatedLabel}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpenEditor}
          className="text-primary hover:bg-primary/10 hover:text-primary"
        >
          Open Editor
        </Button>
        <button
          type="button"
          aria-label="Delete"
          onClick={handleDelete}
          disabled={isDeleteBlocked}
          aria-disabled={isDeleteBlocked}
          title={isDeleteBlocked ? 'Delete localization books first' : undefined}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full hover:bg-accent hover:text-destructive',
            isDeleteBlocked && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground',
          )}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export const BookRow = memo(BookRowImpl);
