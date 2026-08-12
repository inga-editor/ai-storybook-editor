// parse-handoff-fragment.test.ts — pure handoff-code fragment parser.
import { describe, it, expect } from 'vitest';
import { parseHandoffFragment } from './parse-handoff-fragment';

describe('parseHandoffFragment', () => {
  it('extracts code from #handoff=abc', () => {
    expect(parseHandoffFragment('#handoff=abc')).toEqual({ code: 'abc' });
  });

  it('works without leading #', () => {
    expect(parseHandoffFragment('handoff=abc')).toEqual({ code: 'abc' });
  });

  it('ignores other keys, keeps only handoff', () => {
    expect(parseHandoffFragment('#handoff=abc&foo=bar')).toEqual({ code: 'abc' });
  });

  it('URL-decodes the code value', () => {
    expect(parseHandoffFragment('#handoff=a%2Bb')).toEqual({ code: 'a+b' });
  });

  it('returns null for empty hash', () => {
    expect(parseHandoffFragment('')).toBeNull();
    expect(parseHandoffFragment('#')).toBeNull();
  });

  it('returns null when handoff key absent', () => {
    expect(parseHandoffFragment('#token=xyz')).toBeNull();
  });

  it('returns null for empty handoff value', () => {
    expect(parseHandoffFragment('#handoff=')).toBeNull();
  });
});
