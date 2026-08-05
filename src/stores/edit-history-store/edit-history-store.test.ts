import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
  },
}));

import { useSnapshotStore } from '@/stores/snapshot-store';
import { useEditHistoryStore } from './index';
import { MAX_HISTORY, type ItemKey } from './types';

const asState = <T>(v: T) => v as never;

const SCENE_KEY = 'illustration-scene:6:sp1:∅' as ItemKey;

/** Read the live scene owned sub-tree's raw_images off the snapshot store. */
function liveRawImages(): unknown {
  return (useSnapshotStore.getState().illustration.spreads[0] as unknown as Record<string, unknown>).raw_images;
}
function liveImages(): unknown {
  return (useSnapshotStore.getState().illustration.spreads[0] as unknown as Record<string, unknown>).images;
}

/** Mutate the live spread's raw_images (simulates a user scene edit). */
function setRawImages(v: unknown[]): void {
  useSnapshotStore.setState((s) => {
    (s.illustration.spreads[0] as unknown as Record<string, unknown>).raw_images = v;
  });
}

beforeEach(() => {
  useEditHistoryStore.getState().reset();
  useSnapshotStore.setState((s) => {
    s.illustration = asState({
      spreads: [{ id: 'sp1', raw_images: [{ id: 'A' }], images: [{ id: 'IMG' }] }],
      sections: [],
    });
    s.sync.isDirty = false;
  });
});

describe('beginSession / endSession', () => {
  it('opens a session, sets activeKey, resets stacks', () => {
    useEditHistoryStore.getState().beginSession(SCENE_KEY, { raw_images: [{ id: 'A' }] }, 'illustration-scene');
    const st = useEditHistoryStore.getState();
    expect(st.activeKey).toBe(SCENE_KEY);
    expect(st.histories[SCENE_KEY].past).toEqual([]);
    expect(st.histories[SCENE_KEY].future).toEqual([]);
    expect(st.histories[SCENE_KEY].domain).toBe('illustration-scene');
  });

  it('endSession deletes stacks and clears activeKey when it matches', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, {}, 'illustration-scene');
    s.endSession(SCENE_KEY);
    const st = useEditHistoryStore.getState();
    expect(st.histories[SCENE_KEY]).toBeUndefined();
    expect(st.activeKey).toBeNull();
  });
});

describe('dual-session (scene ∥ retouch on one spread — ADR-044 addendum 2026-08-05)', () => {
  const RETOUCH_KEY = 'retouch:10:sp1:∅' as ItemKey;

  it('capture re-aims activeKey at the last-edited session (edit-following focus)', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, {}, 'illustration-scene');
    s.beginSession(RETOUCH_KEY, {}, 'retouch'); // last begin wins initially
    expect(useEditHistoryStore.getState().activeKey).toBe(RETOUCH_KEY);

    s.capture(SCENE_KEY, { raw_images: [] }, 'edit');
    expect(useEditHistoryStore.getState().activeKey).toBe(SCENE_KEY);

    s.capture(RETOUCH_KEY, { shapes: [] }, 'edit');
    expect(useEditHistoryStore.getState().activeKey).toBe(RETOUCH_KEY);
  });

  it('ending the ACTIVE session falls back to a still-open sibling (never orphans its undo)', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, {}, 'illustration-scene');
    s.beginSession(RETOUCH_KEY, {}, 'retouch');
    s.capture(RETOUCH_KEY, { shapes: [] }, 'edit'); // active = retouch

    s.endSession(RETOUCH_KEY);
    const st = useEditHistoryStore.getState();
    expect(st.histories[RETOUCH_KEY]).toBeUndefined();
    expect(st.activeKey).toBe(SCENE_KEY); // scene undo stays reachable

    s.endSession(SCENE_KEY);
    expect(useEditHistoryStore.getState().activeKey).toBeNull();
  });

  it('ending a NON-active session leaves activeKey untouched', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, {}, 'illustration-scene');
    s.beginSession(RETOUCH_KEY, {}, 'retouch');
    s.capture(SCENE_KEY, { raw_images: [] }, 'edit'); // active = scene

    s.endSession(RETOUCH_KEY);
    expect(useEditHistoryStore.getState().activeKey).toBe(SCENE_KEY);
  });
});

describe('capture', () => {
  it('pushes onto past and clears future', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, {}, 'illustration-scene');
    s.capture(SCENE_KEY, { raw_images: [{ id: 'A' }] }, 'edit');
    const h = useEditHistoryStore.getState().histories[SCENE_KEY];
    expect(h.past).toHaveLength(1);
    expect(h.future).toEqual([]);
  });

  it('caps past at MAX_HISTORY (drops oldest)', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, {}, 'illustration-scene');
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      s.capture(SCENE_KEY, { n: i }, 'edit');
    }
    const h = useEditHistoryStore.getState().histories[SCENE_KEY];
    expect(h.past).toHaveLength(MAX_HISTORY);
    // oldest 10 dropped → past[0] is the 11th capture (n === 10).
    expect((h.past[0].snapshot as { n: number }).n).toBe(10);
    expect((h.past[MAX_HISTORY - 1].snapshot as { n: number }).n).toBe(MAX_HISTORY + 9);
  });

  it('ignores a capture for a key with no live session', () => {
    useEditHistoryStore.getState().capture('illustration-scene:6:none:∅' as ItemKey, {}, 'edit');
    expect(useEditHistoryStore.getState().histories['illustration-scene:6:none:∅']).toBeUndefined();
  });
});

describe('undo / redo (scene owned-key merge apply)', () => {
  it('undo restores the pre-edit sub-tree (retouch keys preserved); redo re-applies', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, { raw_images: [{ id: 'A' }] }, 'illustration-scene');

    // User edit: A → [A, B]; capture the pre-edit checkpoint.
    s.capture(SCENE_KEY, { raw_images: [{ id: 'A' }] }, 'edit');
    setRawImages([{ id: 'A' }, { id: 'B' }]);

    // Undo → raw_images restored to [A]; retouch `images` + id untouched.
    useEditHistoryStore.getState().undo();
    expect(liveRawImages()).toEqual([{ id: 'A' }]);
    expect(liveImages()).toEqual([{ id: 'IMG' }]);
    expect((useSnapshotStore.getState().illustration.spreads[0] as unknown as Record<string, unknown>).id).toBe('sp1');

    const afterUndo = useEditHistoryStore.getState().histories[SCENE_KEY];
    expect(afterUndo.past).toHaveLength(0);
    expect(afterUndo.future).toHaveLength(1);

    // Redo → back to [A, B].
    useEditHistoryStore.getState().redo();
    expect(liveRawImages()).toEqual([{ id: 'A' }, { id: 'B' }]);
    const afterRedo = useEditHistoryStore.getState().histories[SCENE_KEY];
    expect(afterRedo.past).toHaveLength(1);
    expect(afterRedo.future).toHaveLength(0);
  });

  it('undo/redo no-op when the respective stack is empty', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, { raw_images: [{ id: 'A' }] }, 'illustration-scene');
    useEditHistoryStore.getState().undo(); // nothing to undo
    expect(liveRawImages()).toEqual([{ id: 'A' }]);
    useEditHistoryStore.getState().redo(); // nothing to redo
    expect(liveRawImages()).toEqual([{ id: 'A' }]);
  });

  it('toggles isApplyingHistory false again after apply', () => {
    const s = useEditHistoryStore.getState();
    s.beginSession(SCENE_KEY, { raw_images: [{ id: 'A' }] }, 'illustration-scene');
    s.capture(SCENE_KEY, { raw_images: [{ id: 'A' }] }, 'edit');
    setRawImages([{ id: 'A' }, { id: 'B' }]);
    useEditHistoryStore.getState().undo();
    expect(useEditHistoryStore.getState().isApplyingHistory).toBe(false);
  });
});
