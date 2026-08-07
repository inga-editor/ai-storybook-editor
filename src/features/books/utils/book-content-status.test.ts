import { describe, expect, it } from 'vitest';
import { deriveBookStatus } from './book-content-status';

describe('deriveBookStatus', () => {
  it('0 spreads → empty even when step is 3 (empty wins)', () => {
    expect(deriveBookStatus(0, 3)).toBe('empty');
  });

  it('step 1 with spreads → in_progress', () => {
    expect(deriveBookStatus(5, 1)).toBe('in_progress');
  });

  it('step 2 with spreads → in_progress', () => {
    expect(deriveBookStatus(12, 2)).toBe('in_progress');
  });

  it('step 3 with spreads → completed', () => {
    expect(deriveBookStatus(12, 3)).toBe('completed');
  });

  it('negative spread count is treated as empty (guarded)', () => {
    expect(deriveBookStatus(-1, 3)).toBe('empty');
  });

  it('NaN spread count is treated as empty (guarded)', () => {
    expect(deriveBookStatus(Number.NaN, 2)).toBe('empty');
  });
});
