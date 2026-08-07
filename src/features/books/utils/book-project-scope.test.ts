import { describe, expect, it } from 'vitest';
import type { BookListItem } from '@/types/editor';
import { filterBooksByProject, hasInternationalBook } from './book-project-scope';

function makeBook(overrides: Partial<BookListItem>): BookListItem {
  return {
    id: 'id',
    title: 'Untitled',
    description: null,
    cover: null,
    owner_id: 'owner',
    step: 1,
    type: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    project_id: null,
    is_international: false,
    ...overrides,
  };
}

const P = 'project-1';

const books: BookListItem[] = [
  makeBook({ id: 'a', type: 1, project_id: P, is_international: true }),
  makeBook({ id: 'b', type: 1, project_id: P }),
  makeBook({ id: 'c', type: 1, project_id: 'project-2' }), // other project
  makeBook({ id: 'd', type: 0, project_id: P }), // source book (type 0)
  makeBook({ id: 'e', type: 1, project_id: null }), // legacy/imported (unscoped)
];

describe('filterBooksByProject', () => {
  it('keeps only type=1 books of the given project', () => {
    expect(filterBooksByProject(books, P).map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('empty when no book matches', () => {
    expect(filterBooksByProject(books, 'nope')).toEqual([]);
  });
});

describe('hasInternationalBook', () => {
  it('true when a scoped book is international', () => {
    expect(hasInternationalBook(filterBooksByProject(books, P))).toBe(true);
  });

  it('false when none is international', () => {
    expect(hasInternationalBook(filterBooksByProject(books, 'project-2'))).toBe(false);
  });

  it('false for an empty list', () => {
    expect(hasInternationalBook([])).toBe(false);
  });
});
