// sketch-normalize.test.ts — the ADR-047 normalizer suite. Proves the two user acceptance
// criteria: (T1/T2) PER-RESOURCE ISOLATION by deep-equal — corrupting resource X leaves every
// other resource byte-identical to the healthy run — and (T5) the taxonomy: ABSENT never cries
// wolf, CONVERT never asks consent, RESET always reports with the right resource key.
// T6 pins 8 sanitized REAL local-DB blobs to zero reset-anomalies (the original incident was a
// false-positive discriminator wiping healthy rows — this is the regression net against that).

import { describe, it, expect } from 'vitest';
import realSketchBlobs from './__fixtures__/real-sketch-blobs.json';
import {
  normalizeSketch,
  normalizeSketchSpread,
  coerceSketchNode,
  DEFAULT_SKETCH,
  type SketchAnomaly,
} from './sketch-normalize';
import type { Sketch } from '@/types/sketch';

const collect = (raw: unknown) => {
  const anomalies: SketchAnomaly[] = [];
  const sketch = normalizeSketch(raw, (a) => anomalies.push(a));
  return { sketch, anomalies };
};

const resets = (anomalies: SketchAnomaly[]) => anomalies.filter((a) => a.cls === 'reset');

const style = (prompt: string) => ({
  style_prompt: prompt,
  is_selected: true,
  image_references: [],
  illustrations: [],
  crops: [],
});

describe('normalizeSketch (shape mapping)', () => {
  it('returns DEFAULT_SKETCH for undefined / null / non-object', () => {
    expect(normalizeSketch(undefined)).toEqual(DEFAULT_SKETCH);
    expect(normalizeSketch(null)).toEqual(DEFAULT_SKETCH);
    expect(normalizeSketch('nope')).toEqual(DEFAULT_SKETCH);
    expect(normalizeSketch(42)).toEqual(DEFAULT_SKETCH);
    expect(normalizeSketch([])).toEqual(DEFAULT_SKETCH);
  });

  // CONTRACT (2026-07-17, data-loss fix): legacy markers used to hard-reset the WHOLE sketch to
  // DEFAULT_SKETCH. They no longer reset anything — reported (`cls:'report'`) instead.
  it('maps a legacy-marker blob defensively instead of resetting to empty', () => {
    expect(normalizeSketch({ dummy_id: 'd1', spreads: [] })).toEqual(DEFAULT_SKETCH);
    // ...but a marker blob that CARRIES data keeps it (that is the whole point):
    const withData = { character_sheets: [{}], characters: [{ key: 'kid', variants: [] }] };
    expect(normalizeSketch(withData).characters).toEqual([{ key: 'kid', variants: [] }]);
  });

  it('maps a legacy spread (images[], no pages[]) instead of resetting to empty', () => {
    const legacy = { id: 'x', spreads: [{ id: 's1', images: [{ id: 'i1' }] }] };
    const result = normalizeSketch(legacy);
    expect(result.id).toBe('x');
    expect(result.spreads).toHaveLength(1);
    expect(result.spreads[0].id).toBe('s1');
  });

  it('preserves a valid new-shape sketch', () => {
    const valid: Sketch = {
      id: 'sk1',
      base: { character_sheet: { styles: [] }, prop_sheet: { styles: [] }, alter_character_sheet: { styles: [] } },
      characters: [{ key: 'c1', variants: [] }],
      props: [],
      stages: [{ key: 'st1', base: { styles: [] }, variants: [{ key: 'v', description: '', visual_design: 'd', art_language: '', illustrations: [], crops: [] }] }],
      spreads: [{ id: 'sp1', images: [], pages: [], textboxes: [] }],
      lineups: [{ id: 't1', name: 'Lineup', entries: [{ kind: 'characters', entity_key: 'c1', variant_key: 'base' }] }],
    };
    expect(normalizeSketch(valid)).toEqual(valid);
  });

  // ⚡REV 2026-08-21 — an absent base workspace is an EMPTY group map (dynamic keys, no fixed sheets).
  it('defaults a missing base workspace to an empty group map (backward-compat)', () => {
    const result = normalizeSketch({ id: 'no-base', characters: [], props: [], stages: [], spreads: [] });
    expect(result.base).toEqual({});
  });

  // ⚡REV 2026-08-21 — keeps EXACTLY the present group keys; an absent group is never injected.
  it('keeps exactly the present group keys — never injects an absent group (no anomaly)', () => {
    const { sketch, anomalies } = collect({
      base: { character_sheet: { styles: [style('watercolor')] }, prop_sheet: { styles: [] } },
    });
    expect(Object.keys(sketch.base).sort()).toEqual(['character_sheet', 'prop_sheet']);
    expect(sketch.base.character_sheet.styles).toHaveLength(1);
    expect(sketch.base.alter_character_sheet).toBeUndefined();
    expect(anomalies).toEqual([]);
  });

  it('defaults missing nested arrays to [] and base to an empty map (defensive)', () => {
    expect(normalizeSketch({ id: 'only-id' })).toEqual({
      id: 'only-id',
      base: {},
      characters: [],
      props: [],
      stages: [],
      spreads: [],
      lineups: [],
    });
  });

  it('coerces a non-string id to null', () => {
    const result = normalizeSketch({ id: 123, characters: [], props: [], stages: [], spreads: [] });
    expect(result.id).toBeNull();
  });

  // Discriminator HAZARD (the original incident): a new spread (images + pages) must NOT
  // false-positive as legacy.
  it('does NOT reset a new-shape spread that has BOTH images[] and pages[]', () => {
    const raw = {
      id: 'sk',
      characters: [],
      props: [],
      stages: [],
      spreads: [
        { id: 'sp', images: [{ id: 'i', illustrations: [] }], pages: [{ type: 'full' }], textboxes: [] },
      ],
    };
    const result = normalizeSketch(raw);
    expect(result.spreads).toHaveLength(1);
    expect(result.spreads[0].id).toBe('sp');
  });

  it('coerces missing variant text fields to empty string', () => {
    const raw = {
      id: 'sk1',
      characters: [{ key: 'hero', variants: [{ key: 'base' }] }],
    };
    const heroBase = normalizeSketch(raw).characters[0].variants[0];
    expect(heroBase.description).toBe('');
    expect(heroBase.visual_design).toBe('');
    expect(heroBase.art_language).toBe('');
  });

  it('preserves a valid base workspace untouched', () => {
    const base = {
      character_sheet: { styles: [style('test style')] },
      prop_sheet: { styles: [] },
      alter_character_sheet: { styles: [style('alter style')] },
    };
    expect(normalizeSketch({ id: 'sk1', base }).base).toEqual(base);
  });

  it('carries self-describing kind/name/order through the read boundary (order = sidebar sort key)', () => {
    const base = {
      character_family: { kind: 'characters', name: 'Character Family', order: 0, styles: [] },
      character_pet: { kind: 'characters', name: 'Character Pet', order: 1, styles: [style('s')] },
    };
    const out = normalizeSketch({ id: 'sk1', base }).base;
    expect(out.character_family).toEqual({ kind: 'characters', name: 'Character Family', order: 0, styles: [] });
    expect(out.character_pet.order).toBe(1);
  });
});

// REGRESSION NET for the 2026-07-17 silent-data-loss incident. Core rule: an unexpected shape
// NEVER silently blanks populated data — it is classified (convert/reset/report) and reported.
describe('normalizeSketch data-safety (never silently blank populated data)', () => {
  // A blob that is populated everywhere AND trips the old `spreads[0]` legacy discriminator
  // (`images` present, `pages` absent).
  const populatedLegacySpreadBlob = () => ({
    id: 'sk1',
    base: {
      character_sheet: { styles: [style('watercolor')] },
      prop_sheet: { styles: [style('inked')] },
    },
    characters: [{ key: 'kid', variants: [] }],
    props: [{ key: 'wand', variants: [] }],
    stages: [{ key: 'forest', variants: [] }],
    spreads: [{ id: 's1', images: [{ id: 'i1', illustrations: [] }] }],
  });

  it('does NOT wipe base styles / characters / props when spreads[0] has images and no pages', () => {
    const result = normalizeSketch(populatedLegacySpreadBlob());
    expect(result.base.character_sheet.styles).toHaveLength(1);
    expect(result.base.character_sheet.styles[0].style_prompt).toBe('watercolor');
    expect(result.base.prop_sheet.styles).toHaveLength(1);
    expect(result.characters).toEqual([{ key: 'kid', variants: [] }]);
    expect(result.props).toEqual([{ key: 'wand', variants: [] }]);
    expect(result.stages).toEqual([{ key: 'forest', base: { styles: [] }, variants: [] }]);
    // The spread itself survives too (pages defaults to [], images kept).
    expect(result.spreads).toHaveLength(1);
    expect(result.spreads[0].id).toBe('s1');
  });

  it.each(['dummy_id', 'character_sheets', 'prop_sheets'])(
    'does NOT wipe populated base styles when the legacy marker %s is present',
    (marker) => {
      const raw = {
        [marker]: 'legacy-value',
        base: { character_sheet: { styles: [style('watercolor')] }, prop_sheet: { styles: [] } },
        characters: [{ key: 'kid', variants: [] }],
      };
      const { sketch, anomalies } = collect(raw);
      expect(sketch.base.character_sheet.styles).toHaveLength(1);
      expect(sketch.characters).toEqual([{ key: 'kid', variants: [] }]);
      // Stale top-level keys are report-only: toast, never a reset, never save-blocked.
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].cls).toBe('report');
      expect(anomalies[0].message).toContain(marker);
    },
  );

  it('does NOT blank a populated styles[] when the sheet carries odd sibling keys', () => {
    const raw = {
      base: {
        character_sheet: { styles: [style('watercolor')], legacy_junk: 42 },
        prop_sheet: { styles: [] },
      },
    };
    const { sketch, anomalies } = collect(raw);
    expect(sketch.base.character_sheet.styles).toHaveLength(1);
    expect(anomalies).toEqual([]); // styles is a valid array → nothing to cry wolf about
  });

  it('salvages a populated styles[] stored directly in the sheet slot (array → convert, no consent)', () => {
    const raw = { base: { character_sheet: [style('watercolor')], prop_sheet: { styles: [] } } };
    const { sketch, anomalies } = collect(raw);
    expect(sketch.base.character_sheet.styles).toHaveLength(1);
    expect(sketch.base.character_sheet.styles[0].style_prompt).toBe('watercolor');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].cls).toBe('convert'); // lossless salvage — never a modal
    expect(anomalies[0].resource).toBe('base.character_sheet');
  });

  it('element-coerces salvaged styles so a junk element cannot crash the base workspace', () => {
    const { sketch } = collect({ base: { character_sheet: ['watercolor', { style_prompt: 'ok' }] } });
    const styles = sketch.base.character_sheet.styles;
    expect(styles).toHaveLength(2);
    for (const s of styles) {
      // The exact shapes the store actions reach into.
      expect(Array.isArray(s.crops)).toBe(true);
      expect(Array.isArray(s.illustrations)).toBe(true);
      expect(Array.isArray(s.image_references)).toBe(true);
    }
    expect(styles[1].style_prompt).toBe('ok'); // real style survives salvage intact
  });

  it('salvages an object-map styles ({"0":…,"1":…}) instead of blanking it (convert)', () => {
    const raw = {
      base: {
        character_sheet: { styles: { 0: style('watercolor'), 1: style('inked') } },
        prop_sheet: { styles: [] },
      },
    };
    const { sketch, anomalies } = collect(raw);
    expect(sketch.base.character_sheet.styles).toHaveLength(2);
    expect(sketch.base.character_sheet.styles.map((s) => s.style_prompt)).toEqual([
      'watercolor',
      'inked',
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].cls).toBe('convert');
  });

  it('classifies unreadable sheet/styles/base shapes as RESET with the right resource', () => {
    const sheetString = collect({ base: { character_sheet: 'nope', prop_sheet: { styles: [] } } });
    expect(resets(sheetString.anomalies)).toHaveLength(1);
    expect(resets(sheetString.anomalies)[0].resource).toBe('base.character_sheet');
    expect(resets(sheetString.anomalies)[0].raw).toBe('nope'); // quarantine payload

    const stylesGarbage = collect({ base: { character_sheet: { styles: { a: 1 } }, prop_sheet: { styles: [] } } });
    expect(resets(stylesGarbage.anomalies)).toHaveLength(1);
    expect(resets(stylesGarbage.anomalies)[0].resource).toBe('base.character_sheet');

    // base itself unreadable → one coarse `base` reset (no group is derivable from a non-object).
    const baseGarbage = collect({ base: 'nope' });
    expect(resets(baseGarbage.anomalies).map((a) => a.resource)).toEqual(['base']);
  });

  it('does NOT blank populated entity collections that are malformed — placeholder + reset instead', () => {
    const { sketch, anomalies } = collect({ characters: 'nope', props: [{ key: 'wand', variants: [] }] });
    expect(sketch.props).toEqual([{ key: 'wand', variants: [] }]); // sibling untouched
    expect(resets(anomalies)).toHaveLength(1);
    expect(resets(anomalies)[0].resource).toBe('characters');
  });

  it('reports a non-object sketch blob as a root reset but still yields DEFAULT_SKETCH', () => {
    const { sketch, anomalies } = collect('nope');
    expect(sketch).toEqual(DEFAULT_SKETCH);
    expect(resets(anomalies)).toHaveLength(1);
    expect(resets(anomalies)[0].resource).toBe('sketch');
    expect(resets(collect(42).anomalies)).toHaveLength(1);
  });

  // MUST NOT CRY WOLF: a brand-new book genuinely has no sketch — that is not an anomaly, and a
  // toast/modal there would train users to ignore the real one.
  it('reports NO anomaly for a genuinely absent sketch (null / undefined = new book)', () => {
    expect(collect(null)).toEqual({ sketch: DEFAULT_SKETCH, anomalies: [] });
    expect(collect(undefined)).toEqual({ sketch: DEFAULT_SKETCH, anomalies: [] });
  });

  it('reports NO anomaly for a well-formed sketch, nor for legitimately absent sub-trees', () => {
    expect(collect(populatedLegacySpreadBlob()).anomalies).toEqual([]);
    expect(collect({ id: 'only-id' }).anomalies).toEqual([]); // absent base/characters/spreads
    expect(collect({ base: {} }).anomalies).toEqual([]); // sheet slots absent → new, not broken
    expect(collect({ base: { character_sheet: {} } }).anomalies).toEqual([]); // no styles yet
  });

  it('reports a non-object spreads[] element as a reset rather than silently collapsing it', () => {
    const { sketch, anomalies } = collect({ spreads: [{ id: 'ok', pages: [], textboxes: [] }, null] });
    expect(sketch.spreads).toHaveLength(2); // slot kept (positional)
    expect(sketch.spreads[0].id).toBe('ok');
    expect(resets(anomalies)).toHaveLength(1);
    expect(resets(anomalies)[0].resource).toBe('spreads'); // id unreadable → coarse
  });
});

// 2026-07-18 stage rework migration: OLD-shape stage blobs (shared SketchVariant — direct
// illustrations[], no crops/base) coerce to the new SketchStage shape. Locked decision
// (plan validation S1): variant IMAGES reset, TEXT kept — a `convert`, NEVER a quarantine
// (a routine migration must not trip the ADR-047 consent modal or block saves).
describe('normalizeSketch stage migration (2026-07-18 rework — reset images, keep text)', () => {
  const oldStage = () => ({
    key: 'forest',
    variants: [
      {
        key: 'base',
        description: 'seed',
        visual_design: 'mossy woods',
        art_language: 'soft pencil',
        illustrations: [{ media_url: 'https://x/old.png', created_time: 't', is_selected: true }],
      },
      { key: 'storm', description: 'd2', visual_design: 'v2', art_language: 'a2' },
    ],
  });

  it('keeps every text field, resets old images, and NEVER quarantines (convert only)', () => {
    const { sketch, anomalies } = collect({ id: 'sk1', stages: [oldStage()] });
    const stage = sketch.stages[0];
    expect(stage.key).toBe('forest');
    expect(stage.base).toEqual({ styles: [] });
    expect(stage.variants).toHaveLength(2);
    expect(stage.variants[0]).toEqual({
      key: 'base',
      description: 'seed',
      visual_design: 'mossy woods',
      art_language: 'soft pencil',
      illustrations: [], // old direct-generate image RESET (wrong grid for the 2-cell model)
      crops: [],
    });
    expect(stage.variants[1].visual_design).toBe('v2');
    // Deliberate migration = convert — never reset/quarantine/save-block.
    expect(resets(anomalies)).toEqual([]);
    const converts = anomalies.filter((a) => a.cls === 'convert');
    expect(converts).toHaveLength(1); // only the variant that actually carried images
    expect(converts[0].resource).toBe('stages/forest');
  });

  it('drops a stray legacy height without stamping the new shape', () => {
    const { sketch, anomalies } = collect({
      stages: [{ key: 's', variants: [{ key: 'v', height: '110cm' }] }],
    });
    expect('height' in sketch.stages[0].variants[0]).toBe(false);
    expect(resets(anomalies)).toEqual([]);
  });

  it('round-trips a NEW-shape stage untouched (no anomaly)', () => {
    const stage = {
      key: 'house_night',
      base: {
        styles: [
          {
            style_prompt: 'ink wash',
            is_selected: true,
            image_references: [{ title: 'r', media_url: 'https://x/r.png' }],
            illustrations: [{ media_url: 'https://x/sheet.png', created_time: 't', is_selected: true }],
            crops: [
              { is_selected: true, illustrations: [{ media_url: 'https://x/c0.png', created_time: 't', is_selected: true }] },
              { is_selected: false, illustrations: [] },
            ],
          },
        ],
      },
      variants: [
        {
          key: 'storm',
          description: 'd',
          visual_design: 'v',
          art_language: 'a',
          illustrations: [{ media_url: 'https://x/vsheet.png', created_time: 't', is_selected: true }],
          crops: [
            { is_selected: false, illustrations: [{ media_url: 'https://x/vc0.png', created_time: 't', is_selected: true }] },
            { is_selected: false, illustrations: [] },
          ],
        },
      ],
    };
    const { sketch, anomalies } = collect({ id: 'sk1', stages: [stage] });
    expect(sketch.stages[0]).toEqual(stage);
    expect(anomalies).toEqual([]);
  });

  it('salvages an object-map base.styles (positional gateway write) as convert', () => {
    const { sketch, anomalies } = collect({
      stages: [{ key: 's', base: { styles: { 0: { style_prompt: 'p' } } }, variants: [] }],
    });
    expect(sketch.stages[0].base.styles).toHaveLength(1);
    expect(sketch.stages[0].base.styles[0].style_prompt).toBe('p');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].cls).toBe('convert');
  });

  it('classifies unreadable base / base.styles / variants as RESET pinned to the stage node', () => {
    const badBase = collect({ stages: [{ key: 's1', base: 42, variants: [] }] });
    expect(resets(badBase.anomalies)).toHaveLength(1);
    expect(resets(badBase.anomalies)[0].resource).toBe('stages/s1');

    const badStyles = collect({ stages: [{ key: 's2', base: { styles: 'nope' }, variants: [] }] });
    expect(resets(badStyles.anomalies)).toHaveLength(1);
    expect(resets(badStyles.anomalies)[0].resource).toBe('stages/s2');

    const badVariants = collect({ stages: [{ key: 's3', variants: 'nope' }] });
    expect(resets(badVariants.anomalies)).toHaveLength(1);
    expect(resets(badVariants.anomalies)[0].resource).toBe('stages/s3');
  });
});

// T1 — the user acceptance criterion: corrupting ONE resource leaves every other resource
// DEEP-EQUAL to the healthy run, and the anomaly names exactly the corrupted resource.
describe('normalizeSketch per-resource isolation (T1 — deep-equal matrix)', () => {
  const healthy = () => ({
    id: 'sk1',
    base: {
      character_sheet: { styles: [style('watercolor')] },
      prop_sheet: { styles: [style('inked')] },
    },
    characters: [{ key: 'kid', variants: [{ key: 'base', description: 'd', visual_design: 'v', art_language: 'a' }] }],
    props: [{ key: 'wand', variants: [] }],
    stages: [{ key: 'forest', variants: [] }],
    spreads: [{ id: 's1', images: [{ id: 'i1', type: 'full', illustrations: [] }], pages: [{ type: 'full' }], textboxes: [] }],
  });

  type ResourceName = 'base.character_sheet' | 'base.prop_sheet' | 'characters' | 'props' | 'stages' | 'spreads';
  const RESOURCES: ResourceName[] = ['base.character_sheet', 'base.prop_sheet', 'characters', 'props', 'stages', 'spreads'];

  const readResource = (sketch: Sketch, r: ResourceName): unknown => {
    if (r === 'base.character_sheet') return sketch.base.character_sheet;
    if (r === 'base.prop_sheet') return sketch.base.prop_sheet;
    return sketch[r];
  };

  const corrupt = (blob: ReturnType<typeof healthy>, r: ResourceName): void => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    if (r === 'base.character_sheet') (blob.base as any).character_sheet = 42; // number in sheet slot
    else if (r === 'base.prop_sheet') (blob.base as any).prop_sheet = 'garbage';
    else if (r === 'characters') (blob as any).characters = 'not-an-array';
    else if (r === 'props') (blob as any).props = 123;
    else if (r === 'stages') (blob as any).stages = { not: 'an array' };
    else (blob as any).spreads = 'oops';
    /* eslint-enable @typescript-eslint/no-explicit-any */
  };

  const expected = normalizeSketch(healthy());

  it.each(RESOURCES)('corrupting %s leaves every OTHER resource deep-equal + attributes the anomaly', (target) => {
    const blob = healthy();
    corrupt(blob, target);
    const { sketch, anomalies } = collect(blob);

    for (const other of RESOURCES) {
      if (other === target) continue;
      expect(readResource(sketch, other)).toEqual(readResource(expected, other));
    }
    expect(sketch.id).toBe('sk1');

    const rs = resets(anomalies);
    expect(rs).toHaveLength(1);
    expect(rs[0].resource).toBe(target);
    expect(anomalies.filter((a) => a.cls !== 'reset')).toEqual([]); // no collateral noise
  });

  it('corrupting TWO resources degrades exactly those two, others intact', () => {
    const blob = healthy();
    corrupt(blob, 'characters');
    corrupt(blob, 'base.prop_sheet');
    const { sketch, anomalies } = collect(blob);
    expect(readResource(sketch, 'props')).toEqual(readResource(expected, 'props'));
    expect(readResource(sketch, 'spreads')).toEqual(readResource(expected, 'spreads'));
    expect(readResource(sketch, 'base.character_sheet')).toEqual(readResource(expected, 'base.character_sheet'));
    expect(resets(anomalies).map((a) => a.resource).sort()).toEqual(['base.prop_sheet', 'characters']);
  });
});

// T2 — fault isolation: a THROWING resource (hostile getter) must not kill the load nor
// contaminate siblings.
describe('normalizeSketch fault isolation (T2 — getter throw)', () => {
  const healthyRest = {
    base: { character_sheet: { styles: [style('w')] }, prop_sheet: { styles: [] } },
    props: [{ key: 'wand', variants: [] }],
    stages: [{ key: 'forest', variants: [] }],
    spreads: [],
  };

  it('a throwing `characters` getter does not throw, siblings deep-equal, anomaly attributed', () => {
    const blob: Record<string, unknown> = { id: 'sk1', ...structuredClone(healthyRest) };
    Object.defineProperty(blob, 'characters', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const { sketch, anomalies } = collect(blob);
    expect(sketch.characters).toEqual([]); // placeholder
    expect(sketch.props).toEqual([{ key: 'wand', variants: [] }]);
    expect(sketch.stages).toEqual([{ key: 'forest', base: { styles: [] }, variants: [] }]);
    expect(sketch.base.character_sheet.styles).toHaveLength(1);
    const rs = resets(anomalies);
    expect(rs).toHaveLength(1);
    expect(rs[0].resource).toBe('characters');
  });

  it('a throwing `base` getter degrades base coarsely (one `base` reset), siblings intact', () => {
    const blob: Record<string, unknown> = { id: 'sk1', ...structuredClone(healthyRest) };
    delete blob.base;
    Object.defineProperty(blob, 'base', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    blob.characters = [{ key: 'kid', variants: [] }];
    const { sketch, anomalies } = collect(blob);
    expect(sketch.base).toEqual({});
    expect(sketch.characters).toEqual([{ key: 'kid', variants: [] }]);
    expect(resets(anomalies).map((a) => a.resource)).toEqual(['base']);
  });

  it('a throwing element inside an entity array degrades that collection, siblings intact', () => {
    const evil: unknown[] = [{ key: 'ok', variants: [] }];
    Object.defineProperty(evil, 1, {
      enumerable: true,
      get() {
        throw new Error('element boom');
      },
    });
    // Force length to include the trap index.
    (evil as { length: number }).length = 2;
    const { sketch, anomalies } = collect({ ...structuredClone(healthyRest), characters: evil });
    expect(sketch.props).toEqual([{ key: 'wand', variants: [] }]);
    expect(resets(anomalies).some((a) => a.resource === 'characters')).toBe(true);
  });
});

describe('normalizeSketchSpread (per-page versioned images[] back-compat)', () => {
  it('wraps a legacy scalar media_url into one selected illustration (type inferred from pages)', () => {
    const out = normalizeSketchSpread({ id: 's1', media_url: 'http://x/i.png', pages: [{ type: 'full' }], textboxes: [] });
    expect(out.images).toHaveLength(1);
    expect(out.images[0].type).toBe('full');
    expect(out.images[0].illustrations[0]).toMatchObject({ media_url: 'http://x/i.png', is_selected: true });
  });

  it('assigns per-page types to legacy typeless images from page order (no clamp)', () => {
    const images = [
      { id: 'i1', illustrations: [{ media_url: 'u1', created_time: 't', is_selected: true }] },
      { id: 'i2', illustrations: [{ media_url: 'u2', created_time: 't', is_selected: true }] },
    ];
    const out = normalizeSketchSpread({ id: 's1', images, pages: [{ type: 'left' }, { type: 'right' }], textboxes: [] });
    expect(out.images).toHaveLength(2);
    expect(out.images.map((im) => im.type)).toEqual(['left', 'right']);
    expect(out.images[0].id).toBe('i1');
  });

  // D8 — dedupe is CONDITIONAL on what the dropped element carries.
  it('dedupe of an EMPTY duplicate image is a lossless convert (keeps first, no consent)', () => {
    const anomalies: SketchAnomaly[] = [];
    const images = [
      { id: 'i1', type: 'full', illustrations: [] },
      { id: 'i2', type: 'full', illustrations: [] },
    ];
    const out = normalizeSketchSpread({ id: 's1', images, pages: [{ type: 'full' }], textboxes: [] }, (a) => anomalies.push(a));
    expect(out.images).toHaveLength(1);
    expect(out.images[0].id).toBe('i1');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].cls).toBe('convert');
  });

  it('dedupe of a duplicate CARRYING illustrations is a lossy reset on that spread (consent)', () => {
    const anomalies: SketchAnomaly[] = [];
    const images = [
      { id: 'i1', type: 'full', illustrations: [] },
      { id: 'i2', type: 'full', illustrations: [{ media_url: 'u', created_time: 't', is_selected: true }] },
    ];
    normalizeSketchSpread({ id: 's1', images, pages: [{ type: 'full' }], textboxes: [] }, (a) => anomalies.push(a));
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].cls).toBe('reset');
    expect(anomalies[0].resource).toBe('spreads/s1'); // node-grain — only this spread blocks
  });

  it('defaults to images:[] when the spread has no image', () => {
    const out = normalizeSketchSpread({ id: 's1', pages: [], textboxes: [] });
    expect(out.images).toEqual([]);
  });

  it('collapses a non-object row to an empty spread', () => {
    expect(normalizeSketchSpread(null)).toEqual({ id: '', images: [], pages: [], textboxes: [] });
  });
});

describe('variant crop model (coerce back-compat + positional crops[])', () => {
  const emptyBaseRaw = () => ({ character_sheet: { styles: [] }, prop_sheet: { styles: [] }, alter_character_sheet: { styles: [] } });

  it('coerces a legacy variant.crop (no raw_sheet) into raw_sheet.crops[0] is_selected=true (lossless)', () => {
    const raw = {
      id: 'sk1',
      base: emptyBaseRaw(),
      characters: [
        {
          key: 'hero',
          variants: [
            {
              key: 'hero_v', description: '', visual_design: '', art_language: '',
              crop: { illustrations: [{ type: 'created', media_url: 'legacy.png', created_time: 't', is_selected: true }] },
            },
          ],
        },
      ],
      props: [], stages: [], spreads: [],
    };
    const v = normalizeSketch(raw).characters[0].variants[0];
    expect(v.raw_sheet?.illustrations).toEqual([]);
    expect(v.raw_sheet?.crops).toHaveLength(1);
    expect(v.raw_sheet?.crops[0].is_selected).toBe(true);
    expect(v.raw_sheet?.crops[0].illustrations[0].media_url).toBe('legacy.png');
  });

  it('coerces a legacy raw_sheet.illustrations + old crop (no crops[]) → crops[0] mapped', () => {
    const raw = {
      id: 'sk1',
      base: emptyBaseRaw(),
      characters: [
        {
          key: 'hero',
          variants: [
            {
              key: 'hero_v', description: '', visual_design: '', art_language: '',
              raw_sheet: { illustrations: [{ type: 'created', media_url: 'sheet.png', created_time: 't', is_selected: true }] },
              crop: { illustrations: [{ type: 'created', media_url: 'crop.png', created_time: 't', is_selected: true }] },
            },
          ],
        },
      ],
      props: [], stages: [], spreads: [],
    };
    const v = normalizeSketch(raw).characters[0].variants[0];
    expect(v.raw_sheet?.illustrations[0].media_url).toBe('sheet.png');
    expect(v.raw_sheet?.crops).toHaveLength(1);
    expect(v.raw_sheet?.crops[0].illustrations[0].media_url).toBe('crop.png');
  });

  it('coerces a new raw_sheet.crops[] positional array (is_selected defaults false when absent)', () => {
    const raw = {
      id: 'sk1',
      base: emptyBaseRaw(),
      characters: [
        {
          key: 'hero',
          variants: [
            {
              key: 'hero_v', description: '', visual_design: '', art_language: '',
              raw_sheet: {
                illustrations: [],
                crops: [
                  { illustrations: [{ type: 'created', media_url: 'c0.png', created_time: 't', is_selected: true }] }, // no is_selected → false
                  { is_selected: true, illustrations: [] },
                ],
              },
            },
          ],
        },
      ],
      props: [], stages: [], spreads: [],
    };
    const crops = normalizeSketch(raw).characters[0].variants[0].raw_sheet!.crops;
    expect(crops).toHaveLength(2);
    expect(crops[0].is_selected).toBe(false);
    expect(crops[0].illustrations[0].media_url).toBe('c0.png');
    expect(crops[1].is_selected).toBe(true);
    expect(crops[1].illustrations).toEqual([]);
  });
});

// T5 — idempotency + taxonomy invariants.
describe('normalizeSketch taxonomy invariants (T5)', () => {
  it('is idempotent: normalize(normalize(x)) deep-equals normalize(x)', () => {
    const raws: unknown[] = [
      null,
      { id: 'only-id' },
      {
        id: 'sk1',
        base: { character_sheet: { styles: [style('w')] }, prop_sheet: { styles: [] } },
        characters: [{ key: 'kid', variants: [{ key: 'base', description: '', visual_design: '', art_language: '', height: '1.1m' }] }],
        props: [],
        stages: [],
        spreads: [{ id: 's1', images: [{ id: 'i1', type: 'full', illustrations: [] }], pages: [{ type: 'full' }], textboxes: [] }],
      },
    ];
    for (const raw of raws) {
      const once = normalizeSketch(raw);
      expect(normalizeSketch(once)).toEqual(once);
    }
  });

  it('CONVERT never produces a reset: height "1.1m" auto-parses to 110 with zero anomalies (D1)', () => {
    const { sketch, anomalies } = collect({
      characters: [{ key: 'kid', variants: [{ key: 'base', description: '', visual_design: '', art_language: '', height: '1.1m' }] }],
    });
    expect(sketch.characters[0].variants[0].height).toBe(110);
    expect(anomalies).toEqual([]);
  });

  it('unparseable height becomes null WITHOUT a consent anomaly (D1 — warn-log only)', () => {
    const { sketch, anomalies } = collect({
      characters: [{ key: 'kid', variants: [{ key: 'base', description: '', visual_design: '', art_language: '', height: 'khoảng chừng cao' }] }],
    });
    expect(sketch.characters[0].variants[0].height).toBeNull();
    expect(resets(anomalies)).toEqual([]);
  });

  it('a reset anomaly always carries the quarantine payload when the raw slot was readable', () => {
    const { anomalies } = collect({ base: { character_sheet: { styles: 'garbage' }, prop_sheet: { styles: [] } } });
    const rs = resets(anomalies);
    expect(rs).toHaveLength(1);
    expect(rs[0].raw).toEqual({ styles: 'garbage' }); // WHOLE sheet slot preserved
  });
});

// Merge-path coercer — the second read boundary must classify identically to the load path.
describe('coerceSketchNode (merge boundary — base/spreads coverage)', () => {
  const collectNode = (path: string[], value: unknown) => {
    const anomalies: SketchAnomaly[] = [];
    const coerced = coerceSketchNode(path, value, (a) => anomalies.push(a));
    return { coerced, anomalies };
  };

  it('passes null/undefined through (remove semantics)', () => {
    expect(coerceSketchNode(['base'], null)).toBeNull();
    expect(coerceSketchNode(['spreads'], undefined)).toBeUndefined();
  });

  it('a valid base sheet node merges byte-identical (parity — no false positives)', () => {
    const sheet = { styles: [style('w')] };
    const { coerced, anomalies } = collectNode(['base', 'character_sheet'], sheet);
    expect(coerced).toEqual(sheet);
    expect(anomalies).toEqual([]);
  });

  it('a malformed base sheet node yields a placeholder + reset (no longer pass-through)', () => {
    const { coerced, anomalies } = collectNode(['base', 'character_sheet'], { styles: 'garbage' });
    expect(coerced).toEqual({ styles: [] });
    expect(resets(anomalies)).toHaveLength(1);
    expect(resets(anomalies)[0].resource).toBe('base.character_sheet');
  });

  it('a whole malformed base node degrades base coarsely (one `base` reset)', () => {
    const { coerced, anomalies } = collectNode(['base'], 'garbage');
    expect(coerced).toEqual({});
    expect(resets(anomalies).map((a) => a.resource)).toEqual(['base']);
  });

  it('the alter sheet node coerces at path grain like the other two (rtype 11)', () => {
    const { coerced, anomalies } = collectNode(['base', 'alter_character_sheet'], 'garbage');
    expect(coerced).toEqual({ styles: [] });
    expect(resets(anomalies)[0].resource).toBe('base.alter_character_sheet');
  });

  it('a valid spread node merges structurally intact (parity)', () => {
    const spread = { id: 's1', images: [{ id: 'i1', type: 'full', illustrations: [] }], pages: [{ type: 'full' }], textboxes: [] };
    const { coerced, anomalies } = collectNode(['spreads', '0'], spread);
    expect(coerced).toEqual(spread);
    expect(anomalies).toEqual([]);
  });

  it('a garbage spreads collection becomes a placeholder [] + coarse reset', () => {
    const { coerced, anomalies } = collectNode(['spreads'], 'garbage');
    expect(coerced).toEqual([]);
    expect(resets(anomalies)).toHaveLength(1);
    expect(resets(anomalies)[0].resource).toBe('spreads');
  });

  it('an entity node with garbage variants reports a reset on that entity', () => {
    const { anomalies } = collectNode(['characters', '0'], { key: 'kid', variants: 'nope' });
    expect(resets(anomalies)).toHaveLength(1);
    expect(resets(anomalies)[0].resource).toBe('characters/kid');
  });

  it('deep child paths pass through untouched (leaf payloads)', () => {
    const payload = { whatever: true };
    expect(coerceSketchNode(['spreads', '0', 'images', '1'], payload)).toBe(payload);
  });
});

// T6 — regression net on REAL local-DB blobs (sanitized: shape preserved, content replaced).
// The original incident was a discriminator wiping HEALTHY rows — these 8 must stay clean.
describe('real-blob regression fixtures (T6 — zero reset anomalies)', () => {
  const fixtures = realSketchBlobs as Array<{ book: string; sketch: unknown }>;

  it('loads all 8 sanitized blobs', () => {
    expect(fixtures).toHaveLength(8);
  });

  it.each(fixtures.map((f) => [f.book, f.sketch] as const))(
    'book %s raises NO consent modal (no reset anomalies)',
    (_book, sketch) => {
      const { anomalies } = collect(sketch);
      expect(resets(anomalies)).toEqual([]);
    },
  );
});

// ── actor_role carry-through (⚡ 2026-07-28 alter characters) ─────────────────────────────────
// The flag lives on `characters[]` entities and is the ONLY thing separating the alter cast from
// the story cast. `coerceEntity` used to drop every unknown field, so without this carry-through
// each load/peer-merge would silently promote every alter into the story.
describe('normalizeSketch actor_role (alter characters)', () => {
  it('preserves actor_role=1 through the load boundary', () => {
    const { sketch, anomalies } = collect({
      characters: [
        { key: 'hero', variants: [] },
        { key: 'hero_alt', actor_role: 1, variants: [] },
      ],
    });
    expect(sketch.characters).toEqual([
      { key: 'hero', variants: [] },
      { key: 'hero_alt', actor_role: 1, variants: [] },
    ]);
    expect(anomalies).toEqual([]);
  });

  it('never invents actor_role: 0 (absent ⇒ 0 — no JSONB churn on pre-alter books)', () => {
    const { sketch } = collect({ characters: [{ key: 'hero', variants: [] }] });
    expect('actor_role' in sketch.characters[0]).toBe(false);
  });

  it('keeps an explicit 0 but coerces an unreadable value to 0 (primary)', () => {
    const { sketch } = collect({
      characters: [
        { key: 'a', actor_role: 0, variants: [] },
        { key: 'b', actor_role: 'nope', variants: [] },
        { key: 'c', actor_role: '1', variants: [] },
      ],
    });
    expect(sketch.characters.map((e) => e.actor_role)).toEqual([0, 0, 1]);
  });

  it('survives the merge boundary too (peer sync of one entity node)', () => {
    const node = coerceSketchNode(['characters', '1'], { key: 'hero_alt', actor_role: 1, variants: [] });
    expect(node).toEqual({ key: 'hero_alt', actor_role: 1, variants: [] });
  });
});
