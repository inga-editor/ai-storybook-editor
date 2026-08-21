import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { toast } from 'sonner';
import { createSketchSlice } from './sketch-slice';
import { createSketchBaseGenerateJobSlice } from './sketch-base-generate-job-slice';
import type { SketchEntity } from '@/types/sketch';
import { callGenerateBaseSheet, type GenerateBaseSheetResult } from '@/apis/sketch-base-api';
import { callCropSheetRow, type CropSheetRowResult } from '@/apis/sketch-variant-api';

// ⚡REV 2026-08-21: ops are keyed by GROUP KEY (`base[group]`). The default character group is
// `character_sheet`, props `prop_sheet`; an "alter" cast is just another character group
// (`alter_character_sheet`) whose entities carry `group: 'alter_character_sheet'` in `characters[]`.
//
// Mock the api-client seams. Base crop reuses the shared positional cutter (api 10) which lives in
// sketch-variant-api → mock BOTH modules (generate on base, crop on variant).
vi.mock('@/apis/sketch-base-api', () => ({
  callGenerateBaseSheet: vi.fn(),
}));
vi.mock('@/apis/sketch-variant-api', () => ({
  callCropSheetRow: vi.fn(),
}));
const mockedGenerateCall = vi.mocked(callGenerateBaseSheet);
const mockedCropCall = vi.mocked(callCropSheetRow);

// Mock the base-sheet gateway flush (ADR-043 rtype 11) so the persist path can be asserted WITHOUT a
// live lock store. The engine seam picks whole-snapshot flush internally in solo.
const mockedSheetFlush = vi.hoisted(() => vi.fn(async () => 'saved'));
vi.mock('./collab-sketch-base-sheet-save-helper', () => ({
  flushSketchBaseSheetUnderLock: mockedSheetFlush,
}));

// Mock the collection save (grain B, rtype 14) — called after a crops replacement on the LOCKED
// style (the store re-clones every group entity's base variant → the WHOLE collection is persisted).
const mockedCollectionSave = vi.hoisted(() => vi.fn(async () => 'saved'));
vi.mock('./collab-sketch-base-entities-save-helper', () => ({
  saveEntityCollection: mockedCollectionSave,
}));

// Mock sonner toast
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

/* eslint-disable @typescript-eslint/no-explicit-any */
function createTestStore(metaId: string | null = 'snap-1') {
  const autoSaveSnapshot = vi.fn(async () => {});
  const store = create<any>()(
    immer((...a: any[]) => ({
      ...(createSketchSlice as any)(...a),
      ...(createSketchBaseGenerateJobSlice as any)(...a),
      sync: { isDirty: false, isSaving: false },
      meta: { id: metaId },
      autoSaveSnapshot,
    })),
  );
  return { store, autoSaveSnapshot };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Drain microtasks
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Success response helper (camelCase matching backend contract). `cellOrder` = reading-order entity
// keys echoed by generate — the slice threads it into the crop step for positional pairing.
const okGenerate = (imageUrl: string, cellOrder: string[] = ['hero']): GenerateBaseSheetResult => ({
  success: true,
  data: {
    imageUrl,
    storagePath: `path/${imageUrl}`,
    cellOrder,
    grid: { cols: cellOrder.length, rows: 1, cellWidth: 256, cellHeight: 256 },
  },
});

// Api-10 crop-sheet-row success helper: crops carry a 1-based `cell` (NOT an entity key), geometry is
// w/h, and skipped/geo/fullbleed live under `meta` (non-fatal degraded signals).
const okCropRow = (
  crops: Array<{ cell: number; imageUrl: string }>,
  meta?: CropSheetRowResult['meta'],
): CropSheetRowResult => ({
  success: true,
  data: {
    crops: crops.map((c) => ({
      cell: c.cell,
      imageUrl: c.imageUrl,
      storagePath: `path/${c.imageUrl}`,
      geometry: { x: 0, y: 0, w: 128, h: 128 },
      source: 'rect' as const,
    })),
    cellCount: crops.length,
    sheetDimensions: { width: 1024, height: 512 },
  },
  meta,
});

const baseEntity = (key: string, group?: string): SketchEntity => ({
  key,
  ...(group ? { group } : {}),
  variants: [{ key: 'base', description: '', visual_design: `${key} look`, art_language: '' }],
});

describe('SketchBaseGenerateJobSlice', () => {
  let store: ReturnType<typeof createTestStore>['store'];
  let autoSaveSnapshot: ReturnType<typeof createTestStore>['autoSaveSnapshot'];

  beforeEach(() => {
    mockedGenerateCall.mockReset();
    mockedCropCall.mockReset();
    mockedSheetFlush.mockReset().mockResolvedValue('saved');
    mockedCollectionSave.mockReset().mockResolvedValue('saved');
    vi.mocked(toast.warning).mockReset();
    ({ store, autoSaveSnapshot } = createTestStore());
  });

  it('add-mode: start → generate → crop chain writes raw + crops → op finalizes to null', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);
    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test prompt',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations).toHaveLength(1);
    expect(style.illustrations[0].media_url).toBe('raw.png');
    expect(style.illustrations[0].is_selected).toBe(true);

    expect(style.crops).toHaveLength(1);
    expect(style.crops[0].key).toBe('hero');
    expect(style.crops[0].illustrations[0].media_url).toBe('crop-hero.png');

    expect(store.getState().baseSheetGenerateOps.character_sheet).toBeUndefined();

    // ⚡ phase-3: persist-after ALWAYS routes through the engine seam (whole-snapshot flush in solo).
    expect(mockedSheetFlush).toHaveBeenCalledWith('character_sheet');
    expect(autoSaveSnapshot).not.toHaveBeenCalled();
  });

  it('generate → crop chain flushes the whole SHEET via gateway (NOT autoSave)', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);
    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test prompt',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations[0].media_url).toBe('raw.png');
    expect(style.crops[0].illustrations[0].media_url).toBe('crop-hero.png');

    expect(mockedSheetFlush).toHaveBeenCalledWith('character_sheet');
    expect(autoSaveSnapshot).not.toHaveBeenCalled();
    // Fresh add-style is never locked → no entity clone changed → grain B untouched.
    expect(mockedCollectionSave).not.toHaveBeenCalled();
  });

  it('on the LOCKED style: crops replacement saves the whole collection ONCE (grain B, rtype 14)', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero'), baseEntity('villain')]);
    // Existing LOCKED style → regenerate replaces its crops → the store re-clones entity variants.
    store.getState().addSketchBaseStyle('character_sheet', {
      style_prompt: 's1',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [],
    });
    store.getState().setSketchBaseStyleSelected('character_sheet', 0);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['hero', 'villain']));
    mockedCropCall.mockResolvedValueOnce(
      okCropRow([
        { cell: 1, imageUrl: 'crop-hero.png' },
        { cell: 2, imageUrl: 'crop-villain.png' },
      ]),
    );

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'regenerate',
      styleIndex: 0,
      stylePrompt: 's1',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const [hero, villain] = store.getState().sketch.characters;
    expect(hero.variants[0].raw_sheet?.crops[0].illustrations[0].media_url).toBe('crop-hero.png');
    expect(villain.variants[0].raw_sheet?.crops[0].illustrations[0].media_url).toBe('crop-villain.png');

    // …and the WHOLE characters collection persisted ONCE (rtype 14) after the sheet flush.
    expect(mockedSheetFlush).toHaveBeenCalled();
    expect(mockedCollectionSave).toHaveBeenCalledTimes(1);
    expect(mockedCollectionSave).toHaveBeenCalledWith('characters');
    expect(autoSaveSnapshot).not.toHaveBeenCalled();
  });

  it('on the LOCKED style: FAILED generate (no crops landed) skips the entity flush', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);
    store.getState().addSketchBaseStyle('character_sheet', {
      style_prompt: 's1',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [],
    });
    store.getState().setSketchBaseStyleSelected('character_sheet', 0);

    mockedGenerateCall.mockResolvedValueOnce({ success: false, error: { code: 'LLM_ERROR', message: 'boom' } } as never);

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'regenerate',
      styleIndex: 0,
      stylePrompt: 's1',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    // Sheet still persists (raw/error state), but no crops landed → clones unchanged → grain B quiet.
    expect(mockedSheetFlush).toHaveBeenCalled();
    expect(mockedCollectionSave).not.toHaveBeenCalled();
  });

  it('opStale: reset op mid-await → crops NOT written', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    const dGen = deferred<ReturnType<typeof okGenerate>>();
    mockedGenerateCall.mockReturnValueOnce(dGen.promise as never);

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();

    // Simulate op reset (cancel or removeStyle mid-chain)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setState((s: any) => {
      s.baseSheetGenerateOps = {};
    });

    dGen.resolve(okGenerate('raw.png'));
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations).toEqual([]); // no raw added
    expect(mockedCropCall).not.toHaveBeenCalled();
  });

  it('per-group single-flight: a second start on the SAME group is blocked', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    const dGen = deferred<ReturnType<typeof okGenerate>>();
    mockedGenerateCall.mockReturnValueOnce(dGen.promise as never);

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    expect(mockedGenerateCall).toHaveBeenCalledTimes(1);

    // Second start on the SAME group (its sheet node already has a writer) → no-op
    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test2',
      referenceImages: [],
      artStyleId: 'style-2',
    });
    expect(mockedGenerateCall).toHaveBeenCalledTimes(1);

    dGen.resolve(okGenerate('raw.png'));
    await tick();
  });

  it('per-group parallel: props starts while characters is still generating', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);
    store.getState().setSketchEntities('props', [baseEntity('lantern')]);

    const dChar = deferred<ReturnType<typeof okGenerate>>();
    const dProp = deferred<ReturnType<typeof okGenerate>>();
    mockedGenerateCall.mockReturnValueOnce(dChar.promise as never);
    mockedGenerateCall.mockReturnValueOnce(dProp.promise as never);

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'chars',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    store.getState().startBaseSheetGenerate({
      group: 'prop_sheet',
      mode: 'add',
      stylePrompt: 'props',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();

    expect(mockedGenerateCall).toHaveBeenCalledTimes(2); // both dispatched
    const ops = store.getState().baseSheetGenerateOps;
    expect(ops.character_sheet).toBeDefined();
    expect(ops.prop_sheet).toBeDefined();

    dChar.resolve(okGenerate('raw.png'));
    dProp.resolve(okGenerate('raw2.png'));
    await tick();
  });

  it('cancel/dismiss address ONE group — the other group is untouched', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setState((s: any) => {
      s.baseSheetGenerateOps.character_sheet = {
        group: 'character_sheet',
        styleIndex: 0,
        phase: 'generating',
        startedAt: 'now',
        isRecrop: false,
      };
      s.baseSheetGenerateOps.prop_sheet = {
        group: 'prop_sheet',
        styleIndex: 0,
        phase: 'generating',
        startedAt: 'now',
        isRecrop: false,
        error: 'boom',
      };
    });

    store.getState().cancelBaseSheetGenerate('character_sheet');
    expect(store.getState().baseSheetGenerateOps.character_sheet?.cancelRequested).toBe(true);
    expect(store.getState().baseSheetGenerateOps.prop_sheet?.cancelRequested).toBeUndefined();

    store.getState().dismissBaseSheetGenerateError('prop_sheet');
    expect(store.getState().baseSheetGenerateOps.prop_sheet).toBeUndefined();
    expect(store.getState().baseSheetGenerateOps.character_sheet).toBeDefined();
  });

  it('recrop: style with raw → crop-only overwrites crops', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    store.getState().addSketchBaseStyle('character_sheet', {
      style_prompt: 'test style',
      is_selected: false,
      image_references: [],
      illustrations: [
        { type: 'created' as const, media_url: 'raw.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
      ],
      crops: [
        {
          key: 'hero',
          illustrations: [
            { type: 'created' as const, media_url: 'old-crop.png', created_time: '2026-07-13T00:00:00Z', is_selected: true },
          ],
        },
      ],
    });

    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'new-crop.png' }]));

    store.getState().recropBaseSheet('character_sheet', 0);
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations[0].media_url).toBe('raw.png'); // raw untouched
    expect(style.crops[0].illustrations[0].media_url).toBe('new-crop.png');
  });

  it('error: add-mode generate fail (no raw) → orphaned style rolled back + op.error persists until dismiss', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);
    // Sheet node does not exist yet — add appends one style, which must be rolled back on failure.
    expect(store.getState().sketch.base.character_sheet?.styles ?? []).toHaveLength(0);

    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockedGenerateCall.mockResolvedValueOnce({
      success: false,
      error: 'boom',
      errorCode: 'LLM_ERROR',
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();

    // Appended (empty) style rolled back — sheet back to empty.
    expect(store.getState().sketch.base.character_sheet.styles).toHaveLength(0);

    expect(store.getState().baseSheetGenerateOps.character_sheet).not.toBeUndefined();
    expect(store.getState().baseSheetGenerateOps.character_sheet?.error).toContain('image model');

    store.getState().dismissBaseSheetGenerateError('character_sheet');
    expect(store.getState().baseSheetGenerateOps.character_sheet).toBeUndefined();
  });

  it('refs: pre-hosted art-style refs → persisted verbatim on the style + sent as media_url to generate', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    const refs = [
      { title: 'ref-a', media_url: 'https://cdn/ref-a.png' },
      { title: 'ref-b', media_url: 'https://cdn/ref-b.png' },
    ];
    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: refs,
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.image_references).toEqual(refs);
    const genArg = mockedGenerateCall.mock.calls[0][1];
    expect(genArg.referenceImages).toEqual([
      { media_url: 'https://cdn/ref-a.png' },
      { media_url: 'https://cdn/ref-b.png' },
    ]);
    // ALWAYS ships the group key as targetGroup.
    expect(genArg.targetGroup).toBe('character_sheet');
    // Route dispatched by the group's kind.
    expect(mockedGenerateCall.mock.calls[0][0]).toBe('characters');
  });

  it('refs: empty → image_references untouched + generate receives an empty array', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.image_references).toEqual([]);
    const genArg = mockedGenerateCall.mock.calls[0][1];
    expect(genArg.referenceImages).toEqual([]);
  });

  it('error: add-mode crop fail AFTER raw landed → style KEPT (not rolled back) + op.error set', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockedCropCall.mockResolvedValueOnce({
      success: false,
      error: 'boom',
      errorCode: 'ALL_CROPS_FAILED',
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const styles = store.getState().sketch.base.character_sheet.styles;
    expect(styles).toHaveLength(1);
    expect(styles[0].illustrations[0].media_url).toBe('raw.png');

    expect(store.getState().baseSheetGenerateOps.character_sheet).not.toBeUndefined();
    expect(store.getState().baseSheetGenerateOps.character_sheet?.error).toContain('crop');
  });

  it('positional pairing: crops keyed by 1-based cell (skipped middle cell does NOT shift keys) + warn', async () => {
    const entityKeys = ['alpha', 'bravo', 'charlie'];
    store.getState().setSketchEntities('characters', entityKeys.map((k) => baseEntity(k)));

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', entityKeys));
    mockedCropCall.mockResolvedValueOnce(
      okCropRow(
        [
          { cell: 1, imageUrl: 'crop-alpha.png' },
          { cell: 3, imageUrl: 'crop-charlie.png' },
        ],
        { skipped: [{ cell: 2, reason: 'upload failed' }] },
      ),
    );

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.crops).toHaveLength(2);
    const alpha = style.crops.find((c: { key: string }) => c.key === 'alpha');
    const charlie = style.crops.find((c: { key: string }) => c.key === 'charlie');
    expect(alpha?.illustrations[0].media_url).toBe('crop-alpha.png');
    expect(charlie?.illustrations[0].media_url).toBe('crop-charlie.png'); // cell 3 → charlie (NOT bravo)
    expect(style.crops.find((c: { key: string }) => c.key === 'bravo')).toBeUndefined();

    expect(vi.mocked(toast.warning)).toHaveBeenCalled();
  });

  it('degraded meta (geoFallback / fullbleed) → non-fatal warn toast, crops still written', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(
      okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }], { geoFallbackCount: 1, fullbleedWarning: true }),
    );

    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.crops[0].illustrations[0].media_url).toBe('crop-hero.png');
    expect(vi.mocked(toast.warning)).toHaveBeenCalled();
  });

  it('modelParams: threaded through start → generate call; crop uses base pathPrefix + cellCount', async () => {
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    const modelParams = { model: 'google/nano-banana-pro', params: { temperature: 0.7 } };
    store.getState().startBaseSheetGenerate({
      group: 'character_sheet',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
      modelParams,
    });
    await tick();
    await tick();
    await tick();

    const genArg = mockedGenerateCall.mock.calls[0][1];
    expect(genArg.modelParams).toEqual(modelParams);
    const cropArg = mockedCropCall.mock.calls[0][0];
    expect(cropArg.pathPrefix).toBe('sketches/base/characters');
    expect(cropArg.cellCount).toBe(1);
  });

  describe('saveResource wiring — opt-in BE-first double-write', () => {
    it('passes saveResource with the group base style anchor for a character group', async () => {
      const { store } = createTestStore('snap-base');
      store.getState().setSketchEntities('characters', [baseEntity('hero')]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png'));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'character_sheet',
        mode: 'add',
        stylePrompt: 'test prompt',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.saveResource).toMatchObject({
        type: 'image_version',
        path: expect.stringContaining('table:snapshots/id:snap-base/col:sketch/key:base/key:character_sheet/key:styles/idx:'),
        action: 'create',
      });
    });

    it('passes saveResource with the group base style anchor for a prop group', async () => {
      const { store } = createTestStore('snap-prop');
      store.getState().setSketchEntities('props', [baseEntity('sword')]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png', ['sword']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'prop_sheet',
        mode: 'add',
        stylePrompt: 'test prompt',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.saveResource).toMatchObject({
        type: 'image_version',
        path: expect.stringContaining('table:snapshots/id:snap-prop/col:sketch/key:base/key:prop_sheet/key:styles/idx:'),
        action: 'create',
      });
    });

    it('anchors on a NON-legacy group key verbatim (custom Excel tab group)', async () => {
      const { store } = createTestStore('snap-custom');
      store.getState().setSketchEntities('characters', [baseEntity('gob', 'goblins_2')]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png', ['gob']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'goblins_2',
        mode: 'add',
        stylePrompt: 'test prompt',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.targetGroup).toBe('goblins_2');
      expect(genArg.saveResource).toMatchObject({
        path: expect.stringContaining('col:sketch/key:base/key:goblins_2/key:styles/idx:'),
      });
    });

    it('omits saveResource when snapshotId is null (not opted in)', async () => {
      const { store } = createTestStore(null);
      store.getState().setSketchEntities('characters', [baseEntity('hero')]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png'));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'character_sheet',
        mode: 'add',
        stylePrompt: 'test prompt',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.saveResource).toBeUndefined();
    });
  });

  // ⚡REV 2026-08-21 — an "alter" cast is just another CHARACTER group (`alter_character_sheet`).
  // Its entities carry `group: 'alter_character_sheet'` in `characters[]`; they generate in parallel
  // with the default `character_sheet` group and land in their own base node.
  describe('multiple character groups — entity source, node routing, storage layout', () => {
    /** hero (default character group) + stunt-hero (alter group) sharing the ONE characters[] array. */
    function seedMixedCast(s: ReturnType<typeof createTestStore>['store']) {
      s.getState().setSketchEntities('characters', [
        baseEntity('hero'),
        baseEntity('stunt-hero', 'alter_character_sheet'),
      ]);
    }

    it('generating the ALTER group sends ONLY that group’s entities', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['stunt-hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-alter.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'alter_character_sheet',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.entities.map((e: { key: string }) => e.key)).toEqual(['stunt-hero']);
      expect(genArg.targetGroup).toBe('alter_character_sheet');
      expect(mockedGenerateCall.mock.calls[0][0]).toBe('characters'); // still route 05
    });

    it('generating the default CHARACTER group excludes the alter cast (no leak)', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'character_sheet',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.entities.map((e: { key: string }) => e.key)).toEqual(['hero']);
    });

    it('results land in base.alter_character_sheet — the default character node is untouched', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw-alter.png', ['stunt-hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-alter.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'alter_character_sheet',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();
      await tick();
      await tick();

      const alterStyle = store.getState().sketch.base.alter_character_sheet.styles[0];
      expect(alterStyle.illustrations[0].media_url).toBe('raw-alter.png');
      expect(alterStyle.crops[0].key).toBe('stunt-hero');
      expect(store.getState().sketch.base.character_sheet).toBeUndefined();
    });

    it('storage prefix stays sketches/base/characters for a character group (layout keyed on the KIND)', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['stunt-hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-alter.png' }]));

      store.getState().startBaseSheetGenerate({
        group: 'alter_character_sheet',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();
      await tick();
      await tick();

      // NOT `sketches/base/alter_character_sheet` — every character group shares the folder and is
      // told apart by the snapshot node it writes.
      expect(mockedCropCall.mock.calls[0][0].pathPrefix).toBe('sketches/base/characters');
    });

    it('three GROUPS generate in parallel (three independent rtype-11 sheet nodes)', async () => {
      seedMixedCast(store);
      store.getState().setSketchEntities('props', [baseEntity('lantern')]);
      const pending = [deferred(), deferred(), deferred()];
      pending.forEach((d) => mockedGenerateCall.mockReturnValueOnce(d.promise as never));

      for (const group of ['character_sheet', 'prop_sheet', 'alter_character_sheet'] as const) {
        store.getState().startBaseSheetGenerate({
          group,
          mode: 'add',
          stylePrompt: 'test',
          referenceImages: [],
          artStyleId: 'style-1',
        });
        await tick();
      }

      expect(mockedGenerateCall).toHaveBeenCalledTimes(3);
      const ops = store.getState().baseSheetGenerateOps;
      expect(ops.character_sheet).toBeDefined();
      expect(ops.prop_sheet).toBeDefined();
      expect(ops.alter_character_sheet).toBeDefined();
    });

    it('recrop of the alter group derives cellOrder from the alter cast only', async () => {
      seedMixedCast(store);
      store.getState().addSketchBaseStyle('alter_character_sheet', {
        style_prompt: 's1',
        is_selected: false,
        image_references: [],
        illustrations: [
          { type: 'created' as const, media_url: 'raw.png', created_time: '2026-07-28T00:00:00Z', is_selected: true },
        ],
        crops: [],
      });
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'recrop-alter.png' }]));

      store.getState().recropBaseSheet('alter_character_sheet', 0);
      await tick();
      await tick();

      // cellCount 1 = the alter cast size (NOT 2 = the whole characters[] array).
      expect(mockedCropCall.mock.calls[0][0].cellCount).toBe(1);
      const style = store.getState().sketch.base.alter_character_sheet.styles[0];
      expect(style.crops[0].key).toBe('stunt-hero');
    });

    it('empty group → generate is refused (no request, warn toast) instead of an empty sheet', async () => {
      store.getState().setSketchEntities('characters', [baseEntity('hero')]);

      store.getState().startBaseSheetGenerate({
        group: 'alter_character_sheet',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      expect(mockedGenerateCall).not.toHaveBeenCalled();
      expect(vi.mocked(toast.warning)).toHaveBeenCalled();
      // …and no orphaned node was materialised for the empty group.
      expect(store.getState().sketch.base.alter_character_sheet).toBeUndefined();
    });
  });
});
