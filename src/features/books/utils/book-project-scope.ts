// book-project-scope.ts — Pure helpers for the project-scoped /books view.
// Extracted from books-page so the scope logic is unit-testable (no store/React).

import type { BookListItem } from '@/types/editor';

/** Library scope: only "normal" books (type === 1). Source books (type 0) excluded. */
export const NORMAL_BOOK_TYPE = 1;

/** Books that belong to the given project AND are normal (type 1) books. */
export function filterBooksByProject(
  books: BookListItem[],
  projectId: string,
): BookListItem[] {
  return books.filter(
    (b) => b.type === NORMAL_BOOK_TYPE && b.project_id === projectId,
  );
}

/** True when any of the (already project-scoped) books is the international edition. */
export function hasInternationalBook(books: BookListItem[]): boolean {
  return books.some((b) => b.is_international);
}
