// hydrate-player-stores.ts — Side-effecting store hydration for the player path.
//
// Writes the denormalized book payload into the three editor stores the player
// render chain reads (book / musics / sounds), so BGM, SFX and narrator volume
// work WITHOUT any DB access. Returns a cleanup fn that resets all three stores
// (keeps editor routes clean if the user navigates away). Hydration strategy
// (direct store writes, not prop-drilling) is deliberate per design §3.1.
//
// CRITICAL landmine (phase-03 §Insights 4): ALWAYS setState both audio stores
// (`items` + `isLoading:false`) even when the arrays are empty. `use-audio-media-url.ts`
// fires `void fetchItems()` (a real Supabase query) whenever a referenced id is
// missing from an EMPTY store that never loaded — in the sub-app that query hits
// RLS and silently fails. Seeding `isLoading:false` + `items:[]` marks the store
// as "loaded, just empty" so no fetch is attempted. This must hold for the
// "book has no music but a spread references a sound id" case.
import { useBookStore } from '@/stores/book-store';
import { useMusicsStore } from '@/stores/musics-store';
import { useSoundsStore } from '@/stores/sounds-store';
import type { AudioResource } from '@/features/audio-library';
import { createLogger } from '@/utils/logger';
import {
  mapBookPreviewToBook,
  shareMediaToAudioResource,
  type PlayableBookSource,
} from './map-book-preview-to-book';

const log = createLogger('PlayerCore', 'hydratePlayerStores');

/**
 * Hydrate the book/musics/sounds stores from a denormalized preview payload.
 *
 * @returns a cleanup fn resetting all three stores to empty.
 */
export function hydratePlayerStoresFromPayload(book: PlayableBookSource): () => void {
  const hydratedBook = mapBookPreviewToBook(book);

  const musicItems: AudioResource[] = book.music?.background
    ? [shareMediaToAudioResource(book.music.background, /* loop */ true)]
    : [];

  // Dedup the 3 sound slots (transition/true/wrong) — a book may reuse one media
  // ref across slots; the store must not carry duplicate ids.
  const soundCandidates = [book.sound?.transition, book.sound?.true, book.sound?.wrong];
  const seenSoundIds = new Set<string>();
  const soundItems: AudioResource[] = [];
  for (const ref of soundCandidates) {
    if (!ref || seenSoundIds.has(ref.id)) continue;
    seenSoundIds.add(ref.id);
    soundItems.push(shareMediaToAudioResource(ref, /* loop */ false));
  }

  useBookStore.getState().setCurrentBook(hydratedBook);
  // ALWAYS setState both audio stores (even when empty) — see landmine note above.
  useMusicsStore.setState({ items: musicItems, isLoading: false, error: null });
  useSoundsStore.setState({ items: soundItems, isLoading: false, error: null });

  log.info('hydratePlayerStoresFromPayload', 'player stores hydrated', {
    bookId: book.id,
    bgmCount: musicItems.length,
    sfxCount: soundItems.length,
    hasNarrator: !!hydratedBook.narrator,
    hasEffects: !!hydratedBook.effects,
  });

  return () => {
    log.debug('hydratePlayerStoresFromPayload', 'cleanup — resetting stores');
    useBookStore.getState().setCurrentBook(null);
    useMusicsStore.setState({ items: [], isLoading: false, error: null });
    useSoundsStore.setState({ items: [], isLoading: false, error: null });
  };
}
