// Pins the Variants-space pure helpers. ⚡REV 2026-08-21 — the space is GROUP-BASED: the sidebar
// groups are dynamic (`useSketchBaseGroups()`), so there is no longer a hard `KIND_GROUPS` list to
// keep in sync. What remains testable here are the pure ref/text helpers + the shared `titleCase`
// (also imported by the sibling Base space — a rename would break it).
import { describe, it, expect } from 'vitest';
import type { VariantRef } from '@/types/sketch';
import {
  GATE_TOOLTIP,
  isBlank,
  isVariantPicked,
  sameRef,
  titleCase,
} from './sketch-variants-constants';

const ref = (over: Partial<VariantRef> = {}): VariantRef => ({
  group: 'character_sheet',
  kind: 'characters',
  entityKey: 'elara',
  variantKey: 'fairy',
  ...over,
});

describe('sameRef', () => {
  it('matches on kind + entityKey + variantKey (group not compared — derived from the entity)', () => {
    expect(sameRef(ref(), ref({ group: 'anything_else' }))).toBe(true);
  });

  it('differs when any of kind / entityKey / variantKey differ', () => {
    expect(sameRef(ref(), ref({ variantKey: 'warrior' }))).toBe(false);
    expect(sameRef(ref(), ref({ entityKey: 'kai' }))).toBe(false);
    expect(sameRef(ref(), ref({ kind: 'props' }))).toBe(false);
  });

  it('is null-safe on either side', () => {
    expect(sameRef(null, ref())).toBe(false);
    expect(sameRef(ref(), undefined)).toBe(false);
    expect(sameRef(null, null)).toBe(false);
  });
});

describe('isBlank', () => {
  it('true for absent / whitespace-only, false for real text', () => {
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('   \n\t ')).toBe(true);
    expect(isBlank('x')).toBe(false);
  });
});

describe('isVariantPicked', () => {
  it('true only when a crop is is_selected', () => {
    expect(isVariantPicked(undefined)).toBe(false);
    expect(
      isVariantPicked({
        key: 'fairy',
        description: '',
        visual_design: '',
        art_language: '',
        raw_sheet: { illustrations: [], crops: [] },
      }),
    ).toBe(false);
    expect(
      isVariantPicked({
        key: 'fairy',
        description: '',
        visual_design: '',
        art_language: '',
        raw_sheet: {
          illustrations: [],
          crops: [{ is_selected: true, illustrations: [] }],
        },
      }),
    ).toBe(true);
  });
});

describe('titleCase (shared — also imported by the Base space)', () => {
  it('splits on _/-/space and capitalizes each word', () => {
    expect(titleCase('kid_hero')).toBe('Kid Hero');
    expect(titleCase('ancient-tome')).toBe('Ancient Tome');
    expect(titleCase('magic wand')).toBe('Magic Wand');
  });
});

describe('GATE_TOOLTIP', () => {
  it('covers exactly the two surviving reasons (no `no-art-style`)', () => {
    expect(Object.keys(GATE_TOOLTIP).sort()).toEqual(['base-not-ready', 'empty-text']);
  });
});
