// Pins the Variants-space group config. This space keeps its OWN KIND_GROUPS (the Base space's
// carries `sheetName`, an import-only concern), so a kind added to the Base space does NOT reach
// this sidebar — the two lists can only be kept in sync on purpose, which is what this file checks.
import { describe, it, expect } from 'vitest';
import { KIND_ENTITY_SOURCE, type BaseKind } from '@/types/sketch';
import { KIND_GROUPS, titleCase } from './sketch-variants-constants';
import { KIND_GROUPS as BASE_KIND_GROUPS } from '../sketch-base-creative-space/sketch-base-constants';
import { SKETCH_KIND_TO_RESOURCE_TYPE } from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';

describe('variants KIND_GROUPS', () => {
  it('renders three groups, alter LAST (same order as the Base space)', () => {
    expect(KIND_GROUPS.map((g) => g.kind)).toEqual(['characters', 'props', 'alter_characters']);
  });

  it('covers every BaseKind — a kind with no group could never be reached in this space', () => {
    const kinds = Object.keys(KIND_ENTITY_SOURCE) as BaseKind[];
    expect(new Set(KIND_GROUPS.map((g) => g.kind))).toEqual(new Set(kinds));
  });

  it('titles/nouns match the Base space (no label drift between the two sidebars)', () => {
    for (const g of KIND_GROUPS) {
      const base = BASE_KIND_GROUPS.find((b) => b.kind === g.kind);
      expect({ title: g.title, noun: g.noun }).toEqual({ title: base?.title, noun: base?.noun });
    }
  });

  it('the alter group does NOT reuse the Prop copy (regression: nounForKind fell through)', () => {
    const alter = KIND_GROUPS.find((g) => g.kind === 'alter_characters');
    expect(alter?.noun).toBe('alter character');
    expect(titleCase(alter!.noun)).toBe('Alter Character');
  });

  it('every rendered group has a peer-lock rtype; alter shares the character node type', () => {
    for (const g of KIND_GROUPS) expect(SKETCH_KIND_TO_RESOURCE_TYPE[g.kind]).toBeGreaterThan(0);
    // An alter IS a `characters[]` entity — same rtype 3, same grant; the entity key disambiguates.
    expect(SKETCH_KIND_TO_RESOURCE_TYPE.alter_characters).toBe(
      SKETCH_KIND_TO_RESOURCE_TYPE.characters,
    );
  });

  it('the group kind maps to a REAL snapshot collection (saveResource path segment)', () => {
    // `alter_characters` is not a snapshot key — every path/storage segment must go through this.
    expect(KIND_ENTITY_SOURCE.alter_characters.collection).toBe('characters');
    for (const g of KIND_GROUPS) {
      expect(['characters', 'props']).toContain(KIND_ENTITY_SOURCE[g.kind].collection);
    }
  });
});
