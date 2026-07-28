// sketch-slice.test.ts — slice STATE + CRUD actions only. The normalizer suites (data-safety,
// isolation, taxonomy) moved to sketch-normalize.test.ts with the 2026-07-17 modularization
// (ADR-047) — this file tests what remains in sketch-slice.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSketchSlice } from './sketch-slice';
import { getSketchSpreadEffectiveUrl } from '@/types/sketch';
import type { SketchEntity, SketchVariant, SketchVariantCrop, SketchSpread, ArtDirection, SketchTextbox } from '@/types/sketch';
import type { Geometry, Typography } from '@/types/spread-types';

// Isolated harness: the sketch slice + the only cross-slice field its actions touch
// (sync.isDirty). Avoids pulling the full store (and supabase client) into a unit test.
/* eslint-disable @typescript-eslint/no-explicit-any */
function createTestStore() {
  return create<any>()(
    immer((...a: any[]) => ({
      ...(createSketchSlice as any)(...a),
      sync: { isDirty: false },
    }))
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// New-shape variant: 3 required text fields (height/imagery optional). `visual_design` carries
// the description text in the thin single-column import (2026-07-13 restructure).
const variant = (key: string, visualDesign = ''): SketchVariant => ({
  key,
  description: '',
  visual_design: visualDesign,
  art_language: '',
});

const entity = (key: string, variants: SketchEntity['variants'] = []): SketchEntity => ({
  key,
  variants,
});

describe('getSketchSpreadEffectiveUrl', () => {
  const withIllustrations = (
    ill: { media_url: string; created_time: string; is_selected: boolean }[],
  ): SketchSpread => ({ id: 's', images: ill.length ? [{ id: 'i', type: 'full', illustrations: ill }] : [], pages: [], textboxes: [] });

  it('returns the selected version url', () => {
    const s = withIllustrations([
      { media_url: 'new', created_time: 't', is_selected: false },
      { media_url: 'sel', created_time: 't', is_selected: true },
    ]);
    expect(getSketchSpreadEffectiveUrl(s)).toBe('sel');
  });

  it('falls back to the newest (index 0) when none selected', () => {
    const s = withIllustrations([{ media_url: 'first', created_time: 't', is_selected: false }]);
    expect(getSketchSpreadEffectiveUrl(s)).toBe('first');
  });

  it('returns null when the spread has no image', () => {
    expect(getSketchSpreadEffectiveUrl(withIllustrations([]))).toBeNull();
  });
});

// ADR-047 degraded/quarantine bookkeeping — the state phase-04's save-block reads.
describe('SketchSlice degraded bookkeeping (ADR-047)', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  const entry = (resource: string, sig = 's1', raw: unknown = { broken: true }) => ({
    resource: resource as never,
    path: resource,
    message: 'hỏng',
    sig,
    raw,
  });

  it('markSketchDegraded appends entries + quarantines raw, deduped by resource+sig', () => {
    store.getState().markSketchDegraded([entry('base.character_sheet')]);
    store.getState().markSketchDegraded([entry('base.character_sheet')]); // duplicate → no-op
    store.getState().markSketchDegraded([entry('characters/hero', 's2', 'raw-blob')]);
    const s = store.getState();
    expect(s.sketchDegraded).toHaveLength(2);
    expect(s.sketchQuarantine['base.character_sheet']).toEqual({ broken: true });
    expect(s.sketchQuarantine['characters/hero']).toBe('raw-blob');
    // Degraded entries never carry the raw blob (it lives ONLY in quarantine).
    expect(s.sketchDegraded[0]).not.toHaveProperty('raw');
  });

  it('same resource with a NEW sig is a new entry (blob changed → decision must be re-asked)', () => {
    store.getState().markSketchDegraded([entry('spreads', 'sig-a')]);
    store.getState().markSketchDegraded([entry('spreads', 'sig-b')]);
    expect(store.getState().sketchDegraded).toHaveLength(2);
  });

  it('markSketchDegraded does NOT dirty the snapshot (no accidental autosave trigger)', () => {
    store.getState().markSketchDegraded([entry('props')]);
    expect(store.getState().sync.isDirty).toBe(false);
  });

  it('resolveSketchDegraded removes only the consented resources + their quarantine', () => {
    store.getState().markSketchDegraded([entry('base.character_sheet'), entry('props', 's3')]);
    store.getState().resolveSketchDegraded(['base.character_sheet']);
    const s = store.getState();
    expect(s.sketchDegraded.map((d: { resource: string }) => d.resource)).toEqual(['props']);
    expect(s.sketchQuarantine).not.toHaveProperty('base.character_sheet');
    expect(s.sketchQuarantine).toHaveProperty('props');
    // D4: consent does NOT write — the reset persists at the next NORMAL save only.
    expect(s.sync.isDirty).toBe(false);
  });
});

describe('SketchSlice entity actions', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  it('setSketchEntities replaces the kind array + sets isDirty', () => {
    store.getState().setSketchEntities('characters', [entity('kid'), entity('mom')]);
    expect(store.getState().sketch.characters.map((e: SketchEntity) => e.key)).toEqual(['kid', 'mom']);
    expect(store.getState().sketch.props).toEqual([]);
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('upsertSketchEntity adds when key is new', () => {
    store.getState().upsertSketchEntity('props', entity('wand'));
    expect(store.getState().sketch.props).toHaveLength(1);
    expect(store.getState().sketch.props[0].key).toBe('wand');
  });

  it('upsertSketchEntity replaces in place when key exists', () => {
    store.getState().setSketchEntities('props', [entity('wand'), entity('shield')]);
    store.getState().upsertSketchEntity('props', entity('wand', [variant('base', 'new')]));
    expect(store.getState().sketch.props).toHaveLength(2);
    expect(store.getState().sketch.props[0].variants).toEqual([variant('base', 'new')]);
  });

  it('removeSketchEntity filters out the key', () => {
    // 'props' (a real BaseKind) — `stages` never was one: it has its own slice + shape, and since
    // the 2026-07-28 widening a kind is resolved through KIND_ENTITY_SOURCE, not `sketch[kind]`.
    store.getState().setSketchEntities('props', [entity('forest'), entity('castle')]);
    store.getState().removeSketchEntity('props', 'forest');
    expect(store.getState().sketch.props.map((e: SketchEntity) => e.key)).toEqual(['castle']);
  });

  it('upsertSketchVariant adds then updates a variant in place', () => {
    store.getState().setSketchEntities('characters', [entity('kid')]);
    store.getState().upsertSketchVariant('characters', 'kid', variant('hero', 'caped'));
    expect(store.getState().sketch.characters[0].variants).toEqual([variant('hero', 'caped')]);
    store.getState().upsertSketchVariant('characters', 'kid', variant('hero', 'masked'));
    expect(store.getState().sketch.characters[0].variants).toEqual([variant('hero', 'masked')]);
  });

  it('upsertSketchVariant is a no-op when the entity is missing', () => {
    store.getState().setSketchEntities('characters', []);
    store.getState().upsertSketchVariant('characters', 'ghost', variant('base', 'x'));
    expect(store.getState().sketch.characters).toEqual([]);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resetDirty = () => store.setState((s: any) => { s.sync.isDirty = false; });

  it('every successful entity mutation sets sync.isDirty', () => {
    store.getState().upsertSketchEntity('characters', entity('kid'));
    expect(store.getState().sync.isDirty).toBe(true);

    resetDirty();
    store.getState().upsertSketchVariant('characters', 'kid', variant('base', 'x'));
    expect(store.getState().sync.isDirty).toBe(true);

    resetDirty();
    store.getState().removeSketchEntity('characters', 'kid');
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('find-guarded no-ops leave sync.isDirty false', () => {
    store.getState().setSketchEntities('characters', []); // sets dirty
    resetDirty();
    store.getState().upsertSketchVariant('characters', 'ghost', variant('base', 'x')); // no match
    expect(store.getState().sync.isDirty).toBe(false);
  });
});

describe('SketchSlice spread actions', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  const geo: Geometry = { x: 0, y: 0, w: 100, h: 100 };
  const typo: Typography = { size: 16 };
  const emptyAd = (): ArtDirection => ({
    stage: '', setting: '', composition: '', action: '', camera: '',
    light_tone: '', art_language: '',
  });
  const spread = (id: string, pageTypes: SketchSpread['pages'][number]['type'][] = ['left', 'right']): SketchSpread => ({
    id,
    images: [],
    pages: pageTypes.map((type) => ({ type, art_direction: emptyAd() })),
    textboxes: [],
  });
  const seed = (...spreads: SketchSpread[]) => store.getState().setSketchSpreads(spreads);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resetDirty = () => store.setState((s: any) => { s.sync.isDirty = false; });
  const ids = () => store.getState().sketch.spreads.map((s: SketchSpread) => s.id);

  it('setSketchSpreads replaces the array + sets isDirty', () => {
    seed(spread('a'), spread('b'));
    expect(ids()).toEqual(['a', 'b']);
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('addSketchSpread pushes to the end', () => {
    seed(spread('a'));
    store.getState().addSketchSpread(spread('b'));
    expect(ids()).toEqual(['a', 'b']);
  });

  it('deleteSketchSpread filters out the id', () => {
    seed(spread('a'), spread('b'), spread('c'));
    store.getState().deleteSketchSpread('b');
    expect(ids()).toEqual(['a', 'c']);
  });

  it('reorderSketchSpreads moves from→to (down and up)', () => {
    seed(spread('a'), spread('b'), spread('c'), spread('d'));
    store.getState().reorderSketchSpreads(0, 2); // a down
    expect(ids()).toEqual(['b', 'c', 'a', 'd']);
    store.getState().reorderSketchSpreads(3, 0); // d up
    expect(ids()).toEqual(['d', 'b', 'c', 'a']);
  });

  it('reorderSketchSpreads clamps out-of-range indices', () => {
    seed(spread('a'), spread('b'), spread('c'));
    store.getState().reorderSketchSpreads(0, 99); // clamp to last
    expect(ids()).toEqual(['b', 'c', 'a']);
  });

  it('reorderSketchSpreads is a no-op when from==to (isDirty stays false)', () => {
    seed(spread('a'), spread('b'));
    resetDirty();
    store.getState().reorderSketchSpreads(1, 1);
    expect(ids()).toEqual(['a', 'b']);
    expect(store.getState().sync.isDirty).toBe(false);
  });

  it('addSketchSpreadImageVersion prepends + auto-selects on the matched spread + page only', () => {
    seed(spread('a'), spread('b'));
    store.getState().addSketchSpreadImageVersion('a', 'left', 'https://x/s1.png');
    const imgs = store.getState().sketch.spreads[0].images;
    expect(imgs).toHaveLength(1);
    expect(imgs[0].type).toBe('left');
    expect(imgs[0].illustrations[0]).toMatchObject({ media_url: 'https://x/s1.png', is_selected: true });
    // Second generate on the SAME page: new version prepended + selected, previous deselected.
    store.getState().addSketchSpreadImageVersion('a', 'left', 'https://x/s2.png');
    const ill = store.getState().sketch.spreads[0].images[0].illustrations;
    expect(ill.map((i: { media_url: string }) => i.media_url)).toEqual(['https://x/s2.png', 'https://x/s1.png']);
    expect(ill[0].is_selected).toBe(true);
    expect(ill[1].is_selected).toBe(false);
    // Sibling spread untouched.
    expect(store.getState().sketch.spreads[1].images).toEqual([]);
  });

  it('selectSketchSpreadImageVersion flips is_selected to an existing version without prepending', () => {
    seed(spread('a'));
    store.getState().addSketchSpreadImageVersion('a', 'left', 'https://x/v1.png');
    store.getState().addSketchSpreadImageVersion('a', 'left', 'https://x/v2.png'); // v2 is head/selected
    resetDirty();
    store.getState().selectSketchSpreadImageVersion('a', 'left', 'https://x/v1.png');
    const ill = store.getState().sketch.spreads[0].images[0].illustrations;
    // Order unchanged (no prepend); selection moved to v1.
    expect(ill.map((i: { media_url: string }) => i.media_url)).toEqual(['https://x/v2.png', 'https://x/v1.png']);
    expect(ill.find((i: { media_url: string }) => i.media_url === 'https://x/v1.png').is_selected).toBe(true);
    expect(ill.find((i: { media_url: string }) => i.media_url === 'https://x/v2.png').is_selected).toBe(false);
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('selectSketchSpreadImageVersion no-ops (isDirty stays false) on unknown url or already-selected', () => {
    seed(spread('a'));
    store.getState().addSketchSpreadImageVersion('a', 'left', 'https://x/v1.png');
    resetDirty();
    store.getState().selectSketchSpreadImageVersion('a', 'left', 'https://x/missing.png'); // unknown url
    store.getState().selectSketchSpreadImageVersion('a', 'left', 'https://x/v1.png'); // already selected
    expect(store.getState().sync.isDirty).toBe(false);
    expect(store.getState().sketch.spreads[0].images[0].illustrations[0].is_selected).toBe(true);
  });

  it('addSketchSpreadImageVersion creates a separate image slot per page type', () => {
    seed(spread('a', ['left', 'right']));
    store.getState().addSketchSpreadImageVersion('a', 'left', 'https://x/left.png');
    store.getState().addSketchSpreadImageVersion('a', 'right', 'https://x/right.png');
    const imgs = store.getState().sketch.spreads[0].images;
    expect(imgs).toHaveLength(2);
    expect(imgs.map((im: { type: string }) => im.type).sort()).toEqual(['left', 'right']);
    const left = imgs.find((im: { type: string }) => im.type === 'left');
    const right = imgs.find((im: { type: string }) => im.type === 'right');
    expect(left.illustrations[0].media_url).toBe('https://x/left.png');
    expect(right.illustrations[0].media_url).toBe('https://x/right.png');
  });

  // ⚡ opts (arg 4, options object — replaced the old positional aiRequestId/imageId pair).
  // Full provenance = an Edit-modal commit routed through the sketch adapters.
  it('addSketchSpreadImageVersion writes the full provenance triple from opts', () => {
    seed(spread('a'));
    store.getState().addSketchSpreadImageVersion('a', 'full', 'https://x/edited.png', {
      aiRequestId: 'req-9',
      imageId: 'img-preminted',
      type: 'edited',
      originalUrl: 'https://x/gen.png',
    });
    const img = store.getState().sketch.spreads[0].images[0];
    // `imageId` is honoured for the freshly-created page-image node (BE-first double-write).
    expect(img.id).toBe('img-preminted');
    expect(img.illustrations[0]).toMatchObject({
      media_url: 'https://x/edited.png',
      is_selected: true,
      ai_request_id: 'req-9',
      type: 'edited',
      original_url: 'https://x/gen.png',
    });
  });

  // omit-if-absent: no `opts` ⇒ the 3 provenance keys must be ABSENT, not `undefined` (an
  // `undefined` key would serialize into the snapshot JSONB as an explicit null field).
  it('addSketchSpreadImageVersion omits provenance keys entirely when opts is absent', () => {
    seed(spread('a'));
    store.getState().addSketchSpreadImageVersion('a', 'full', 'https://x/plain.png');
    const entry = store.getState().sketch.spreads[0].images[0].illustrations[0];
    expect('ai_request_id' in entry).toBe(false);
    expect('type' in entry).toBe(false);
    expect('original_url' in entry).toBe(false);
    // Legacy 3-field shape preserved verbatim. NOTE (by design): this exhaustive key assertion —
    // and the partial-opts case below — MUST be updated in the same commit as the deferred
    // "generate writes type:'created'" follow-up. A break there is expected, not a regression.
    expect(Object.keys(entry).sort()).toEqual(['created_time', 'is_selected', 'media_url']);
  });

  // Partial opts (raw generate output: aiRequestId + imageId, deliberately NO `type`).
  it('addSketchSpreadImageVersion writes only the provenance fields present in opts', () => {
    seed(spread('a'));
    store.getState().addSketchSpreadImageVersion('a', 'left', 'https://x/gen.png', {
      aiRequestId: 'req-1',
      imageId: 'img-1',
    });
    const entry = store.getState().sketch.spreads[0].images[0].illustrations[0];
    expect(entry.ai_request_id).toBe('req-1');
    expect('type' in entry).toBe(false);
    expect('original_url' in entry).toBe(false);
  });

  it('updateSketchPageArtDirection merges patch into the page matched by type', () => {
    seed(spread('a', ['left', 'right']));
    store.getState().updateSketchPageArtDirection('a', 'right', { stage: 'forest', camera: 'wide' });
    const pages = store.getState().sketch.spreads[0].pages;
    expect(pages.find((p: SketchSpread['pages'][number]) => p.type === 'right')!.art_direction.stage).toBe('forest');
    expect(pages.find((p: SketchSpread['pages'][number]) => p.type === 'right')!.art_direction.camera).toBe('wide');
    // left page untouched
    expect(pages.find((p: SketchSpread['pages'][number]) => p.type === 'left')!.art_direction.stage).toBe('');
  });

  it('updateSketchPageArtDirection no-ops on a missing page type (isDirty stays false)', () => {
    seed(spread('a', ['full']));
    resetDirty();
    store.getState().updateSketchPageArtDirection('a', 'left', { stage: 'x' });
    expect(store.getState().sync.isDirty).toBe(false);
  });

  it('updateSketchTextbox merges into the language entry, skipping the id slot', () => {
    const tb: SketchTextbox = { id: 't1', en: { text: 'hi', geometry: geo, typography: typo } };
    seed({ id: 'a', images: [], pages: [], textboxes: [tb] });
    store.getState().updateSketchTextbox('a', 't1', 'en', { text: 'hello' });
    const entry = store.getState().sketch.spreads[0].textboxes[0].en;
    expect(entry.text).toBe('hello');
    expect(entry.geometry).toEqual(geo); // untouched
    expect(store.getState().sketch.spreads[0].textboxes[0].id).toBe('t1');
  });

  it('updateSketchTextbox creates the language entry when absent (canvas create-on-first-edit)', () => {
    const tb: SketchTextbox = { id: 't1', en: { text: 'hi', geometry: geo, typography: typo } };
    seed({ id: 'a', images: [], pages: [], textboxes: [tb] });
    resetDirty();
    // Canvas emits a full content object for the newly-requested language.
    store.getState().updateSketchTextbox('a', 't1', 'vi', { text: 'xin chào', geometry: geo, typography: typo });
    const created = store.getState().sketch.spreads[0].textboxes[0].vi;
    expect(created.text).toBe('xin chào');
    expect(store.getState().sketch.spreads[0].textboxes[0].en.text).toBe('hi'); // other lang untouched
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('updateSketchTextbox never overwrites the id slot', () => {
    const tb: SketchTextbox = { id: 't1', en: { text: 'hi', geometry: geo, typography: typo } };
    seed({ id: 'a', images: [], pages: [], textboxes: [tb] });
    resetDirty();
    store.getState().updateSketchTextbox('a', 't1', 'id', { text: 'nope' });
    expect(store.getState().sketch.spreads[0].textboxes[0].id).toBe('t1');
    expect(store.getState().sync.isDirty).toBe(false);
  });

  it('deleteSketchTextbox removes the textbox by id', () => {
    const tb = (id: string): SketchTextbox => ({ id, en: { text: id, geometry: geo, typography: typo } });
    seed({ id: 'a', images: [], pages: [], textboxes: [tb('t1'), tb('t2')] });
    store.getState().deleteSketchTextbox('a', 't1');
    expect(store.getState().sketch.spreads[0].textboxes.map((t: SketchTextbox) => t.id)).toEqual(['t2']);
  });

  it('mutations set isDirty; missing-target actions do not', () => {
    seed(spread('a'));
    resetDirty();
    store.getState().addSketchSpreadImageVersion('missing', 'full', 'u');
    store.getState().deleteSketchTextbox('missing', 't');
    store.getState().updateSketchTextbox('missing', 't', 'en', { text: 'x' });
    expect(store.getState().sync.isDirty).toBe(false);
  });
});

describe('SketchSlice base (workspace) actions', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const resetDirty = () => store.setState((s: any) => { s.sync.isDirty = false; });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('addSketchBaseStyle appends style to sheet + sets isDirty', () => {
    const style = {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [],
    };
    store.getState().addSketchBaseStyle('characters', style);
    expect(store.getState().sketch.base.character_sheet.styles).toHaveLength(1);
    expect(store.getState().sketch.base.character_sheet.styles[0]).toEqual(style);
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('removeSketchBaseStyle filters out by index + sets isDirty', () => {
    const s1 = { style_prompt: 'style 1', is_selected: false, image_references: [], illustrations: [], crops: [] };
    const s2 = { style_prompt: 'style 2', is_selected: false, image_references: [], illustrations: [], crops: [] };
    store.getState().addSketchBaseStyle('characters', s1);
    store.getState().addSketchBaseStyle('characters', s2);
    store.getState().removeSketchBaseStyle('characters', 0);
    expect(store.getState().sketch.base.character_sheet.styles).toHaveLength(1);
    expect(store.getState().sketch.base.character_sheet.styles[0].style_prompt).toBe('style 2');
  });

  it('removeSketchBaseStyle no-ops on out-of-range index (isDirty stays false)', () => {
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [],
    });
    resetDirty();
    store.getState().removeSketchBaseStyle('characters', 99);
    expect(store.getState().sketch.base.character_sheet.styles).toHaveLength(1);
    expect(store.getState().sync.isDirty).toBe(false);
  });

  it('addSketchBaseStyleIllustration prepends + sets is_selected true + clears others', () => {
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [
        { type: 'created' as const, media_url: 'old.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
      ],
      crops: [],
    });

    store.getState().addSketchBaseStyleIllustration('characters', 0, 'new.png');

    const illustrations = store.getState().sketch.base.character_sheet.styles[0].illustrations;
    expect(illustrations).toHaveLength(2);
    expect(illustrations[0].media_url).toBe('new.png');
    expect(illustrations[0].is_selected).toBe(true);
    expect(illustrations[1].media_url).toBe('old.png');
    expect(illustrations[1].is_selected).toBe(false);
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('setSketchBaseStyleIllustrations replaces the array', () => {
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [
        { type: 'created' as const, media_url: 'old.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
      ],
      crops: [],
    });

    const newIlls = [
      { type: 'created' as const, media_url: 'new1.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
      { type: 'created' as const, media_url: 'new2.png', created_time: '2026-07-13T00:00:00Z', is_selected: false },
    ];
    store.getState().setSketchBaseStyleIllustrations('characters', 0, newIlls);

    const illustrations = store.getState().sketch.base.character_sheet.styles[0].illustrations;
    expect(illustrations).toHaveLength(2);
    expect(illustrations[0].media_url).toBe('new1.png');
    expect(illustrations[1].media_url).toBe('new2.png');
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('setSketchBaseStyleCrops replaces crops array', () => {
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [
        {
          key: 'hero',
          illustrations: [
            { type: 'created' as const, media_url: 'old-crop.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
          ],
        },
      ],
    });

    const newCrops = [
      {
        key: 'hero',
        illustrations: [
          { type: 'created' as const, media_url: 'new-crop.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
        ],
      },
      {
        key: 'villain',
        illustrations: [
          { type: 'created' as const, media_url: 'villain-crop.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
        ],
      },
    ];
    store.getState().setSketchBaseStyleCrops('characters', 0, newCrops);

    const crops = store.getState().sketch.base.character_sheet.styles[0].crops;
    expect(crops).toHaveLength(2);
    expect(crops[0].key).toBe('hero');
    expect(crops[0].illustrations[0].media_url).toBe('new-crop.png');
    expect(crops[1].key).toBe('villain');
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('setSketchBaseCropIllustrations replaces one crop\'s illustrations', () => {
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [
        {
          key: 'hero',
          illustrations: [
            { type: 'created' as const, media_url: 'old.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
          ],
        },
        {
          key: 'villain',
          illustrations: [
            { type: 'created' as const, media_url: 'villain.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
          ],
        },
      ],
    });

    const newIlls = [
      { type: 'created' as const, media_url: 'new-hero.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
    ];
    store.getState().setSketchBaseCropIllustrations('characters', 0, 'hero', newIlls);

    const crops = store.getState().sketch.base.character_sheet.styles[0].crops;
    expect(crops[0].illustrations[0].media_url).toBe('new-hero.png');
    // Villain untouched
    expect(crops[1].illustrations[0].media_url).toBe('villain.png');
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('setSketchBaseStyleSelected sets is_selected exclusive per sheet + clones crops into entity variants[base].raw_sheet.crops[0]', () => {
    // Setup entities
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [variant('base')] },
      { key: 'villain', variants: [variant('base')] },
    ]);

    // Setup styles with crops
    const heroIll = { type: 'created' as const, media_url: 'hero-crop.png', created_time: '2026-07-13T00:00:00Z', is_selected: true };
    const villainIll = { type: 'created' as const, media_url: 'villain-crop.png', created_time: '2026-07-13T00:00:00Z', is_selected: true };

    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'style 1',
      is_selected: true,
      image_references: [],
      illustrations: [],
      crops: [
        { key: 'hero', illustrations: [heroIll] },
        { key: 'villain', illustrations: [villainIll] },
      ],
    });
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'style 2',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [
        { key: 'hero', illustrations: [{ type: 'created' as const, media_url: 'hero-crop-2.png', created_time: '2026-07-13T00:00:00Z', is_selected: true }] },
      ],
    });

    // Select style 1 → crops cloned into entities
    store.getState().setSketchBaseStyleSelected('characters', 1); // st2

    // Assert exclusive is_selected
    expect(store.getState().sketch.base.character_sheet.styles[0].is_selected).toBe(false);
    expect(store.getState().sketch.base.character_sheet.styles[1].is_selected).toBe(true);

    // Assert crops cloned into variants[base].raw_sheet.crops[0] (base invariant: 1 crop,
    // is_selected=true, raw_sheet.illustrations empty).
    const heroBase = store.getState().sketch.characters[0].variants.find((v: SketchVariant) => v.key === 'base');
    const villainBase = store.getState().sketch.characters[1].variants.find((v: SketchVariant) => v.key === 'base');
    expect(heroBase?.raw_sheet?.illustrations).toEqual([]);
    expect(heroBase?.raw_sheet?.crops).toHaveLength(1);
    expect(heroBase?.raw_sheet?.crops[0].is_selected).toBe(true);
    expect(heroBase?.raw_sheet?.crops[0].illustrations[0].media_url).toBe('hero-crop-2.png');
    expect(villainBase?.raw_sheet).toBeUndefined(); // no crop in st2 for villain → untouched
  });

  it('setSketchBaseStyleSelected clones with isolation (clone is separate object, not reference)', () => {
    // Setup entity
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [variant('base')] },
    ]);

    const cropIll = { type: 'created' as const, media_url: 'hero-crop.png', created_time: '2026-07-13T00:00:00Z', is_selected: true };
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [{ key: 'hero', illustrations: [cropIll] }],
    });

    // Select style
    store.getState().setSketchBaseStyleSelected('characters', 0);

    // Get the cloned crop from variant
    const heroBase = store.getState().sketch.characters[0].variants.find((v: SketchVariant) => v.key === 'base');
    const clonedCropIll = heroBase?.raw_sheet?.crops[0].illustrations[0];

    // Get the original crop in the style
    const style = store.getState().sketch.base.character_sheet.styles[0];
    const originalCropIll = style.crops[0].illustrations[0];

    // Assert they are separate objects (deep clone, not reference)
    // Same values but different object identity
    expect(clonedCropIll).not.toBe(originalCropIll);
    expect(clonedCropIll?.media_url).toBe(originalCropIll.media_url);
    expect(clonedCropIll?.type).toBe(originalCropIll.type);
    expect(clonedCropIll?.is_selected).toBe(originalCropIll.is_selected);
  });

  // ── Dual-write (live-follow clone, 2026-07-20): crop writes on the LOCKED style re-clone the
  //    entity's variants[base].raw_sheet so downstream readers never see a stale official image. ──

  const ill = (url: string, selected = true) => ({
    type: 'created' as const,
    media_url: url,
    created_time: '2026-07-20T00:00:00Z',
    is_selected: selected,
  });

  it('setSketchBaseCropIllustrations on the LOCKED style re-clones ONLY that entity\'s base variant', () => {
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [variant('base')] },
      { key: 'villain', variants: [variant('base')] },
    ]);
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's1', is_selected: false, image_references: [], illustrations: [],
      crops: [
        { key: 'hero', illustrations: [ill('hero-old.png')] },
        { key: 'villain', illustrations: [ill('villain-old.png')] },
      ],
    });
    store.getState().setSketchBaseStyleSelected('characters', 0); // lock → clones seeded

    store.getState().setSketchBaseCropIllustrations('characters', 0, 'hero', [ill('hero-edited.png')]);

    const [hero, villain] = store.getState().sketch.characters;
    const heroClone = hero.variants[0].raw_sheet?.crops[0];
    expect(heroClone?.is_selected).toBe(true);
    expect(heroClone?.illustrations[0].media_url).toBe('hero-edited.png');
    // Sibling entity untouched by a single-crop edit.
    expect(villain.variants[0].raw_sheet?.crops[0].illustrations[0].media_url).toBe('villain-old.png');
    // Clone is isolated (deep copy, not a shared reference with the sheet crop).
    const sheetIll = store.getState().sketch.base.character_sheet.styles[0].crops[0].illustrations[0];
    expect(heroClone?.illustrations[0]).not.toBe(sheetIll);
  });

  it('setSketchBaseCropIllustrations on an UNLOCKED style leaves entity base variants untouched', () => {
    store.getState().setSketchEntities('characters', [{ key: 'hero', variants: [variant('base')] }]);
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's1', is_selected: true, image_references: [], illustrations: [],
      crops: [{ key: 'hero', illustrations: [ill('locked-crop.png')] }],
    });
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's2', is_selected: false, image_references: [], illustrations: [],
      crops: [{ key: 'hero', illustrations: [ill('other-crop.png')] }],
    });
    store.getState().setSketchBaseStyleSelected('characters', 0); // lock s1

    store.getState().setSketchBaseCropIllustrations('characters', 1, 'hero', [ill('other-edited.png')]);

    // Clone still tracks the LOCKED style (s1), not the edited unlocked one.
    const clone = store.getState().sketch.characters[0].variants[0].raw_sheet?.crops[0];
    expect(clone?.illustrations[0].media_url).toBe('locked-crop.png');
  });

  it('setSketchBaseStyleCrops on the LOCKED style re-clones ALL entity base variants (re-crop live-follow)', () => {
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [variant('base')] },
      { key: 'villain', variants: [variant('base')] },
    ]);
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's1', is_selected: false, image_references: [], illustrations: [],
      crops: [
        { key: 'hero', illustrations: [ill('hero-old.png')] },
        { key: 'villain', illustrations: [ill('villain-old.png')] },
      ],
    });
    store.getState().setSketchBaseStyleSelected('characters', 0);

    // Raw-edit auto re-crop replaces the whole crops[] → every clone follows.
    store.getState().setSketchBaseStyleCrops('characters', 0, [
      { key: 'hero', illustrations: [ill('hero-recut.png')] },
      { key: 'villain', illustrations: [ill('villain-recut.png')] },
    ]);

    const [hero, villain] = store.getState().sketch.characters;
    expect(hero.variants[0].raw_sheet?.crops[0].illustrations[0].media_url).toBe('hero-recut.png');
    expect(villain.variants[0].raw_sheet?.crops[0].illustrations[0].media_url).toBe('villain-recut.png');
  });

  it('setSketchBaseStyleCrops on an UNLOCKED style does not touch entity base variants', () => {
    store.getState().setSketchEntities('characters', [{ key: 'hero', variants: [variant('base')] }]);
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's1', is_selected: false, image_references: [], illustrations: [],
      crops: [{ key: 'hero', illustrations: [ill('hero-old.png')] }],
    });

    store.getState().setSketchBaseStyleCrops('characters', 0, [
      { key: 'hero', illustrations: [ill('hero-new.png')] },
    ]);

    expect(store.getState().sketch.characters[0].variants[0].raw_sheet).toBeUndefined();
  });

  it('updateSketchBaseEntityText updates only provided fields, leaves others untouched', () => {
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [{ key: 'base', description: 'old desc', height: 110, visual_design: 'old design', art_language: 'old lang' }] },
    ]);
    resetDirty();

    store.getState().updateSketchBaseEntityText('characters', 'hero', {
      visual_design: 'new design',
      art_language: 'new lang',
    });

    const base = store.getState().sketch.characters[0].variants[0];
    expect(base.visual_design).toBe('new design');
    expect(base.art_language).toBe('new lang');
    expect(base.description).toBe('old desc'); // not in the patch → untouched
    expect(base.height).toBe(110); // not in the patch → untouched
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('updateSketchBaseEntityText persists description + height when provided (merged Edit modal)', () => {
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [{ key: 'base', description: 'original', height: 100, visual_design: '', art_language: '' }] },
    ]);
    resetDirty();

    store.getState().updateSketchBaseEntityText('characters', 'hero', {
      description: 'edited desc',
      height: 105,
      visual_design: 'new',
    });

    const base = store.getState().sketch.characters[0].variants[0];
    expect(base.description).toBe('edited desc');
    expect(base.height).toBe(105);
    expect(base.visual_design).toBe('new');
  });

  it('updateSketchBaseEntityText clears height when passed null (null = xoá, undefined = giữ)', () => {
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [{ key: 'base', description: '', height: 110, visual_design: '', art_language: '' }] },
    ]);
    resetDirty();

    store.getState().updateSketchBaseEntityText('characters', 'hero', { height: null });

    expect(store.getState().sketch.characters[0].variants[0].height).toBeNull();
  });

  it('setSketchBaseStyleImageReferences replaces image_references on the target style', () => {
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's', is_selected: false, image_references: [], illustrations: [], crops: [],
    });
    resetDirty();

    store.getState().setSketchBaseStyleImageReferences('characters', 0, [
      { title: 'ref-a.jpg', media_url: 'https://cdn/a.png' },
    ]);

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.image_references).toEqual([{ title: 'ref-a.jpg', media_url: 'https://cdn/a.png' }]);
    expect(store.getState().sync.isDirty).toBe(true);
  });
});

describe('SketchSlice variant crop actions (positional crops[])', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resetDirty = () => store.setState((s: any) => { s.sync.isDirty = false; });

  const ill = (url: string) => ({ type: 'created' as const, media_url: url, created_time: 't', is_selected: true });

  // Seed a char entity: a 'base' variant (no imagery) + 'hero_v' with raw_sheet + 2 positional crops.
  const seedVariantWithCrops = () =>
    store.getState().setSketchEntities('characters', [
      {
        key: 'hero',
        variants: [
          { key: 'base', description: '', visual_design: '', art_language: '' },
          {
            key: 'hero_v', description: '', visual_design: '', art_language: '',
            raw_sheet: {
              illustrations: [],
              crops: [
                { is_selected: false, illustrations: [ill('c0.png')] },
                { is_selected: false, illustrations: [ill('c1.png')] },
              ],
            },
          },
        ],
      },
    ]);

  const heroV = () =>
    store.getState().sketch.characters[0].variants.find((v: SketchVariant) => v.key === 'hero_v');

  it('setSketchVariantCrops replaces raw_sheet.crops[] + sets isDirty', () => {
    seedVariantWithCrops();
    resetDirty();
    store.getState().setSketchVariantCrops('characters', 'hero', 'hero_v', [
      { is_selected: true, illustrations: [ill('n0.png')] },
    ]);
    expect(heroV().raw_sheet.crops).toHaveLength(1);
    expect(heroV().raw_sheet.crops[0].illustrations[0].media_url).toBe('n0.png');
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('setSketchVariantCrops creates raw_sheet (illustrations empty) when absent', () => {
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [{ key: 'hero_v', description: '', visual_design: '', art_language: '' }] },
    ]);
    store.getState().setSketchVariantCrops('characters', 'hero', 'hero_v', [{ is_selected: false, illustrations: [] }]);
    expect(heroV().raw_sheet.illustrations).toEqual([]);
    expect(heroV().raw_sheet.crops).toHaveLength(1);
  });

  it('setSketchVariantCrops no-ops when the variant is missing (isDirty stays false)', () => {
    seedVariantWithCrops();
    resetDirty();
    store.getState().setSketchVariantCrops('characters', 'hero', 'ghost', [{ is_selected: false, illustrations: [] }]);
    expect(store.getState().sync.isDirty).toBe(false);
  });

  it('selectSketchVariantCrop locks exactly one cell (≤1 is_selected), re-select clears the prior', () => {
    seedVariantWithCrops();
    store.getState().selectSketchVariantCrop('characters', 'hero', 'hero_v', 1);
    let crops = heroV().raw_sheet.crops;
    expect(crops.filter((c: SketchVariantCrop) => c.is_selected)).toHaveLength(1);
    expect(crops[1].is_selected).toBe(true);
    expect(crops[0].is_selected).toBe(false);
    // Re-select a different cell → previous flag cleared.
    store.getState().selectSketchVariantCrop('characters', 'hero', 'hero_v', 0);
    crops = heroV().raw_sheet.crops;
    expect(crops.filter((c: SketchVariantCrop) => c.is_selected)).toHaveLength(1);
    expect(crops[0].is_selected).toBe(true);
    expect(crops[1].is_selected).toBe(false);
  });

  it('selectSketchVariantCrop no-ops on out-of-range cropIndex (isDirty stays false)', () => {
    seedVariantWithCrops();
    resetDirty();
    store.getState().selectSketchVariantCrop('characters', 'hero', 'hero_v', 9);
    expect(store.getState().sync.isDirty).toBe(false);
    expect(heroV().raw_sheet.crops.filter((c: SketchVariantCrop) => c.is_selected)).toHaveLength(0);
  });

  it('setSketchVariantCropIllustrations writes only crops[cropIndex].illustrations', () => {
    seedVariantWithCrops();
    store.getState().setSketchVariantCropIllustrations('characters', 'hero', 'hero_v', 1, [ill('edited.png')]);
    const crops = heroV().raw_sheet.crops;
    expect(crops[1].illustrations[0].media_url).toBe('edited.png');
    expect(crops[0].illustrations[0].media_url).toBe('c0.png'); // untouched
    expect(store.getState().sync.isDirty).toBe(true);
  });

  it('setSketchVariantCropIllustrations no-ops on missing cropIndex (isDirty stays false)', () => {
    seedVariantWithCrops();
    resetDirty();
    store.getState().setSketchVariantCropIllustrations('characters', 'hero', 'hero_v', 9, [ill('x.png')]);
    expect(store.getState().sync.isDirty).toBe(false);
  });

  it('setSketchVariantRawSheetIllustrations preserves existing crops[] (does not wipe)', () => {
    seedVariantWithCrops();
    store.getState().setSketchVariantRawSheetIllustrations('characters', 'hero', 'hero_v', [ill('sheet.png')]);
    const rs = heroV().raw_sheet;
    expect(rs.illustrations[0].media_url).toBe('sheet.png');
    expect(rs.crops).toHaveLength(2); // preserved
    expect(rs.crops[0].illustrations[0].media_url).toBe('c0.png');
  });

  it('setSketchVariantRawSheetIllustrations on a variant with no raw_sheet yields empty crops[]', () => {
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [{ key: 'hero_v', description: '', visual_design: '', art_language: '' }] },
    ]);
    store.getState().setSketchVariantRawSheetIllustrations('characters', 'hero', 'hero_v', [ill('s.png')]);
    expect(heroV().raw_sheet.crops).toEqual([]);
  });
});

// ── Alter characters (⚡ 2026-07-28) ──────────────────────────────────────────────────────────
// `alter_characters` is a VIRTUAL kind over `sketch.characters[]` (actor_role === 1). The whole
// feature's failure mode is SILENT: a missing filter mixes the two casts with no error anywhere,
// so every kind↔cast pairing below is asserted explicitly.
describe('SketchSlice alter characters (actor_role routing)', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  const cropIll = (url: string) => ({
    type: 'created' as const,
    media_url: url,
    created_time: '2026-07-28T00:00:00Z',
    is_selected: true,
  });

  /** hero (primary) + hero_alt (alter) in ONE characters[] array, both with a 'base' variant. */
  const seedMixedCast = () => {
    store.setState((s: { sketch: { characters: SketchEntity[] } }) => {
      s.sketch.characters = [
        { key: 'hero', variants: [variant('base')] },
        { key: 'hero_alt', actor_role: 1, variants: [variant('base')] },
      ];
    });
  };

  const baseCropUrlOf = (entityKey: string) =>
    store
      .getState()
      .sketch.characters.find((e: SketchEntity) => e.key === entityKey)
      ?.variants.find((v: SketchVariant) => v.key === 'base')?.raw_sheet?.crops[0]
      ?.illustrations[0]?.media_url;

  it('locking the ALTER sheet clones into actor_role=1 entities only', () => {
    seedMixedCast();
    store.getState().addSketchBaseStyle('alter_characters', {
      style_prompt: 'alter style',
      is_selected: false,
      image_references: [],
      illustrations: [],
      // A crop keyed 'hero' is present too — it must be IGNORED (hero is not part of this kind).
      crops: [
        { key: 'hero_alt', illustrations: [cropIll('alt-crop.png')] },
        { key: 'hero', illustrations: [cropIll('WRONG-hero.png')] },
      ],
    });
    store.getState().setSketchBaseStyleSelected('alter_characters', 0);

    expect(baseCropUrlOf('hero_alt')).toBe('alt-crop.png');
    expect(baseCropUrlOf('hero')).toBeUndefined(); // primary untouched
    // The style landed on the ALTER sheet, not the character sheet.
    expect(store.getState().sketch.base.alter_character_sheet.styles[0].is_selected).toBe(true);
    expect(store.getState().sketch.base.character_sheet.styles).toEqual([]);
  });

  it('locking the CHARACTER sheet leaves alter entities untouched', () => {
    seedMixedCast();
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 'story style',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [
        { key: 'hero', illustrations: [cropIll('hero-crop.png')] },
        { key: 'hero_alt', illustrations: [cropIll('WRONG-alt.png')] },
      ],
    });
    store.getState().setSketchBaseStyleSelected('characters', 0);

    expect(baseCropUrlOf('hero')).toBe('hero-crop.png');
    expect(baseCropUrlOf('hero_alt')).toBeUndefined();
  });

  it('setSketchEntities replaces only its own cast (alter write keeps the story cast)', () => {
    seedMixedCast();
    store.getState().setSketchEntities('alter_characters', [entity('villain_alt')]);
    const keys = store.getState().sketch.characters.map((e: SketchEntity) => e.key);
    expect(keys).toContain('hero'); // story cast survived
    expect(keys).toContain('villain_alt');
    expect(keys).not.toContain('hero_alt'); // the alter cast was the one replaced
    // …and the new entity is stamped from the kind (absent flag ⇒ it would rejoin the story cast).
    expect(
      store.getState().sketch.characters.find((e: SketchEntity) => e.key === 'villain_alt')?.actor_role,
    ).toBe(1);
  });

  it('setSketchEntities REFUSES an incoming key already held by the other cast', () => {
    seedMixedCast();
    // `hero_alt` is an alter; writing the story cast with that key would put the SAME key twice
    // in `characters[]`, breaking the gateway `find:key=` anchor, the rtype-3 lock and the
    // lineup entry ref all at once — with no error anywhere.
    store.getState().setSketchEntities('characters', [entity('hero'), entity('hero_alt')]);
    const chars = store.getState().sketch.characters;
    expect(chars.filter((e: SketchEntity) => e.key === 'hero_alt')).toHaveLength(1);
    expect(chars.find((e: SketchEntity) => e.key === 'hero_alt')?.actor_role).toBe(1); // still the alter
    expect(chars.some((e: SketchEntity) => e.key === 'hero')).toBe(true); // rest of the batch landed
    // …and the inverse direction is refused too.
    store.getState().setSketchEntities('alter_characters', [entity('hero')]);
    const after = store.getState().sketch.characters;
    expect(after.filter((e: SketchEntity) => e.key === 'hero')).toHaveLength(1);
    expect(after.find((e: SketchEntity) => e.key === 'hero')?.actor_role).toBeUndefined();
  });

  it('upsert under `characters` drops a stale actor_role; removal is kind-scoped', () => {
    seedMixedCast();
    store.getState().upsertSketchEntity('characters', { key: 'hero2', actor_role: 1, variants: [] });
    expect(
      store.getState().sketch.characters.find((e: SketchEntity) => e.key === 'hero2'),
    ).toEqual({ key: 'hero2', variants: [] }); // absent ⇒ 0, no explicit 0 written

    store.getState().removeSketchEntity('characters', 'hero_alt'); // wrong kind → no-op
    expect(store.getState().sketch.characters.some((e: SketchEntity) => e.key === 'hero_alt')).toBe(true);
    store.getState().removeSketchEntity('alter_characters', 'hero_alt');
    expect(store.getState().sketch.characters.some((e: SketchEntity) => e.key === 'hero_alt')).toBe(false);
  });

  it('upsert REFUSES to move an entity across casts (would strip/flip actor_role silently)', () => {
    seedMixedCast();
    store.getState().upsertSketchEntity('characters', entity('hero_alt', [variant('base', 'hijacked')]));
    const alt = store.getState().sketch.characters.find((e: SketchEntity) => e.key === 'hero_alt');
    expect(alt?.actor_role).toBe(1); // still an alter
    expect(alt?.variants).toEqual([variant('base')]); // untouched
    // …and the inverse direction is refused too.
    store.getState().upsertSketchEntity('alter_characters', entity('hero'));
    expect(
      store.getState().sketch.characters.find((e: SketchEntity) => e.key === 'hero')?.actor_role,
    ).toBeUndefined();
  });

  it('a no-op removal (wrong cast) does NOT mark the store dirty', () => {
    seedMixedCast();
    store.setState((s: { sync: { isDirty: boolean } }) => { s.sync.isDirty = false; });
    store.getState().removeSketchEntity('characters', 'hero_alt');
    expect(store.getState().sync.isDirty).toBe(false);
  });
});
