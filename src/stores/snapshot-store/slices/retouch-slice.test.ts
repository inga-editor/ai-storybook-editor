// retouch-slice.test.ts — focused unit test for `revertRetouchOwnedSubtree` (ADR-044 per-spread
// held session, onLost revert). Restores the RETOUCH owned-key sub-tree of a spread to a pre-edit
// baseline: owned keys in the baseline are restored, owned keys ABSENT from the baseline are deleted
// (drops what was added since acquire), and SCENE keys are left untouched (disjoint partition).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock supabase so importing the REAL snapshot store does not initialise a client — the revert is a
// pure state mutation, no client touched.
vi.mock('@/apis/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
    from: vi.fn(),
  },
}));

import { useSnapshotStore } from '@/stores/snapshot-store';

const asState = <T>(v: T) => v as never;

// Post-edit spread state: I ADDED image iNEW, textbox tNEW, video vNEW and animation #1, and edited
// audios — all to be dropped on revert. `raw_images` + `manuscript` are SCENE keys (must survive).
const makePostEditSpread = () =>
  asState({
    id: 'sp1',
    raw_images: [{ id: 'r1' }],
    manuscript: { scene: 'keep-me' },
    images: [{ id: 'i1' }, { id: 'iNEW' }],
    textboxes: [{ id: 'tNEW' }],
    videos: [{ id: 'vNEW' }],
    animations: [{ order: 0 }, { order: 1 }],
  });

// Pre-edit baseline (owned sub-tree only) captured at acquire: no videos key at all.
const BASELINE = {
  images: [{ id: 'i1' }],
  textboxes: [],
  animations: [{ order: 0 }],
} as unknown;

describe('revertRetouchOwnedSubtree', () => {
  beforeEach(() => {
    useSnapshotStore.setState((s) => {
      s.illustration.spreads = [makePostEditSpread(), asState({ id: 'sp2', images: [] })];
      s.sync.isDirty = false;
    });
  });

  it('restores baseline owned keys + deletes owned keys absent from baseline, dirties', () => {
    useSnapshotStore.getState().revertRetouchOwnedSubtree('sp1', BASELINE);
    const spread = useSnapshotStore.getState().illustration.spreads[0] as unknown as Record<string, unknown>;

    // Owned keys present in baseline → restored to baseline value (added items dropped).
    expect(spread.images).toEqual([{ id: 'i1' }]);
    expect(spread.textboxes).toEqual([]);
    expect(spread.animations).toEqual([{ order: 0 }]);
    // Owned key ABSENT from baseline → deleted (the added video is dropped).
    expect('videos' in spread).toBe(false);
    // SCENE keys (disjoint partition) untouched.
    expect(spread.raw_images).toEqual([{ id: 'r1' }]);
    expect(spread.manuscript).toEqual({ scene: 'keep-me' });

    expect(useSnapshotStore.getState().sync.isDirty).toBe(true);
  });

  it('no-op (no throw) when the spread id is unknown', () => {
    expect(() =>
      useSnapshotStore.getState().revertRetouchOwnedSubtree('does-not-exist', BASELINE),
    ).not.toThrow();
    // Sibling spread untouched.
    const sp1 = useSnapshotStore.getState().illustration.spreads[0] as unknown as Record<string, unknown>;
    expect(sp1.images).toEqual([{ id: 'i1' }, { id: 'iNEW' }]);
  });
});

describe('slot mutual exclusion', () => {
  it('patch with parametric_slot: undefined + casting_slot: seed clears parametric and sets casting', () => {
    useSnapshotStore.setState((s) => {
      const img = asState({
        id: 'img_1',
        geometry: { x: 0, y: 0, w: 100, h: 100 },
        media_url: 'https://example.test/image.png',
        parametric_slot: {
          key: 'char_a.gender',
          values: [{ value: 'male', is_default: true, illustrations: [] }],
        },
      });
      s.illustration.spreads = [asState({ id: 'sp1', images: [img] })];
    });

    const castingSeed = asState({
      actant_id: 'sibling_1',
      actors: [{ id: 'char_alice', actor_type: 1, media_url: 'https://example.test/image.png', is_default: true }],
    });

    useSnapshotStore.getState().updateRetouchImage('sp1', 'img_1', {
      parametric_slot: undefined,
      casting_slot: castingSeed,
    });

    const image = useSnapshotStore.getState().illustration.spreads[0].images[0] as unknown as Record<string, unknown>;

    // parametric_slot must be undefined (falsy check)
    expect(image.parametric_slot).toBeUndefined();
    // LOAD-BEARING: immer MATERIALIZES a key assigned `undefined` (Object.assign on the draft),
    // so the key still exists on the in-store item. Four comment blocks in the slot feature tell
    // callers to use truthy checks (`!!item.casting_slot`) because of exactly this. If immer ever
    // starts dropping the key, this assertion fails and those comments become stale — not silently.
    expect('parametric_slot' in image).toBe(true);
    // casting_slot must be set
    expect(image.casting_slot).toEqual(castingSeed);
    // JSON.stringify must NOT include parametric_slot key (persist clean)
    const persisted = JSON.parse(JSON.stringify(image)) as Record<string, unknown>;
    expect('parametric_slot' in persisted).toBe(false);
    expect('casting_slot' in persisted).toBe(true);
  });
});
