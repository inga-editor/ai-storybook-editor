import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createImageTaskSlice } from './image-task-slice';
import { callGenerateScene } from '@/apis/illustration-api';
import { callEditObjectImage } from '@/apis/retouch-api';
import { toast } from 'sonner';

// API seams — keep image-api-client / supabase out of the unit test.
vi.mock('@/apis/illustration-api', () => ({
  callGenerateScene: vi.fn(),
  callGenerateCharacterBase: vi.fn(),
  callGenerateCharacterVariant: vi.fn(),
  callGeneratePropBase: vi.fn(),
  callGeneratePropVariant: vi.fn(),
  callGenerateStageBase: vi.fn(),
  callGenerateStageVariant: vi.fn(),
}));
vi.mock('@/apis/retouch-api', () => ({ callEditObjectImage: vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

// Isolate the resource-lock store (breaks the slice ↔ store cycle) with a TOGGLEABLE collabPersist
// + acquire/save/release seams. `collabPersist=false` routes the solo path; `true` exercises the
// gateway save path via the REAL collab-image-save-helper (not mocked — integration of both).
const h = vi.hoisted(() => {
  const acquire = vi.fn();
  const save = vi.fn();
  const release = vi.fn();
  const state = {
    collabPersist: false,
    acquire,
    save,
    release,
    bookId: 'book-1',
    registry: new Map<string, { holder_user_id: string }>(),
    holderNames: new Map<string, string>(),
  };
  return { acquire, save, release, state };
});
vi.mock('@/stores/resource-lock-store', () => ({
  useResourceLockStore: { getState: () => h.state },
  keyOf: (bookId: string, t: { step: number; resource_type: number; resource_id: string; locale: string | null }) =>
    `${bookId}|${t.step}|${t.resource_type}|${t.resource_id}|${t.locale ?? ''}`,
  FALLBACK_HOLDER_NAME: 'another editor',
}));

const mockedScene = vi.mocked(callGenerateScene);
const mockedEdit = vi.mocked(callEditObjectImage);
const infoToast = vi.mocked(toast.info);
const errorToast = vi.mocked(toast.error);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
// Drain the .then chain + the fire-and-forget collab persist (acquire→save→release awaits).
const flush = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function createTestStore() {
  return create<any>()(
    immer((...a: any[]) => ({
      ...(createImageTaskSlice as any)(...a),
      characters: [],
      props: [],
      stages: [],
      illustration: {
        spreads: [
          {
            id: 'sp1',
            raw_images: [{ id: 'ri1', illustrations: [] }],
            images: [{ id: 'img1', illustrations: [] }],
          },
        ],
      },
      meta: { id: 'snap-1', bookId: 'book-1' },
      sync: { isDirty: false, isSaving: false },
    })),
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const sceneParams = (over: Record<string, unknown> = {}) => ({
  entityType: 'illustration_image' as const,
  entityKey: 'sp1',
  entityName: 'Spread 1',
  childKey: 'ri1',
  childName: 'Raw 1',
  visualDescription: 'a cat on a mat',
  artStyleId: 'style-1',
  ...over,
});
const okScene = { success: true as const, data: { imageUrl: 'scene.png', storagePath: 'p' } };

describe('ImageTaskSlice — collab per-resource save wiring', () => {
  beforeEach(() => {
    h.acquire.mockReset();
    h.save.mockReset();
    h.release.mockReset();
    h.release.mockResolvedValue(undefined);
    h.state.collabPersist = false;
    h.state.registry.clear();
    h.state.holderNames.clear();
    mockedScene.mockReset();
    mockedEdit.mockReset();
    infoToast.mockReset();
    errorToast.mockReset();
  });

  it('collab OFF: generate prepends + isDirty, NO gateway save (solo path unchanged)', async () => {
    mockedScene.mockResolvedValue(okScene as never);
    const store = createTestStore();

    store.getState().startGenerateTask(sceneParams());
    await flush();

    const raw = store.getState().illustration.spreads[0].raw_images[0];
    expect(raw.illustrations).toHaveLength(1);
    expect(raw.illustrations[0].media_url).toBe('scene.png');
    expect(raw.illustrations[0].is_selected).toBe(true);
    expect(store.getState().sync.isDirty).toBe(true);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('collab ON: generate persists the node under lock (action 5, log true) + still prepends', async () => {
    h.state.collabPersist = true;
    h.acquire.mockResolvedValue({ ok: true });
    h.save.mockResolvedValue({ ok: true });
    mockedScene.mockResolvedValue(okScene as never);
    const store = createTestStore();

    store.getState().startGenerateTask(sceneParams());
    await flush();

    const raw = store.getState().illustration.spreads[0].raw_images[0];
    expect(raw.illustrations).toHaveLength(1); // local optimistic mutate still applied
    expect(store.getState().sync.isDirty).toBe(true); // solo mutate byte-identical

    const expectedTarget = { step: 2, resource_type: 1, resource_id: 'ri1', locale: null };
    expect(h.acquire).toHaveBeenCalledWith(expectedTarget);
    expect(h.save).toHaveBeenCalledTimes(1);
    const [target, payload] = h.save.mock.calls[0];
    expect(target).toEqual(expectedTarget);
    expect(payload.action_type).toBe(5);
    expect(payload.log).toBe(true);
    expect(payload.patch.id).toBe('ri1'); // the fresh raw_image node
    expect(payload.target_ref).toEqual({ spread_id: 'sp1', image_id: 'ri1' });
    expect(h.release).toHaveBeenCalledWith(expectedTarget);
  });

  it('collab ON: edit persists the node under lock with action_type 3', async () => {
    h.state.collabPersist = true;
    h.acquire.mockResolvedValue({ ok: true });
    h.save.mockResolvedValue({ ok: true });
    mockedEdit.mockResolvedValue({ success: true, data: { imageUrl: 'edited.png' } } as never);
    const store = createTestStore();

    store.getState().startEditTask({
      entityType: 'illustration_image',
      entityKey: 'sp1',
      entityName: 'S',
      childKey: 'ri1',
      childName: 'R',
      prompt: 'make it blue',
      imageUrl: 'orig.png',
    });
    await flush();

    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0][1].action_type).toBe(3);
  });

  it('collab ON: acquire 409 → skipped (no save) + toast, local prepend KEPT', async () => {
    h.state.collabPersist = true;
    h.acquire.mockResolvedValue({ ok: false, code: 'LOCK_HELD', holder: 'u2' });
    h.state.registry.set('book-1|2|1|ri1|', { holder_user_id: 'u2' });
    h.state.holderNames.set('u2', 'Bob');
    mockedScene.mockResolvedValue(okScene as never);
    const store = createTestStore();

    store.getState().startGenerateTask(sceneParams());
    await flush();

    const raw = store.getState().illustration.spreads[0].raw_images[0];
    expect(raw.illustrations).toHaveLength(1); // optimistic local mutate kept
    expect(h.save).not.toHaveBeenCalled();
    expect(infoToast).toHaveBeenCalledTimes(1);
    expect(infoToast.mock.calls[0][0]).toContain('Bob');
  });

  it('collab ON: upload persists the node under lock with action_type 5', async () => {
    h.state.collabPersist = true;
    h.acquire.mockResolvedValue({ ok: true });
    h.save.mockResolvedValue({ ok: true });
    const store = createTestStore();

    store.getState().addUploadedIllustration({ entityKey: 'sp1', childKey: 'ri1', mediaUrl: 'up.png' });
    await flush();

    const raw = store.getState().illustration.spreads[0].raw_images[0];
    expect(raw.illustrations[0].type).toBe('uploaded');
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0][1].action_type).toBe(5);
  });

  it('collab OFF: upload prepends + isDirty, NO gateway save', async () => {
    const store = createTestStore();

    store.getState().addUploadedIllustration({ entityKey: 'sp1', childKey: 'ri1', mediaUrl: 'up.png' });
    await flush();

    const raw = store.getState().illustration.spreads[0].raw_images[0];
    expect(raw.illustrations[0].type).toBe('uploaded');
    expect(store.getState().sync.isDirty).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  describe('saveResource wiring — opt-in BE-first double-write', () => {
    it('generate scene passes saveResource with correct image_version anchor', async () => {
      mockedScene.mockResolvedValue(okScene as never);
      const store = createTestStore();

      store.getState().startGenerateTask(sceneParams());
      await flush();

      expect(mockedScene).toHaveBeenCalledWith(
        expect.objectContaining({
          saveResource: expect.objectContaining({
            type: 'image_version',
            path: expect.stringContaining('table:snapshots/id:snap-1/col:illustration/spread:sp1/key:raw_images/find:id=ri1'),
            action: 'create',
          }),
        }),
      );
    });

    it('edit passes saveResource with edit action', async () => {
      mockedEdit.mockResolvedValue({ success: true, data: { imageUrl: 'edited.png' } } as never);
      const store = createTestStore();

      store.getState().startEditTask({
        entityType: 'illustration_image',
        entityKey: 'sp1',
        entityName: 'S',
        childKey: 'ri1',
        childName: 'R',
        prompt: 'make it blue',
        imageUrl: 'orig.png',
      });
      await flush();

      expect(mockedEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          saveResource: expect.objectContaining({
            type: 'image_version',
            action: 'edit',
          }),
        }),
      );
    });

    it('omits saveResource when snapshotId is absent (not opted in)', async () => {
      mockedScene.mockResolvedValue(okScene as never);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const store = create<any>()(
        immer((...a: any[]) => ({
          ...(createImageTaskSlice as any)(...a),
          characters: [],
          props: [],
          stages: [],
          illustration: {
            spreads: [
              {
                id: 'sp1',
                raw_images: [{ id: 'ri1', illustrations: [] }],
                images: [{ id: 'img1', illustrations: [] }],
              },
            ],
          },
          meta: { id: null, bookId: 'book-1' }, // No snapshot id
          sync: { isDirty: false, isSaving: false },
        })),
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */

      store.getState().startGenerateTask(sceneParams());
      await flush();

      // When snapshotId is null, saveResource should be undefined so it's not included in the body
      expect(mockedScene).toHaveBeenCalledWith(
        expect.not.objectContaining({
          saveResource: expect.anything(),
        }),
      );
    });
  });
});
