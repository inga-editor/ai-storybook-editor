// map-book-preview-to-book.ts — Pure conversion: BookPreviewData → editor `Book`.
//
// Single source of truth for the denormalized preview payload → editor Book
// mapping shared by SharePreviewViewer, PlayerViewer (player sub-app) and
// PrintExportPage. Keeping this in ONE place prevents the mapping from drifting
// across the (now 3) consumers.
//
// This module is intentionally pure (no store writes, no React) — the
// side-effecting hydration lives in `hydrate-player-stores.ts`.
import type {
  BookPreviewData,
  ShareMediaRef,
  ShareNarratorSetting,
} from '@/types/share-preview-types';
import type { AudioResource } from '@/features/audio-library';
import type { Book, NarratorLanguageEntry, NarratorSettings } from '@/types/editor';
import {
  DEFAULT_INFERENCE_PARAMS,
  NARRATOR_LANGUAGE_KEY_REGEX,
  VOLUME_DEFAULT,
} from '@/constants/config-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('PlayerCore', 'mapBookPreviewToBook');

/**
 * Neutral input alias for the denormalized book payload. Both share (Editor DB)
 * and player (App DB) produce this shape — never name it `share*` here so the
 * player sub-app can consume the helper without a share-flavoured coupling.
 */
export type PlayableBookSource = BookPreviewData;

/** Options controlling which optional facets are hydrated. */
export interface MapBookPreviewOptions {
  /**
   * When false, audio-related settings (narrator/music/sound) are nulled. Print
   * export renders a silent static raster and needs no audio. Default true.
   */
  includeAudio?: boolean;
}

// Map a denormalized preview media ref → AudioResource shape that
// musics-store / sounds-store consumers expect. Non-runtime fields are stubbed
// because the player path never invokes update/delete/library flows.
export function shareMediaToAudioResource(ref: ShareMediaRef, loop: boolean): AudioResource {
  return {
    id: ref.id,
    name: ref.name ?? '',
    description: null,
    mediaUrl: ref.media_url,
    loop,
    duration: 0,
    influence: null,
    tags: null,
    source: 0,
    createdAt: '',
  };
}

// Convert ShareNarratorSetting (per-language entries with media_url) →
// NarratorSettings expected by `useBookNarratorVolume` / `useNarratorLanguageEntry`.
// Inference params get defaults — they only affect generation, not playback.
export function hydrateNarrator(input: ShareNarratorSetting | undefined): NarratorSettings | null {
  if (!input) return null;
  const volumeScale = typeof input.volume_scale === 'number' ? input.volume_scale : VOLUME_DEFAULT;
  const out: NarratorSettings = {
    ...DEFAULT_INFERENCE_PARAMS,
    model: 'eleven_v3',
  };
  // volume_scale lives outside NarratorInferenceParams; assigned via index signature.
  (out as unknown as Record<string, number>).volume_scale = volumeScale;
  let langCount = 0;
  for (const [key, val] of Object.entries(input)) {
    if (key === 'volume_scale') continue;
    if (!NARRATOR_LANGUAGE_KEY_REGEX.test(key)) continue;
    if (!val || typeof val !== 'object') continue;
    const entry = val as { voice_id?: string | null; media_url?: string };
    const langEntry: NarratorLanguageEntry = {
      voice_id: entry.voice_id ?? '',
      media_url: entry.media_url ?? null,
    };
    (out as unknown as Record<string, NarratorLanguageEntry>)[key] = langEntry;
    langCount++;
  }
  log.debug('hydrateNarrator', 'narrator hydrated', { langCount, hasVolume: true });
  return out;
}

/**
 * Convert the denormalized preview payload into the editor `Book` object the
 * canvas internals read (typography, template_layout, dimension, audio refs).
 *
 * @param book    denormalized source payload
 * @param options `includeAudio:false` nulls narrator/music/sound (print path)
 */
export function mapBookPreviewToBook(
  book: PlayableBookSource,
  options: MapBookPreviewOptions = {},
): Book {
  const includeAudio = options.includeAudio ?? true;
  log.debug('mapBookPreviewToBook', 'mapping preview → book', {
    bookId: book.id,
    includeAudio,
  });

  return {
    id: book.id,
    title: book.title,
    description: null,
    owner_id: '',
    step: 0,
    type: 1,
    original_language: book.original_language,
    current_version: null,
    current_content: null,
    cover: book.cover,
    book_type: book.book_type,
    dimension: book.dimension,
    target_audience: null,
    format_id: null,
    era_id: null,
    location_id: null,
    artstyle_id: null,
    sketchstyle_id: null,
    typography: book.typography as unknown as Book['typography'],
    narrator: includeAudio ? hydrateNarrator(book.narrator) : null,
    shape: book.shape as unknown as Book['shape'],
    branch: book.branch as unknown as Book['branch'],
    music:
      includeAudio && book.music
        ? {
            background_id: book.music.background?.id ?? null,
            volume_scale: book.music.volume_scale,
          }
        : null,
    sound:
      includeAudio && book.sound
        ? {
            transition_id: book.sound.transition?.id ?? null,
            true_id: book.sound.true?.id ?? null,
            wrong_id: book.sound.wrong?.id ?? null,
            volume_scale: book.sound.volume_scale,
          }
        : null,
    effects: book.effects as unknown as Book['effects'],
    remix: null,
    template_layout: book.template_layout as unknown as Book['template_layout'],
    created_at: '',
    updated_at: '',
  };
}
