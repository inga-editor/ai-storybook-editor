// sketch-kind-entity-selectors.test.ts — the kind→entity read seam introduced with alter
// characters (⚡ 2026-07-28). `alter_characters` is a VIRTUAL kind over `sketch.characters[]`
// (actor_role === 1): `sketch['alter_characters']` does not exist, so every selector must resolve
// through KIND_ENTITY_SOURCE. A missing filter here has NO type/runtime/server error — it just
// ships the wrong cast — hence both directions are asserted, plus ref-stability (a fresh
// `.filter()` array on every render is a re-render loop waiting to happen).
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
  useStoryCharacters,
  useAlterCharacters,
  useSketchKindEntities,
  useSketchEntityKeys,
  useSketchEntityByKey,
  useSketchBaseEntityKeys,
  selectStoryCharacters,
  selectAlterCharacters,
} from '@/stores/snapshot-store/selectors';
import type { SketchEntity } from '@/types/sketch';

const variant = (key: string) => ({ key, description: '', visual_design: '', art_language: '' });

const CAST: SketchEntity[] = [
  { key: 'hero', variants: [variant('base')] },
  { key: 'hero_alt', actor_role: 1, variants: [variant('base')] },
  { key: 'sidekick', actor_role: 0, variants: [] }, // explicit 0 = story cast
  { key: 'villain_alt', actor_role: 1, variants: [] },
];

const seed = () => {
  act(() => {
    useSnapshotStore.setState((s) => {
      s.sketch.characters = CAST;
      s.sketch.props = [{ key: 'wand', variants: [variant('base')] }];
    });
  });
};

describe('kind → entity selectors', () => {
  beforeEach(seed);

  it('useStoryCharacters excludes every alter (absent ⇒ 0, explicit 0 included)', () => {
    const { result } = renderHook(() => useStoryCharacters());
    expect(result.current.map((e) => e.key)).toEqual(['hero', 'sidekick']);
  });

  it('useAlterCharacters returns ONLY actor_role === 1', () => {
    const { result } = renderHook(() => useAlterCharacters());
    expect(result.current.map((e) => e.key)).toEqual(['hero_alt', 'villain_alt']);
  });

  it('useSketchKindEntities(props) passes the collection through (no role split)', () => {
    const { result } = renderHook(() => useSketchKindEntities('props'));
    expect(result.current.map((e) => e.key)).toEqual(['wand']);
    // props has no `actorRole` → the raw store ref is returned unchanged.
    expect(result.current).toBe(useSnapshotStore.getState().sketch.props);
  });

  it('returns a REFERENTIALLY STABLE array across re-renders (no filter-per-render loop)', () => {
    const { result, rerender } = renderHook(() => useAlterCharacters());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('key/entity lookups are kind-scoped (an alter key misses under `characters`)', () => {
    expect(renderHook(() => useSketchEntityKeys('alter_characters')).result.current).toEqual([
      'hero_alt',
      'villain_alt',
    ]);
    expect(
      renderHook(() => useSketchEntityByKey('characters', 'hero_alt')).result.current,
    ).toBeUndefined();
    expect(
      renderHook(() => useSketchEntityByKey('alter_characters', 'hero_alt')).result.current?.key,
    ).toBe('hero_alt');
  });

  it('useSketchBaseEntityKeys filters by kind AND by having a `base` variant', () => {
    expect(renderHook(() => useSketchBaseEntityKeys('characters')).result.current).toEqual(['hero']);
    expect(renderHook(() => useSketchBaseEntityKeys('alter_characters')).result.current).toEqual([
      'hero_alt',
    ]);
  });

  it('pure selectors mirror the hooks (imperative callers: job slices, getState reads)', () => {
    const state = useSnapshotStore.getState();
    expect(selectStoryCharacters(state).map((e) => e.key)).toEqual(['hero', 'sidekick']);
    expect(selectAlterCharacters(state).map((e) => e.key)).toEqual(['hero_alt', 'villain_alt']);
  });
});
