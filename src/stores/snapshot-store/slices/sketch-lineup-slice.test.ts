// Lineup tab setters (sketch-lineup-slice, 2026-07-25): virtual-tab seeding, id-stable rename,
// remove, whole-entries replace — and the sync.isDirty contract (solo persist path).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
  },
}));

import { useSnapshotStore } from '@/stores/snapshot-store';
import type { SketchLineupTab } from '@/types/sketch';

const tab = (id: string, over: Partial<SketchLineupTab> = {}): SketchLineupTab => ({
  id,
  name: `Tab ${id}`,
  entries: [],
  ...over,
});

const charEntry = { kind: 'characters' as const, entity_key: 'elara', variant_key: 'base' };
const propEntry = { kind: 'props' as const, entity_key: 'wand', variant_key: 'base' };

const setLineups = (lineups: SketchLineupTab[]) => {
  useSnapshotStore.setState((s) => {
    s.sketch.lineups = lineups;
    s.sync.isDirty = false;
  });
};

const state = () => useSnapshotStore.getState();

describe('sketch-lineup-slice', () => {
  beforeEach(() => setLineups([]));

  describe('addSketchLineupTab', () => {
    it('seeds [virtualTab, tab] when lineups is empty and a virtualTab is given (materialize)', () => {
      const virtual = tab('virtual', { entries: [charEntry] });
      state().addSketchLineupTab(tab('new'), virtual);
      expect(state().sketch.lineups.map((t) => t.id)).toEqual(['virtual', 'new']);
      expect(state().sync.isDirty).toBe(true);
    });

    it('appends WITHOUT re-seeding when tabs already exist', () => {
      setLineups([tab('t1')]);
      state().addSketchLineupTab(tab('t2'), tab('virtual'));
      expect(state().sketch.lineups.map((t) => t.id)).toEqual(['t1', 't2']);
    });

    it('plain append when no virtualTab is given', () => {
      state().addSketchLineupTab(tab('only'));
      expect(state().sketch.lineups.map((t) => t.id)).toEqual(['only']);
    });

    it('does NOT duplicate when tab IS the virtual tab (materialize-by-edit shape)', () => {
      const virtual = tab('virtual');
      state().addSketchLineupTab({ ...virtual, entries: [charEntry] }, virtual);
      expect(state().sketch.lineups.map((t) => t.id)).toEqual(['virtual']);
      expect(state().sketch.lineups[0].entries).toEqual([charEntry]);
    });
  });

  describe('renameSketchLineupTab', () => {
    it('renames by id, keeping the id (identity never changes on rename)', () => {
      setLineups([tab('t1'), tab('t2')]);
      state().renameSketchLineupTab('t2', 'Winter cast');
      const t2 = state().sketch.lineups.find((t) => t.id === 't2');
      expect(t2).toMatchObject({ id: 't2', name: 'Winter cast' });
      expect(state().sync.isDirty).toBe(true);
    });

    it('unknown id → no-op and stays clean', () => {
      setLineups([tab('t1')]);
      state().renameSketchLineupTab('ghost', 'X');
      expect(state().sketch.lineups[0].name).toBe('Tab t1');
      expect(state().sync.isDirty).toBe(false);
    });
  });

  describe('removeSketchLineupTab', () => {
    it('removes by id (incl. the LAST tab — the last-tab guard is a UI rule)', () => {
      setLineups([tab('t1')]);
      state().removeSketchLineupTab('t1');
      expect(state().sketch.lineups).toEqual([]);
      expect(state().sync.isDirty).toBe(true);
    });

    it('unknown id → no-op and stays clean', () => {
      setLineups([tab('t1')]);
      state().removeSketchLineupTab('ghost');
      expect(state().sketch.lineups).toHaveLength(1);
      expect(state().sync.isDirty).toBe(false);
    });
  });

  describe('setSketchLineupTabEntries', () => {
    it('replaces the whole entries[] preserving the caller order', () => {
      setLineups([tab('t1', { entries: [charEntry] })]);
      state().setSketchLineupTabEntries('t1', [propEntry, charEntry]);
      expect(state().sketch.lineups[0].entries).toEqual([propEntry, charEntry]);
      expect(state().sync.isDirty).toBe(true);
    });

    it('accepts [] (uncheck-all keeping-dangling is built by the CALLER)', () => {
      setLineups([tab('t1', { entries: [charEntry] })]);
      state().setSketchLineupTabEntries('t1', []);
      expect(state().sketch.lineups[0].entries).toEqual([]);
    });

    it('unknown tab id → no-op and stays clean', () => {
      setLineups([tab('t1')]);
      state().setSketchLineupTabEntries('ghost', [charEntry]);
      expect(state().sketch.lineups[0].entries).toEqual([]);
      expect(state().sync.isDirty).toBe(false);
    });
  });
});
