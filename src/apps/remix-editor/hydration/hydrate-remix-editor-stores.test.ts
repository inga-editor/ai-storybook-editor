// hydrate-remix-editor-stores.test.ts — runs against the REAL editor stores.
// Asserts (1) the fixed hydrate ORDER with snapshot LAST (via invocation-order spies),
// (2) humans/voices land populated + isLoading:false so the lazy Supabase fetch never
// fires, and (3) the normalized book is returned for the config gate + header title.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hydrateRemixEditorStores } from './hydrate-remix-editor-stores';
import { useArtStyleStore } from '@/stores/art-style-store';
import { useBookStore } from '@/stores/book-store';
import { useHumansStore } from '@/stores/humans-store';
import { useVoicesStore } from '@/stores/voices-store';
import { useEditorSettingsStore } from '@/stores/editor-settings-store';
import { useSnapshotStore } from '@/stores/snapshot-store';
import type { RemixEditorBookBundle } from '../data/remix-editor-bundle-types';
import type { Book } from '@/types/editor';
import type { HumanRow } from '@/types/human';
import type { VoiceRow } from '@/types/voice';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function makeBundle(over?: Partial<RemixEditorBookBundle>): RemixEditorBookBundle {
  return {
    contractVersion: 1,
    book: {
      id: 'b1',
      title: 'My Book',
      original_language: 'vi_VN',
      dimension: null,
      remix: null,
      typography: null,
    } as unknown as Book,
    snapshot: {
      id: 's1',
      book_id: 'b1',
      version: '202601010000',
      save_type: 1,
      tag: null,
      updated_at: '',
      created_at: '',
      docs: null,
      sketch: null,
      dummies: null,
      illustration: null,
      props: null,
      characters: null,
      stages: null,
    },
    artStyle: { id: 'a1', name: 'Watercolor', description: 'soft', tags: null, image_references: null, type: 1 },
    humans: [],
    voices: [],
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useSnapshotStore.getState().resetSnapshot();
});

describe('hydrateRemixEditorStores — order', () => {
  it('hydrates snapshot LAST (after art-style, book, humans, voices, editor-settings)', () => {
    const artSpy = vi.spyOn(useArtStyleStore, 'setState');
    const bookSpy = vi.spyOn(useBookStore.getState(), 'setCurrentBook');
    const humansSpy = vi.spyOn(useHumansStore, 'setState');
    const voicesSpy = vi.spyOn(useVoicesStore, 'setState');
    const settingsSpy = vi.spyOn(useEditorSettingsStore.getState(), 'resetSettings');
    const snapSpy = vi.spyOn(useSnapshotStore.getState(), 'initSnapshot');

    hydrateRemixEditorStores(makeBundle());

    const snapOrder = snapSpy.mock.invocationCallOrder[0];
    expect(snapOrder).toBeDefined();
    for (const spy of [artSpy, bookSpy, humansSpy, voicesSpy, settingsSpy]) {
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.invocationCallOrder[0]).toBeLessThan(snapOrder);
    }
  });
});

describe('hydrateRemixEditorStores — loaded flag blocks lazy fetch', () => {
  it('populates humans/voices with isLoading:false and never triggers the Supabase fetch', () => {
    const fetchHumansSpy = vi.spyOn(useHumansStore.getState(), 'fetchHumans');
    const fetchVoicesSpy = vi.spyOn(useVoicesStore.getState(), 'fetchVoices');

    const humans = [
      { id: 'h1', source_name: 'x', display_name: {}, gender: null, country: null, description: null, visual_profiles: [], voice_profiles: [], created_at: '' } as unknown as HumanRow,
    ];
    const voices = [{ id: 'v1', name: 'Narrator' } as unknown as VoiceRow];

    hydrateRemixEditorStores(makeBundle({ humans, voices }));

    expect(useHumansStore.getState().humans).toHaveLength(1);
    expect(useHumansStore.getState().isLoading).toBe(false);
    expect(useVoicesStore.getState().voices).toHaveLength(1);
    expect(useVoicesStore.getState().isLoading).toBe(false);
    expect(fetchHumansSpy).not.toHaveBeenCalled();
    expect(fetchVoicesSpy).not.toHaveBeenCalled();
  });

  it('empty humans/voices is OK — hydrates [] without error', () => {
    hydrateRemixEditorStores(makeBundle({ humans: [], voices: [] }));
    expect(useHumansStore.getState().humans).toEqual([]);
    expect(useHumansStore.getState().error).toBeNull();
    expect(useVoicesStore.getState().voices).toEqual([]);
    expect(useVoicesStore.getState().error).toBeNull();
  });
});

describe('hydrateRemixEditorStores — store writes', () => {
  it('writes book, art-style, editor-settings (language/step) + snapshot meta and returns the normalized book', () => {
    const returned = hydrateRemixEditorStores(makeBundle());

    expect(returned.id).toBe('b1');
    expect(useBookStore.getState().currentBook?.id).toBe('b1');
    expect(useArtStyleStore.getState().name).toBe('Watercolor');
    expect(useArtStyleStore.getState().description).toBe('soft');
    expect(useEditorSettingsStore.getState().currentLanguage.code).toBe('vi_VN');
    expect(useEditorSettingsStore.getState().currentStep).toBe('retouch');
    expect(useSnapshotStore.getState().meta.id).toBe('s1');
    expect(useSnapshotStore.getState().meta.bookId).toBe('b1');
  });

  it('null artStyle → art-style store cleared (name/description null, isLoading false)', () => {
    hydrateRemixEditorStores(makeBundle({ artStyle: null }));
    expect(useArtStyleStore.getState().name).toBeNull();
    expect(useArtStyleStore.getState().description).toBeNull();
    expect(useArtStyleStore.getState().isLoading).toBe(false);
  });
});
