// save-policies.test.ts — the ZERO-BEHAVIOR-CHANGE parity proof: every domain's resolveTarget +
// buildPayload must match the pre-existing resolver/builder on the same fixture, and getNode must
// read the same node the old space-level accessor read. If a policy ever drifts from its source
// helper, one of these fails.

import { describe, it, expect, vi } from 'vitest';

// vi.hoisted so the fixture is available inside the hoisted vi.mock factory.
const h = vi.hoisted(() => ({
  snapshot: {
    characters: [{ key: 'hero', basic: { name: 'Hero' } }],
    props: [{ key: 'sword', basic: { name: 'Sword' } }],
    stages: [{ key: 'forest', basic: { name: 'Forest' } }],
    illustration: {
      spreads: [
        {
          id: 'sp1',
          // SCENE_OWNED_KEYS members
          raw_images: [{ id: 'ri1' }],
          manuscript: 'once upon a time',
          pages: [{ n: 1 }],
          // RETOUCH_OWNED_KEYS members
          images: [{ id: 'im1' }],
          videos: [{ id: 'v1' }],
          // non-owned key (must be dropped by the projection)
          id_only_junk: 'x',
        },
      ],
    },
    sketch: {
      characters: [
        { key: 'skHero', actor_role: 0 },
        { key: 'skAlter', actor_role: 1 }, // an alter character — same characters[] array
      ],
      props: [{ key: 'skProp' }],
      stages: [{ key: 'skStage', base: { styles: [] } }],
      base: { character_sheet: { crops: [1] }, prop_sheet: { crops: [2] } },
      lineups: [{ id: 'tab1' }, { id: 'tab2' }],
    },
  },
}));

vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: { getState: () => h.snapshot },
}));

// Avoid pulling the real resource-lock-store (supabase channel) — the resolvers/builders under
// test are pure; only keyOf + FALLBACK_HOLDER_NAME are needed at module eval.
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => ({ bookId: 'book1', registry: new Map(), holderNames: new Map() }) },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  FALLBACK_HOLDER_NAME: 'another editor',
  ACTION_TYPE_CREATE: 2,
}));

import { SAVE_POLICIES, projectNode } from './save-policies';
import { keyOf } from '@/stores/resource-lock-store';
import { resolveImageLockTarget } from '@/stores/snapshot-store/slices/collab-image-save-helper';
import {
  resolveSketchVariantLockTarget,
  buildSketchEntityPayload,
} from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import {
  resolveSketchStageLockTarget,
  buildSketchStagePayload,
} from '@/stores/snapshot-store/slices/collab-sketch-stage-save-helper';
import {
  resolveSketchBaseSheetLockTarget,
  buildSketchBaseSheetPayload,
} from '@/stores/snapshot-store/slices/collab-sketch-base-sheet-save-helper';
import { buildSketchLineupsPayload } from '@/stores/snapshot-store/slices/collab-sketch-lineups-save-helper';
import {
  SCENE_OWNED_KEYS,
  RETOUCH_OWNED_KEYS,
} from '@/stores/snapshot-store/slices/collab-owned-subtree';

describe('resolveTarget parity (step/rtype/resource_id/locale)', () => {
  it('illustration-entity — character/prop/stage → resolveImageLockTarget', () => {
    expect(SAVE_POLICIES['illustration-entity'].resolveTarget('character/hero', null)).toEqual(
      resolveImageLockTarget('character', 'hero', 'hero', null),
    );
    expect(SAVE_POLICIES['illustration-entity'].resolveTarget('prop/sword', null)).toEqual({
      step: 2,
      resource_type: 4,
      resource_id: 'sword',
      locale: null,
    });
    expect(SAVE_POLICIES['illustration-entity'].resolveTarget('stage/forest', null)).toEqual({
      step: 2,
      resource_type: 5,
      resource_id: 'forest',
      locale: null,
    });
  });

  it('scene-spread → step 2 / rtype 6; retouch-spread → step 3 / rtype 10', () => {
    expect(SAVE_POLICIES['scene-spread'].resolveTarget('sp1')).toEqual({
      step: 2,
      resource_type: 6,
      resource_id: 'sp1',
      locale: null,
    });
    expect(SAVE_POLICIES['retouch-spread'].resolveTarget('sp1')).toEqual({
      step: 3,
      resource_type: 10,
      resource_id: 'sp1',
      locale: null,
    });
  });

  it('sketch-entity → resolveSketchVariantLockTarget (characters rtype 3, props rtype 4)', () => {
    expect(SAVE_POLICIES['sketch-entity'].resolveTarget('characters/skHero')).toEqual(
      resolveSketchVariantLockTarget('characters', 'skHero'),
    );
    expect(SAVE_POLICIES['sketch-entity'].resolveTarget('props/skProp')).toEqual(
      resolveSketchVariantLockTarget('props', 'skProp'),
    );
  });

  it('sketch-stage → resolveSketchStageLockTarget', () => {
    expect(SAVE_POLICIES['sketch-stage'].resolveTarget('skStage')).toEqual(
      resolveSketchStageLockTarget('skStage'),
    );
  });

  it('sketch-base-sheet → resolveSketchBaseSheetLockTarget (id IS the group key, ⚡REV 2026-08-21)', () => {
    // The rtype-11 resource_id is the GROUP KEY, passed straight through (no reverse map).
    expect(SAVE_POLICIES['sketch-base-sheet'].resolveTarget('character_sheet')).toEqual(
      resolveSketchBaseSheetLockTarget('character_sheet'),
    );
    expect(SAVE_POLICIES['sketch-base-sheet'].resolveTarget('goblins_2')).toEqual(
      resolveSketchBaseSheetLockTarget('goblins_2'),
    );
  });

  it('sketch-lineups → step 1 / rtype 12 sentinel', () => {
    expect(SAVE_POLICIES['sketch-lineups'].resolveTarget('lineups')).toEqual({
      step: 1,
      resource_type: 12,
      resource_id: 'lineups',
      locale: null,
    });
  });

  it('sketch-image / sketch-textbox (phase-4 stubs) — resolveTarget is faithful', () => {
    expect(SAVE_POLICIES['sketch-image'].resolveTarget('img1', null)).toEqual({
      step: 1,
      resource_type: 1,
      resource_id: 'img1',
      locale: null,
    });
    expect(SAVE_POLICIES['sketch-textbox'].resolveTarget('tb1', 'en_US')).toEqual({
      step: 1,
      resource_type: 2,
      resource_id: 'tb1',
      locale: 'en_US',
    });
  });

  it('composite id never leaks a "/" into the lock key (resource_id is the plain key)', () => {
    const t = SAVE_POLICIES['illustration-entity'].resolveTarget('character/hero', null);
    expect(t.resource_id).toBe('hero');
    expect(keyOf('book1', t)).not.toContain('/');
  });
});

describe('buildPayload parity (vs the pre-existing builder on the same fixture)', () => {
  const NODE = { key: 'hero', basic: { name: 'Hero' } };

  it('illustration-entity / scene-spread / retouch-spread → { action_type:3, patch, log:true }', () => {
    const expected = { action_type: 3, patch: NODE, log: true };
    expect(SAVE_POLICIES['illustration-entity'].buildPayload(NODE, 'character/hero')).toEqual(expected);
    expect(SAVE_POLICIES['scene-spread'].buildPayload(NODE, 'sp1')).toEqual(expected);
    expect(SAVE_POLICIES['retouch-spread'].buildPayload(NODE, 'sp1')).toEqual(expected);
  });

  it('sketch-entity → buildSketchEntityPayload', () => {
    expect(SAVE_POLICIES['sketch-entity'].buildPayload(NODE, 'characters/skHero')).toEqual(
      buildSketchEntityPayload(NODE),
    );
  });

  it('sketch-stage → buildSketchStagePayload', () => {
    expect(SAVE_POLICIES['sketch-stage'].buildPayload(NODE, 'skStage')).toEqual(
      buildSketchStagePayload(NODE),
    );
  });

  it('sketch-base-sheet → buildSketchBaseSheetPayload', () => {
    const sheet = { crops: [1] };
    expect(SAVE_POLICIES['sketch-base-sheet'].buildPayload(sheet, 'character_sheet')).toEqual(
      buildSketchBaseSheetPayload(sheet),
    );
  });

  it('sketch-lineups → buildSketchLineupsPayload (collection-scope, array patch)', () => {
    const tabs = [{ id: 'tab1' }, { id: 'tab2' }];
    expect(SAVE_POLICIES['sketch-lineups'].buildPayload(tabs, 'lineups')).toEqual(
      buildSketchLineupsPayload(tabs as never),
    );
  });
});

describe('getNode (reads the same node the old space accessor read)', () => {
  it('illustration-entity → the whole entity node by key', () => {
    expect(SAVE_POLICIES['illustration-entity'].getNode('character/hero')).toEqual({
      key: 'hero',
      basic: { name: 'Hero' },
    });
  });

  it('sketch-entity → finds an ALTER character in the shared characters[] array (rtype-3 disambig)', () => {
    // The wrapper can only derive kind "characters" from rtype 3; a raw find by unique key must
    // still resolve the alter node that lives in sketch.characters[].
    expect(SAVE_POLICIES['sketch-entity'].getNode('characters/skAlter')).toEqual({
      key: 'skAlter',
      actor_role: 1,
    });
  });

  it('scene-spread / retouch-spread → the spread node', () => {
    const spread = h.snapshot.illustration.spreads[0];
    expect(SAVE_POLICIES['scene-spread'].getNode('sp1')).toBe(spread);
    expect(SAVE_POLICIES['retouch-spread'].getNode('sp1')).toBe(spread);
  });

  it('sketch-base-sheet → the per-kind sheet node', () => {
    expect(SAVE_POLICIES['sketch-base-sheet'].getNode('character_sheet')).toEqual({ crops: [1] });
    expect(SAVE_POLICIES['sketch-base-sheet'].getNode('prop_sheet')).toEqual({ crops: [2] });
  });

  it('sketch-lineups → the whole tabs array', () => {
    expect(SAVE_POLICIES['sketch-lineups'].getNode('lineups')).toBe(h.snapshot.sketch.lineups);
  });
});

describe('projectNode (owned-key projection for the spread domains)', () => {
  it('scene-spread keeps only SCENE_OWNED_KEYS; retouch-spread only RETOUCH_OWNED_KEYS', () => {
    const spread = h.snapshot.illustration.spreads[0];
    const scene = projectNode(SAVE_POLICIES['scene-spread'], spread) as Record<string, unknown>;
    const retouch = projectNode(SAVE_POLICIES['retouch-spread'], spread) as Record<string, unknown>;
    // scene owns raw_images/manuscript/pages; must NOT carry images/videos or the junk key.
    expect(Object.keys(scene).sort()).toEqual(
      SCENE_OWNED_KEYS.filter((k) => k in spread).sort(),
    );
    expect(scene).not.toHaveProperty('images');
    expect(scene).not.toHaveProperty('id_only_junk');
    // retouch owns images/videos; must NOT carry raw_images/manuscript.
    expect(Object.keys(retouch).sort()).toEqual(
      RETOUCH_OWNED_KEYS.filter((k) => k in spread).sort(),
    );
    expect(retouch).not.toHaveProperty('raw_images');
  });

  it('whole-node domains project the node unchanged', () => {
    const node = { key: 'hero' };
    expect(projectNode(SAVE_POLICIES['illustration-entity'], node)).toBe(node);
  });
});
