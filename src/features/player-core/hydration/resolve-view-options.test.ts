// resolve-view-options.test.ts — edition/language constraint resolution.
import { describe, it, expect } from 'vitest';
import { resolveAvailableEditions, resolveAvailableLanguages } from './resolve-view-options';

describe('resolveAvailableEditions', () => {
  it('all-false → all-true fallback', () => {
    expect(resolveAvailableEditions({})).toEqual({
      classic: true,
      dynamic: true,
      interactive: true,
    });
    expect(
      resolveAvailableEditions({ classic: false, dynamic: false, interactive: false }),
    ).toEqual({ classic: true, dynamic: true, interactive: true });
  });

  it('partial config returned as-is', () => {
    expect(resolveAvailableEditions({ classic: true })).toEqual({ classic: true });
  });
});

describe('resolveAvailableLanguages', () => {
  it('empty list → undefined', () => {
    expect(resolveAvailableLanguages([])).toBeUndefined();
  });

  it('non-empty list returned as-is', () => {
    const langs = [{ name: 'English', code: 'en_US' }];
    expect(resolveAvailableLanguages(langs)).toBe(langs);
  });
});
