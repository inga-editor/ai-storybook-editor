import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSketchSlice } from './sketch-slice';
import {
  createSketchVariantGenerateJobSlice,
  VARIANT_GENERATE_CONCURRENCY_CAP,
} from './sketch-variant-generate-job-slice';
import type { SketchEntity } from '@/types/sketch';
import {
  callGenerateVariantSheet,
  callCropSheetRow,
  type GenerateVariantSheetResult,
  type CropSheetRowResult,
} from '@/apis/sketch-variant-api';

// Mock the sonner toast (no-snapshot + geo-warning paths toast) + the api-client seam.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/apis/sketch-variant-api', () => ({
  callGenerateVariantSheet: vi.fn(),
  callCropSheetRow: vi.fn(),
}));
const mockedGen = vi.mocked(callGenerateVariantSheet);
const mockedCut = vi.mocked(callCropSheetRow);

// Isolate resource-lock (mutable collabPersist toggles the solo flushSnapshot vs collab gateway path)
// + the collab whole-node flush helper (mocked to assert ordering + abort). This unit test imports the
// slice DIRECTLY (bypassing snapshot-store/index), so the real modules would close the slice ↔ store cycle.
const h = vi.hoisted(() => ({
  lockState: { collabPersist: false as boolean, bookId: undefined as string | undefined },
  // ⚡ phase-3: flushSketchEntityUnderLock now delegates to ensureSaved → returns a SaveOutcome.
  flushEntity: vi.fn(async (_k: string, _e: string) => 'saved' as string),
  // ⚡ phase-2: flush-before-generate is now a single `ensureSaved` (engine internalizes solo/collab).
  ensureSaved: vi.fn(async (_domain: string, _id: string) => 'saved' as string),
  // ⚡ M1: persist-after rebases the held baseline on a landed save (prevents release double-write).
  rebaseBaseline: vi.fn((_key: string) => {}),
}));
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.lockState },
  keyOf: (b: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${b}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
}));
vi.mock('./collab-sketch-variant-save-helper', () => ({
  flushSketchEntityUnderLock: h.flushEntity,
  resolveSketchVariantLockTarget: (kind: string, key: string) => ({
    step: 1,
    resource_type: kind === 'props' ? 4 : 3,
    resource_id: key,
    locale: null,
  }),
}));
// The save engine is imported dynamically by the slice; mock its ensureSaved (the save-before-generate
// gate) + rebaseBaseline (persist-after). makeEntityId is imported from the PURE entity-id submodule.
vi.mock('@/stores/save-session-store', () => ({
  useSaveSessionStore: { getState: () => ({ ensureSaved: h.ensureSaved, rebaseBaseline: h.rebaseBaseline }) },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
// Isolated harness: sketch slice (state + per-variant setters) + the variant-job slice, plus the only
// cross-slice deps runGenerate touches — sync, meta.id (snapshotId after the awaited flush),
// flushSnapshot (awaited; stubbed no-op) and autoSaveSnapshot (fire-and-forget; stubbed no-op).
function createTestStore(metaId: string | null = 'snap-1') {
  const flushSnapshot = vi.fn(async () => {});
  const autoSaveSnapshot = vi.fn(async () => {});
  const store = create<any>()(
    immer((...a: any[]) => ({
      ...(createSketchSlice as any)(...a),
      ...(createSketchVariantGenerateJobSlice as any)(...a),
      sync: { isDirty: false, isSaving: false },
      meta: { id: metaId },
      flushSnapshot,
      autoSaveSnapshot,
    })),
  );
  return { store, flushSnapshot, autoSaveSnapshot };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Drain microtasks by yielding a macrotask.
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

const REF = { kind: 'characters', entityKey: 'kid', variantKey: 'hero' } as const;
const KEY = 'characters|kid|hero';
const REF2 = { kind: 'props', entityKey: 'sword', variantKey: 'gold' } as const;
const KEY2 = 'props|sword|gold';

// Entity carrying a base + a non-base 'hero' variant (setters no-op if the variant is absent).
const entityWithVariant = (): SketchEntity => ({
  key: 'kid',
  variants: [
    { key: 'base', description: '', visual_design: '', art_language: '' },
    { key: 'hero', description: '', visual_design: 'brave knight', art_language: '' },
  ],
});

const okGen = (imageUrl: string): GenerateVariantSheetResult => ({
  success: true,
  data: {
    imageUrl,
    storagePath: `p/${imageUrl}`,
    entityKey: 'kid',
    variantKey: 'hero',
    grid: { cols: 4, rows: 1, aspectRatio: '21:9', cellCount: 4 },
  },
});

const okCut = (
  urls: string[],
  meta?: CropSheetRowResult['meta'],
): CropSheetRowResult => ({
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
    sheetDimensions: { width: 100, height: 50 },
  },
  meta,
});

const variantHero = (store: ReturnType<typeof createTestStore>['store']) =>
  store.getState().sketch.characters.find((e: SketchEntity) => e.key === 'kid')!.variants.find(
    (v: { key: string }) => v.key === 'hero',
  )!;

// Warm the (mocked) save-session-store module so the slice's first dynamic `import()` resolves in a
// microtask — otherwise the very first save-before-generate test races the cold module load.
beforeAll(async () => {
  await import('@/stores/save-session-store');
});

describe('SketchVariantGenerateJobSlice', () => {
  let store: ReturnType<typeof createTestStore>['store'];
  let autoSaveSnapshot: ReturnType<typeof createTestStore>['autoSaveSnapshot'];

  beforeEach(() => {
    mockedGen.mockReset();
    mockedCut.mockReset();
    h.lockState.collabPersist = false; // default: solo path (legacy flushSnapshot)
    h.lockState.bookId = undefined;
    h.flushEntity.mockReset().mockResolvedValue('saved');
    h.ensureSaved.mockReset().mockResolvedValue('saved');
    h.rebaseBaseline.mockReset();
    ({ store, autoSaveSnapshot } = createTestStore());
    store.getState().setSketchEntities('characters', [entityWithVariant()]);
  });

  it('(a) save-before-generate: ensureSaved runs BEFORE generate; payload has NO artStyleId', async () => {
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick(); // 2nd macrotask: the dynamic import of the save engine resolves before generate

    // ⚡ phase-2: the solo/collab flush fork is now internal to ensureSaved (asserted in
    // ensure-saved.test.ts). At this layer we assert the gate ran on the right entity, before generate.
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-entity', 'characters/kid');
    expect(mockedGen).toHaveBeenCalledTimes(1);
    expect(h.ensureSaved.mock.invocationCallOrder[0]).toBeLessThan(
      mockedGen.mock.invocationCallOrder[0],
    );
    // ⚡ ADR-047 contract: snapshot-reading payload carries snapshotId + keys ONLY (artStyleId dropped).
    expect(mockedGen.mock.calls[0][0]).toBe('characters'); // kind dispatch
    expect(mockedGen.mock.calls[0][1]).toMatchObject({
      snapshotId: 'snap-1',
      entityKey: 'kid',
      variantKey: 'hero',
    });
    expect(mockedGen.mock.calls[0][1]).not.toHaveProperty('artStyleId');
    // Phase 03: saveResource added for BE-first double-write opt-in
    expect(mockedGen.mock.calls[0][1]).toHaveProperty('saveResource');
  });

  it('(a2) COLLAB: ensureSaved runs BEFORE generate (engine handles the gateway flush)', async () => {
    h.lockState.collabPersist = true;
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();

    // Risk #1: the entity node is persisted (via the engine) BEFORE the AI reads the DB.
    expect(h.ensureSaved).toHaveBeenCalledWith('sketch-entity', 'characters/kid');
    expect(mockedGen).toHaveBeenCalledTimes(1);
    expect(h.ensureSaved.mock.invocationCallOrder[0]).toBeLessThan(mockedGen.mock.invocationCallOrder[0]);
  });

  it('(a3) save-before FAILS (peer lock) → generate ABORTED, op kept with error', async () => {
    h.lockState.collabPersist = true;
    h.ensureSaved.mockResolvedValueOnce('blocked'); // peer holds the entity / save rejected
    mockedGen.mockResolvedValue(okGen('raw.png'));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();

    expect(h.ensureSaved).toHaveBeenCalled();
    expect(mockedGen).not.toHaveBeenCalled(); // never burn AI tokens on a stale / peer-owned node
    expect(store.getState().variantSheetGenerateOps[KEY]?.error).toContain('Could not save before generating');
  });

  it('(a4) COLLAB: persists the RESULT via the gateway helper (not autoSaveSnapshot)', async () => {
    h.lockState.collabPersist = true;
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();
    await tick();

    // persist-AFTER-crops fires through the gateway helper (flush-before is now ensureSaved, mocked).
    expect(h.flushEntity).toHaveBeenCalled();
    expect(autoSaveSnapshot).not.toHaveBeenCalled(); // collab never dual-writes via autosave
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
  });

  it('(a5) persist-after routes through the engine seam (ensureSaved rebases the baseline internally)', async () => {
    h.lockState.collabPersist = true;
    h.lockState.bookId = 'book1';
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();
    await tick();
    await tick();

    // ⚡ phase-3: persist-after is a single `flushSketchEntityUnderLock(kind, key)` → engine `ensureSaved`
    // (which rebases the held baseline itself). The slice no longer rebases directly, and never passes
    // a node / releaseIfAcquired — the engine owns the lock lifecycle.
    expect(h.flushEntity).toHaveBeenCalledWith('characters', 'kid');
    expect(h.rebaseBaseline).not.toHaveBeenCalled();
  });

  it('(b) meta.id == null → toasts + does NOT call generate + keeps the errored op', async () => {
    ({ store } = createTestStore(null)); // meta.id stays null after the save-before gate
    store.getState().setSketchEntities('characters', [entityWithVariant()]);
    mockedGen.mockResolvedValue(okGen('raw.png'));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();

    const { toast } = await import('sonner');
    expect(h.ensureSaved).toHaveBeenCalled();
    expect(mockedGen).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Save the book first, then generate.');
    // op kept (error set) so the notifications hook can surface it.
    expect(store.getState().variantSheetGenerateOps[KEY]).not.toBeUndefined();
    expect(store.getState().variantSheetGenerateOps[KEY]?.error).toBe('Save the book first, then generate.');
  });

  it('(c) advances phase generate → cut', async () => {
    const dGen = deferred<GenerateVariantSheetResult>();
    const dCut = deferred<CropSheetRowResult>();
    mockedGen.mockReturnValueOnce(dGen.promise as never);
    mockedCut.mockReturnValueOnce(dCut.promise as never);

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    expect(store.getState().variantSheetGenerateOps[KEY]?.phase).toBe('generate');

    dGen.resolve(okGen('raw.png'));
    await tick();
    expect(store.getState().variantSheetGenerateOps[KEY]?.phase).toBe('cut');

    dCut.resolve(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));
    await tick();
    // op finalized to null after a clean run.
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
  });

  it('(d) writes raw (prepend, selected) + crops via the setters with the right pathPrefix', async () => {
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();
    await tick();

    const hero = variantHero(store);
    // Raw sheet: 1 version, prepended + selected.
    expect(hero.raw_sheet.illustrations).toHaveLength(1);
    expect(hero.raw_sheet.illustrations[0].media_url).toBe('raw.png');
    expect(hero.raw_sheet.illustrations[0].is_selected).toBe(true);
    // Crops: 4 positional cells, one canonical illustration each.
    expect(hero.raw_sheet.crops).toHaveLength(4);
    expect(hero.raw_sheet.crops.map((c: { illustrations: { media_url: string }[] }) => c.illustrations[0].media_url)).toEqual([
      'c1.png',
      'c2.png',
      'c3.png',
      'c4.png',
    ]);
    // Cut endpoint got the derived pathPrefix + fixed cellCount 4.
    expect(mockedCut.mock.calls[0][0]).toMatchObject({
      imageUrl: 'raw.png',
      cellCount: 4,
      pathPrefix: 'sketches/variants/characters/kid/hero',
    });
    // Durability persist fired (phase-3: via the engine seam, not a direct autoSaveSnapshot).
    expect(h.flushEntity).toHaveBeenCalledWith('characters', 'kid');
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
  });

  it('(e) crops are NOT auto-locked (cell.is_selected=false, inner illustration selected)', async () => {
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();
    await tick();

    const crops = variantHero(store).raw_sheet.crops;
    expect(crops.every((c: { is_selected: boolean }) => c.is_selected === false)).toBe(true);
    expect(crops.every((c: { illustrations: { is_selected: boolean }[] }) => c.illustrations[0].is_selected === true)).toBe(true);
  });

  it('(f) per-variant single-flight: a second start for the SAME variant is a no-op', async () => {
    const dGen = deferred<GenerateVariantSheetResult>();
    mockedGen.mockReturnValueOnce(dGen.promise as never);

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    expect(mockedGen).toHaveBeenCalledTimes(1);

    store.getState().startVariantSheetGenerate(REF);
    expect(mockedGen).toHaveBeenCalledTimes(1); // still 1
    expect(store.getState().variantSheetGenerateOps[KEY]?.entityKey).toBe('kid'); // original op unchanged

    dGen.resolve(okGen('raw.png'));
    await tick();
  });

  it('(f2) parallel: a DIFFERENT variant starts while the first is in flight', async () => {
    const dGen = deferred<GenerateVariantSheetResult>();
    mockedGen.mockReturnValueOnce(dGen.promise as never);
    mockedGen.mockReturnValueOnce(deferred<GenerateVariantSheetResult>().promise as never);

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    store.getState().startVariantSheetGenerate(REF2);
    await tick();

    expect(mockedGen).toHaveBeenCalledTimes(2);
    const ops = store.getState().variantSheetGenerateOps;
    expect(Object.keys(ops).sort()).toEqual([KEY, KEY2].sort());
    expect(ops[KEY].entityKey).toBe('kid');
    expect(ops[KEY2].entityKey).toBe('sword');

    dGen.resolve(okGen('raw.png'));
    await tick();
  });

  it('(f2b) SAME entity, different variant is BLOCKED — the persist grain is the entity node', async () => {
    // kid has two non-base variants; both would flush the same rtype-3 entity node, so the second
    // must not be admitted (whole-node last-writer-wins + shared-lock release race).
    store.getState().setSketchEntities('characters', [
      {
        key: 'kid',
        variants: [
          { key: 'base', description: '', visual_design: '', art_language: '' },
          { key: 'hero', description: '', visual_design: 'brave knight', art_language: '' },
          { key: 'sad', description: '', visual_design: 'downcast knight', art_language: '' },
        ],
      },
    ]);
    const dGen = deferred<GenerateVariantSheetResult>();
    mockedGen.mockReturnValueOnce(dGen.promise as never);

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    expect(mockedGen).toHaveBeenCalledTimes(1);

    store.getState().startVariantSheetGenerate({
      kind: 'characters',
      entityKey: 'kid',
      variantKey: 'sad',
    });

    expect(mockedGen).toHaveBeenCalledTimes(1); // sibling variant refused
    expect(store.getState().variantSheetGenerateOps['characters|kid|sad']).toBeUndefined();
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeDefined();

    dGen.resolve(okGen('raw.png'));
    await tick();
  });

  it('(f2c) recrop is refused while a SIBLING variant of the same entity runs', async () => {
    store.getState().setSketchVariantRawSheetIllustrations('characters', 'kid', 'hero', [
      {
        type: 'created' as const,
        media_url: 'raw.png',
        created_time: '2026-07-15T00:00:00Z',
        is_selected: true,
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setState((s: any) => {
      s.variantSheetGenerateOps['characters|kid|sad'] = {
        kind: 'characters',
        entityKey: 'kid',
        variantKey: 'sad',
        phase: 'generate',
        startedAt: 'now',
      };
    });

    store.getState().recropVariantSheet(REF);

    expect(mockedCut).not.toHaveBeenCalled();
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
  });

  it('(f3) client cap: the op past VARIANT_GENERATE_CONCURRENCY_CAP is dropped', async () => {
    // Cap-many in-flight ops, planted directly (each would otherwise need its own deferred chain).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setState((s: any) => {
      for (let i = 0; i < VARIANT_GENERATE_CONCURRENCY_CAP; i++) {
        s.variantSheetGenerateOps[`characters|filler${i}|v`] = {
          kind: 'characters',
          entityKey: `filler${i}`,
          variantKey: 'v',
          phase: 'generate',
          startedAt: 'now',
        };
      }
    });

    store.getState().startVariantSheetGenerate(REF);

    expect(mockedGen).not.toHaveBeenCalled();
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
    expect(Object.keys(store.getState().variantSheetGenerateOps)).toHaveLength(
      VARIANT_GENERATE_CONCURRENCY_CAP,
    );
  });

  it('(f4) finalize drops ONLY its own key — a sibling op survives', async () => {
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png']));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setState((s: any) => {
      s.variantSheetGenerateOps[KEY2] = {
        kind: 'props',
        entityKey: 'sword',
        variantKey: 'gold',
        phase: 'generate',
        startedAt: 'now',
      };
    });

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();
    await tick();

    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined(); // finished → dropped
    expect(store.getState().variantSheetGenerateOps[KEY2]).toBeDefined(); // sibling untouched
  });

  it('(g) error path keeps the op (with friendly message) until dismiss clears it', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockedGen.mockResolvedValueOnce({ success: false, error: 'boom', errorCode: 'LLM_ERROR' } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();

    const op = store.getState().variantSheetGenerateOps[KEY];
    expect(op).not.toBeUndefined();
    expect(op?.error).toContain('image model'); // LLM_ERROR friendly copy
    // No crops/raw written on a generate failure.
    expect(variantHero(store).raw_sheet).toBeUndefined();
    expect(mockedCut).not.toHaveBeenCalled();

    store.getState().dismissVariantSheetGenerateError(REF);
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
  });

  it('opStale: op reset mid-generate → raw + crops NOT written, cut never called', async () => {
    const dGen = deferred<GenerateVariantSheetResult>();
    mockedGen.mockReturnValueOnce(dGen.promise as never);

    store.getState().startVariantSheetGenerate(REF);
    await tick();

    // Simulate resetSnapshot clearing the op while the generate call is in flight.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setState((s: any) => {
      s.variantSheetGenerateOps = {};
    });
    dGen.resolve(okGen('raw.png'));
    await tick();
    await tick();

    expect(variantHero(store).raw_sheet).toBeUndefined(); // no raw written
    expect(mockedCut).not.toHaveBeenCalled(); // opStale bailed before the cut phase
  });

  it('non-fatal: geoFallback/fullbleed warning toasts but still writes crops', async () => {
    mockedGen.mockResolvedValueOnce(okGen('raw.png'));
    mockedCut.mockResolvedValueOnce(
      okCut(['c1.png', 'c2.png', 'c3.png', 'c4.png'], { geoFallbackCount: 2, fullbleedWarning: true }),
    );

    store.getState().startVariantSheetGenerate(REF);
    await tick();
    await tick();
    await tick();

    const { toast } = await import('sonner');
    expect(toast.warning).toHaveBeenCalledWith('Some cells may be misaligned');
    expect(variantHero(store).raw_sheet.crops).toHaveLength(4); // crops still written
    expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined(); // warning is non-fatal → op finalized
  });

  // ── recropVariantSheet: cut-only re-run (Raw-tab edit commit → crops stale) ───────────────────────
  describe('recropVariantSheet', () => {
    const rawIllustrations = (
      entries: { media_url: string; is_selected: boolean; created_time?: string }[],
    ) =>
      entries.map((e) => ({
        type: 'created' as const,
        media_url: e.media_url,
        created_time: e.created_time ?? '2026-07-15T00:00:00Z',
        is_selected: e.is_selected,
      }));

    const oldCrop = (url: string) => [
      {
        is_selected: true,
        illustrations: [
          { type: 'created' as const, media_url: url, created_time: '2026-07-13T00:00:00Z', is_selected: true },
        ],
      },
    ];

    it('(h) happy path: overwrites crops[] with 4 unpicked cells cut from the effective raw url', async () => {
      store.getState().setSketchVariantRawSheetIllustrations(
        'characters',
        'kid',
        'hero',
        rawIllustrations([{ media_url: 'raw.png', is_selected: true }]),
      );
      // Seed a stale crop set that must be fully replaced.
      store.getState().setSketchVariantCrops('characters', 'kid', 'hero', oldCrop('old.png'));
      mockedCut.mockResolvedValueOnce(okCut(['n1.png', 'n2.png', 'n3.png', 'n4.png']));

      store.getState().recropVariantSheet(REF);
      expect(store.getState().variantSheetGenerateOps[KEY]?.phase).toBe('cut'); // skips 'generate'
      await tick();
      await tick();

      expect(mockedCut).toHaveBeenCalledTimes(1);
      expect(mockedCut.mock.calls[0][0]).toMatchObject({
        imageUrl: 'raw.png',
        cellCount: 4,
        pathPrefix: 'sketches/variants/characters/kid/hero',
      });
      const crops = variantHero(store).raw_sheet.crops;
      expect(crops).toHaveLength(4);
      expect(crops.map((c: { illustrations: { media_url: string }[] }) => c.illustrations[0].media_url)).toEqual([
        'n1.png',
        'n2.png',
        'n3.png',
        'n4.png',
      ]);
      expect(crops.every((c: { is_selected: boolean }) => c.is_selected === false)).toBe(true);
      expect(crops.every((c: { illustrations: { is_selected: boolean }[] }) => c.illustrations[0].is_selected === true)).toBe(true);
      // Raw sheet itself is untouched by a cut-only re-run.
      expect(variantHero(store).raw_sheet.illustrations[0].media_url).toBe('raw.png');
      expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
    });

    it('(i) guard: no raw sheet (no effective url) → no api call, no op set', () => {
      // Fresh entityWithVariant fixture: hero variant has no raw_sheet at all.
      store.getState().recropVariantSheet(REF);
      expect(mockedCut).not.toHaveBeenCalled();
      expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
    });

    it('(j) single-flight: blocked while an op is already running', () => {
      store.getState().setSketchVariantRawSheetIllustrations(
        'characters',
        'kid',
        'hero',
        rawIllustrations([{ media_url: 'raw.png', is_selected: true }]),
      );
      // Simulate an in-flight op (e.g. a generate op) without resolving it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.setState((s: any) => {
        s.variantSheetGenerateOps[KEY] = {
          kind: 'characters',
          entityKey: 'kid',
          variantKey: 'hero',
          phase: 'generate',
          startedAt: 'now',
        };
      });

      store.getState().recropVariantSheet(REF);

      expect(mockedCut).not.toHaveBeenCalled();
      expect(store.getState().variantSheetGenerateOps[KEY]?.phase).toBe('generate'); // unchanged, never set to 'cut'
    });

    it('(k) failure: callCropSheetRow fails → op keeps a classified error, PREVIOUS crops[] unchanged', async () => {
      store.getState().setSketchVariantRawSheetIllustrations(
        'characters',
        'kid',
        'hero',
        rawIllustrations([{ media_url: 'raw.png', is_selected: true }]),
      );
      store.getState().setSketchVariantCrops('characters', 'kid', 'hero', oldCrop('old.png'));
      /* eslint-disable @typescript-eslint/no-explicit-any */
      mockedCut.mockResolvedValueOnce({ success: false, error: 'boom', errorCode: 'ALL_CROPS_FAILED' } as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */

      store.getState().recropVariantSheet(REF);
      await tick();
      await tick();

      const op = store.getState().variantSheetGenerateOps[KEY];
      expect(op).not.toBeUndefined();
      expect(op?.error).toContain('Could not cut any cell'); // ALL_CROPS_FAILED friendly copy
      // Previous crops preserved verbatim — runCut only writes crops[] on success.
      const crops = variantHero(store).raw_sheet.crops;
      expect(crops).toHaveLength(1);
      expect(crops[0].illustrations[0].media_url).toBe('old.png');
    });

    it('(l) persist-after ALWAYS fires, even on cut failure — via the engine seam (phase-3)', async () => {
      store.getState().setSketchVariantRawSheetIllustrations(
        'characters',
        'kid',
        'hero',
        rawIllustrations([{ media_url: 'raw.png', is_selected: true }]),
      );
      /* eslint-disable @typescript-eslint/no-explicit-any */
      mockedCut.mockResolvedValueOnce({ success: false, error: 'boom', errorCode: 'ALL_CROPS_FAILED' } as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */

      store.getState().recropVariantSheet(REF);
      await tick();
      await tick();

      // ⚡ phase-3: the solo/collab fork is internal to the engine seam — persist-after is always the
      // same `flushSketchEntityUnderLock(kind, key)` call (the engine picks whole-snapshot flush in solo).
      expect(h.flushEntity).toHaveBeenCalledWith('characters', 'kid');
      expect(autoSaveSnapshot).not.toHaveBeenCalled();
    });

    it('(m) persist-after COLLAB: flushSketchEntityUnderLock called (engine owns the lock lifecycle)', async () => {
      h.lockState.collabPersist = true;
      store.getState().setSketchVariantRawSheetIllustrations(
        'characters',
        'kid',
        'hero',
        rawIllustrations([{ media_url: 'raw.png', is_selected: true }]),
      );
      mockedCut.mockResolvedValueOnce(okCut(['n1.png', 'n2.png', 'n3.png', 'n4.png']));

      store.getState().recropVariantSheet(REF);
      await tick();
      await tick();

      // No node arg, no releaseIfAcquired — the engine reads the fresh node + decides the lifecycle.
      expect(h.flushEntity).toHaveBeenCalledWith('characters', 'kid');
      expect(autoSaveSnapshot).not.toHaveBeenCalled();
      expect(store.getState().variantSheetGenerateOps[KEY]).toBeUndefined();
    });

    it('(n) effective-url precedence: is_selected version wins over the newest (index 0) entry', async () => {
      // index 0 = "newest" by prepend convention but NOT selected; index 1 = older but is_selected.
      store.getState().setSketchVariantRawSheetIllustrations(
        'characters',
        'kid',
        'hero',
        rawIllustrations([
          { media_url: 'newest.png', is_selected: false, created_time: '2026-07-15T00:00:00Z' },
          { media_url: 'selected.png', is_selected: true, created_time: '2026-07-14T00:00:00Z' },
        ]),
      );
      mockedCut.mockResolvedValueOnce(okCut(['n1.png', 'n2.png', 'n3.png', 'n4.png']));

      store.getState().recropVariantSheet(REF);
      await tick();
      await tick();

      expect(mockedCut.mock.calls[0][0]).toMatchObject({ imageUrl: 'selected.png' });
    });
  });

  describe('saveResource wiring — opt-in BE-first double-write', () => {
    const rawIllustrations = (
      entries: { media_url: string; is_selected: boolean; created_time?: string }[] = [
        { media_url: 'raw.png', is_selected: true },
      ],
    ) =>
      entries.map((e) => ({
        type: 'created' as const,
        media_url: e.media_url,
        created_time: e.created_time ?? '2026-07-15T00:00:00Z',
        is_selected: e.is_selected,
      }));

    it('passes saveResource with correct variant raw_sheet anchor for character', async () => {
      const { store } = createTestStore('snap-var');
      store.getState().setSketchVariantRawSheetIllustrations('characters', 'hero', 'cool', rawIllustrations());
      mockedGen.mockResolvedValueOnce(okGen('gen.png'));
      mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png']));

      store.getState().startVariantSheetGenerate({
        kind: 'characters',
        entityKey: 'hero',
        variantKey: 'cool',
        visualDescription: 'cool variant',
        referenceImages: [],
        baseVariantImageUrl: 'base.png',
        artStyleId: 'style-1',
      });
      await tick();

      // mockedGen is called with (kind, params), second arg is the params object
      expect(mockedGen.mock.calls[0][0]).toBe('characters');
      expect(mockedGen.mock.calls[0][1]).toMatchObject({
        saveResource: expect.objectContaining({
          type: 'image_version',
          path: expect.stringContaining('table:snapshots/id:snap-var/col:sketch/key:characters/find:key=hero/key:variants/find:key=cool/key:raw_sheet'),
          action: 'create',
        }),
      });
    });

    it('passes saveResource with correct variant raw_sheet anchor for props', async () => {
      const { store } = createTestStore('snap-prop-var');
      store.getState().setSketchVariantRawSheetIllustrations('props', 'sword', 'rusty', rawIllustrations());
      mockedGen.mockResolvedValueOnce(okGen('gen.png'));
      mockedCut.mockResolvedValueOnce(okCut(['c1.png']));

      store.getState().startVariantSheetGenerate({
        kind: 'props',
        entityKey: 'sword',
        variantKey: 'rusty',
        visualDescription: 'rusty sword',
        referenceImages: [],
        baseVariantImageUrl: 'base.png',
        artStyleId: 'style-1',
      });
      await tick();

      // mockedGen is called with (kind, params), second arg is the params object
      expect(mockedGen.mock.calls[0][0]).toBe('props');
      expect(mockedGen.mock.calls[0][1]).toMatchObject({
        saveResource: expect.objectContaining({
          type: 'image_version',
          path: expect.stringContaining('table:snapshots/id:snap-prop-var/col:sketch/key:props/find:key=sword/key:variants/find:key=rusty/key:raw_sheet'),
          action: 'create',
        }),
      });
    });

    it('omits saveResource when snapshotId is null (not opted in)', async () => {
      const { store } = createTestStore(null);
      store.getState().setSketchVariantRawSheetIllustrations('characters', 'hero', 'cool', rawIllustrations());
      mockedGen.mockResolvedValueOnce(okGen('gen.png'));
      mockedCut.mockResolvedValueOnce(okCut(['c1.png', 'c2.png']));

      store.getState().startVariantSheetGenerate({
        kind: 'characters',
        entityKey: 'hero',
        variantKey: 'cool',
        visualDescription: 'cool variant',
        referenceImages: [],
        baseVariantImageUrl: 'base.png',
        artStyleId: 'style-1',
      });
      await tick();

      // When snapshotId is null, generate should not be called
      expect(mockedGen).not.toHaveBeenCalled();
    });
  });
});
