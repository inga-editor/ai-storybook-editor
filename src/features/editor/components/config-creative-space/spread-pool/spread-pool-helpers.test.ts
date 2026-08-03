// spread-pool-helpers.test.ts — pure logic for the Spread Pool config section.
// vitest only — NO node builtins (tsc -b type-checks with vite/client types).

import { describe, it, expect } from 'vitest';
import {
  SPREAD_POOL_LOCK_STEP,
  SPREAD_POOL_RESOURCE_TYPE,
  SPREAD_POOL_ACTION_TYPE,
  buildSpreadPoolLockTarget,
  mergePool,
  shouldSkipPoolWrite,
  mergeTitle,
  resolveTitleText,
  originalTitleText,
} from './spread-pool-helpers';

describe('buildSpreadPoolLockTarget', () => {
  it('pins step 2 + resource_type 6 (owned-key merge, NOT whole-node step 1)', () => {
    const target = buildSpreadPoolLockTarget('sp-1');
    // Trap #3: step MUST be 2 — step 1 would drop sibling spread keys.
    expect(target.step).toBe(2);
    expect(SPREAD_POOL_LOCK_STEP).toBe(2);
    expect(target.resource_type).toBe(6);
    expect(SPREAD_POOL_RESOURCE_TYPE).toBe(6);
    expect(target.resource_id).toBe('sp-1');
    expect(target.locale).toBeNull();
  });

  it('edit action_type is 3', () => {
    expect(SPREAD_POOL_ACTION_TYPE).toBe(3);
  });
});

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
