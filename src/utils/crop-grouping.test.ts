// crop-grouping.test.ts — Unit tests for groupCropsForBatch (rev2 batch model).
// Covers: image-only selection (auto_pic/video excluded), dedup by
// (spread_id, id) for a multi-subject layer, multi-subject tags[] carried on
// one crop, disabled-subject tag drop, entity order (characters then props,
// tie-break spread_number), zero-geometry skip, objectKey = tags[0].object_key.

import { describe, it, expect } from 'vitest';
import { groupCropsForBatch } from './crop-grouping';
import type { Remix } from '@/types/remix';
import type { SpreadTag } from '@/types/spread-types';

// ── Fixture builders ─────────────────────────────────────────────────────────

function tag(
  type: 'character' | 'prop' | 'other',
  objectKey: string,
  variant = 'v1',
): SpreadTag {
  return { type, object_key: objectKey, variant_key: variant } as SpreadTag;
}

interface ImgOpts {
  id: string;
  tags: SpreadTag[];
  w?: number;
  h?: number;
  mediaUrl?: string;
  annotation?: { description?: string };
}
function img(o: ImgOpts) {
  return {
    id: o.id,
    media_url: o.mediaUrl ?? `https://cdn/${o.id}.png`,
    aspect_ratio: '1:1',
    geometry: { x: 0, y: 0, w: o.w ?? 100, h: o.h ?? 100 },
    'z-index': 0,
    tags: o.tags,
    ...(o.annotation ? { annotation: o.annotation } : {}),
  };
}
function autoPic(id: string, tags: SpreadTag[]) {
  return {
    id,
    media_url: `https://cdn/${id}.lottie`,
    geometry: { x: 0, y: 0, w: 100, h: 100 },
    'z-index': 0,
    tags,
  };
}

interface SpreadOpts {
  id: string;
  pageNumber: number;
  images?: ReturnType<typeof img>[];
  autoPics?: ReturnType<typeof autoPic>[];
}
function spread(o: SpreadOpts) {
  return {
    id: o.id,
    pages: [{ number: o.pageNumber, type: 'normal_page', layout: null, background: { color: '#fff', texture: null } }],
    images: o.images ?? [],
    auto_pics: o.autoPics ?? [],
    textboxes: [],
  };
}

interface RemixOpts {
  charKeys?: string[];
  propKeys?: string[];
  spreads?: ReturnType<typeof spread>[];
  /** Swappable set (remix_config.characters[] keys) — defaults to charKeys
   *  (roster == swappable, the common case). Pass a subset to test the
   *  roster ⊃ swappable split (amend 2026-07-31). */
  swappableCharKeys?: string[];
  /** ⚡2026-08-06 — config keys present WITHOUT a `traits` key (text-only
   *  personalize entries). They must be EXCLUDED from crop grouping. */
  textOnlyCharKeys?: string[];
}
function makeRemix(o: RemixOpts = {}): Remix {
  const swappable = (o.swappableCharKeys ?? o.charKeys ?? []).map((k) => ({
    key: k, human_id: null, visual: null, traits: [], base_image_url: null, is_enabled: true,
  }));
  // Text-only entries carry NO `traits` / `base_image_url` key (marker semantics).
  const textOnly = (o.textOnlyCharKeys ?? []).map((k) => ({
    key: k, human_id: null, visual: null, is_enabled: true,
  }));
  return {
    id: 'remix-1',
    characters: (o.charKeys ?? []).map((k) => ({ key: k, name: k, variants: [] })),
    props: (o.propKeys ?? []).map((k) => ({ key: k, name: k, variants: [] })),
    remix_config: {
      characters: [...swappable, ...textOnly],
    },
    illustration: { spreads: o.spreads ?? [], sections: [] },
  } as unknown as Remix;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('groupCropsForBatch — image-only crop selection', () => {
  it('selects image layers carrying ≥1 enabled subject tag', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [spread({ id: 's1', pageNumber: 1, images: [img({ id: 'i1', tags: [tag('character', 'c1')] })] })],
    });
    const { cropInputs, cropMetaById } = groupCropsForBatch(r);
    expect(cropInputs.map((c) => c.id)).toEqual(['i1']);
    expect(cropInputs[0].objectKey).toBe('c1');
    expect(cropMetaById['i1'].media_url).toBe('https://cdn/i1.png');
    expect(cropMetaById['i1'].spread_id).toBe('s1');
  });

  it('ignores auto_pic (animated) layers even when subject-tagged', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [spread({ id: 's1', pageNumber: 1, autoPics: [autoPic('anim1', [tag('character', 'c1')])] })],
    });
    expect(groupCropsForBatch(r).cropInputs).toEqual([]);
  });

  it('skips a layer with no enabled subject tag (only role/other tags)', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [spread({ id: 's1', pageNumber: 1, images: [img({ id: 'i1', tags: [tag('other', 'background')] })] })],
    });
    expect(groupCropsForBatch(r).cropInputs).toEqual([]);
  });

  it('skips a layer with zero/negative geometry', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [spread({ id: 's1', pageNumber: 1, images: [img({ id: 'i1', tags: [tag('character', 'c1')], w: 0, h: 50 })] })],
    });
    expect(groupCropsForBatch(r).cropInputs).toEqual([]);
  });

  it('roster char WITHOUT a remix_config entry gets no crops (roster ⊃ swappable — amend 2026-07-31)', () => {
    const r = makeRemix({
      charKeys: ['c1', 'c2'], // c2 = cast-in actor locked for swap
      swappableCharKeys: ['c1'],
      spreads: [spread({
        id: 's1',
        pageNumber: 1,
        images: [
          img({ id: 'i1', tags: [tag('character', 'c1')] }),
          img({ id: 'i2', tags: [tag('character', 'c2')] }),
        ],
      })],
    });
    const { cropInputs } = groupCropsForBatch(r);
    expect(cropInputs.map((c) => c.id)).toEqual(['i1']);
  });

  it('⚡2026-08-06 excludes a TEXT-ONLY config entry (no `traits` key) — not visual-swappable', () => {
    const r = makeRemix({
      charKeys: ['c1', 'c2'], // c2 has a config entry but is text-only (no traits)
      swappableCharKeys: ['c1'],
      textOnlyCharKeys: ['c2'],
      spreads: [spread({
        id: 's1',
        pageNumber: 1,
        images: [
          img({ id: 'i1', tags: [tag('character', 'c1')] }),
          img({ id: 'i2', tags: [tag('character', 'c2')] }),
        ],
      })],
    });
    // c2 present in remix_config but WITHOUT traits → filtered out of grouping.
    expect(groupCropsForBatch(r).cropInputs.map((c) => c.id)).toEqual(['i1']);
  });
});

describe('groupCropsForBatch — dedup + multi-subject tags[]', () => {
  it('a multi-subject layer becomes ONE crop carrying all enabled tags (no per-subject duplication)', () => {
    const r = makeRemix({
      charKeys: ['c1', 'c2'],
      spreads: [
        spread({
          id: 's1',
          pageNumber: 1,
          images: [img({ id: 'i1', tags: [tag('character', 'c1'), tag('character', 'c2')] })],
        }),
      ],
    });
    const { cropInputs, cropMetaById } = groupCropsForBatch(r);
    expect(cropInputs).toHaveLength(1);
    expect(cropInputs[0].id).toBe('i1');
    // tags[] carries BOTH enabled subjects.
    expect(cropMetaById['i1'].tags.map((t) => t.object_key).sort()).toEqual(['c1', 'c2']);
    // objectKey (affinity) = the first tag's object_key.
    expect(cropInputs[0].objectKey).toBe('c1');
  });

  it('drops disabled subject tags from tags[] (keeps enabled ones)', () => {
    // c2 is NOT in the enabled set → its tag is dropped; c1 remains.
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [
        spread({
          id: 's1',
          pageNumber: 1,
          images: [img({ id: 'i1', tags: [tag('character', 'c1'), tag('character', 'c2')] })],
        }),
      ],
    });
    const { cropMetaById } = groupCropsForBatch(r);
    expect(cropMetaById['i1'].tags.map((t) => t.object_key)).toEqual(['c1']);
  });

  it('dedups the SAME (spread_id, layer id) — never two crops for one layer', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [
        spread({ id: 's1', pageNumber: 1, images: [img({ id: 'i1', tags: [tag('character', 'c1')] })] }),
      ],
    });
    const { cropInputs } = groupCropsForBatch(r);
    expect(cropInputs.filter((c) => c.id === 'i1')).toHaveLength(1);
  });
});

describe('groupCropsForBatch — lean CropEntry shape (⚡2026-06-12)', () => {
  it('emits ONLY the 5 lean fields — annotation/layer_kind/spread_number are gone', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [
        spread({
          id: 's1',
          pageNumber: 1,
          images: [img({ id: 'i1', tags: [tag('character', 'c1')], annotation: { description: 'waving, mid-stride' } })],
        }),
      ],
    });
    const meta = groupCropsForBatch(r).cropMetaById['i1'];
    expect(Object.keys(meta).sort()).toEqual(['geometry', 'id', 'media_url', 'spread_id', 'tags']);
  });
});

describe('groupCropsForBatch — ordering', () => {
  it('orders crops by entity (characters then props), tie-break spread_number', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      propKeys: ['p1'],
      spreads: [
        // prop crop on an earlier spread, character crop on a later one — order
        // must still be character-first (entity order beats spread_number).
        spread({ id: 's1', pageNumber: 1, images: [img({ id: 'prop1', tags: [tag('prop', 'p1')] })] }),
        spread({ id: 's2', pageNumber: 2, images: [img({ id: 'char1', tags: [tag('character', 'c1')] })] }),
      ],
    });
    expect(groupCropsForBatch(r).cropInputs.map((c) => c.id)).toEqual(['char1', 'prop1']);
  });

  it('within one entity, orders by spread_number', () => {
    const r = makeRemix({
      charKeys: ['c1'],
      spreads: [
        spread({ id: 's2', pageNumber: 5, images: [img({ id: 'late', tags: [tag('character', 'c1')] })] }),
        spread({ id: 's1', pageNumber: 2, images: [img({ id: 'early', tags: [tag('character', 'c1')] })] }),
      ],
    });
    expect(groupCropsForBatch(r).cropInputs.map((c) => c.id)).toEqual(['early', 'late']);
  });
});
