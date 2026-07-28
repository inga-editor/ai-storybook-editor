import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { toast } from 'sonner';
import { createSketchSlice } from './sketch-slice';
import { createSketchBaseGenerateJobSlice } from './sketch-base-generate-job-slice';
import type { SketchEntity } from '@/types/sketch';
import { callGenerateBaseSheet, type GenerateBaseSheetResult } from '@/apis/sketch-base-api';
import { callCropSheetRow, type CropSheetRowResult } from '@/apis/sketch-variant-api';

// Mock the api-client seams. ⚡2026-07-15: base crop migrated 07 → shared positional cutter (api 10)
// which lives in sketch-variant-api → mock BOTH modules (generate on base, crop on variant).
vi.mock('@/apis/sketch-base-api', () => ({
  callGenerateBaseSheet: vi.fn(),
}));
vi.mock('@/apis/sketch-variant-api', () => ({
  callCropSheetRow: vi.fn(),
}));
const mockedGenerateCall = vi.mocked(callGenerateBaseSheet);
const mockedCropCall = vi.mocked(callCropSheetRow);

// Mutable collab flag so tests can drive the solo (autoSave) vs collab (gateway flush) persist path.
const lockState = vi.hoisted(() => ({ collabPersist: false as boolean }));

// Mock resource-lock-store to isolate from collab (collabPersist drives the persist branch).
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: {
    getState: () => ({ collabPersist: lockState.collabPersist, myUserId: null, holderNames: new Map() }),
  },
}));

// Mock the base-sheet gateway flush (ADR-043 rtype 11) so the collab persist path can be asserted
// WITHOUT a live lock store. Solo path never calls it (autoSaveSnapshot instead).
const mockedSheetFlush = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./collab-sketch-base-sheet-save-helper', () => ({
  flushSketchBaseSheetUnderLock: mockedSheetFlush,
}));

// Mock the per-entity gateway flush (grain B, rtype 3/4) — called after a crops replacement on the
// LOCKED style (the store re-clones entity base variants → those nodes flush too).
const mockedEntityFlush = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./collab-sketch-variant-save-helper', () => ({
  flushSketchEntityUnderLock: mockedEntityFlush,
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

describe('SketchBaseGenerateJobSlice', () => {
  let store: ReturnType<typeof createTestStore>['store'];
  let autoSaveSnapshot: ReturnType<typeof createTestStore>['autoSaveSnapshot'];

  beforeEach(() => {
    mockedGenerateCall.mockReset();
    mockedCropCall.mockReset();
    mockedSheetFlush.mockReset().mockResolvedValue(true);
    mockedEntityFlush.mockReset().mockResolvedValue(true);
    lockState.collabPersist = false; // default: solo (autoSave path)
    vi.mocked(toast.warning).mockReset();
    ({ store, autoSaveSnapshot } = createTestStore());
  });

  it('add-mode: start → generate → crop chain writes raw + crops → op finalizes to null', async () => {
    // Setup base entities
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [
        {
          key: 'base',
          description: '',
          visual_design: 'mighty warrior',
          art_language: '',
        },
      ],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    // Mock successful generate → crop chain
    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    // Start the job in 'add' mode (creates a new style)
    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test prompt',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    // Assert raw written (prepended + selected)
    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations).toHaveLength(1);
    expect(style.illustrations[0].media_url).toBe('raw.png');
    expect(style.illustrations[0].is_selected).toBe(true);

    // Assert crops written
    expect(style.crops).toHaveLength(1);
    expect(style.crops[0].key).toBe('hero');
    expect(style.crops[0].illustrations[0].media_url).toBe('crop-hero.png');

    // Assert op finalized (null after success)
    expect(store.getState().baseSheetGenerateOps.characters).toBeUndefined();

    // Assert autoSave called (solo persist path)
    expect(autoSaveSnapshot).toHaveBeenCalled();
    // Solo → the gateway sheet flush is NEVER touched.
    expect(mockedSheetFlush).not.toHaveBeenCalled();
  });

  it('collab persist: generate → crop chain flushes the whole SHEET via gateway (NOT autoSave)', async () => {
    lockState.collabPersist = true; // collab space → gateway held-session owns persistence
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'mighty warrior', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test prompt',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    // Raw + crops still written locally.
    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations[0].media_url).toBe('raw.png');
    expect(style.crops[0].illustrations[0].media_url).toBe('crop-hero.png');

    // Collab → gateway whole-sheet flush (one-shot releaseIfAcquired), NOT the suppressed autoSave.
    expect(mockedSheetFlush).toHaveBeenCalledWith('characters', expect.any(Object), { releaseIfAcquired: true });
    expect(autoSaveSnapshot).not.toHaveBeenCalled();
    // Fresh add-style is never locked → no entity clone changed → grain B untouched.
    expect(mockedEntityFlush).not.toHaveBeenCalled();
  });

  it('collab persist on the LOCKED style: crops replacement also flushes every entity node (grain B)', async () => {
    lockState.collabPersist = true;
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [{ key: 'base', description: '', visual_design: 'w', art_language: '' }] },
      { key: 'villain', variants: [{ key: 'base', description: '', visual_design: 'v', art_language: '' }] },
    ]);
    // Existing LOCKED style → regenerate replaces its crops → the store re-clones entity variants.
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's1',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [],
    });
    store.getState().setSketchBaseStyleSelected('characters', 0);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['hero', 'villain']));
    mockedCropCall.mockResolvedValueOnce(
      okCropRow([
        { cell: 1, imageUrl: 'crop-hero.png' },
        { cell: 2, imageUrl: 'crop-villain.png' },
      ]),
    );

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'regenerate',
      styleIndex: 0,
      stylePrompt: 's1',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    // Entity base-variant clones live-followed the new crops…
    const [hero, villain] = store.getState().sketch.characters;
    expect(hero.variants[0].raw_sheet?.crops[0].illustrations[0].media_url).toBe('crop-hero.png');
    expect(villain.variants[0].raw_sheet?.crops[0].illustrations[0].media_url).toBe('crop-villain.png');

    // …and BOTH entity nodes flushed through the gateway (grain B) after the sheet flush.
    expect(mockedSheetFlush).toHaveBeenCalled();
    expect(mockedEntityFlush).toHaveBeenCalledTimes(2);
    expect(mockedEntityFlush).toHaveBeenCalledWith('characters', 'hero', expect.any(Object), { releaseIfAcquired: true });
    expect(mockedEntityFlush).toHaveBeenCalledWith('characters', 'villain', expect.any(Object), { releaseIfAcquired: true });
    expect(autoSaveSnapshot).not.toHaveBeenCalled();
  });

  it('collab persist on the LOCKED style: FAILED generate (no crops landed) skips the entity flush', async () => {
    lockState.collabPersist = true;
    store.getState().setSketchEntities('characters', [
      { key: 'hero', variants: [{ key: 'base', description: '', visual_design: 'w', art_language: '' }] },
    ]);
    store.getState().addSketchBaseStyle('characters', {
      style_prompt: 's1',
      is_selected: false,
      image_references: [],
      illustrations: [],
      crops: [],
    });
    store.getState().setSketchBaseStyleSelected('characters', 0);

    mockedGenerateCall.mockResolvedValueOnce({ success: false, error: { code: 'LLM_ERROR', message: 'boom' } } as never);

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
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
    expect(mockedEntityFlush).not.toHaveBeenCalled();
  });

  it('opStale: reset op mid-await → crops NOT written', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    const dGen = deferred<ReturnType<typeof okGenerate>>();
    mockedGenerateCall.mockReturnValueOnce(dGen.promise as never);

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
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

    // Resolve generate (but op is stale, runCrop guard should bail)
    dGen.resolve(okGenerate('raw.png'));
    await tick();
    await tick();

    // Assert raw NOT written
    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations).toEqual([]); // no raw added

    // Assert crop was never called (opStale prevented runCrop)
    expect(mockedCropCall).not.toHaveBeenCalled();
  });

  it('per-kind single-flight: a second start on the SAME kind is blocked', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    const dGen = deferred<ReturnType<typeof okGenerate>>();
    mockedGenerateCall.mockReturnValueOnce(dGen.promise as never);

    // First start
    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    expect(mockedGenerateCall).toHaveBeenCalledTimes(1);

    // Second start on the SAME kind (its sheet node already has a writer) → no-op
    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test2',
      referenceImages: [],
      artStyleId: 'style-2',
    });
    expect(mockedGenerateCall).toHaveBeenCalledTimes(1); // still 1, not 2

    dGen.resolve(okGenerate('raw.png'));
    await tick();
  });

  it('per-kind parallel: props starts while characters is still generating', async () => {
    const baseEntity = (key: string): SketchEntity => ({
      key,
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    });
    store.getState().setSketchEntities('characters', [baseEntity('hero')]);
    store.getState().setSketchEntities('props', [baseEntity('lantern')]);

    const dChar = deferred<ReturnType<typeof okGenerate>>();
    const dProp = deferred<ReturnType<typeof okGenerate>>();
    mockedGenerateCall.mockReturnValueOnce(dChar.promise as never);
    mockedGenerateCall.mockReturnValueOnce(dProp.promise as never);

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'chars',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    store.getState().startBaseSheetGenerate({
      kind: 'props',
      mode: 'add',
      stylePrompt: 'props',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();

    expect(mockedGenerateCall).toHaveBeenCalledTimes(2); // both dispatched
    const ops = store.getState().baseSheetGenerateOps;
    expect(ops.characters).toBeDefined();
    expect(ops.props).toBeDefined();

    dChar.resolve(okGenerate('raw.png'));
    dProp.resolve(okGenerate('raw2.png'));
    await tick();
  });

  it('cancel/dismiss address ONE kind — the other kind is untouched', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setState((s: any) => {
      s.baseSheetGenerateOps.characters = {
        kind: 'characters',
        styleIndex: 0,
        phase: 'generating',
        startedAt: 'now',
        isRecrop: false,
      };
      s.baseSheetGenerateOps.props = {
        kind: 'props',
        styleIndex: 0,
        phase: 'generating',
        startedAt: 'now',
        isRecrop: false,
        error: 'boom',
      };
    });

    store.getState().cancelBaseSheetGenerate('characters');
    expect(store.getState().baseSheetGenerateOps.characters?.cancelRequested).toBe(true);
    expect(store.getState().baseSheetGenerateOps.props?.cancelRequested).toBeUndefined();

    store.getState().dismissBaseSheetGenerateError('props');
    expect(store.getState().baseSheetGenerateOps.props).toBeUndefined();
    expect(store.getState().baseSheetGenerateOps.characters).toBeDefined();
  });

  it('recrop: style with raw → crop-only overwrites crops', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    // Add style with raw + old crops
    store.getState().addSketchBaseStyle('characters', {
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

    // Mock crop result (new crops)
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'new-crop.png' }]));

    // Start recrop (crop-only, references the existing raw at style index 0)
    store.getState().recropBaseSheet('characters', 0);
    await tick();
    await tick();

    // Assert raw untouched
    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.illustrations[0].media_url).toBe('raw.png');

    // Assert crops overwritten
    expect(style.crops[0].illustrations[0].media_url).toBe('new-crop.png');
  });

  it('error: add-mode generate fail (no raw) → orphaned style rolled back + op.error persists until dismiss', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);
    // Sheet starts empty — add appends one style, which must be rolled back on failure.
    expect(store.getState().sketch.base.character_sheet.styles).toHaveLength(0);

    // Mock generate fail
    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockedGenerateCall.mockResolvedValueOnce({
      success: false,
      error: 'boom',
      errorCode: 'LLM_ERROR',
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();

    // Assert the appended (empty) style was rolled back — sheet back to original length.
    expect(store.getState().sketch.base.character_sheet.styles).toHaveLength(0);

    // Assert op.error set + op kept (not finalized to null)
    expect(store.getState().baseSheetGenerateOps.characters).not.toBeUndefined();
    expect(store.getState().baseSheetGenerateOps.characters?.error).toContain('image model');

    // Dismiss
    store.getState().dismissBaseSheetGenerateError('characters');
    expect(store.getState().baseSheetGenerateOps.characters).toBeUndefined();
  });

  it('refs: pre-hosted art-style refs → persisted verbatim on the style + sent as media_url to generate', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    const refs = [
      { title: 'ref-a', media_url: 'https://cdn/ref-a.png' },
      { title: 'ref-b', media_url: 'https://cdn/ref-b.png' },
    ];
    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: refs,
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    // Persisted verbatim (already hosted — no upload roundtrip).
    expect(style.image_references).toEqual(refs);
    // Generate received media_url refs only (title stripped, order preserved).
    const genArg = mockedGenerateCall.mock.calls[0][1];
    expect(genArg.referenceImages).toEqual([
      { media_url: 'https://cdn/ref-a.png' },
      { media_url: 'https://cdn/ref-b.png' },
    ]);
  });

  it('refs: empty → image_references untouched + generate receives an empty array', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.image_references).toEqual([]); // never written when no refs picked
    const genArg = mockedGenerateCall.mock.calls[0][1];
    expect(genArg.referenceImages).toEqual([]);
  });

  it('error: add-mode crop fail AFTER raw landed → style KEPT (not rolled back) + op.error set', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    // Generate succeeds (raw lands), crop fails → partial success → keep the style.
    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockedCropCall.mockResolvedValueOnce({
      success: false,
      error: 'boom',
      errorCode: 'ALL_CROPS_FAILED',
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    // Style KEPT (raw already landed = partial success) with the raw illustration.
    const styles = store.getState().sketch.base.character_sheet.styles;
    expect(styles).toHaveLength(1);
    expect(styles[0].illustrations[0].media_url).toBe('raw.png');

    // op.error set + kept
    expect(store.getState().baseSheetGenerateOps.characters).not.toBeUndefined();
    expect(store.getState().baseSheetGenerateOps.characters?.error).toContain('crop');
  });

  it('positional pairing: crops keyed by 1-based cell (skipped middle cell does NOT shift keys) + warn', async () => {
    // 3 base entities in reading order alpha,bravo,charlie. Backend cuts cells 1 & 3, SKIPS cell 2.
    const entityKeys = ['alpha', 'bravo', 'charlie'];
    const entities: SketchEntity[] = entityKeys.map((key) => ({
      key,
      variants: [{ key: 'base', description: '', visual_design: `${key} look`, art_language: '' }],
    }));
    store.getState().setSketchEntities('characters', entities);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', entityKeys));
    // Crops for cell 1 + cell 3 only. If the slice paired by ARRAY INDEX the second crop would wrongly
    // land on 'bravo' (index 1) — assert it lands on 'charlie' (cell 3 → cellOrder[2]).
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
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.crops).toHaveLength(2); // only 2 crops written (cell 2 skipped)
    const alpha = style.crops.find((c: { key: string }) => c.key === 'alpha');
    const charlie = style.crops.find((c: { key: string }) => c.key === 'charlie');
    expect(alpha?.illustrations[0].media_url).toBe('crop-alpha.png');
    expect(charlie?.illustrations[0].media_url).toBe('crop-charlie.png'); // cell 3 → charlie (NOT bravo)
    expect(style.crops.find((c: { key: string }) => c.key === 'bravo')).toBeUndefined();

    // Non-fatal skipped warn surfaced.
    expect(vi.mocked(toast.warning)).toHaveBeenCalled();
  });

  it('degraded meta (geoFallback / fullbleed) → non-fatal warn toast, crops still written', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(
      okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }], { geoFallbackCount: 1, fullbleedWarning: true }),
    );

    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
    });
    await tick();
    await tick();
    await tick();

    const style = store.getState().sketch.base.character_sheet.styles[0];
    expect(style.crops[0].illustrations[0].media_url).toBe('crop-hero.png'); // crop still written
    expect(vi.mocked(toast.warning)).toHaveBeenCalled();
  });

  it('modelParams: threaded through start → generate call; crop uses base pathPrefix + cellCount', async () => {
    const baseEntity: SketchEntity = {
      key: 'hero',
      variants: [{ key: 'base', description: '', visual_design: 'test', art_language: '' }],
    };
    store.getState().setSketchEntities('characters', [baseEntity]);

    mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png'));
    mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

    const modelParams = { model: 'google/nano-banana-pro', params: { temperature: 0.7 } };
    store.getState().startBaseSheetGenerate({
      kind: 'characters',
      mode: 'add',
      stylePrompt: 'test',
      referenceImages: [],
      artStyleId: 'style-1',
      modelParams,
    });
    await tick();
    await tick();
    await tick();

    // Generate received modelParams verbatim.
    const genArg = mockedGenerateCall.mock.calls[0][1];
    expect(genArg.modelParams).toEqual(modelParams);
    // crop-sheet-row (api 10) called with the base pathPrefix + cellCount derived from cellOrder.
    const cropArg = mockedCropCall.mock.calls[0][0];
    expect(cropArg.pathPrefix).toBe('sketches/base/characters');
    expect(cropArg.cellCount).toBe(1);
  });

  describe('saveResource wiring — opt-in BE-first double-write', () => {
    it('passes saveResource with correct base style anchor for character', async () => {
      const { store } = createTestStore('snap-base');
      const baseEntity: SketchEntity = {
        key: 'hero',
        variants: [{ key: 'base', description: '', visual_design: 'mighty warrior', art_language: '' }],
      };
      store.getState().setSketchEntities('characters', [baseEntity]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png'));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'characters',
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

    it('passes saveResource with correct base style anchor for props', async () => {
      const { store } = createTestStore('snap-prop');
      const baseEntity: SketchEntity = {
        key: 'sword',
        variants: [{ key: 'base', description: '', visual_design: 'mighty sword', art_language: '' }],
      };
      store.getState().setSketchEntities('props', [baseEntity]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png'));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'props',
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

    it('passes saveResource anchored on the ALTER sheet node for alter_characters', async () => {
      const { store } = createTestStore('snap-alter');
      store.getState().setSketchEntities('alter_characters', [
        { key: 'stunt-hero', variants: [{ key: 'base', description: '', visual_design: 'stand-in', art_language: '' }] },
      ]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png', ['stunt-hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'alter_characters',
        mode: 'add',
        stylePrompt: 'test prompt',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();
      await tick();
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.saveResource).toMatchObject({
        type: 'image_version',
        path: expect.stringContaining(
          'table:snapshots/id:snap-alter/col:sketch/key:base/key:alter_character_sheet/key:styles/idx:',
        ),
        action: 'create',
      });
    });

    it('omits saveResource when snapshotId is null (not opted in)', async () => {
      const { store } = createTestStore(null);
      const baseEntity: SketchEntity = {
        key: 'hero',
        variants: [{ key: 'base', description: '', visual_design: 'mighty warrior', art_language: '' }],
      };
      store.getState().setSketchEntities('characters', [baseEntity]);

      mockedGenerateCall.mockResolvedValueOnce(okGenerate('gen.png'));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'characters',
        mode: 'add',
        stylePrompt: 'test prompt',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      // When snapshotId is null, saveResource should be undefined (not opted in)
      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.saveResource).toBeUndefined();
    });
  });

  // ⚡2026-07-28 — alter characters. `sketch['alter_characters']` DOES NOT EXIST: alter entities
  // live in `sketch.characters[]` behind `actor_role === 1`. Every read here must resolve through
  // KIND_ENTITY_SOURCE, or the alter group generates an EMPTY sheet with no type error and no
  // runtime error (the failure the whole feature is most exposed to).
  describe('alter characters — entity source, sheet routing, storage layout', () => {
    /** hero (story cast) + stunt-hero (alter) sharing the ONE characters[] array. */
    function seedMixedCast(s: ReturnType<typeof createTestStore>['store']) {
      s.getState().setSketchEntities('characters', [
        { key: 'hero', variants: [{ key: 'base', description: '', visual_design: 'brave', art_language: '' }] },
      ]);
      s.getState().setSketchEntities('alter_characters', [
        { key: 'stunt-hero', variants: [{ key: 'base', description: '', visual_design: 'stand-in', art_language: '' }] },
      ]);
    }

    it('generating the ALTER sheet sends ONLY actor_role=1 entities', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['stunt-hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-alter.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'alter_characters',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.entities.map((e: { key: string }) => e.key)).toEqual(['stunt-hero']);
    });

    it('generating the CHARACTER sheet excludes the alter cast (no leak in the other direction)', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-hero.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'characters',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      const genArg = mockedGenerateCall.mock.calls[0][1];
      expect(genArg.entities.map((e: { key: string }) => e.key)).toEqual(['hero']);
    });

    it('results land in base.alter_character_sheet — the character sheet is untouched', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw-alter.png', ['stunt-hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-alter.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'alter_characters',
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
      expect(store.getState().sketch.base.character_sheet.styles).toHaveLength(0);
    });

    it('storage prefix stays sketches/base/characters for alter (layout keyed on the COLLECTION)', async () => {
      seedMixedCast(store);
      mockedGenerateCall.mockResolvedValueOnce(okGenerate('raw.png', ['stunt-hero']));
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'crop-alter.png' }]));

      store.getState().startBaseSheetGenerate({
        kind: 'alter_characters',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();
      await tick();
      await tick();

      // NOT `sketches/base/alter_characters` — the two character sheets deliberately share the
      // folder and are told apart by the snapshot node they write.
      expect(mockedCropCall.mock.calls[0][0].pathPrefix).toBe('sketches/base/characters');
    });

    it('all THREE kinds generate in parallel (three independent rtype-11 sheet nodes)', async () => {
      seedMixedCast(store);
      store.getState().setSketchEntities('props', [
        { key: 'lantern', variants: [{ key: 'base', description: '', visual_design: 'lamp', art_language: '' }] },
      ]);
      const pending = [deferred(), deferred(), deferred()];
      pending.forEach((d) => mockedGenerateCall.mockReturnValueOnce(d.promise as never));

      for (const kind of ['characters', 'props', 'alter_characters'] as const) {
        store.getState().startBaseSheetGenerate({
          kind,
          mode: 'add',
          stylePrompt: 'test',
          referenceImages: [],
          artStyleId: 'style-1',
        });
        await tick();
      }

      expect(mockedGenerateCall).toHaveBeenCalledTimes(3);
      const ops = store.getState().baseSheetGenerateOps;
      expect(ops.characters).toBeDefined();
      expect(ops.props).toBeDefined();
      expect(ops.alter_characters).toBeDefined();

      // Left in flight on purpose — the point is that three ops COEXIST, and settling them here
      // would race the shared crop mock across the three chains.
    });

    it('recrop of the alter sheet derives cellOrder from the alter cast only', async () => {
      seedMixedCast(store);
      store.getState().addSketchBaseStyle('alter_characters', {
        style_prompt: 's1',
        is_selected: false,
        image_references: [],
        illustrations: [
          { type: 'created' as const, media_url: 'raw.png', created_time: '2026-07-28T00:00:00Z', is_selected: true },
        ],
        crops: [],
      });
      mockedCropCall.mockResolvedValueOnce(okCropRow([{ cell: 1, imageUrl: 'recrop-alter.png' }]));

      store.getState().recropBaseSheet('alter_characters', 0);
      await tick();
      await tick();

      // cellCount 1 = the alter cast size (NOT 2 = the whole characters[] array).
      expect(mockedCropCall.mock.calls[0][0].cellCount).toBe(1);
      const style = store.getState().sketch.base.alter_character_sheet.styles[0];
      expect(style.crops[0].key).toBe('stunt-hero');
    });

    it('empty alter group → generate is refused (no request, warn toast) instead of an empty sheet', async () => {
      store.getState().setSketchEntities('characters', [
        { key: 'hero', variants: [{ key: 'base', description: '', visual_design: 'brave', art_language: '' }] },
      ]);

      store.getState().startBaseSheetGenerate({
        kind: 'alter_characters',
        mode: 'add',
        stylePrompt: 'test',
        referenceImages: [],
        artStyleId: 'style-1',
      });
      await tick();

      expect(mockedGenerateCall).not.toHaveBeenCalled();
      expect(vi.mocked(toast.warning)).toHaveBeenCalled();
      // …and no orphaned style was appended to the alter sheet.
      expect(store.getState().sketch.base.alter_character_sheet.styles).toHaveLength(0);
    });
  });
});
