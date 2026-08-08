// parse-token-fragment.test.ts — pure fragment parser.
import { describe, it, expect } from 'vitest';
import { parseTokenFragment } from './parse-token-fragment';

describe('parseTokenFragment', () => {
  it('extracts token from #token=abc', () => {
    expect(parseTokenFragment('#token=abc')).toEqual({ token: 'abc' });
  });

  it('works without leading #', () => {
    expect(parseTokenFragment('token=abc')).toEqual({ token: 'abc' });
  });

  it('ignores other keys, keeps only token', () => {
    expect(parseTokenFragment('#token=abc&language=vi')).toEqual({ token: 'abc' });
  });

  it('URL-decodes the token value', () => {
    expect(parseTokenFragment('#token=a%2Bb')).toEqual({ token: 'a+b' });
  });

  it('returns null for empty hash', () => {
    expect(parseTokenFragment('')).toBeNull();
    expect(parseTokenFragment('#')).toBeNull();
  });

  it('returns null when token key absent', () => {
    expect(parseTokenFragment('#language=vi')).toBeNull();
  });

  it('returns null for empty token value', () => {
    expect(parseTokenFragment('#token=')).toBeNull();
  });
});
