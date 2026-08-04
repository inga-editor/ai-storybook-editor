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
  projectPoolFields,
  diffPoolDraft,
} from './spread-pool-helpers';
import type { BranchSetting, Section } from '@/types/illustration-types';
import type { BaseSpread } from '@/types/spread-types';

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

describe('projectPoolFields', () => {
  function spread(id: string, over: Partial<BaseSpread> = {}): BaseSpread {
    return { id, pages: [], images: [], textboxes: [], ...over };
  }

  it('extracts pool + title from spreads into a draft object', () => {
    const spreads = [
      spread('sp1', { pool: { is_true: true, is_default: false }, title: { en_US: { text: 'Hello' } } }),
      spread('sp2', { pool: undefined, title: undefined }),
      spread('sp3'), // neither pool nor title
    ];
    const draft = projectPoolFields(spreads);
    expect(draft).toEqual({
      sp1: { pool: { is_true: true, is_default: false }, title: { en_US: { text: 'Hello' } } },
      sp2: { pool: null, title: null },
      sp3: { pool: null, title: null },
    });
  });

  it('always includes both pool and title keys (even if null)', () => {
    const spreads = [spread('sp1')];
    const draft = projectPoolFields(spreads);
    expect(draft.sp1).toHaveProperty('pool');
    expect(draft.sp1).toHaveProperty('title');
    expect(draft.sp1.pool).toBeNull();
    expect(draft.sp1.title).toBeNull();
  });

  it('empty spreads → empty draft', () => {
    expect(projectPoolFields([])).toEqual({});
  });

  it('does not include thumbnail_url (BE leaf-write stays out)', () => {
    const spreads = [spread('sp1', { thumbnail_url: 'https://cdn.example.com/thumb.webp' })];
    const draft = projectPoolFields(spreads);
    expect(draft.sp1).not.toHaveProperty('thumbnail_url');
  });
});

describe('diffPoolDraft', () => {
  function spread(id: string, over: Partial<BaseSpread> = {}): BaseSpread {
    return { id, pages: [], images: [], textboxes: [], ...over };
  }

  it('returns empty array when draft matches source', () => {
    const spreads = [
      spread('sp1', { pool: { is_true: true, is_default: false }, title: { en_US: { text: 'Hello' } } }),
    ];
    const source = projectPoolFields(spreads);
    const draft = projectPoolFields(spreads); // identical copy
    expect(diffPoolDraft(draft, source)).toEqual([]);
  });

  it('detects pool changes', () => {
    const spreads = [spread('sp1', { pool: { is_true: true, is_default: false } })];
    const source = projectPoolFields(spreads);
    const draft = { sp1: { pool: { is_true: false, is_default: false }, title: null } };
    const diffs = diffPoolDraft(draft, source);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].spreadId).toBe('sp1');
    expect(diffs[0].patch).toEqual({ pool: { is_true: false, is_default: false } });
  });

  it('detects title changes', () => {
    const spreads = [spread('sp1', { title: { en_US: { text: 'Hello' } } })];
    const source = projectPoolFields(spreads);
    const draft = { sp1: { pool: null, title: { en_US: { text: 'World' } } } };
    const diffs = diffPoolDraft(draft, source);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].patch).toEqual({ title: { en_US: { text: 'World' } } });
  });

  it('detects both pool and title changes in one spread', () => {
    const spreads = [spread('sp1', { pool: { is_true: true, is_default: false }, title: { en_US: { text: 'Old' } } })];
    const source = projectPoolFields(spreads);
    const draft = { sp1: { pool: { is_true: false, is_default: true }, title: { en_US: { text: 'New' } } } };
    const diffs = diffPoolDraft(draft, source);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].patch).toEqual({
      pool: { is_true: false, is_default: true },
      title: { en_US: { text: 'New' } },
    });
  });

  it('prunes deleted spreads: ids gone from source are skipped', () => {
    const spreads = [spread('sp1', { title: { en_US: { text: 'Hello' } } })];
    const source = projectPoolFields(spreads);
    // Draft has a spread that no longer exists in source
    const draft = {
      sp1: { pool: null, title: { en_US: { text: 'Hello' } } },
      sp2: { pool: null, title: { en_US: { text: 'Orphaned' } } }, // deleted
    };
    const diffs = diffPoolDraft(draft, source);
    // sp2 is not in source, so it's pruned
    expect(diffs).toEqual([]);
  });

  it('only emits NON-NULL values in patch', () => {
    const spreads = [
      spread('sp1', { pool: { is_true: true, is_default: false } }),
      spread('sp2', { pool: undefined, title: { en_US: { text: 'Has title' } } }),
    ];
    const source = projectPoolFields(spreads);
    const draft = {
      sp1: { pool: { is_true: false, is_default: false }, title: undefined }, // pool changed
      sp2: { pool: undefined, title: undefined }, // both undefined (cleared)
    };
    const diffs = diffPoolDraft(draft, source);
    // sp1: pool changed (emitted)
    // sp2: title went from "Has title" to null (not emitted — only non-null values)
    expect(diffs).toHaveLength(1);
    expect(diffs[0].spreadId).toBe('sp1');
    expect(diffs[0].patch).toEqual({ pool: { is_true: false, is_default: false } });
  });

  it('preserves order of changed spreads', () => {
    const spreads = [
      spread('sp1', { title: { en_US: { text: 'First' } } }),
      spread('sp2', { title: { en_US: { text: 'Second' } } }),
      spread('sp3', { title: { en_US: { text: 'Third' } } }),
    ];
    const source = projectPoolFields(spreads);
    const draft = {
      sp1: { pool: null, title: { en_US: { text: 'Changed' } } },
      sp2: { pool: null, title: { en_US: { text: 'Second' } } }, // unchanged
      sp3: { pool: null, title: { en_US: { text: 'Changed' } } },
    };
    const diffs = diffPoolDraft(draft, source);
    expect(diffs.map((d) => d.spreadId)).toEqual(['sp1', 'sp3']);
  });
});
