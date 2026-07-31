// rewrite-casted-tags.test.ts — subject-tag rewrite for casted layers.

import { describe, it, expect } from 'vitest';
import { rewriteCastedTags } from './rewrite-casted-tags';
import type { RewriteCastedTagsContext } from './rewrite-casted-tags';
import type { CastingAssignment } from '@/types/editor';
import type { Character } from '@/types/character-types';
import type { Prop } from '@/types/prop-types';
import type { SpreadImage, SpreadTag } from '@/types/spread-types';

function charC2(): Character {
  return {
    key: 'c2',
    name: 'c2',
    variants: [
      { key: 'c2_v0', type: 0 },
      { key: 'c2_shared', type: 1 },
    ],
  } as unknown as Character;
}

function propP2(): Prop {
  return {
    key: 'p2',
    name: 'p2',
    variants: [
      { key: 'p2_v0', type: 0 },
      { key: 'p2_shared', type: 1 },
    ],
  } as unknown as Prop;
}

const ctx: RewriteCastedTagsContext = {
  snapshotCharacters: [charC2()],
  snapshotProps: [propP2()],
};

function layer(tags?: SpreadTag[]): SpreadImage {
  return { id: 'img-1', geometry: { x: 0, y: 0, w: 1, h: 1 }, tags } as unknown as SpreadImage;
}

const castC2: CastingAssignment = { actant_id: 'a1', actor_id: 'c2', actor_type: 1 };
const castP2: CastingAssignment = { actant_id: 'a1', actor_id: 'p2', actor_type: 2 };

describe('rewriteCastedTags', () => {
  it('rewrites a character tag → chosen actor key; keeps matching variant, else base', () => {
    const l = layer([
      { type: 'character', object_key: 'orig', variant_key: 'c2_shared' }, // variant exists on c2 → kept
      { type: 'character', object_key: 'orig', variant_key: 'gone' }, // missing → base c2_v0
      { type: 'other', object_key: 'background', variant_key: null }, // untouched
    ]);
    rewriteCastedTags(l, castC2, ctx);
    expect(l.tags).toEqual([
      { type: 'character', object_key: 'c2', variant_key: 'c2_shared' },
      { type: 'character', object_key: 'c2', variant_key: 'c2_v0' },
      { type: 'other', object_key: 'background', variant_key: null },
    ]);
  });

  it('rewrites a prop actor → tag type "prop" + prop key + base variant fallback', () => {
    const l = layer([{ type: 'prop', object_key: 'orig', variant_key: 'nope' }]);
    rewriteCastedTags(l, castP2, ctx);
    expect(l.tags).toEqual([{ type: 'prop', object_key: 'p2', variant_key: 'p2_v0' }]);
  });

  it('flips a character tag to a prop tag when the chosen actor is a prop', () => {
    const l = layer([{ type: 'character', object_key: 'orig', variant_key: 'p2_shared' }]);
    rewriteCastedTags(l, castP2, ctx);
    expect(l.tags![0]).toEqual({ type: 'prop', object_key: 'p2', variant_key: 'p2_shared' });
  });

  it('resolvedActor null → tags untouched (plain / default-fallback layer)', () => {
    const original: SpreadTag[] = [{ type: 'character', object_key: 'orig', variant_key: 'x' }];
    const l = layer([...original]);
    rewriteCastedTags(l, null, ctx);
    expect(l.tags).toEqual(original);
  });

  it('no tags on the layer → no-op', () => {
    const l = layer(undefined);
    expect(() => rewriteCastedTags(l, castC2, ctx)).not.toThrow();
    expect(l.tags).toBeUndefined();
  });
});
