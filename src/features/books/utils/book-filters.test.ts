import { describe, expect, it } from 'vitest';
import type { BookListItem } from '@/types/editor';
import { applyFilters, matchSearch } from './book-filters';
import { DEFAULT_BOOKS_FILTERS } from '../constants';

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

const books: BookListItem[] = [
  makeBook({ id: 'a', title: 'Dragon Tales', step: 1 }),
  makeBook({ id: 'b', title: 'Ocean Quest', description: 'a deep sea dragon', step: 2 }),
  makeBook({ id: 'c', title: 'Mountain', step: 3, description: null }),
];

describe('applyFilters', () => {
  it("step 'all' returns every book", () => {
    expect(applyFilters(books, { search: '', step: 'all' }).map((b) => b.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('filters by step', () => {
    expect(applyFilters(books, { search: '', step: 2 }).map((b) => b.id)).toEqual(['b']);
  });

  it('filters by search across title + description', () => {
    expect(applyFilters(books, { search: 'dragon', step: 'all' }).map((b) => b.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('combines step + search', () => {
    expect(applyFilters(books, { search: 'dragon', step: 1 }).map((b) => b.id)).toEqual(['a']);
  });

  it('default filters return all', () => {
    expect(applyFilters(books, DEFAULT_BOOKS_FILTERS)).toHaveLength(3);
  });
});

describe('matchSearch', () => {
  it('empty query matches all', () => {
    expect(matchSearch(makeBook({}), '')).toBe(true);
  });

  it('handles null description without throwing', () => {
    const book = makeBook({ title: 'Hello', description: null });
    expect(matchSearch(book, 'world')).toBe(false);
    expect(matchSearch(book, 'hel')).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(matchSearch(makeBook({ title: 'Dragon' }), '  DRAGON ')).toBe(true);
  });
});
