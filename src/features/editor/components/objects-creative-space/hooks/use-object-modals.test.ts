// use-object-modals.test.ts — Pins the `openSlot` ROUTING invariant (03-image-toolbar §4.9):
// the ItemSlotModal is INIT-ONLY, so an item that already carries a slot must NOT open it —
// `parametric_slot` routes to EditParametricSlotModal, `casting_slot` still toasts "Coming soon".
// The check has to be TRUTHY (`img.casting_slot`), never `'casting_slot' in img`: the init write
// sets the unused slot key to `undefined` and immer materializes that key on the stored item, so a
// key-presence check would report a slot that does not exist and lock the user out of Init forever.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
// `vi.mock` below is hoisted above every import, so this binding IS the mocked instance.
import { toast } from 'sonner';
import type { SpreadImage } from '@/types/canvas-types';
import { useObjectModals } from './use-object-modals';

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const SPREAD_ID = 'sp_1';

/** The hook only reads `actions` inside handleEditAudioComplete, which these tests never call. */
const actionsStub = {} as unknown as Parameters<typeof useObjectModals>[1];

const makeImage = (overrides?: Partial<SpreadImage>): SpreadImage =>
  ({
    id: 'img_1',
    geometry: { x: 0, y: 0, w: 100, h: 100 },
    media_url: 'https://example.test/image.png',
    ...overrides,
  }) as unknown as SpreadImage;

const renderModals = () =>
  renderHook(() => useObjectModals(SPREAD_ID, actionsStub));

describe('useObjectModals.openSlot routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('item with NO slot → opens the init modal, no toast', () => {
    const { result } = renderModals();
    const img = makeImage();

    act(() => result.current.openSlot(img));

    expect(result.current.slot.open).toBe(true);
    expect(result.current.slot.image).toBe(img);
    expect(result.current.slot.spreadId).toBe(SPREAD_ID);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('item with casting_slot → does NOT open, shows "Coming soon"', () => {
    const { result } = renderModals();
    const img = makeImage({
      casting_slot: {
        actant_id: 'sibling_1',
        actors: [
          { id: 'char_alice', actor_type: 1, media_url: 'https://example.test/a.png', is_default: true },
        ],
      },
    } as unknown as Partial<SpreadImage>);

    act(() => result.current.openSlot(img));

    expect(result.current.slot.open).toBe(false);
    expect(result.current.slot.image).toBeNull();
    expect(toast.info).toHaveBeenCalledWith('Coming soon');
  });

  // ⚡2026-07-28: parametric no longer no-ops — it routes to EditParametricSlotModal. Casting
  // keeps the toast (its `actants`/`actors` shape has no design yet).
  it('item with parametric_slot → opens the EDIT modal (by id), not the init modal', () => {
    const { result } = renderModals();
    const img = makeImage({
      parametric_slot: {
        key: 'char_a.gender',
        values: [{ value: 'male', is_default: true, illustrations: [] }],
      },
    } as unknown as Partial<SpreadImage>);

    act(() => result.current.openSlot(img));

    expect(result.current.slot.open).toBe(false);
    expect(result.current.slot.image).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
    expect(result.current.parametric.open).toBe(true);
    // ID, not the object: the modal writes `values[]` and must re-resolve the LIVE store item.
    expect(result.current.parametric.imageId).toBe(img.id);
    expect(result.current.parametric.spreadId).toBe(SPREAD_ID);
  });

  it('closeParametric clears the id AND the captured spreadId', () => {
    const { result } = renderModals();
    const img = makeImage({
      parametric_slot: { key: 'country', values: [] },
    } as unknown as Partial<SpreadImage>);

    act(() => result.current.openSlot(img));
    expect(result.current.parametric.spreadId).toBe(SPREAD_ID);

    act(() => result.current.closeParametric());

    expect(result.current.parametric.open).toBe(false);
    expect(result.current.parametric.imageId).toBeNull();
    expect(result.current.parametric.spreadId).toBe('');
  });

  it('slot key present but UNDEFINED (post-init write shape) → still opens', () => {
    // Regression guard for the truthy-vs-`in` check: immer keeps the `undefined` key on the item.
    const { result } = renderModals();
    const img = makeImage({ casting_slot: undefined, parametric_slot: undefined } as unknown as Partial<SpreadImage>);

    act(() => result.current.openSlot(img));

    expect(result.current.slot.open).toBe(true);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('closeSlot clears image AND the captured spreadId', () => {
    const { result } = renderModals();

    act(() => result.current.openSlot(makeImage()));
    expect(result.current.slot.spreadId).toBe(SPREAD_ID);

    act(() => result.current.closeSlot());

    expect(result.current.slot.open).toBe(false);
    expect(result.current.slot.image).toBeNull();
    expect(result.current.slot.spreadId).toBe('');
  });
});
