// use-visuals-tab.test.ts — Pins the TWO invariants of the generate flow that a refactor is most
// likely to break silently (01-visuals-tab.md §4.4, README §4.4):
//   1. ENSURE-THEN-CALL — `onEnsureValueEntry` rejecting must ABORT: no API call (never burn an
//      AI call on a missing `saveResource` anchor) and no version written.
//   2. STALE-GUARD — a result landing after `runId` moved on (modal closed / item swapped) must
//      be swallowed, never prepended onto whatever the modal shows now.
// vitest + @testing-library/react only — NO node builtins.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
// `vi.mock` calls are hoisted above the imports, so these bindings ARE the mocked instances.
import { callGenerateParametricVariant } from '@/apis/image-api';
import { toast } from 'sonner';
import type { ItemParametricSlot, SpreadImage } from '@/types/spread-types';
import type { ParametricTabArgs } from './parametric-slot-modal-constants';
import { useVisualsTab } from './use-visuals-tab';

vi.mock('@/apis/image-api', () => ({ callGenerateParametricVariant: vi.fn() }));
// Pulled in transitively (upload flow / provenance) — both reach Supabase at import time.
vi.mock('@/apis/storage-api', () => ({ uploadImageToStorage: vi.fn() }));
vi.mock('@/apis/provenance-api', () => ({ callGetAiRequestReferences: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const mockGenerate = vi.mocked(callGenerateParametricVariant);

const SLOT: ItemParametricSlot = {
  key: 'country',
  values: [{ value: 'VN', is_default: true, illustrations: [] }],
};

/** Minimal item — only the field `resolveEffectiveImageUrl` reads matters (chain rung 4). */
const ITEM = { id: 'img_1', media_url: 'https://cdn.test/item.png' } as SpreadImage;

interface Harness {
  args: ParametricTabArgs;
  runId: { value: number };
  onPrependIllustration: ReturnType<typeof vi.fn>;
  onEnsureValueEntry: ReturnType<typeof vi.fn>;
  setBusy: ReturnType<typeof vi.fn>;
}

function makeHarness(overrides: Partial<ParametricTabArgs> = {}): Harness {
  // The shell owns the token; the tab only bumps/reads it — model it exactly that way so the
  // test can simulate "the modal closed" by bumping it from the outside.
  const runId = { value: 0 };
  const onPrependIllustration = vi.fn();
  const onEnsureValueEntry = vi.fn().mockResolvedValue(undefined);
  const setBusy = vi.fn();

  const args: ParametricTabArgs = {
    item: ITEM,
    slot: SLOT,
    characters: [],
    selectedValue: 'US',
    defaultValue: 'VN',
    entry: null,
    versions: [],
    selectedVer: null,
    zoom: 100,
    isDangling: false,
    isRuntimeOnly: false,
    isGeneratable: true,
    canEdit: true,
    pathPrefix: 'parametric/img_1',
    buildSaveResourcePath: () => 'table:snapshots/id:snap_1/col:illustration/…',
    attribution: { snapshotId: 'snap_1' },
    isActive: true,
    readRunId: () => runId.value,
    bumpRunId: () => (runId.value += 1),
    onPrependIllustration,
    onSelectIllustration: vi.fn(),
    onDeleteIllustration: vi.fn(),
    onEnsureValueEntry,
    setBusy,
    ...overrides,
  };
  return { args, runId, onPrependIllustration, onEnsureValueEntry, setBusy };
}

const okResponse = (saved?: boolean) => ({
  success: true as const,
  data: {
    imageUrl: 'https://cdn.test/generated.png',
    storagePath: 'p/generated.png',
    aiRequestId: 'ai_1',
    ...(saved === undefined ? {} : { saved }),
  },
});

describe('useVisualsTab — generate invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ENSURE-THEN-CALL: a rejected ensure ABORTS — no API call, no version written', async () => {
    const h = makeHarness();
    h.onEnsureValueEntry.mockRejectedValue(new Error('PARAMETRIC_COMMIT_SAVE_REJECTED'));
    const { result } = renderHook(() => useVisualsTab(h.args));

    await act(async () => {
      result.current.onGenerate();
    });

    expect(h.onEnsureValueEntry).toHaveBeenCalledWith('US');
    // THE invariant: a failed anchor persist must never reach the paid endpoint.
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(h.onPrependIllustration).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Không lưu được giá trị mới, thử lại');
    // Busy is released — runId never moved, so the guarded finally runs.
    expect(h.setBusy).toHaveBeenLastCalledWith(false);
  });

  it('STALE-GUARD: a result landing after runId moved on is swallowed', async () => {
    const h = makeHarness();
    let resolveApi: (value: ReturnType<typeof okResponse>) => void = () => {};
    mockGenerate.mockReturnValue(
      new Promise((resolve) => {
        resolveApi = resolve;
      }) as ReturnType<typeof callGenerateParametricVariant>,
    );

    const { result } = renderHook(() => useVisualsTab(h.args));
    await act(async () => {
      result.current.onGenerate();
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    // The shell bumps on close / forcePop / item swap — simulate that mid-flight.
    h.runId.value += 1;

    await act(async () => {
      resolveApi(okResponse());
    });

    expect(h.onPrependIllustration).not.toHaveBeenCalled();
  });

  it('happy path: prepends the created version with its ai_request_id', async () => {
    const h = makeHarness();
    mockGenerate.mockResolvedValue(okResponse());
    const { result } = renderHook(() => useVisualsTab(h.args));

    await act(async () => {
      result.current.onGenerate();
    });

    expect(h.onPrependIllustration).toHaveBeenCalledTimes(1);
    const [value, illustration] = h.onPrependIllustration.mock.calls[0];
    expect(value).toBe('US');
    expect(illustration).toMatchObject({
      type: 'created',
      media_url: 'https://cdn.test/generated.png',
      is_selected: true,
      ai_request_id: 'ai_1',
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('soft-fail `saved:false` warns but still keeps the image (no rollback)', async () => {
    const h = makeHarness();
    mockGenerate.mockResolvedValue({
      ...okResponse(false),
      data: { ...okResponse(false).data, saveError: 'SAVE_RESOURCE_ANCHOR_NOT_FOUND' },
    });
    const { result } = renderHook(() => useVisualsTab(h.args));

    await act(async () => {
      result.current.onGenerate();
    });

    expect(h.onPrependIllustration).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      'Ảnh đã sinh nhưng chưa lưu tự động — hãy lưu lại',
    );
  });

  it('a disabled axis never reaches ensure or the API (photo ⇒ isGeneratable false)', async () => {
    const h = makeHarness({ isGeneratable: false });
    const { result } = renderHook(() => useVisualsTab(h.args));

    await act(async () => {
      result.current.onGenerate();
    });

    expect(h.onEnsureValueEntry).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(result.current.generateDisabledReason).toBe('unsupported_axis');
  });
});
