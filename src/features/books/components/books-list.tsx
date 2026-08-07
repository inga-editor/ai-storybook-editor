// books-list.tsx — Renders the (already-filtered) books as a <ul> list view,
// resolving 3 states: library-empty (DB has no type=1 book → CTA), filtered-empty
// (filter/search matched nothing → adjust hint, no create CTA), and populated.
// Empty states are inline presentational components (not split to their own files).

import { BookOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BookRow } from '@/features/books/components/book-row';
import type { BookListItem } from '@/types/editor';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'BooksList');

interface BooksListProps {
  books: BookListItem[]; // already filtered by parent
  isLibraryEmpty: boolean; // raw books (pre-filter) === 0
  onOpenDetails: (book: BookListItem) => void;
  onEdit: (book: BookListItem) => void;
  onDelete: (book: BookListItem) => void;
  onNew?: () => void; // LibraryEmptyState CTA
}

/** This project has no books yet → invite to create/import the first edition. */
function LibraryEmptyState({ onNew }: { onNew?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <BookOpen className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <p className="text-base font-medium">No books in this project yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Create the international edition first, or import one from a Zip / Script
        file.
      </p>
      {onNew ? (
        <Button onClick={onNew} className="mt-2">
          <Plus className="mr-1.5 h-4 w-4" />
          New Book
        </Button>
      ) : null}
    </div>
  );
}

/** Books exist but the active filter/search matched none → suggest adjusting. */
function FilteredEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <BookOpen className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <p className="text-base font-medium">No books found</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Try adjusting your search or step filter.
      </p>
    </div>
  );
}

export function BooksList({
  books,
  isLibraryEmpty,
  onOpenDetails,
  onEdit,
  onDelete,
  onNew,
}: BooksListProps) {
  if (isLibraryEmpty) {
    log.debug('render', 'library empty');
    return <LibraryEmptyState onNew={onNew} />;
  }

  if (books.length === 0) {
    log.debug('render', 'filtered empty');
    return <FilteredEmptyState />;
  }

  log.debug('render', 'populated', { count: books.length });
  return (
    <ul role="list" className="divide-y divide-border px-6">
      {books.map((book) => (
        <li key={book.id}>
          <BookRow
            book={book}
            onOpenDetails={onOpenDetails}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </li>
      ))}
    </ul>
  );
}
