// crop-sheet-layout-batch.test.ts — Unit tests for the ⚡2026-06-12
// STAGE-GENERIC batch lifecycle + relayout engine helpers (addStageBatch /
// removeStageBatch / relayoutStageBatchSheets / importStageBatch) and the pure
// deriveBatchSwapTask selector helper.
//
// The engine helpers take a decoupled `RelayoutDeps` (set/get over an
// in-memory `{ remixes }` + a faithful stage-keyed `patchRemixCropSheets`
// replaceAll impl) and persist via the `RemixDataGateway` seam, installed here
// with an in-memory fake (records `updateColumns` calls; errors injectable).

import { describe, it, expect, beforeEach } from 'vitest';

import {
  addStageBatch,
  importStageBatch,
  removeStageBatch,
  relayoutStageBatchSheets,
  currentCropsOfBatch,
  type RelayoutDeps,
} from './crop-sheet-layout';
import {
  createFakeRemixGateway,
  type FakeRemixGateway,
} from './gateway/fake-remix-gateway';
import {
  RemixGatewayError,
  setRemixDataGateway,
} from './gateway/remix-data-gateway';
import { deriveBatchSwapTask } from './selectors';
import type { CropSheetUpdate } from './types';
import type { CropEntry, Remix, RemixMix, RemixJob } from '@/types/remix';
import type { SpreadTag } from '@/types/spread-types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function tag(objectKey: string, variant = 'v1'): SpreadTag {
  return { type: 'character', object_key: objectKey, variant_key: variant } as SpreadTag;
}

/** Spread with one subject-tagged image so groupCropsForBatch yields crops. */
function spreadWithCrop(id: string, page: number, layerId: string, objectKey: string) {
  return {
    id,
    pages: [{ number: page, type: 'normal_page', layout: null, background: { color: '#fff', texture: null } }],
    images: [
      {
        id: layerId,
        media_url: `https://cdn/${layerId}.png`,
        aspect_ratio: '1:1',
        geometry: { x: 0, y: 0, w: 40, h: 40 },
        'z-index': 0,
        tags: [tag(objectKey)],
      },
    ],
    auto_pics: [],
    textboxes: [],
  };
}

/** Build a LEAN CropEntry matching the spread fixture (`spreadWithCrop`).
 *  `geometry` carries non-zero dims so the stage-2/3 native path has inputs. */
function makeCropEntry(spreadId: string, layerId: string, objectKey: string): CropEntry {
  return {
    spread_id: spreadId,
    id: layerId,
    tags: [tag(objectKey)],
    media_url: `https://cdn/${layerId}.png`,
    geometry: { x: 0, y: 0, w: 320, h: 240 },
  };
}

/** A batch fixture that can carry a real `original_crops[]` lineup so rev6
 *  subset filters + per-batch relayout have something to work with. */
function makeBatch(
  id: string,
  order: number,
  name: string,
  withSwap = false,
  cropIds: Array<{ spreadId: string; layerId: string; objectKey: string }> = [
    { spreadId: 's1', layerId: 'i1', objectKey: 'c1' },
    { spreadId: 's2', layerId: 'i2', objectKey: 'c1' },
  ],
): RemixMix {
  return {
    id,
    order,
    name,
    crop_sheets: [
      {
        title: 'sheet 1',
        sheet_geometry: { width: 100, height: 100 },
        image_url: '',
        swap_results: withSwap
          ? [
              {
                media_url: 'https://cdn/swap.png',
                created_time: 't',
                is_selected: true,
                crops: cropIds.map((c) => ({
                  spread_id: c.spreadId,
                  id: c.layerId,
                  media_url: `https://cdn/swap-${c.layerId}.png`,
                  is_final: true,
                })),
              },
            ]
          : [],
        original_crops: cropIds.map((c) => makeCropEntry(c.spreadId, c.layerId, c.objectKey)),
      },
    ],
  };
}

function makeRemix(mixes: RemixMix[], rmbgs: RemixMix[] = [], upscales: RemixMix[] = []): Remix {
  return {
    id: 'remix-1',
    characters: [{ key: 'c1', name: 'C1', variants: [] }],
    props: [],
    mixes,
    rmbgs,
    upscales,
    illustration: {
      spreads: [spreadWithCrop('s1', 1, 'i1', 'c1'), spreadWithCrop('s2', 2, 'i2', 'c1')],
      sections: [],
    },
  } as unknown as Remix;
}

/** In-memory deps over a mutable `{ remixes }` with a faithful stage-keyed
 *  replaceAll patchRemixCropSheets (mirrors crud-slice keyed on batch id). */
function makeDeps(remix: Remix): RelayoutDeps & { state: { remixes: Remix[] } } {
  const state = { remixes: [remix] };
  return {
    state,
    dimension: null,
    set: (updater) => {
      const next = updater(state);
      state.remixes = next.remixes;
    },
    get: () => state,
    patchRemixCropSheets: (remixId: string, updates: CropSheetUpdate[]) => {
      state.remixes = state.remixes.map((r) => {
        if (r.id !== remixId) return r;
        const next = { ...r };
        for (const u of updates) {
          if (u.kind === 'replaceAll') {
            next[u.stage] = (next[u.stage] ?? []).map((m) =>
              m.id === u.entityKey ? { ...m, crop_sheets: u.sheets } : m,
            );
          }
        }
        return next;
      });
    },
  };
}

let gw: FakeRemixGateway;
const updateCount = () => gw.calls.filter((c) => c.op === 'updateColumns').length;

beforeEach(() => {
  gw = createFakeRemixGateway();
  setRemixDataGateway(gw);
});

// ── currentCropsOfBatch (helper) ────────────────────────────────────────────

describe('currentCropsOfBatch', () => {
  it('returns deduplicated crops across all sheets of the batch', () => {
    const batch: RemixMix = {
      id: 'b1',
      order: 0,
      name: 'Batch 1',
      crop_sheets: [
        {
          title: 'sheet 1',
          sheet_geometry: { width: 100, height: 100 },
          image_url: '',
          swap_results: [],
          original_crops: [makeCropEntry('s1', 'i1', 'c1'), makeCropEntry('s2', 'i2', 'c1')],
        },
        {
          // Duplicate (s1/i1) on a second sheet — must collapse to ONE entry.
          title: 'sheet 2',
          sheet_geometry: { width: 100, height: 100 },
          image_url: '',
          swap_results: [],
          original_crops: [makeCropEntry('s1', 'i1', 'c1')],
        },
      ],
    };
    const out = currentCropsOfBatch(batch);
    expect(out.map((c) => `${c.spread_id}/${c.id}`)).toEqual(['s1/i1', 's2/i2']);
  });

  it('returns an empty array for a batch with no crops', () => {
    expect(currentCropsOfBatch(makeBatch('b1', 0, 'Batch 1', false, []))).toEqual([]);
  });
});

// ── addStageBatch (rev6 — subset, stage-generic) ────────────────────────────

describe('addStageBatch (rev6 subset)', () => {
  it("stage 'mixes': appends a new batch packed from the SELECTED subset (K=1) + returns new id", async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);

    // Pick only the s1/i1 crop — the new batch must contain ONLY that crop.
    const selection = new Set<string>(['s1/i1']);
    const newId = await addStageBatch(deps, 'remix-1', 'mixes', 'b1', selection);

    expect(newId).not.toBeNull();
    expect(typeof newId).toBe('string');
    expect(newId).not.toBe('b1');

    const mixes = deps.state.remixes[0].mixes;
    expect(mixes).toHaveLength(2);
    const added = mixes[1];
    expect(added.id).toBe(newId);
    expect(added.order).toBe(1);
    expect(added.crop_sheets).toHaveLength(1);
    // Subset filter actually narrowed the lineup.
    const addedKeys = added.crop_sheets[0].original_crops.map(
      (c) => `${c.spread_id}/${c.id}`,
    );
    expect(addedKeys).toEqual(['s1/i1']);
    expect(updateCount()).toBe(1);
  });

  it("stage 'rmbgs': subset packs from the batch's OWN crops at native px — no illustration re-pull", async () => {
    const rmbgBatch = makeBatch('rb1', 0, 'Batch 1');
    const remix = makeRemix([], [rmbgBatch]);
    const deps = makeDeps(remix);

    const newId = await addStageBatch(
      deps,
      'remix-1',
      'rmbgs',
      'rb1',
      new Set<string>(['s2/i2']),
    );
    expect(newId).not.toBeNull();

    const rows = deps.state.remixes[0].rmbgs;
    expect(rows).toHaveLength(2);
    const addedKeys = rows[1].crop_sheets[0].original_crops.map(
      (c) => `${c.spread_id}/${c.id}`,
    );
    expect(addedKeys).toEqual(['s2/i2']);
    // Native-px path: the placed crop keeps its native dims (320×240).
    const placed = rows[1].crop_sheets[0].original_crops[0];
    expect(placed.geometry.w).toBe(320);
    expect(placed.geometry.h).toBe(240);
    // mixes column untouched.
    expect(deps.state.remixes[0].mixes).toHaveLength(0);
  });

  it('throws on empty selection (no UI bug should ever call this with empty)', async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);

    await expect(
      addStageBatch(deps, 'remix-1', 'mixes', 'b1', new Set()),
    ).rejects.toThrow(/non-empty/i);
    // No optimistic push, no persist.
    expect(deps.state.remixes[0].mixes).toHaveLength(1);
    expect(updateCount()).toBe(0);
  });

  it('throws when selection has zero matches against the active batch (stale keys)', async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);

    const stale = new Set<string>(['s9/i9', 's8/i8']);
    await expect(
      addStageBatch(deps, 'remix-1', 'mixes', 'b1', stale),
    ).rejects.toThrow(/stale|match/i);
    expect(deps.state.remixes[0].mixes).toHaveLength(1);
    expect(updateCount()).toBe(0);
  });

  it('returns null and rolls back when persist fails', async () => {
    gw.failNext(new RemixGatewayError('db down', { code: 'SERVER' }));
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);

    const newId = await addStageBatch(
      deps,
      'remix-1',
      'mixes',
      'b1',
      new Set<string>(['s1/i1']),
    );
    expect(newId).toBeNull();
    // Rolled back to the single original batch.
    expect(deps.state.remixes[0].mixes.map((m) => m.id)).toEqual(['b1']);
  });

  it('returns null when the remix is missing', async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);
    const newId = await addStageBatch(
      deps,
      'unknown-remix',
      'mixes',
      'b1',
      new Set<string>(['s1/i1']),
    );
    expect(newId).toBeNull();
    expect(updateCount()).toBe(0);
  });
});

// ── importStageBatch (Import finals of the previous stage) ──────────────────

describe('importStageBatch', () => {
  it("builds a 'rmbgs' batch from the SELECTED finals of mixes[] (K=1, native px)", async () => {
    // mixes batch with a selected swap_result whose crops are ALL final.
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1', /* withSwap */ true)]);
    const deps = makeDeps(remix);

    const newId = await importStageBatch(
      deps,
      'remix-1',
      'rmbgs',
      new Set<string>(['s1/i1']),
    );
    expect(newId).not.toBeNull();

    const rows = deps.state.remixes[0].rmbgs;
    expect(rows).toHaveLength(1);
    const sheet = rows[0].crop_sheets[0];
    expect(sheet.original_crops.map((c) => `${c.spread_id}/${c.id}`)).toEqual(['s1/i1']);
    // media_url = the PREVIOUS stage's OUTPUT piece (the swapped cut).
    expect(sheet.original_crops[0].media_url).toBe('https://cdn/swap-i1.png');
    expect(sheet.swap_results).toEqual([]);
    expect(updateCount()).toBe(1);
  });

  it('throws when no fresh final matches the selection (stale)', async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1', false)]); // no finals at all
    const deps = makeDeps(remix);
    await expect(
      importStageBatch(deps, 'remix-1', 'rmbgs', new Set<string>(['s1/i1'])),
    ).rejects.toThrow(/stale/i);
    expect(updateCount()).toBe(0);
  });
});

// ── removeStageBatch ──────────────────────────────────────────────────────────

describe('removeStageBatch', () => {
  it('removes a batch by id + persists', async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1'), makeBatch('b2', 1, 'Batch 2')]);
    const deps = makeDeps(remix);

    const ok = await removeStageBatch(deps, 'remix-1', 'mixes', 'b1');
    expect(ok).toBe(true);
    expect(deps.state.remixes[0].mixes.map((m) => m.id)).toEqual(['b2']);
  });

  it("refuses to remove the last 'mixes' batch (BATCH_MIN guard)", async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);

    const ok = await removeStageBatch(deps, 'remix-1', 'mixes', 'b1');
    expect(ok).toBe(false);
    expect(deps.state.remixes[0].mixes.map((m) => m.id)).toEqual(['b1']);
    expect(updateCount()).toBe(0);
  });

  it("allows removing the LAST 'rmbgs' batch (allowZeroBatch stage)", async () => {
    const remix = makeRemix([], [makeBatch('rb1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);

    const ok = await removeStageBatch(deps, 'remix-1', 'rmbgs', 'rb1');
    expect(ok).toBe(true);
    expect(deps.state.remixes[0].rmbgs).toEqual([]);
    expect(updateCount()).toBe(1);
  });
});

// ── relayoutStageBatchSheets ──────────────────────────────────────────────────

describe('relayoutStageBatchSheets', () => {
  it('changes K (delta) and clears swap_results on every rebuilt sheet', async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1', /* withSwap */ true)]);
    const deps = makeDeps(remix);
    expect(remix.mixes[0].crop_sheets[0].swap_results).toHaveLength(1); // precondition

    const ok = await relayoutStageBatchSheets(deps, 'remix-1', 'mixes', 'b1', +1); // K: 1 → 2
    expect(ok).toBe(true);

    const sheets = deps.state.remixes[0].mixes[0].crop_sheets;
    expect(sheets).toHaveLength(2);
    // DESTRUCTIVE: every rebuilt sheet has swap_results cleared.
    for (const s of sheets) expect(s.swap_results).toEqual([]);
    expect(updateCount()).toBe(1);
  });

  it('no-ops (returns false, no persist) when the count would not change at the clamp', async () => {
    // Already at SHEET_MIN=1; delta=-1 clamps back to 1 → no change.
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);

    const ok = await relayoutStageBatchSheets(deps, 'remix-1', 'mixes', 'b1', -1);
    expect(ok).toBe(false);
    expect(updateCount()).toBe(0);
  });

  it('returns false for an unknown batch', async () => {
    const remix = makeRemix([makeBatch('b1', 0, 'Batch 1')]);
    const deps = makeDeps(remix);
    expect(await relayoutStageBatchSheets(deps, 'remix-1', 'mixes', 'nope', +1)).toBe(false);
  });

  it('rev6: uses PER-BATCH scope (subset) instead of full illustration', async () => {
    // illustration has s1/i1 + s2/i2 + s3/i3; the batch carries only the
    // {s1/i1, s2/i2} subset. After relayout (K:1→2, within the 2-crop cap) the
    // rebuilt sheets must still carry that subset only — never pull s3/i3 from
    // the full grouping. (≥2 subset crops required: the per-batch cap forbids
    // more sheets than crops, so a 1-crop batch can't grow to K=2.)
    const subsetBatch = makeBatch('b1', 0, 'Batch 1', false, [
      { spreadId: 's1', layerId: 'i1', objectKey: 'c1' },
      { spreadId: 's2', layerId: 'i2', objectKey: 'c1' },
    ]);
    const remix = makeRemix([subsetBatch]);
    // Extend the full illustration with a 3rd crop the batch does NOT carry.
    (remix.illustration.spreads as unknown as Array<ReturnType<typeof spreadWithCrop>>).push(
      spreadWithCrop('s3', 3, 'i3', 'c1'),
    );
    const deps = makeDeps(remix);

    const ok = await relayoutStageBatchSheets(deps, 'remix-1', 'mixes', 'b1', +1); // K: 1 → 2
    expect(ok).toBe(true);

    const sheets = deps.state.remixes[0].mixes[0].crop_sheets;
    // Union of crop ids across the rebuilt sheets — the subset, NOT s3/i3.
    const ids = new Set<string>();
    for (const s of sheets) for (const c of s.original_crops) ids.add(`${c.spread_id}/${c.id}`);
    expect([...ids].sort()).toEqual(['s1/i1', 's2/i2']);
  });

  it('caps K at the batch crop count — a 1-crop batch cannot grow to K=2', async () => {
    // New rule: max sheets per batch = crop count (replaces flat SHEET_MAX=10).
    const oneCrop = makeBatch('b1', 0, 'Batch 1', false, [
      { spreadId: 's1', layerId: 'i1', objectKey: 'c1' },
    ]);
    const remix = makeRemix([oneCrop]);
    const deps = makeDeps(remix);

    // K:1→2 requested, but cap=1 → clamps to current → no-op (false, no persist).
    const ok = await relayoutStageBatchSheets(deps, 'remix-1', 'mixes', 'b1', +1);
    expect(ok).toBe(false);
    expect(deps.state.remixes[0].mixes[0].crop_sheets).toHaveLength(1);
  });

  it("stage 'rmbgs': re-packs the batch's own crops at native px and persists the rmbgs column", async () => {
    const rmbgBatch = makeBatch('rb1', 0, 'Batch 1');
    const remix = makeRemix([], [rmbgBatch]);
    const deps = makeDeps(remix);

    const ok = await relayoutStageBatchSheets(deps, 'remix-1', 'rmbgs', 'rb1', +1); // K: 1 → 2
    expect(ok).toBe(true);

    const sheets = deps.state.remixes[0].rmbgs[0].crop_sheets;
    expect(sheets).toHaveLength(2);
    // Native-px dims preserved on the re-pack.
    const all = sheets.flatMap((s) => s.original_crops);
    expect(all).toHaveLength(2);
    for (const c of all) {
      expect(c.geometry.w).toBe(320);
      expect(c.geometry.h).toBe(240);
    }
  });
});

// ── deriveBatchSwapTask ───────────────────────────────────────────────────────

function job(over: Partial<RemixJob>): RemixJob {
  return {
    id: 'j1',
    remixId: 'remix-1',
    phase: 'remix_mix_swap',
    batchId: 'b1',
    triggeredBy: 'user',
    status: 'queued',
    currentStep: 0,
    totalSteps: 3,
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    ...over,
  } as RemixJob;
}

describe('deriveBatchSwapTask', () => {
  it('idle when no matching job of the phase for (remix, batch)', () => {
    expect(deriveBatchSwapTask([], 'remix-1', 'b1', 'remix_mix_swap')).toEqual({ state: 'idle' });
    // A job for a DIFFERENT batch does not count.
    expect(
      deriveBatchSwapTask([job({ batchId: 'other' })], 'remix-1', 'b1', 'remix_mix_swap'),
    ).toEqual({ state: 'idle' });
    // ⚡stage isolation: a remix_rmbg job never matches the mixes phase.
    expect(
      deriveBatchSwapTask([job({ phase: 'remix_rmbg' })], 'remix-1', 'b1', 'remix_mix_swap'),
    ).toEqual({ state: 'idle' });
  });

  it('running with current/total while queued or running', () => {
    expect(
      deriveBatchSwapTask(
        [job({ status: 'running', currentStep: 2, totalSteps: 5 })],
        'remix-1',
        'b1',
        'remix_mix_swap',
      ),
    ).toEqual({ state: 'running', current: 2, total: 5 });
  });

  it("matches the STAGE phase — remix_rmbg job derives via phase 'remix_rmbg'", () => {
    expect(
      deriveBatchSwapTask(
        [job({ phase: 'remix_rmbg', status: 'running', currentStep: 1, totalSteps: 2 })],
        'remix-1',
        'b1',
        'remix_rmbg',
      ),
    ).toEqual({ state: 'running', current: 1, total: 2 });
  });

  it('error for failed/cancelled jobs (failedSheets from result)', () => {
    const t = deriveBatchSwapTask(
      [job({ status: 'failed', result: { failed_sheets: 2, errors: [{ message: 'boom' }] } as RemixJob['result'] })],
      'remix-1',
      'b1',
      'remix_mix_swap',
    );
    expect(t.state).toBe('error');
    if (t.state === 'error') {
      expect(t.message).toBe('boom');
      expect(t.failedSheets).toBe(2);
    }
  });

  it('idle for a clean completed job; error for a completed job with errors', () => {
    expect(
      deriveBatchSwapTask(
        [job({ status: 'completed', result: { errors: [] } as RemixJob['result'] })],
        'remix-1',
        'b1',
        'remix_mix_swap',
      ),
    ).toEqual({ state: 'idle' });
    const partial = deriveBatchSwapTask(
      [job({ status: 'completed', result: { errors: [{ message: 'one sheet failed' }] } as RemixJob['result'] })],
      'remix-1',
      'b1',
      'remix_mix_swap',
    );
    expect(partial.state).toBe('error');
  });

  it('picks the LATEST job by createdAt', () => {
    const older = job({ id: 'old', status: 'failed', createdAt: '2026-05-27T00:00:00.000Z', result: { errors: [{ message: 'x' }] } as RemixJob['result'] });
    const newer = job({ id: 'new', status: 'running', currentStep: 1, totalSteps: 4, createdAt: '2026-05-27T01:00:00.000Z' });
    expect(deriveBatchSwapTask([older, newer], 'remix-1', 'b1', 'remix_mix_swap')).toEqual({
      state: 'running',
      current: 1,
      total: 4,
    });
  });
});
