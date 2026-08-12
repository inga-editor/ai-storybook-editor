// hydrate-remix-editor-stores.ts — Side-effecting store hydration for the Remix
// Editor sub-app. One bundle → every store the remix surface reads, so
// `RemixCreativeSpace` renders WITHOUT touching any Supabase fetch path.
//
// Returns the normalized `Book` so the caller can (a) gate `config_missing` via
// isBookRemixEmpty and (b) hand `book.title` to the shell.
//
// ⚡ ORDER IS LOAD-BEARING — snapshot is hydrated LAST. See the guard comment
//    above step 6 before touching anything here.
import { useArtStyleStore } from '@/stores/art-style-store';
import { useBookStore } from '@/stores/book-store';
import { useHumansStore } from '@/stores/humans-store';
import { useVoicesStore } from '@/stores/voices-store';
import { useEditorSettingsStore } from '@/stores/editor-settings-store';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { mapHumanRow } from '@/features/humans/utils/human-mapper';
import { mapVoiceRow } from '@/features/voices/utils/voice-mapper';
import { normalizeBookRemix, normalizeBookTypography } from '@/constants/config-constants';
import { AVAILABLE_LANGUAGES } from '@/constants/editor-constants';
import type { Book } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import type { RemixEditorBookBundle } from '../data/remix-editor-bundle-types';

const log = createLogger('RemixEditor', 'HydrateStores');

/**
 * Hydrate every store the remix surface reads from `bundle`, in a fixed order.
 * Synchronous + idempotent (a second call overwrites). Returns the normalized book.
 */
export function hydrateRemixEditorStores(bundle: RemixEditorBookBundle): Book {
  const { book, snapshot, artStyle, humans, voices } = bundle;

  // Normalize exactly like book-store.fetchBook so `isBookRemixEmpty` and the remix
  // UI read the canonical remix/typography shapes (legacy/partial rows get reshaped).
  const hydratedBook: Book = {
    ...book,
    remix: normalizeBookRemix(book.remix),
    typography: normalizeBookTypography(book.typography),
  };

  // 1. art-style — seed name+description; isLoading:false keeps lazy fetchArtStyle idle.
  useArtStyleStore.setState({
    name: artStyle?.name ?? null,
    description: artStyle?.description ?? null,
    isLoading: false,
    error: null,
  });

  // 2. book
  useBookStore.getState().setCurrentBook(hydratedBook);

  // 3. humans — map rows→domain. `isLoading:false` + populated list marks the store
  //    "loaded" so the lazy `fetchHumans` (Supabase) that gates on it NEVER fires in
  //    the sub-app. Empty list is fine (loaded, just empty).
  useHumansStore.setState({ humans: humans.map(mapHumanRow), isLoading: false, error: null });

  // 4. voices — same "loaded, maybe empty" contract as humans.
  useVoicesStore.setState({ voices: voices.map(mapVoiceRow), isLoading: false, error: null });

  // 5. editor-settings — language from book.original_language, canvas+bleed from
  //    book.dimension. Step is fixed to 'retouch' (the pipeline step that hosts the
  //    remix creative space; the surface only reads language, so the step is inert
  //    for rendering). Mirrors editor-page.tsx book-open hydration.
  const language =
    AVAILABLE_LANGUAGES.find((l) => l.code === hydratedBook.original_language) ??
    AVAILABLE_LANGUAGES[0];
  useEditorSettingsStore.getState().resetSettings(language, 'retouch', hydratedBook.dimension ?? null, 3);

  // 6. ⚡ snapshot LAST — see design 02 §3.1. `remix-store/index.ts:53` subscribes
  //    `snapshot.meta.id`; setting it fires `syncFromServer` (remix list) IMMEDIATELY
  //    via the Phase-05 gateway. Steps 1–5 MUST already be in place so the surface has
  //    book/humans/voices/settings when the remix list streams in. DO NOT reorder.
  useSnapshotStore.getState().initSnapshot({
    docs: snapshot.docs ?? undefined,
    sketch: snapshot.sketch ?? undefined,
    dummies: snapshot.dummies ?? undefined,
    illustration: snapshot.illustration ?? undefined,
    props: snapshot.props ?? undefined,
    characters: snapshot.characters ?? undefined,
    stages: snapshot.stages ?? undefined,
    meta: {
      id: snapshot.id,
      bookId: snapshot.book_id,
      version: snapshot.version,
      tag: snapshot.tag ?? null,
      autoSaveId: null,
    },
  });

  log.info('hydrateRemixEditorStores', 'hydrated', {
    bookId: hydratedBook.id,
    snapshotId: snapshot.id,
    humans: humans.length,
    voices: voices.length,
    hasArtStyle: !!artStyle,
  });

  return hydratedBook;
}
