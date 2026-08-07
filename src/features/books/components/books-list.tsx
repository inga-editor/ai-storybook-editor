// books-list.tsx — Renders the project's book editions as a <ul> divide-y list,
// in RPC order (international-first). Two states only (toolbar dropped 2026-08-07):
// project-empty → ProjectEmptyState (CTA New International), else populated rows.
// isDeleteBlocked is derived HERE (the list sees all siblings) and passed per-row:
// an international book with any localization sibling can't be deleted.

import { BookOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BookRow } from '@/features/books/components/book-row';
import type { ProjectBookItem } from '@/features/books/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'BooksList');

interface BooksListProps {
  books: ProjectBookItem[]; // RPC order (is_international DESC, created_at ASC)
  onOpenDetails: (book: ProjectBookItem) => void;
  onOpenEditor: (book: ProjectBookItem) => void;
  onDelete: (book: ProjectBookItem) => void;
  onNewInternational?: () => void; // ProjectEmptyState CTA
}

/** This project has no books yet → invite to create the international edition. */
function ProjectEmptyState({ onNewInternational }: { onNewInternational?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <BookOpen className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <p className="text-base font-medium">No books in this project yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Create the international edition first — localizations are cloned from it.
      </p>
      {onNewInternational ? (
        <Button onClick={onNewInternational} className="mt-2">
          <Plus className="mr-1.5 h-4 w-4" />
          New International
        </Button>
      ) : null}
    </div>
  );
}

export function BooksList({
  books,
  onOpenDetails,
  onOpenEditor,
  onDelete,
  onNewInternational,
}: BooksListProps) {
  if (books.length === 0) {
    log.debug('render', 'project empty');
    return <ProjectEmptyState onNewInternational={onNewInternational} />;
  }

  // international + still has localization siblings → its 🗑 is blocked (guard UX).
  const hasLocalization = books.some((b) => !b.is_international);

  log.debug('render', 'populated', { count: books.length, hasLocalization });
  return (
    <ul role="list" className="divide-y divide-border px-6">
      {books.map((book) => (
        <li key={book.id}>
          <BookRow
            book={book}
            onOpenDetails={onOpenDetails}
            onOpenEditor={onOpenEditor}
            onDelete={onDelete}
            isDeleteBlocked={book.is_international && hasLocalization}
          />
        </li>
      ))}
    </ul>
  );
}
