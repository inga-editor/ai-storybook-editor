// map-book-preview-to-book.test.ts — pure mapping BookPreviewData → Book.
import { describe, it, expect } from 'vitest';
import type { BookPreviewData } from '@/types/share-preview-types';
import {
  mapBookPreviewToBook,
  hydrateNarrator,
  shareMediaToAudioResource,
} from './map-book-preview-to-book';

function makeBook(overrides: Partial<BookPreviewData> = {}): BookPreviewData {
  return {
    id: 'book-1',
    title: 'Test Book',
    cover: { thumbnail_url: 't.png', normal_url: 'n.png' },
    dimension: 3,
    book_type: 1,
    original_language: 'en_US',
    typography: {},
    branch: {},
    shape: {},
    template_layout: { page_numbering: undefined },
    ...overrides,
  };
}

describe('shareMediaToAudioResource', () => {
  it('maps ref → AudioResource with loop + stubbed runtime fields', () => {
    const r = shareMediaToAudioResource({ id: 'm1', media_url: 'u1', name: 'BGM' }, true);
    expect(r).toMatchObject({ id: 'm1', name: 'BGM', mediaUrl: 'u1', loop: true, duration: 0 });
  });

  it('defaults name to empty string when absent', () => {
    const r = shareMediaToAudioResource({ id: 'm2', media_url: 'u2' }, false);
    expect(r.name).toBe('');
    expect(r.loop).toBe(false);
  });
});

describe('hydrateNarrator', () => {
  it('returns null when input absent', () => {
    expect(hydrateNarrator(undefined)).toBeNull();
  });

  it('hydrates multiple language entries + volume_scale', () => {
    const out = hydrateNarrator({
      volume_scale: 0.5,
      en_US: { voice_id: 'v1', media_url: 'a1' },
      vi_VN: { voice_id: 'v2', media_url: 'a2' },
    });
    expect(out).not.toBeNull();
    const rec = out as unknown as Record<string, unknown>;
    expect(rec.volume_scale).toBe(0.5);
    expect(rec.en_US).toEqual({ voice_id: 'v1', media_url: 'a1' });
    expect(rec.vi_VN).toEqual({ voice_id: 'v2', media_url: 'a2' });
  });

  it('ignores non-language keys and defaults missing voice_id/media_url', () => {
    const out = hydrateNarrator({
      not_a_lang: { voice_id: 'x' } as never,
      en_US: {},
    });
    const rec = out as unknown as Record<string, unknown>;
    expect(rec.not_a_lang).toBeUndefined();
    expect(rec.en_US).toEqual({ voice_id: '', media_url: null });
  });

  it('falls back to VOLUME_DEFAULT when volume_scale absent', () => {
    const out = hydrateNarrator({ en_US: { voice_id: 'v', media_url: 'a' } });
    const rec = out as unknown as Record<string, unknown>;
    expect(rec.volume_scale).toBe(1);
  });
});

describe('mapBookPreviewToBook', () => {
  it('maps core fields + audio by default', () => {
    const book = mapBookPreviewToBook(
      makeBook({
        narrator: { volume_scale: 0.8, en_US: { voice_id: 'v', media_url: 'a' } },
        music: { background: { id: 'bg', media_url: 'u' }, volume_scale: 0.6 },
        sound: {
          transition: { id: 's1', media_url: 'u1' },
          true: { id: 's2', media_url: 'u2' },
          wrong: { id: 's3', media_url: 'u3' },
          volume_scale: 0.7,
        },
      }),
    );
    expect(book.id).toBe('book-1');
    expect(book.original_language).toBe('en_US');
    expect(book.narrator).not.toBeNull();
    expect(book.music).toEqual({ background_id: 'bg', volume_scale: 0.6 });
    expect(book.sound).toEqual({
      transition_id: 's1',
      true_id: 's2',
      wrong_id: 's3',
      volume_scale: 0.7,
    });
  });

  it('nulls narrator/music/sound when narrator absent (narrator → null)', () => {
    const book = mapBookPreviewToBook(makeBook());
    expect(book.narrator).toBeNull();
    expect(book.music).toBeNull();
    expect(book.sound).toBeNull();
  });

  it('includeAudio:false nulls all audio even when present (print path)', () => {
    const book = mapBookPreviewToBook(
      makeBook({
        narrator: { volume_scale: 1, en_US: { voice_id: 'v', media_url: 'a' } },
        music: { background: { id: 'bg', media_url: 'u' }, volume_scale: 1 },
        sound: { transition: { id: 's1', media_url: 'u1' }, volume_scale: 1 },
      }),
      { includeAudio: false },
    );
    expect(book.narrator).toBeNull();
    expect(book.music).toBeNull();
    expect(book.sound).toBeNull();
  });
});
