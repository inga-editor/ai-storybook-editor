// branch-title.test.ts — multi-language title resolution + structural-key safety.

import { describe, it, expect } from 'vitest';
import { localizedTitle, resolveBranchTitle } from './branch-title';
import type { Branch, BranchSetting } from '@/types/illustration-types';

const branchSetting: BranchSetting = {
  branches: [{ section_id: 'sec1', is_default: true }],
  en_US: { title: 'Which path?' },
  vi_VN: { title: 'Đường nào?' },
};

const branchOnlyVi: BranchSetting = {
  branches: [],
  vi_VN: { title: 'Chỉ tiếng Việt' },
};

const branchNoLocale: Branch = {
  section_id: 'sec_x',
  is_default: false,
  image_url: 'https://example.com/x.png',
};

describe('localizedTitle', () => {
  it('reads node[lang].title when present', () => {
    expect(localizedTitle(branchSetting, 'en_US')).toBe('Which path?');
    expect(localizedTitle(branchSetting, 'vi_VN')).toBe('Đường nào?');
  });

  it('returns null for a missing language', () => {
    expect(localizedTitle(branchSetting, 'ja_JP')).toBeNull();
  });

  it('never treats a structural key as a locale', () => {
    expect(localizedTitle(branchSetting, 'branches')).toBeNull();
    expect(localizedTitle(branchNoLocale, 'image_url')).toBeNull();
    expect(localizedTitle(branchNoLocale, 'section_id')).toBeNull();
  });
});

describe('resolveBranchTitle', () => {
  it('prefers the requested language', () => {
    expect(resolveBranchTitle(branchSetting, 'en_US', 'fallback')).toBe('Which path?');
  });

  it('falls back to the first available language when the requested one is absent', () => {
    expect(resolveBranchTitle(branchOnlyVi, 'en_US', 'fallback')).toBe('Chỉ tiếng Việt');
  });

  it('falls back to the provided fallback when no localized title exists', () => {
    expect(resolveBranchTitle(branchNoLocale, 'en_US', 'Section A')).toBe('Section A');
  });

  it('falls back to empty string when fallback is empty and no title exists', () => {
    expect(resolveBranchTitle(branchNoLocale, 'en_US', '')).toBe('');
  });

  it('ignores an empty-string localized title (treats it as absent)', () => {
    const emptyTitle: BranchSetting = { branches: [], en_US: { title: '' }, vi_VN: { title: 'Có tiêu đề' } };
    expect(resolveBranchTitle(emptyTitle, 'en_US', 'fb')).toBe('Có tiêu đề');
  });
});
