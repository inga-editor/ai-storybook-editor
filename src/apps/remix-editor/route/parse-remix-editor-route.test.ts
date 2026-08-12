// parse-remix-editor-route.test.ts — route matching table for the single sub-app route.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { parseRemixEditorRoute } from './parse-remix-editor-route';

describe('parseRemixEditorRoute', () => {
  it('parses /book/:bookId (no query)', () => {
    expect(parseRemixEditorRoute({ pathname: '/book/abc-123', search: '' })).toEqual({
      bookId: 'abc-123',
    });
  });

  it('parses /book/:bookId with a trailing slash', () => {
    expect(parseRemixEditorRoute({ pathname: '/book/abc-123/', search: '' })).toEqual({
      bookId: 'abc-123',
    });
  });

  it('reads ?remix= into preselectRemixId', () => {
    expect(
      parseRemixEditorRoute({ pathname: '/book/abc-123', search: '?remix=xyz-9' }),
    ).toEqual({ bookId: 'abc-123', preselectRemixId: 'xyz-9' });
  });

  it('ignores an empty ?remix= (omits preselectRemixId)', () => {
    expect(parseRemixEditorRoute({ pathname: '/book/abc-123', search: '?remix=' })).toEqual({
      bookId: 'abc-123',
    });
  });

  it('decodes a URL-encoded bookId segment', () => {
    expect(parseRemixEditorRoute({ pathname: '/book/a%20b', search: '' })).toEqual({
      bookId: 'a b',
    });
  });

  it('returns null for the root path', () => {
    expect(parseRemixEditorRoute({ pathname: '/', search: '' })).toBeNull();
  });

  it('returns null when bookId segment is missing (/book or /book/)', () => {
    expect(parseRemixEditorRoute({ pathname: '/book', search: '' })).toBeNull();
    expect(parseRemixEditorRoute({ pathname: '/book/', search: '' })).toBeNull();
  });

  it('returns null for a nested/unknown path', () => {
    expect(parseRemixEditorRoute({ pathname: '/book/abc/extra', search: '' })).toBeNull();
    expect(parseRemixEditorRoute({ pathname: '/other/abc', search: '' })).toBeNull();
  });
});
