// sketch-slice-import-reset.test.ts — `setSketchBaseEntities` sheet reset (2026-08-05). An Excel
// import whole-replaces the cast; the kinds' base sheets (raw lineup images + locked pick) picture
// the OLD entities, so `resetSheetKinds` must clear them in the SAME atomic update — and must NOT
// touch the alter sheet when the alter cast was preserved (tab absent).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock supabase so importing the REAL snapshot store does not initialise a client.
vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
  },
}));

import { useSnapshotStore } from '@/stores/snapshot-store';
import type { SketchBaseStyle, SketchEntity } from '@/types/sketch';

const asState = <T,>(v: T) => v as never;

const style = (prompt: string): SketchBaseStyle => ({
  style_prompt: prompt,
  is_selected: true, // locked pick — exactly what must not survive a cast replace
  image_references: [],
  illustrations: [],
  crops: [],
});

const entity = (key: string, actorRole?: number): SketchEntity =>
  ({ key, ...(actorRole != null ? { actor_role: actorRole } : {}), variants: [] }) as never;

beforeEach(() => {
  useSnapshotStore.setState((s) => {
    s.sketch.characters = asState([entity('old-hero'), entity('old-alter', 1)]);
    s.sketch.props = asState([entity('old-sword')]);
    s.sketch.base = asState({
      character_sheet: { styles: [style('char-style')] },
      prop_sheet: { styles: [style('prop-style')] },
      alter_character_sheet: { styles: [style('alter-style')] },
    });
    s.sync.isDirty = false;
  });
});

describe('setSketchBaseEntities — resetSheetKinds', () => {
  it('clears the named kinds’ sheets atomically with the cast replace', () => {
    useSnapshotStore.getState().setSketchBaseEntities({
      characters: [entity('new-hero')],
      props: [entity('new-sword')],
      resetSheetKinds: ['characters', 'props', 'alter_characters'],
    });
    const st = useSnapshotStore.getState();
    expect(st.sketch.characters.map((e) => e.key)).toEqual(['new-hero']);
    expect(st.sketch.base.character_sheet.styles).toEqual([]);
    expect(st.sketch.base.prop_sheet.styles).toEqual([]);
    expect(st.sketch.base.alter_character_sheet.styles).toEqual([]);
    expect(st.sync.isDirty).toBe(true);
  });

  it('preserves the alter sheet when alter_characters is not in the reset list', () => {
    useSnapshotStore.getState().setSketchBaseEntities({
      characters: [entity('new-hero'), entity('old-alter', 1)], // alter cast preserved by the commit
      props: [],
      resetSheetKinds: ['characters', 'props'],
    });
    const base = useSnapshotStore.getState().sketch.base;
    expect(base.character_sheet.styles).toEqual([]);
    expect(base.prop_sheet.styles).toEqual([]);
    expect(base.alter_character_sheet.styles).toHaveLength(1); // untouched
  });

  it('omitting resetSheetKinds leaves every sheet untouched (backwards-compatible)', () => {
    useSnapshotStore.getState().setSketchBaseEntities({
      characters: [entity('new-hero')],
      props: [],
    });
    const base = useSnapshotStore.getState().sketch.base;
    expect(base.character_sheet.styles).toHaveLength(1);
    expect(base.prop_sheet.styles).toHaveLength(1);
    expect(base.alter_character_sheet.styles).toHaveLength(1);
  });
});
