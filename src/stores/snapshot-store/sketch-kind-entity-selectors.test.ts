// sketch-kind-entity-selectors.test.ts — ⚡REV 2026-08-21 the GROUP read seam. Base sheets are a
// dynamic group map; entities carry `group` (legacy books derive it via `resolveEntityGroup`, the
// ONLY remaining `actor_role` read). Covers `useSketchBaseGroups` (union + sort + legacy derive),
// `useSketchGroupEntities` (per-group filter + ref stability), and the plain kind reads.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
  },
}));

import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  useSketchBaseGroups,
  useSketchGroupEntities,
  useSketchKindEntities,
  useSketchEntityKeys,
  useSketchEntityByKey,
  useSketchBaseEntityKeys,
} from '@/stores/snapshot-store/selectors';
import type { SketchBase, SketchEntity } from '@/types/sketch';

const variant = (key: string) => ({ key, description: '', visual_design: '', art_language: '' });

const seed = (base: SketchBase, characters: SketchEntity[], props: SketchEntity[]) => {
  act(() => {
    useSnapshotStore.setState((s) => {
      s.sketch.base = base as never;
      s.sketch.characters = characters;
      s.sketch.props = props;
    });
  });
};

// A legacy blob: base has the 3 hard-coded group keys (no self-describing kind/name), entities
// carry NO `group` and the old `actor_role` flag distinguishes the alter group.
const LEGACY_BASE: SketchBase = {
  character_sheet: { styles: [] },
  prop_sheet: { styles: [] },
  alter_character_sheet: { styles: [] },
} as never;
const LEGACY_CHARS: SketchEntity[] = [
  { key: 'hero', variants: [variant('base')] }, // → character_sheet
  { key: 'hero_alt', actor_role: 1, variants: [variant('base')] } as never, // → alter_character_sheet
];
const LEGACY_PROPS: SketchEntity[] = [{ key: 'wand', variants: [variant('base')] }]; // → prop_sheet

describe('useSketchBaseGroups', () => {
  it('unions legacy base keys ∪ derived entity groups; char groups before prop, insertion order within kind', () => {
    seed(LEGACY_BASE, LEGACY_CHARS, LEGACY_PROPS);
    const { result } = renderHook(() => useSketchBaseGroups());
    // character-kind groups first, in base insertion order (character_sheet before alter_character_sheet),
    // then prop — NOT alphabetical.
    expect(result.current).toEqual([
      { group_key: 'character_sheet', kind: 'characters', name: 'character_sheet' },
      { group_key: 'alter_character_sheet', kind: 'characters', name: 'alter_character_sheet' },
      { group_key: 'prop_sheet', kind: 'props', name: 'prop_sheet' },
    ]);
  });

  it('takes kind + display name from a self-describing base node', () => {
    seed({ squad: { kind: 'characters', name: 'The Squad', styles: [] } } as never, [], []);
    const { result } = renderHook(() => useSketchBaseGroups());
    expect(result.current).toEqual([
      { group_key: 'squad', kind: 'characters', name: 'The Squad' },
    ]);
  });

  it('orders character groups by explicit `order`, NOT by (jsonb-scrambled) key insertion order', () => {
    // Keys deliberately arrive in Postgres jsonb order (by length, then bytewise) — the bug's
    // symptom. The explicit `order` (Excel tab position) must win.
    seed(
      {
        character_pet: { kind: 'characters', name: 'Character Pet', order: 1, styles: [] },
        alter_characters: { kind: 'characters', name: 'Alter Characters', order: 2, styles: [] },
        character_family: { kind: 'characters', name: 'Character Family', order: 0, styles: [] },
      } as never,
      [],
      [],
    );
    const { result } = renderHook(() => useSketchBaseGroups());
    expect(result.current.map((g) => g.group_key)).toEqual([
      'character_family',
      'character_pet',
      'alter_characters',
    ]);
  });

  it('surfaces a group that exists ONLY via an entity (no base node yet)', () => {
    seed({}, [{ key: 'a', group: 'heroes', variants: [] }], [{ key: 'b', group: 'gear', variants: [] }]);
    const { result } = renderHook(() => useSketchBaseGroups());
    expect(result.current).toEqual([
      { group_key: 'heroes', kind: 'characters', name: 'heroes' },
      { group_key: 'gear', kind: 'props', name: 'gear' },
    ]);
  });
});

describe('useSketchGroupEntities', () => {
  it('legacy: splits the char array into character_sheet vs alter_character_sheet by actor_role', () => {
    seed(LEGACY_BASE, LEGACY_CHARS, LEGACY_PROPS);
    expect(
      renderHook(() => useSketchGroupEntities('character_sheet')).result.current.map((e) => e.key),
    ).toEqual(['hero']);
    expect(
      renderHook(() => useSketchGroupEntities('alter_character_sheet')).result.current.map((e) => e.key),
    ).toEqual(['hero_alt']);
    expect(
      renderHook(() => useSketchGroupEntities('prop_sheet')).result.current.map((e) => e.key),
    ).toEqual(['wand']);
  });

  it('new book: filters by explicit entity.group', () => {
    seed({}, [
      { key: 'a', group: 'squad', variants: [] },
      { key: 'b', group: 'villains', variants: [] },
    ], []);
    expect(renderHook(() => useSketchGroupEntities('squad')).result.current.map((e) => e.key)).toEqual(['a']);
    expect(renderHook(() => useSketchGroupEntities('villains')).result.current.map((e) => e.key)).toEqual(['b']);
  });

  it('returns a REFERENTIALLY STABLE array across re-renders (no filter-per-render loop)', () => {
    seed(LEGACY_BASE, LEGACY_CHARS, LEGACY_PROPS);
    const { result, rerender } = renderHook(() => useSketchGroupEntities('character_sheet'));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('plain kind reads (no split — every character is equal)', () => {
  beforeEach(() => seed(LEGACY_BASE, LEGACY_CHARS, LEGACY_PROPS));

  it('useSketchKindEntities returns the whole raw array', () => {
    const { result } = renderHook(() => useSketchKindEntities('characters'));
    expect(result.current).toBe(useSnapshotStore.getState().sketch.characters);
    expect(result.current.map((e) => e.key)).toEqual(['hero', 'hero_alt']);
  });

  it('useSketchEntityKeys / useSketchEntityByKey read the kind array directly', () => {
    expect(renderHook(() => useSketchEntityKeys('characters')).result.current).toEqual(['hero', 'hero_alt']);
    expect(renderHook(() => useSketchEntityByKey('characters', 'hero_alt')).result.current?.key).toBe('hero_alt');
    expect(renderHook(() => useSketchEntityByKey('props', 'wand')).result.current?.key).toBe('wand');
  });

  it('useSketchBaseEntityKeys filters a group down to entities with a base variant', () => {
    expect(renderHook(() => useSketchBaseEntityKeys('character_sheet')).result.current).toEqual(['hero']);
    expect(renderHook(() => useSketchBaseEntityKeys('alter_character_sheet')).result.current).toEqual(['hero_alt']);
    expect(renderHook(() => useSketchBaseEntityKeys('prop_sheet')).result.current).toEqual(['wand']);
  });
});
