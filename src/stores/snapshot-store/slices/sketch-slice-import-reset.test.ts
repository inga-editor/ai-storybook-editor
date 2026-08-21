// sketch-slice-import-reset.test.ts — ⚡REV 2026-08-21 `setSketchBaseEntities` whole-replace with
// `sheetGroups`. An Excel import replaces the whole cast; `sheetGroups` is the COMPLETE new set of
// base groups, so each listed group's node is reset ({kind,name,styles:[]}) and any base key NOT
// listed (a group that vanished from the workbook) is DELETED locally.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock supabase so importing the REAL snapshot store does not initialise a client.
vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
  },
}));

import { useSnapshotStore } from '@/stores/snapshot-store';
import type { BaseGroup, SketchBaseStyle, SketchEntity } from '@/types/sketch';

const asState = <T,>(v: T) => v as never;

const style = (prompt: string): SketchBaseStyle => ({
  style_prompt: prompt,
  is_selected: true, // locked pick — exactly what must not survive a cast replace
  image_references: [],
  illustrations: [],
  crops: [],
});

const entity = (key: string, group?: string): SketchEntity =>
  ({ key, ...(group ? { group } : {}), variants: [] }) as never;

const group = (group_key: string, kind: BaseGroup['kind'], name = group_key): BaseGroup => ({
  group_key,
  kind,
  name,
});

beforeEach(() => {
  useSnapshotStore.setState((s) => {
    s.sketch.characters = asState([entity('old-hero', 'heroes'), entity('old-extra', 'extras')]);
    s.sketch.props = asState([entity('old-sword', 'weapons')]);
    s.sketch.base = asState({
      heroes: { kind: 'characters', name: 'Heroes', styles: [style('hero-style')] },
      extras: { kind: 'characters', name: 'Extras', styles: [style('extra-style')] },
      weapons: { kind: 'props', name: 'Weapons', styles: [style('weapon-style')] },
    });
    s.sync.isDirty = false;
  });
});

describe('setSketchBaseEntities — whole-replace + sheetGroups', () => {
  it('resets each listed group node and DELETES groups that vanished from the import', () => {
    useSnapshotStore.getState().setSketchBaseEntities({
      characters: [entity('new-hero', 'heroes')],
      props: [entity('new-sword', 'weapons')],
      // `extras` is gone from this import → its base node must be deleted.
      sheetGroups: [group('heroes', 'characters', 'Heroes'), group('weapons', 'props', 'Weapons')],
    });
    const st = useSnapshotStore.getState();
    expect(st.sketch.characters.map((e) => e.key)).toEqual(['new-hero']);
    expect(Object.keys(st.sketch.base).sort()).toEqual(['heroes', 'weapons']); // extras dropped
    expect(st.sketch.base.heroes.styles).toEqual([]); // locked pick reset
    expect(st.sketch.base.weapons.styles).toEqual([]);
    expect(st.sketch.base.heroes.kind).toBe('characters');
    expect(st.sketch.base.heroes.name).toBe('Heroes');
    expect(st.sync.isDirty).toBe(true);
  });

  it('seeds a brand-new group node listed in sheetGroups', () => {
    useSnapshotStore.getState().setSketchBaseEntities({
      characters: [entity('a', 'heroes'), entity('b', 'sidekicks')],
      props: [],
      sheetGroups: [group('heroes', 'characters'), group('sidekicks', 'characters', 'Sidekicks')],
    });
    const base = useSnapshotStore.getState().sketch.base;
    expect(Object.keys(base).sort()).toEqual(['heroes', 'sidekicks']); // weapons + extras dropped
    expect(base.sidekicks).toEqual({ kind: 'characters', name: 'Sidekicks', order: 1, styles: [] });
  });

  it('omitting sheetGroups leaves every base node untouched (cast-only replace)', () => {
    useSnapshotStore.getState().setSketchBaseEntities({
      characters: [entity('new-hero', 'heroes')],
      props: [],
    });
    const base = useSnapshotStore.getState().sketch.base;
    expect(Object.keys(base).sort()).toEqual(['extras', 'heroes', 'weapons']);
    expect(base.heroes.styles).toHaveLength(1);
    expect(base.weapons.styles).toHaveLength(1);
  });
});
