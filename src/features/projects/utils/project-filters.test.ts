import { describe, expect, it } from 'vitest';
import type { ProjectOverviewRow } from '../types';
import { applySearch } from './project-filters';

function makeProject(overrides: Partial<ProjectOverviewRow>): ProjectOverviewRow {
  return {
    id: 'id',
    title: 'Untitled',
    description: null,
    status: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    book_count: 0,
    international_book_id: null,
    cover: null,
    original_language: null,
    support_languages: null,
    ...overrides,
  };
}

const rows: ProjectOverviewRow[] = [
  makeProject({ id: 'a', title: 'Dragon Tales' }),
  makeProject({ id: 'b', title: 'Ocean Quest', description: 'a deep sea DRAGON' }),
  makeProject({ id: 'c', title: 'Mountain' }),
];

describe('applySearch', () => {
  it('empty needle returns the SAME array reference (memo-safe)', () => {
    expect(applySearch(rows, '')).toBe(rows);
    expect(applySearch(rows, '   ')).toBe(rows);
  });

  it('matches by title', () => {
    expect(applySearch(rows, 'ocean').map((r) => r.id)).toEqual(['b']);
  });

  it('matches by description', () => {
    expect(applySearch(rows, 'deep sea').map((r) => r.id)).toEqual(['b']);
  });

  it('is case-insensitive across title + description', () => {
    expect(applySearch(rows, 'dragon').map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('no match → empty array', () => {
    expect(applySearch(rows, 'zzz')).toEqual([]);
  });
});
