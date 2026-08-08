// hydrate-player-stores.test.ts — side-effecting store hydration.
// The 3 editor stores are mocked so we assert setState wiring without real
// Supabase/audio-library modules loading.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BookPreviewData } from '@/types/share-preview-types';

// vi.mock factories are hoisted above const declarations — use vi.hoisted so the
// spies exist when the factories run.
const { setCurrentBook, musicsSetState, soundsSetState } = vi.hoisted(() => ({
  setCurrentBook: vi.fn(),
  musicsSetState: vi.fn(),
  soundsSetState: vi.fn(),
}));

vi.mock('@/stores/book-store', () => ({
  useBookStore: { getState: () => ({ setCurrentBook }) },
}));
vi.mock('@/stores/musics-store', () => ({
  useMusicsStore: { setState: musicsSetState },
}));
vi.mock('@/stores/sounds-store', () => ({
  useSoundsStore: { setState: soundsSetState },
}));

import { hydratePlayerStoresFromPayload } from './hydrate-player-stores';

function makeBook(overrides: Partial<BookPreviewData> = {}): BookPreviewData {
  return {
    id: 'book-1',
    title: 'Test',
    cover: {},
    dimension: 3,
    book_type: 1,
    original_language: 'en_US',
    typography: {},
    branch: {},
    shape: {},
    ...overrides,
  };
}

beforeEach(() => {
  setCurrentBook.mockClear();
  musicsSetState.mockClear();
  soundsSetState.mockClear();
});

describe('hydratePlayerStoresFromPayload', () => {
  it('seeds book + both audio stores with items', () => {
    hydratePlayerStoresFromPayload(
      makeBook({
        music: { background: { id: 'bg', media_url: 'u' }, volume_scale: 1 },
        sound: {
          transition: { id: 's1', media_url: 'u1' },
          true: { id: 's2', media_url: 'u2' },
          wrong: { id: 's3', media_url: 'u3' },
          volume_scale: 1,
        },
      }),
    );
    expect(setCurrentBook).toHaveBeenCalledTimes(1);
    expect(musicsSetState).toHaveBeenCalledWith({
      items: [expect.objectContaining({ id: 'bg', loop: true })],
      isLoading: false,
      error: null,
    });
    const soundArg = soundsSetState.mock.calls[0][0];
    expect(soundArg.items.map((i: { id: string }) => i.id)).toEqual(['s1', 's2', 's3']);
    expect(soundArg.isLoading).toBe(false);
  });

  it('dedups repeated sound ids across the 3 slots', () => {
    hydratePlayerStoresFromPayload(
      makeBook({
        sound: {
          transition: { id: 'dup', media_url: 'u1' },
          true: { id: 'dup', media_url: 'u2' },
          wrong: { id: 'other', media_url: 'u3' },
          volume_scale: 1,
        },
      }),
    );
    const soundArg = soundsSetState.mock.calls[0][0];
    expect(soundArg.items.map((i: { id: string }) => i.id)).toEqual(['dup', 'other']);
  });

  it('LANDMINE: setState both audio stores even when arrays empty (no music, no sound)', () => {
    // book has no music but downstream a spread may reference a sound id — the
    // stores MUST be seeded isLoading:false so use-audio-media-url never fires
    // a real Supabase fetchItems() (RLS-blocked in the sub-app).
    hydratePlayerStoresFromPayload(makeBook());
    expect(musicsSetState).toHaveBeenCalledWith({ items: [], isLoading: false, error: null });
    expect(soundsSetState).toHaveBeenCalledWith({ items: [], isLoading: false, error: null });
  });

  it('cleanup fn resets all three stores', () => {
    const cleanup = hydratePlayerStoresFromPayload(makeBook());
    setCurrentBook.mockClear();
    musicsSetState.mockClear();
    soundsSetState.mockClear();
    cleanup();
    expect(setCurrentBook).toHaveBeenCalledWith(null);
    expect(musicsSetState).toHaveBeenCalledWith({ items: [], isLoading: false, error: null });
    expect(soundsSetState).toHaveBeenCalledWith({ items: [], isLoading: false, error: null });
  });
});
