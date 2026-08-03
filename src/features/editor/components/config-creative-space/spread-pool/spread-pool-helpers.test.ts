// spread-pool-helpers.test.ts — pure logic for the Spread Pool config section.
// vitest only — NO node builtins (tsc -b type-checks with vite/client types).

import { describe, it, expect } from 'vitest';
import {
  isPoolToggleLocked,
  mergePool,
  shouldSkipPoolWrite,
  mergeTitle,
  resolveTitleText,
  originalTitleText,
} from './spread-pool-helpers';
import type { BranchSetting, Section } from '@/types/illustration-types';

function section(over: Partial<Section>): Section {
  return { id: 's', title: '', start_spread_id: '', end_spread_id: '', ...over };
}
const BRANCH = {} as BranchSetting;

describe('mergePool', () => {
  it('seeds an all-false object when current pool is absent', () => {
    expect(mergePool(null, { is_true: true })).toEqual({ is_true: true, is_default: false });
    expect(mergePool(undefined, { is_true: true })).toEqual({ is_true: true, is_default: false });
  });

  it('KEEPS is_default when only is_true toggles off', () => {
    const current = { is_true: true, is_default: true };
    expect(mergePool(current, { is_true: false })).toEqual({ is_true: false, is_default: true });
  });

  it('overrides is_default independently of is_true', () => {
    const current = { is_true: true, is_default: false };
    expect(mergePool(current, { is_default: true })).toEqual({ is_true: true, is_default: true });
  });
});

describe('shouldSkipPoolWrite', () => {
  it('true when pool absent AND toggling OFF with no default change (never-pooled legacy)', () => {
    expect(shouldSkipPoolWrite(null, { is_true: false })).toBe(true);
    expect(shouldSkipPoolWrite(undefined, { is_true: false })).toBe(true);
  });

  it('false when toggling ON', () => {
    expect(shouldSkipPoolWrite(null, { is_true: true })).toBe(false);
  });

  it('false when pool already exists', () => {
    expect(shouldSkipPoolWrite({ is_true: true, is_default: false }, { is_true: false })).toBe(false);
  });

  it('false when a default change is present even with pool absent', () => {
    expect(shouldSkipPoolWrite(null, { is_true: false, is_default: true })).toBe(false);
  });
});

describe('mergeTitle', () => {
  it('sets a trimmed text under the language key', () => {
    expect(mergeTitle(null, 'en_US', '  Hello  ')).toEqual({ en_US: { text: 'Hello' } });
  });

  it('DELETES the language key when text is empty/whitespace (no {text:""} residue)', () => {
    const current = { en_US: { text: 'Hi' }, vi_VN: { text: 'Chào' } };
    expect(mergeTitle(current, 'en_US', '   ')).toEqual({ vi_VN: { text: 'Chào' } });
  });

  it('does not mutate the input object', () => {
    const current = { en_US: { text: 'Hi' } };
    mergeTitle(current, 'vi_VN', 'Chào');
    expect(current).toEqual({ en_US: { text: 'Hi' } });
  });
});

describe('resolveTitleText', () => {
  it('prefers the original-language text', () => {
    const title = { en_US: { text: 'English' }, vi_VN: { text: 'Việt' } };
    expect(resolveTitleText(title, 'en_US', 3)).toBe('English');
  });

  it('falls back to the first available language when original is empty/absent', () => {
    const title = { vi_VN: { text: 'Việt' } };
    expect(resolveTitleText(title, 'en_US', 3)).toBe('Việt');
  });

  it('falls back to `Spread {index}` when title is null/empty', () => {
    expect(resolveTitleText(null, 'en_US', 4)).toBe('Spread 4');
    expect(resolveTitleText({ en_US: { text: '  ' } }, 'en_US', 5)).toBe('Spread 5');
  });
});

describe('originalTitleText', () => {
  it('returns raw original-language text or empty string', () => {
    expect(originalTitleText({ en_US: { text: 'Hi' } }, 'en_US')).toBe('Hi');
    expect(originalTitleText(null, 'en_US')).toBe('');
    expect(originalTitleText({ vi_VN: { text: 'Chào' } }, 'en_US')).toBe('');
  });
});

describe('isPoolToggleLocked', () => {
  it('returns null for a plain spread with no branch/section link', () => {
    expect(isPoolToggleLocked({ id: 'sp1' }, [])).toBeNull();
  });

  it("returns 'branch' when the spread carries branch_setting", () => {
    expect(isPoolToggleLocked({ id: 'sp1', branch_setting: BRANCH }, [])).toBe('branch');
  });

  it("returns 'section' when the spread id is a start/end/next anchor", () => {
    const sections = [
      section({ start_spread_id: 'sp2', end_spread_id: 'sp3', next_spread_id: 'sp4' }),
    ];
    expect(isPoolToggleLocked({ id: 'sp2' }, sections)).toBe('section'); // start
    expect(isPoolToggleLocked({ id: 'sp3' }, sections)).toBe('section'); // end
    expect(isPoolToggleLocked({ id: 'sp4' }, sections)).toBe('section'); // next
    expect(isPoolToggleLocked({ id: 'sp9' }, sections)).toBeNull(); // unrelated
  });

  it("prefers 'branch' over 'section' when both apply", () => {
    const sections = [section({ start_spread_id: 'sp1', end_spread_id: 'sp1' })];
    expect(isPoolToggleLocked({ id: 'sp1', branch_setting: BRANCH }, sections)).toBe('branch');
  });
});
