// sketch-stage-generate-job-slice.test.ts — the two 2-phase chains of the stage space:
//   base style (11 STATELESS — no flush-before) → auto-cut 10 (cellCount=2, 0 picked)
//   variant   (12 SNAPSHOT-READING — flush-before mandatory) → auto-cut 10
// plus single-flight, FE 422-mirror gates, add-rollback, recrop, opStale.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSketchStageSlice } from './sketch-stage-slice';
import { createSketchStageGenerateJobSlice } from './sketch-stage-generate-job-slice';
import type { SketchStage, SketchStageCrop } from '@/types/sketch';
import {
  callGenerateBaseStageSheet,
  callGenerateStageVariantSheet,
  type GenerateBaseStageSheetResult,
  type GenerateStageVariantSheetResult,
} from '@/apis/sketch-stage-api';
import { callCropSheetRow, type CropSheetRowResult } from '@/apis/sketch-variant-api';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/apis/sketch-stage-api', () => ({
  callGenerateBaseStageSheet: vi.fn(),
  callGenerateStageVariantSheet: vi.fn(),
}));
vi.mock('@/apis/sketch-variant-api', () => ({ callCropSheetRow: vi.fn() }));
const mockedBaseGen = vi.mocked(callGenerateBaseStageSheet);
const mockedVariantGen = vi.mocked(callGenerateStageVariantSheet);
const mockedCut = vi.mocked(callCropSheetRow);

// Isolate resource-lock (collabPersist toggles solo flushSnapshot vs gateway) + the stage flush helper.
const h = vi.hoisted(() => ({
  lockState: { collabPersist: false as boolean },
  flushStage: vi.fn(async (_k: string, _n: unknown, _o?: { releaseIfAcquired?: boolean }) => true as boolean),
}));
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.lockState },
}));
vi.mock('./collab-sketch-stage-save-helper', () => ({
  flushSketchStageUnderLock: h.flushStage,
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function createTestStore(metaId: string | null = 'snap-1', stages: SketchStage[] = []) {
  const flushSnapshot = vi.fn(async () => {});
  const autoSaveSnapshot = vi.fn(async () => {});
  const store = create<any>()(
    immer((...a: any[]) => ({
      ...(createSketchStageSlice as any)(...a),
      ...(createSketchStageGenerateJobSlice as any)(...a),
      sketch: { stages },
      sync: { isDirty: false, isSaving: false },
      meta: { id: metaId },
      flushSnapshot,
      autoSaveSnapshot,
    })),
  );
  return { store, flushSnapshot, autoSaveSnapshot };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ill = (url: string, selected = true) => ({
  type: 'created' as const,
  media_url: url,
  created_time: '2026-07-18T00:00:00Z',
  is_selected: selected,
});
const pickedCrop = (url: string): SketchStageCrop => ({ is_selected: true, illustrations: [ill(url)] });

/** Stage with base text + one LOCKED style whose crop is picked (full base chain) + a 'storm' variant. */
const readyStage = (): SketchStage => ({
  key: 'forest',
  base: {
    styles: [
      {
        style_prompt: 'ink',
        is_selected: true,
        image_references: [],
        illustrations: [ill('sheet.png')],
        crops: [pickedCrop('base-crop.png'), { is_selected: false, illustrations: [] }],
      },
    ],
  },
  variants: [
    { key: 'base', description: '', visual_design: 'mossy woods', art_language: 'soft pencil', illustrations: [], crops: [pickedCrop('base-crop.png')] },
    { key: 'storm', description: '', visual_design: 'storm over woods', art_language: '', illustrations: [], crops: [] },
  ],
});

const okBaseGen = (imageUrl: string): GenerateBaseStageSheetResult => ({
  success: true,
  data: {
    imageUrl,
    storagePath: `p/${imageUrl}`,
    stageKey: 'forest',
    grid: { cols: 2, rows: 1, aspectRatio: '21:9', cellCount: 2 },
  },
});

const okVariantGen = (imageUrl: string): GenerateStageVariantSheetResult => ({
  success: true,
  data: {
    imageUrl,
    storagePath: `p/${imageUrl}`,
    entityKey: 'forest',
    variantKey: 'storm',
    grid: { cols: 2, rows: 1, aspectRatio: '21:9', cellCount: 2 },
  },
});

const okCut = (urls: string[], meta?: CropSheetRowResult['meta']): CropSheetRowResult => ({
  success: true,
  data: {
    crops: urls.map((u, i) => ({
      cell: i + 1,
      imageUrl: u,
      storagePath: `p/${u}`,
      geometry: { x: 0, y: 0, w: 10, h: 10 },
      source: 'rect' as const,
    })),
    cellCount: urls.length,
    sheetDimensions: { width: 100, height: 42 },
  },
  meta,
});

const BASE_PARAMS = {
  stageKey: 'forest',
  mode: 'add' as const,
  stylePrompt: 'ink wash',
  referenceImages: [{ title: 'r', media_url: 'https://x/r.png' }],
  artStyleId: 'style-1',
};

const stageOf = (store: ReturnType<typeof createTestStore>['store']): SketchStage =>
  store.getState().sketch.stages.find((s: SketchStage) => s.key === 'forest');
const stormOf = (store: ReturnType<typeof createTestStore>['store']) =>
  stageOf(store).variants.find((v) => v.key === 'storm')!;

describe('startStageBaseSheetGenerate (11 — STATELESS)', () => {
  let store: ReturnType<typeof createTestStore>['store'];
  let flushSnapshot: ReturnType<typeof createTestStore>['flushSnapshot'];
  let autoSaveSnapshot: ReturnType<typeof createTestStore>['autoSaveSnapshot'];

  beforeEach(() => {
    mockedBaseGen.mockReset();
    mockedVariantGen.mockReset();
    mockedCut.mockReset();
    h.lockState.collabPersist = false;
    h.flushStage.mockReset().mockResolvedValue(true);
    ({ store, flushSnapshot, autoSaveSnapshot } = createTestStore('snap-1', [readyStage()]));
  });

  it('does NOT flush before generate (stateless) and sends base text inline from the store', async () => {
    mockedBaseGen.mockResolvedValueOnce(okBaseGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png']));

    store.getState().startStageBaseSheetGenerate(BASE_PARAMS);
    await tick();
    await tick();

    expect(flushSnapshot).not.toHaveBeenCalled(); // ⚡ stateless — no flush-before
    expect(mockedBaseGen).toHaveBeenCalledTimes(1);
    expect(mockedBaseGen.mock.calls[0][0]).toMatchObject({
      stageKey: 'forest',
      visualDescription: 'mossy woods', // variants[base] text from the STORE, inline
      artLanguage: 'soft pencil',
      artStyleId: 'style-1',
      stylePrompt: 'ink wash',
      referenceImages: [{ media_url: 'https://x/r.png' }],
      snapshotId: 'snap-1', // regression lock (G1): book cost attribution must forward meta.id
    });
  });

  it("mode 'add' appends a style, prepends the sheet, cuts 2 unpicked cells, persists (solo)", async () => {
    mockedBaseGen.mockResolvedValueOnce(okBaseGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png']));

    store.getState().startStageBaseSheetGenerate(BASE_PARAMS);
    await tick();
    await tick();
    await tick();

    const styles = stageOf(store).base.styles;
    expect(styles).toHaveLength(2); // appended attempt
    const added = styles[1];
    expect(added.style_prompt).toBe('ink wash'); // persisted config
    expect(added.image_references).toEqual([{ title: 'r', media_url: 'https://x/r.png' }]);
    expect(added.illustrations[0].media_url).toBe('raw.png');
    expect(added.illustrations[0].is_selected).toBe(true);
    expect(added.crops).toHaveLength(2);
    expect(added.crops.every((c) => !c.is_selected)).toBe(true); // 0 picked — user chooses
    expect(mockedCut.mock.calls[0][0]).toMatchObject({
      imageUrl: 'raw.png',
      cellCount: 2, // ⚡ stage sheets are 2 cells
      pathPrefix: 'sketches/base/stages/forest',
    });
    expect(autoSaveSnapshot).toHaveBeenCalled();
    expect(store.getState().stageSheetGenerateOp).toBeNull();
  });

  it("mode 'add' FAILURE before any raw lands → the appended style is rolled back", async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    mockedBaseGen.mockResolvedValueOnce({ success: false, error: 'boom', errorCode: 'LLM_ERROR' } as any);

    store.getState().startStageBaseSheetGenerate(BASE_PARAMS);
    await tick();
    await tick();

    expect(stageOf(store).base.styles).toHaveLength(1); // orphan add rolled back
    expect(store.getState().stageSheetGenerateOp?.error).toContain('image model');
    store.getState().dismissStageSheetGenerateError();
    expect(store.getState().stageSheetGenerateOp).toBeNull();
  });

  it('single-flight: a second start while an op runs is a no-op', async () => {
    const dGen = deferred<GenerateBaseStageSheetResult>();
    mockedBaseGen.mockReturnValueOnce(dGen.promise as never);

    store.getState().startStageBaseSheetGenerate(BASE_PARAMS);
    await tick();
    store.getState().startStageBaseSheetGenerate({ ...BASE_PARAMS, stageKey: 'forest' });
    expect(mockedBaseGen).toHaveBeenCalledTimes(1);

    dGen.resolve(okBaseGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png']));
    await tick();
  });

  it('COLLAB: persists the RESULT via the gateway helper with releaseIfAcquired:true', async () => {
    h.lockState.collabPersist = true;
    mockedBaseGen.mockResolvedValueOnce(okBaseGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png']));

    store.getState().startStageBaseSheetGenerate(BASE_PARAMS);
    await tick();
    await tick();
    await tick();

    expect(h.flushStage).toHaveBeenCalledWith('forest', expect.any(Object), { releaseIfAcquired: true });
    expect(autoSaveSnapshot).not.toHaveBeenCalled();
  });

  it('opStale: op reset mid-generate → nothing written, cut never called', async () => {
    const dGen = deferred<GenerateBaseStageSheetResult>();
    mockedBaseGen.mockReturnValueOnce(dGen.promise as never);

    store.getState().startStageBaseSheetGenerate(BASE_PARAMS);
    await tick();
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    store.setState((s: any) => {
      s.stageSheetGenerateOp = null;
    });
    dGen.resolve(okBaseGen('raw.png'));
    await tick();
    await tick();

    expect(stageOf(store).base.styles[1]?.illustrations ?? []).toHaveLength(0); // appended style got no raw
    expect(mockedCut).not.toHaveBeenCalled();
  });
});

describe('startStageVariantSheetGenerate (12 — SNAPSHOT-READING)', () => {
  let store: ReturnType<typeof createTestStore>['store'];
  let flushSnapshot: ReturnType<typeof createTestStore>['flushSnapshot'];

  beforeEach(() => {
    mockedBaseGen.mockReset();
    mockedVariantGen.mockReset();
    mockedCut.mockReset();
    h.lockState.collabPersist = false;
    h.flushStage.mockReset().mockResolvedValue(true);
    ({ store, flushSnapshot } = createTestStore('snap-1', [readyStage()]));
  });

  it('SOLO: flushes the snapshot BEFORE generate; payload = {snapshotId, entityKey, variantKey} only', async () => {
    mockedVariantGen.mockResolvedValueOnce(okVariantGen('vraw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['v1.png', 'v2.png']));

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();
    await tick();

    expect(flushSnapshot).toHaveBeenCalled();
    expect(flushSnapshot.mock.invocationCallOrder[0]).toBeLessThan(mockedVariantGen.mock.invocationCallOrder[0]);
    expect(mockedVariantGen.mock.calls[0][0]).toMatchObject({
      snapshotId: 'snap-1',
      entityKey: 'forest',
      variantKey: 'storm',
    }); // ⚡ NO artStyleId — style comes from the BASE_VARIANT anchor
    // Phase 03: saveResource added for BE-first double-write opt-in
    expect(mockedVariantGen.mock.calls[0][0]).toHaveProperty('saveResource');
  });

  it('COLLAB: gateway whole-stage flush BEFORE generate (keeps the lock — no releaseIfAcquired)', async () => {
    h.lockState.collabPersist = true;
    mockedVariantGen.mockResolvedValueOnce(okVariantGen('vraw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['v1.png', 'v2.png']));

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();
    await tick();
    await tick();

    expect(h.flushStage).toHaveBeenCalled();
    // First call = flush-before (no options object → default keep-lock).
    expect(h.flushStage.mock.calls[0][0]).toBe('forest');
    expect(h.flushStage.mock.calls[0][2]).toBeUndefined();
    expect(h.flushStage.mock.invocationCallOrder[0]).toBeLessThan(mockedVariantGen.mock.invocationCallOrder[0]);
    expect(flushSnapshot).not.toHaveBeenCalled();
  });

  it('COLLAB: flush-before FAILS (peer lock) → generate ABORTED, op kept with error', async () => {
    h.lockState.collabPersist = true;
    h.flushStage.mockResolvedValueOnce(false);
    mockedVariantGen.mockResolvedValue(okVariantGen('vraw.png'));

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();
    await tick();

    expect(mockedVariantGen).not.toHaveBeenCalled();
    expect(store.getState().stageSheetGenerateOp?.error).toContain('Could not save before generating');
  });

  it('meta.id == null → toasts + does NOT call generate + keeps the errored op', async () => {
    ({ store } = createTestStore(null, [readyStage()]));
    mockedVariantGen.mockResolvedValue(okVariantGen('vraw.png'));

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();
    await tick();

    const { toast } = await import('sonner');
    expect(mockedVariantGen).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Save the book first, then generate.');
    expect(store.getState().stageSheetGenerateOp?.error).toBe('Save the book first, then generate.');
  });

  it('writes the variant sheet (prepend, selected) + 2 unpicked cells with the variant pathPrefix', async () => {
    mockedVariantGen.mockResolvedValueOnce(okVariantGen('vraw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['v1.png', 'v2.png']));

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();
    await tick();
    await tick();

    const storm = stormOf(store);
    expect(storm.illustrations[0].media_url).toBe('vraw.png');
    expect(storm.illustrations[0].is_selected).toBe(true);
    expect(storm.crops.map((c) => c.illustrations[0].media_url)).toEqual(['v1.png', 'v2.png']);
    expect(storm.crops.every((c) => !c.is_selected)).toBe(true);
    expect(mockedCut.mock.calls[0][0]).toMatchObject({
      cellCount: 2,
      pathPrefix: 'sketches/variants/stages/forest/storm',
    });
    expect(store.getState().stageSheetGenerateOp).toBeNull();
  });

  it('FE gate mirrors 422: base chain broken → BASE_NOT_READY toast, no op, no api call', async () => {
    const broken = readyStage();
    broken.base.styles[0].is_selected = false; // break the chain (no locked style)
    ({ store } = createTestStore('snap-1', [broken]));

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();

    const { toast } = await import('sonner');
    expect(mockedVariantGen).not.toHaveBeenCalled();
    expect(store.getState().stageSheetGenerateOp).toBeNull();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Lock a base style'));
  });

  it('FE gate mirrors 422: both text fields empty → EMPTY_VARIANT_DESCRIPTION toast, no api call', async () => {
    const s = readyStage();
    const storm = s.variants.find((v) => v.key === 'storm')!;
    storm.visual_design = '';
    storm.art_language = '  ';
    ({ store } = createTestStore('snap-1', [s]));

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();

    const { toast } = await import('sonner');
    expect(mockedVariantGen).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('no visual description'));
  });

  it("variantKey 'base' → CANNOT_GENERATE_BASE_VARIANT gate (base generates via the style workspace)", async () => {
    store.getState().startStageVariantSheetGenerate('forest', 'base');
    await tick();
    const { toast } = await import('sonner');
    expect(mockedVariantGen).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Base section'));
  });

  it('classified error kept on the op until dismiss (BASE_NOT_READY from the backend)', async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    mockedVariantGen.mockResolvedValueOnce({ success: false, error: 'x', errorCode: 'BASE_NOT_READY' } as any);

    store.getState().startStageVariantSheetGenerate('forest', 'storm');
    await tick();
    await tick();

    expect(store.getState().stageSheetGenerateOp?.error).toContain('Lock a base style');
    store.getState().dismissStageSheetGenerateError();
    expect(store.getState().stageSheetGenerateOp).toBeNull();
  });
});

describe('recropStageBaseSheet / recropStageVariantSheet (cut-only re-runs)', () => {
  let store: ReturnType<typeof createTestStore>['store'];

  beforeEach(() => {
    mockedBaseGen.mockReset();
    mockedVariantGen.mockReset();
    mockedCut.mockReset();
    h.lockState.collabPersist = false;
    h.flushStage.mockReset().mockResolvedValue(true);
    ({ store } = createTestStore('snap-1', [readyStage()]));
  });

  it('base recrop cuts from the effective raw and OVERWRITES crops (0 picked) — clone clears', async () => {
    mockedCut.mockResolvedValueOnce(okCut(['n1.png', 'n2.png']));

    store.getState().recropStageBaseSheet('forest', 0);
    expect(store.getState().stageSheetGenerateOp?.phase).toBe('cut'); // skips 'generate'
    await tick();
    await tick();

    const style = stageOf(store).base.styles[0];
    expect(style.crops.map((c) => c.illustrations[0].media_url)).toEqual(['n1.png', 'n2.png']);
    expect(style.crops.every((c) => !c.is_selected)).toBe(true);
    // The locked style's re-cut broke the chain → the base-variant clone cleared (via the setter).
    expect(stageOf(store).variants.find((v) => v.key === 'base')!.crops).toEqual([]);
    expect(mockedCut.mock.calls[0][0]).toMatchObject({ imageUrl: 'sheet.png', cellCount: 2 });
  });

  it('variant recrop: no raw sheet → no api call, no op', () => {
    store.getState().recropStageVariantSheet('forest', 'storm'); // storm has no illustrations
    expect(mockedCut).not.toHaveBeenCalled();
    expect(store.getState().stageSheetGenerateOp).toBeNull();
  });

  it('recrop blocked while an op is running → warning toast, previous crops kept', async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    store.setState((s: any) => {
      s.stageSheetGenerateOp = {
        target: { stageKey: 'forest', target: 'base', styleIndex: 0 },
        phase: 'generate',
        startedAt: 'now',
      };
    });
    store.getState().recropStageBaseSheet('forest', 0);
    const { toast } = await import('sonner');
    expect(mockedCut).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Still processing'));
  });

  it('cut failure keeps the PREVIOUS crops + classifies the error', async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    mockedCut.mockResolvedValueOnce({ success: false, error: 'x', errorCode: 'ALL_CROPS_FAILED' } as any);

    store.getState().recropStageBaseSheet('forest', 0);
    await tick();
    await tick();

    const style = stageOf(store).base.styles[0];
    expect(style.crops[0].illustrations[0].media_url).toBe('base-crop.png'); // untouched
    expect(store.getState().stageSheetGenerateOp?.error).toContain('Could not cut any cell');
  });

  it('geometry warning is non-fatal: toasts, crops still written, op finalized', async () => {
    mockedCut.mockResolvedValueOnce(okCut(['n1.png', 'n2.png'], { geoFallbackCount: 1 }));

    store.getState().recropStageBaseSheet('forest', 0);
    await tick();
    await tick();

    const { toast } = await import('sonner');
    expect(toast.warning).toHaveBeenCalledWith('Some cells may be misaligned');
    expect(stageOf(store).base.styles[0].crops).toHaveLength(2);
    expect(store.getState().stageSheetGenerateOp).toBeNull();
  });

  describe('saveResource wiring — opt-in BE-first double-write', () => {
    it('passes saveResource with correct stage variant anchor', async () => {
      const stageForTest = readyStage();
      const { store } = createTestStore('snap-stage', [stageForTest]);
      mockedVariantGen.mockResolvedValueOnce(okVariantGen('gen.png'));
      mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png']));

      store.getState().startStageVariantSheetGenerate('forest', 'storm');
      await tick();
      await tick();

      const genArg = mockedVariantGen.mock.calls[0][0];
      expect(genArg.saveResource).toMatchObject({
        type: 'image_version',
        path: expect.stringContaining('table:snapshots/id:snap-stage/col:sketch/key:stages/find:key=forest/key:variants/find:key=storm'),
        action: 'create',
      });
    });

    it('omits saveResource when snapshotId is null (not opted in)', async () => {
      const stageForTest = readyStage();
      const { store } = createTestStore(null, [stageForTest]);
      mockedVariantGen.mockResolvedValueOnce(okVariantGen('gen.png'));
      mockedCut.mockResolvedValueOnce(okCut(['c1.png']));

      store.getState().startStageVariantSheetGenerate('forest', 'storm');
      await tick();
      await tick();

      // When snapshotId is null, generate should not be called
      expect(mockedVariantGen).not.toHaveBeenCalled();
    });
  });
});
