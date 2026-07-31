// sprite-layout.test.ts — Pure sprite-plane layout helpers.
//
// `getImageNaturalDimensionsFromUrl` is mocked (no real image loads): cells use
// NATURAL artwork dimensions per layout, so every test registers its fixture
// dims in `mockDims` (default 1000×1000 square when unregistered, 'fail' to
// simulate a broken read → square cap-size fallback).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Remix, RemixSpriteCropSheet, RemixSpriteEntry } from '@/types/remix';
import {
  groupVariantsForSprite,
  partitionByObjectAffinity,
  originalVariantArtwork,
  currentCellsOfSprite,
  addSpriteSubset,
  buildSeedSprite,
  spriteCellKey,
  type SpriteCell,
} from './sprite-layout';

// ── Dim-measurement mock ─────────────────────────────────────────────────────

const { mockDims } = vi.hoisted(() => ({
  mockDims: new Map<string, { width: number; height: number } | 'fail'>(),
}));

vi.mock('@/utils/aspect-ratio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/aspect-ratio-utils')>();
  return {
    ...actual,
    getImageNaturalDimensionsFromUrl: vi.fn(async (url: string) => {
      const d = mockDims.get(url);
      if (d === 'fail') throw new Error('mock dim read failure');
      return d ?? { width: 1000, height: 1000 };
    }),
  };
});

beforeEach(() => {
  mockDims.clear();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function illus(url: string, selected = true) {
  return { media_url: url, created_time: '2026-06-08T00:00:00Z', is_selected: selected };
}

function variant(key: string, type: 0 | 1, urls: { url: string; sel: boolean }[]) {
  return {
    name: key,
    key,
    type,
    appearance: {} as never,
    visual_description: '',
    illustrations: urls.map((u) => illus(u.url, u.sel)),
    image_references: [],
  };
}

function makeRemix(opts: {
  chars: { key: string; enabled: boolean; variants: ReturnType<typeof variant>[] }[];
}): Remix {
  return {
    id: 'r1',
    snapshot_id: 's1',
    name: 'R',
    remix_config: {
      story: { presets: [], branches: [] },
      characters: opts.chars.map((c) => ({
        key: c.key,
        human_id: 'h1',
        visual: 'v1',
        traits: [],
        base_image_url: null,
        is_enabled: c.enabled,
      })),
      memories: { is_enabled: false, style: 'styled', photos: [] },
      voices: [],
      languages: [],
    },
    illustration: { spreads: [], sections: [] },
    characters: opts.chars.map((c) => ({
      order: 0,
      name: c.key,
      key: c.key,
      basic_info: {} as never,
      personality: {} as never,
      variants: c.variants,
      voice_setting: null,
    })) as never,
    props: [],
    mixes: [],
  rmbgs: [],
  upscales: [],
    sprites: [],
    created_at: '',
    updated_at: '',
  };
}

// ── originalVariantArtwork ───────────────────────────────────────────────────

describe('originalVariantArtwork', () => {
  it('prefers the selected illustration', () => {
    expect(
      originalVariantArtwork({
        illustrations: [illus('a', false), illus('b', true)],
      }),
    ).toBe('b');
  });
  it('falls back to first then null', () => {
    expect(
      originalVariantArtwork({ illustrations: [illus('a', false)] }),
    ).toBe('a');
    expect(originalVariantArtwork({ illustrations: [] })).toBeNull();
    expect(originalVariantArtwork({})).toBeNull();
  });
});

// ── groupVariantsForSprite ───────────────────────────────────────────────────

describe('groupVariantsForSprite', () => {
  it('collects enabled-character variants with artwork, skips disabled + artwork-less', () => {
    const remix = makeRemix({
      chars: [
        { key: 'c1', enabled: true, variants: [variant('base', 0, [{ url: 'c1b', sel: true }]), variant('v1', 1, [{ url: 'c1v1', sel: true }])] },
        { key: 'c2', enabled: false, variants: [variant('base', 0, [{ url: 'c2b', sel: true }])] },
        { key: 'c3', enabled: true, variants: [variant('base', 0, [])] }, // no artwork
      ],
    });
    const cells = groupVariantsForSprite(remix);
    expect(cells.map((c) => c.object_key)).toEqual(['c1', 'c1']);
    expect(cells.map((c) => c.variant_key)).toEqual(['base', 'v1']);
    expect(cells.every((c) => c.type === 'character')).toBe(true);
  });

  it('dedups by cellKey', () => {
    const remix = makeRemix({
      chars: [{ key: 'c1', enabled: true, variants: [variant('base', 0, [{ url: 'x', sel: true }]), variant('base', 0, [{ url: 'y', sel: true }])] }],
    });
    expect(groupVariantsForSprite(remix)).toHaveLength(1);
  });
});

// ── partitionByObjectAffinity ────────────────────────────────────────────────

const cell = (obj: string, vk: string): SpriteCell => ({
  type: 'character',
  object_key: obj,
  variant_key: vk,
  media_url: `${obj}/${vk}`,
});

describe('partitionByObjectAffinity', () => {
  it('K=1 packs all cells onto one sheet, no overlap', async () => {
    const cells = [cell('a', '1'), cell('a', '2'), cell('b', '1')];
    const sheets = await partitionByObjectAffinity(cells, 1);
    expect(sheets).toHaveLength(1);
    const crops = sheets[0].original_crops;
    expect(crops).toHaveLength(3);
    // No overlapping geometry.
    for (let i = 0; i < crops.length; i++) {
      for (let j = i + 1; j < crops.length; j++) {
        const a = crops[i].geometry;
        const b = crops[j].geometry;
        const disjoint =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  it('K>=2 keeps a character on a single sheet when clusters fit the per-sheet budget', async () => {
    // 2+2 cells, K=2 → each cluster's area equals the budget (not OVER it), so
    // the engine keeps each character intact (oversized clusters that exceed the
    // budget are split crop-by-crop — that's a separate, documented case).
    const cells = [cell('a', '1'), cell('a', '2'), cell('b', '1'), cell('b', '2')];
    const sheets = await partitionByObjectAffinity(cells, 2);
    expect(sheets).toHaveLength(2);
    const sheetOf = (obj: string, vk: string) =>
      sheets.findIndex((s) => s.original_crops.some((c) => c.object_key === obj && c.variant_key === vk));
    expect(new Set([sheetOf('a', '1'), sheetOf('a', '2')]).size).toBe(1);
    expect(new Set([sheetOf('b', '1'), sheetOf('b', '2')]).size).toBe(1);
  });

  // Column counts below depend on `landscapeTolerance: 0.1` in the sprite layout
  // — square cells would otherwise stack into a tall single column for 2–3 cells.
  it('packs 2 square cells into a 2-col single row (not a vertical stack)', async () => {
    const cells = [cell('a', '1'), cell('a', '2')];
    const crops = (await partitionByObjectAffinity(cells, 1)).flatMap((s) => s.original_crops);
    expect(new Set(crops.map((c) => c.geometry.x)).size).toBe(2); // 2 columns
    expect(new Set(crops.map((c) => c.geometry.y)).size).toBe(1); // 1 row
  });

  it('packs 3 square cells into a 2-col [2,1] grid (not a vertical stack)', async () => {
    const cells = [cell('a', '1'), cell('a', '2'), cell('a', '3')];
    const crops = (await partitionByObjectAffinity(cells, 1)).flatMap((s) => s.original_crops);
    expect(new Set(crops.map((c) => c.geometry.x)).size).toBe(2); // 2 columns
    expect(new Set(crops.map((c) => c.geometry.y)).size).toBe(2); // 2 rows [2,1]
  });

  it('packs 5 square cells into a 3-col × 2-row landscape grid', async () => {
    const cells = [
      cell('a', '1'), cell('a', '2'), cell('a', '3'), cell('a', '4'), cell('a', '5'),
    ];
    const sheets = await partitionByObjectAffinity(cells, 1);
    expect(sheets).toHaveLength(1);
    expect(new Set(sheets[0].original_crops.map((c) => c.geometry.x)).size).toBe(3);
    expect(new Set(sheets[0].original_crops.map((c) => c.geometry.y)).size).toBe(2);
  });

  it('frames a square cell grid to a 1:1 sheet (N=3 [2,1] and N=4 2×2)', async () => {
    // Square content + equal re-frame margins → square sheet. Guards against the
    // engine's ratio snap (which would stretch the 2×2[2,1] sheet to 4:3).
    for (const n of [3, 4]) {
      const cells = Array.from({ length: n }, (_, i) => cell('a', String(i)));
      const sheet = (await partitionByObjectAffinity(cells, 1))[0];
      expect(sheet.sheet_geometry.width).toBe(sheet.sheet_geometry.height);
    }
  });

  it('spaces square cells EVENLY — horizontal gap === vertical gap (2·gutter = 64px)', async () => {
    // 4 square cells → 2×2 grid. Equal gutters → identical gaps on both axes.
    const cells = Array.from({ length: 4 }, (_, i) => cell('a', String(i)));
    const crops = (await partitionByObjectAffinity(cells, 1)).flatMap((s) => s.original_crops);
    const w = crops[0].geometry.w;
    const h = crops[0].geometry.h;
    const xs = [...new Set(crops.map((c) => c.geometry.x))].sort((a, b) => a - b);
    const ys = [...new Set(crops.map((c) => c.geometry.y))].sort((a, b) => a - b);
    expect(xs).toHaveLength(2);
    expect(ys).toHaveLength(2);
    const gapX = xs[1] - (xs[0] + w);
    const gapY = ys[1] - (ys[0] + h);
    expect(gapX).toBe(64);
    expect(gapY).toBe(64);
    expect(gapX).toBe(gapY);
  });

  it('swap_results always empty + image_url empty on fresh layout', async () => {
    const sheets = await partitionByObjectAffinity([cell('a', '1')], 1);
    expect(sheets[0].swap_results).toEqual([]);
    expect(sheets[0].image_url).toBe('');
  });
});

// ── natural dims + longest-edge cap + global factor ─────────────────────────

const MAX_SHEET_DIM = 8192;
const MAX_SHEET_PIXELS = 32_000_000;

/** geometry of one cell, looked up by cellKey across all sheets. */
function geometryOf(sheets: RemixSpriteCropSheet[], key: string) {
  for (const s of sheets) {
    for (const c of s.original_crops) {
      if (spriteCellKey(c) === key) return c.geometry;
    }
  }
  throw new Error(`cell ${key} not found in any sheet`);
}

describe('partitionByObjectAffinity — natural dims (non-square cells)', () => {
  it('cells keep their NATURAL aspect — portrait and landscape are not squared', async () => {
    mockDims.set('a/1', { width: 1000, height: 1500 }); // portrait
    mockDims.set('a/2', { width: 1500, height: 1000 }); // landscape
    const sheets = await partitionByObjectAffinity([cell('a', '1'), cell('a', '2')], 1);
    // ≤2 cells/sheet → cap 2000; longest edge 1500 ≤ cap → factor 1 → exact dims.
    expect(geometryOf(sheets, 'character/a/1')).toMatchObject({ w: 1000, h: 1500 });
    expect(geometryOf(sheets, 'character/a/2')).toMatchObject({ w: 1500, h: 1000 });
  });

  it('≤2 cells/sheet → longest edge capped at 2000, aspect preserved', async () => {
    mockDims.set('a/1', { width: 4000, height: 2000 });
    mockDims.set('a/2', { width: 4000, height: 2000 });
    const sheets = await partitionByObjectAffinity([cell('a', '1'), cell('a', '2')], 1);
    for (const key of ['character/a/1', 'character/a/2']) {
      const g = geometryOf(sheets, key);
      expect(Math.max(g.w, g.h)).toBe(2000); // factor 0.5 pins longest edge to cap
      expect(g.h).toBe(1000); // 2:1 aspect kept
    }
  });

  it('>2 cells/sheet → longest edge capped at 1000', async () => {
    for (const i of [1, 2, 3]) mockDims.set(`a/${i}`, { width: 4000, height: 4000 });
    const sheets = await partitionByObjectAffinity(
      [cell('a', '1'), cell('a', '2'), cell('a', '3')],
      1,
    );
    for (const i of [1, 2, 3]) {
      const g = geometryOf(sheets, `character/a/${i}`);
      expect(g.w).toBe(1000);
      expect(g.h).toBe(1000);
    }
  });

  it('cap keys off PER-SHEET count: 4 cells over K=2 → 2 cells/sheet → cap 2000', async () => {
    const cells = [cell('a', '1'), cell('a', '2'), cell('b', '1'), cell('b', '2')];
    for (const c of cells) mockDims.set(c.media_url, { width: 4000, height: 4000 });
    const sheets = await partitionByObjectAffinity(cells, 2);
    const crops = sheets.flatMap((s) => s.original_crops);
    for (const c of crops) expect(c.geometry.w).toBe(2000);
  });

  it('applies ONE global factor to ALL cells — true relative proportions, no per-cell normalization', async () => {
    mockDims.set('a/1', { width: 4000, height: 4000 });
    mockDims.set('a/2', { width: 1000, height: 1000 });
    const sheets = await partitionByObjectAffinity([cell('a', '1'), cell('a', '2')], 1);
    // cap 2000, longest 4000 → factor 0.5 for BOTH cells.
    expect(geometryOf(sheets, 'character/a/1')).toMatchObject({ w: 2000, h: 2000 });
    expect(geometryOf(sheets, 'character/a/2')).toMatchObject({ w: 500, h: 500 });
  });

  it('never UPSCALES — cells smaller than the cap keep their natural size', async () => {
    mockDims.set('a/1', { width: 800, height: 600 });
    mockDims.set('a/2', { width: 640, height: 480 });
    const sheets = await partitionByObjectAffinity([cell('a', '1'), cell('a', '2')], 1);
    expect(geometryOf(sheets, 'character/a/1')).toMatchObject({ w: 800, h: 600 });
    expect(geometryOf(sheets, 'character/a/2')).toMatchObject({ w: 640, h: 480 });
  });

  it('dim read failure → square cap-sized fallback cell + warning, layout continues', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockDims.set('a/1', { width: 1000, height: 500 });
      mockDims.set('a/2', 'fail');
      const sheets = await partitionByObjectAffinity([cell('a', '1'), cell('a', '2')], 1);
      // Failed cell falls back to cap×cap (2000); longest edge = cap → factor 1
      // → the measured cell keeps its natural size.
      expect(geometryOf(sheets, 'character/a/2')).toMatchObject({ w: 2000, h: 2000 });
      expect(geometryOf(sheets, 'character/a/1')).toMatchObject({ w: 1000, h: 500 });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── ordering — crops[] follows remix.characters input order ─────────────────

describe('partitionByObjectAffinity — ordering (ordinal = input order)', () => {
  it('crops[] ARRAY order = input order even when packing places larger cells first', async () => {
    // didi's cells are larger → potpack's size-sort places them first
    // GEOMETRICALLY; crops[] (→ ordinal badges 1..N) must still follow the
    // input (remix.characters) order. No assertion on x/y — geometric position
    // stays fill-optimized by design.
    mockDims.set('leena/base', { width: 500, height: 500 });
    mockDims.set('didi/base', { width: 1500, height: 1500 });
    mockDims.set('didi/v1', { width: 1000, height: 1000 });
    const cells = [cell('leena', 'base'), cell('didi', 'base'), cell('didi', 'v1')];
    const sheets = await partitionByObjectAffinity(cells, 1);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].original_crops.map((c) => spriteCellKey(c))).toEqual([
      'character/leena/base',
      'character/didi/base',
      'character/didi/v1',
    ]);
  });

  it('K=2: first-appearing character lands on sheet 0 — not displaced by a larger-area cluster', async () => {
    // didi has MORE cells but leena appears first in the input → appearance
    // order (preserveInputOrder) buckets leena's cluster first → sheet 0.
    // leena is large enough that didi's cluster stays within the per-sheet
    // budget (no oversize split).
    mockDims.set('leena/base', { width: 2000, height: 2000 });
    mockDims.set('didi/base', { width: 1000, height: 1000 });
    mockDims.set('didi/v1', { width: 1000, height: 1000 });
    const cells = [cell('leena', 'base'), cell('didi', 'base'), cell('didi', 'v1')];
    const sheets = await partitionByObjectAffinity(cells, 2);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].original_crops.map((c) => spriteCellKey(c))).toEqual(['character/leena/base']);
    expect(sheets[1].original_crops.map((c) => spriteCellKey(c))).toEqual([
      'character/didi/base',
      'character/didi/v1',
    ]);
  });

  it('INTERLEAVED input is re-grouped by object_key — variants of one character stay adjacent in crops[] AND placement', async () => {
    // Relayout regression: a prior K=2 over-budget split stores sheet order
    // [leena/base, didi/base | leena/school]; shrinking back to K=1 feeds the
    // interleaved order in. crops[] (→ ordinals) must come out re-grouped, and
    // with equal-size cells the GEOMETRIC reading order must match crops[]
    // (input-order tie-break), keeping leena's variants side by side.
    const cells = [cell('leena', 'base'), cell('didi', 'base'), cell('leena', 'school')];
    const sheets = await partitionByObjectAffinity(cells, 1);
    expect(sheets).toHaveLength(1);
    const grouped = [
      'character/leena/base',
      'character/leena/school',
      'character/didi/base',
    ];
    expect(sheets[0].original_crops.map((c) => spriteCellKey(c))).toEqual(grouped);
    const readingOrder = [...sheets[0].original_crops]
      .sort((a, b) => a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x)
      .map((c) => spriteCellKey(c));
    expect(readingOrder).toEqual(grouped);
  });

  it('re-grouping keeps first-appearance order of characters and in-group order of variants', async () => {
    const cells = [
      cell('momo', 'v2'),
      cell('leena', 'base'),
      cell('momo', 'v1'),
      cell('leena', 'school'),
    ];
    const sheets = await partitionByObjectAffinity(cells, 1);
    expect(sheets[0].original_crops.map((c) => spriteCellKey(c))).toEqual([
      'character/momo/v2',
      'character/momo/v1',
      'character/leena/base',
      'character/leena/school',
    ]);
  });
});

// ── persisted schema — transient dims never leak ─────────────────────────────

describe('partitionByObjectAffinity — persisted SpriteCrop schema', () => {
  it('crops carry ONLY SpriteCrop fields (transient width/height stripped)', async () => {
    const sheets = await partitionByObjectAffinity([cell('a', '1')], 1);
    const crop = sheets[0].original_crops[0];
    expect(Object.keys(crop).sort()).toEqual([
      'geometry',
      'media_url',
      'object_key',
      'type',
      'variant_key',
    ]);
  });
});

// ── sheet cap guard ──────────────────────────────────────────────────────────

describe('partitionByObjectAffinity — sheet cap guard', () => {
  it('clamps an over-cap sheet within both caps, crops stay in-bounds + scaled', async () => {
    // Far more cells than fit at the 1000px cap on K=1 → sheet overflows
    // 8192px / 32 MP → guard must scale the whole sheet down rather than emit
    // an un-swappable one. (Default mock dims: 1000×1000 squares.)
    const cells = Array.from({ length: 150 }, (_, i) => cell('a', String(i)));
    const sheets = await partitionByObjectAffinity(cells, 1);
    expect(sheets).toHaveLength(1);
    const sheet = sheets[0];
    const { width, height } = sheet.sheet_geometry;
    expect(width).toBeLessThanOrEqual(MAX_SHEET_DIM);
    expect(height).toBeLessThanOrEqual(MAX_SHEET_DIM);
    expect(width * height).toBeLessThanOrEqual(MAX_SHEET_PIXELS);
    // Clamp genuinely engaged → cells shrank below their natural 1000px.
    expect(sheet.original_crops[0].geometry.w).toBeLessThan(1000);
    for (const c of sheet.original_crops) {
      expect(c.geometry.x).toBeGreaterThanOrEqual(0);
      expect(c.geometry.y).toBeGreaterThanOrEqual(0);
      expect(c.geometry.x + c.geometry.w).toBeLessThanOrEqual(width);
      expect(c.geometry.y + c.geometry.h).toBeLessThanOrEqual(height);
    }
  });

  it('within-cap sheets are NOT clamped (cells keep their natural dimension)', async () => {
    const cells = Array.from({ length: 8 }, (_, i) => cell('a', String(i)));
    const crops = (await partitionByObjectAffinity(cells, 1)).flatMap((s) => s.original_crops);
    // 8 cells @1000px well under caps → exact 1000, no down-scale.
    for (const c of crops) expect(c.geometry.w).toBe(1000);
  });
});

// ── currentCellsOfSprite + addSpriteSubset ───────────────────────────────────

async function spriteFrom(cells: SpriteCell[]): Promise<RemixSpriteEntry> {
  return {
    id: 'sp1',
    order: 0,
    name: 'Sprite 1',
    crop_sheets: await partitionByObjectAffinity(cells, 1),
  };
}

describe('currentCellsOfSprite + addSpriteSubset', () => {
  it('currentCellsOfSprite dedups across sheets', async () => {
    const sprite = await spriteFrom([cell('a', '1'), cell('a', '2'), cell('b', '1')]);
    expect(currentCellsOfSprite(sprite)).toHaveLength(3);
  });

  it('addSpriteSubset filters to selected cellKeys', async () => {
    const sprite = await spriteFrom([cell('a', '1'), cell('a', '2'), cell('b', '1')]);
    const sel = new Set([spriteCellKey(cell('a', '1')), spriteCellKey(cell('b', '1'))]);
    const sheets = await addSpriteSubset(sprite, sel);
    const keys = sheets.flatMap((s) => s.original_crops.map((c) => spriteCellKey(c)));
    expect(new Set(keys)).toEqual(sel);
  });

  it('addSpriteSubset returns [] when nothing matches', async () => {
    const sprite = await spriteFrom([cell('a', '1')]);
    expect(await addSpriteSubset(sprite, new Set(['character/zzz/9']))).toEqual([]);
  });
});

// ── buildSeedSprite ──────────────────────────────────────────────────────────

describe('buildSeedSprite', () => {
  it('seeds Sprite 1 (K=1) from enabled variants; null when already seeded', async () => {
    const remix = makeRemix({
      chars: [{ key: 'c1', enabled: true, variants: [variant('base', 0, [{ url: 'x', sel: true }])] }],
    });
    const seed = await buildSeedSprite(remix);
    expect(seed?.name).toBe('Sprite 1');
    expect(seed?.crop_sheets[0].original_crops).toHaveLength(1);

    const seeded = { ...remix, sprites: [seed!] };
    expect(await buildSeedSprite(seeded)).toBeNull();
  });

  it('null when no variant cells', async () => {
    const remix = makeRemix({ chars: [{ key: 'c1', enabled: false, variants: [] }] });
    expect(await buildSeedSprite(remix)).toBeNull();
  });
});
