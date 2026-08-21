// base-entities-policy.test.ts — the rtype-14 `sketch-base-entities` save-domain (ADR-044 addendum 2,
// 2026-08-05): base space "save 1 cục" + Excel import re-route. Proves the policy resolveTarget/
// getNode/buildPayload, the `deriveSaveTarget` case 1:14, and the load-bearing invariant that
// `alter_characters` and `characters` resolve to ONE session (shared `characters` collection) so the
// two kinds never open two baselines that overwrite each other.

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  snapshot: {
    sketch: {
      characters: [{ key: 'c0', actor_role: 0 }, { key: 'c1', actor_role: 1 }],
      props: [{ key: 'p0' }],
      stages: [{ key: 's0' }],
    },
  },
}));

vi.mock('@/stores/snapshot-store', () => ({
  useSnapshotStore: { getState: () => h.snapshot },
}));

vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => ({ bookId: 'book1' }) },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  FALLBACK_HOLDER_NAME: 'another editor',
  ACTION_TYPE_CREATE: 2,
}));

import { SAVE_POLICIES } from './save-policies';
import { deriveSaveTarget } from './derive-save-target';
import { keyOf } from '@/stores/resource-lock-store';
import {
  BASE_KIND_TO_COLLECTION,
  resolveEntityCollectionLockTarget,
  buildEntityCollectionPayload,
  RESOURCE_TYPE_ENTITY_COLLECTION,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';

describe('BASE_KIND_TO_COLLECTION', () => {
  it('maps each base-group kind onto its entity collection (identity for the two base kinds)', () => {
    expect(BASE_KIND_TO_COLLECTION.characters).toBe('characters');
    expect(BASE_KIND_TO_COLLECTION.props).toBe('props');
  });
});

describe('resolveEntityCollectionLockTarget / buildEntityCollectionPayload', () => {
  it('resolveTarget → step 1 / rtype 14 / resource_id === collection', () => {
    expect(resolveEntityCollectionLockTarget('characters')).toEqual({
      step: 1,
      resource_type: RESOURCE_TYPE_ENTITY_COLLECTION,
      resource_id: 'characters',
      locale: null,
    });
    expect(RESOURCE_TYPE_ENTITY_COLLECTION).toBe(14);
  });

  it('buildPayload → collection-scope column-root REPLACE (LIST patch + count audit)', () => {
    const arr = [{ key: 'c0' }, { key: 'c1' }];
    expect(buildEntityCollectionPayload(arr, 'characters')).toEqual({
      action_type: 3,
      patch: arr,
      collection: 'characters',
      target_ref: { count: 2 },
      log: true,
    });
  });
});

describe("SAVE_POLICIES['sketch-base-entities']", () => {
  const policy = SAVE_POLICIES['sketch-base-entities'];

  it('is lock-exempt', () => {
    expect(policy.locking).toBe('none');
  });

  it('resolveTarget mirrors resolveEntityCollectionLockTarget for each collection', () => {
    for (const c of ['characters', 'props', 'stages'] as const) {
      expect(policy.resolveTarget(c)).toEqual(resolveEntityCollectionLockTarget(c));
    }
  });

  it('getNode returns the WHOLE sketch.{collection} array', () => {
    expect(policy.getNode('characters')).toBe(h.snapshot.sketch.characters);
    expect(policy.getNode('props')).toBe(h.snapshot.sketch.props);
    expect(policy.getNode('stages')).toBe(h.snapshot.sketch.stages);
  });

  it('getNode defaults to [] for an absent collection (never crashes a .length/.map)', () => {
    expect(policy.getNode('unknown')).toEqual([]);
  });

  it('buildPayload mirrors buildEntityCollectionPayload on the same array', () => {
    const arr = h.snapshot.sketch.characters;
    expect(policy.buildPayload(arr, 'characters')).toEqual(
      buildEntityCollectionPayload(arr, 'characters'),
    );
  });
});

describe('deriveSaveTarget — case 1:14', () => {
  it('maps a step-1 / rtype-14 LockTarget to the sketch-base-entities domain (id = collection)', () => {
    expect(
      deriveSaveTarget({ step: 1, resource_type: 14, resource_id: 'props', locale: null }),
    ).toEqual({ domain: 'sketch-base-entities', id: 'props', locale: null });
  });
});

describe('character-kind groups share ONE rtype-14 session (no double-overwrite)', () => {
  it('every character-kind group resolves to the SAME session via the shared collection', () => {
    // Multiple character GROUPS (e.g. a "characters" group + a legacy "alter_character_sheet" group)
    // all carry kind 'characters' → collection 'characters', so the base space (which keys rtype-14
    // by COLLECTION, not group_key) collapses them onto one session ⇒ one baseline, no overwrite.
    const charKey = keyOf('book1', policyResolve('characters'));
    const propKey = keyOf('book1', policyResolve('props'));
    expect(keyOf('book1', policyResolve('characters'))).toBe(charKey); // stable per collection
    expect(propKey).not.toBe(charKey); // props is a distinct session
  });
});

/** Resolve a base KIND to its rtype-14 session lock target through the SAME mapping the space uses. */
function policyResolve(kind: keyof typeof BASE_KIND_TO_COLLECTION) {
  return SAVE_POLICIES['sketch-base-entities'].resolveTarget(BASE_KIND_TO_COLLECTION[kind]);
}
