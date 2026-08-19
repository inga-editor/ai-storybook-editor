// share-preview-viewer.tsx — Thin consumer of the shared player-core hydration
// helpers. All mapping/conversion logic lives in `player-core/hydration/*`
// (single source of truth shared with PlayerViewer) — this component only wires
// those helpers into React effects/memos and renders PlayableSpreadView.
import { useMemo, useEffect, useLayoutEffect } from 'react';
import {
  PlayableSpreadView,
  detectMediaQuality,
} from '@/features/editor/components/playable-spread-view';
import type { PlayableSpread } from '@/types/playable-types';
import type { Section } from '@/types/illustration-types';
import {
  usePlaybackActions,
  type InitializePayload,
} from '@/stores/animation-playback-store';
import type {
  BookPreviewData,
  ShareConfig,
  SnapshotPreviewData,
} from '@/types/share-preview-types';
import { useSetCanvasSize } from '@/stores/editor-settings-store';
import { hydratePlayerStoresFromPayload } from '@/features/player-core/hydration/hydrate-player-stores';
import { toPlayableSpreads, toSections } from '@/features/player-core/hydration/to-playable-spreads';
import {
  resolveAvailableEditions,
  resolveAvailableLanguages,
} from '@/features/player-core/hydration/resolve-view-options';
import { buildInitializePayload } from '@/features/player-core/hydration/build-initialize-payload';
import { createLogger } from '@/utils/logger';

const log = createLogger('SharePreview', 'SharePreviewViewer');

interface SharePreviewViewerProps {
  book: BookPreviewData;
  snapshot: SnapshotPreviewData | null;
  shareConfig: ShareConfig;
}

export function SharePreviewViewer({ book, snapshot, shareConfig }: SharePreviewViewerProps) {
  const setCanvasSize = useSetCanvasSize();
  const { initialize, teardown } = usePlaybackActions();

  // Rendition quality resolved once at mount (parity PlayerViewer) — screen/DPR
  // don't change mid-session; nginx falls back safely if the quality misses.
  const mediaQuality = useMemo(() => detectMediaQuality(), []);

  // Sync book dimension → canvas size store so PlayerCanvas renders at correct spread dimensions
  useEffect(() => {
    log.debug('useEffect:dimension', 'set canvas size', { dimension: book.dimension });
    setCanvasSize(book.dimension ?? null);
  }, [book.dimension, setCanvasSize]);

  // Hydrate editor stores (book/musics/sounds) with denormalized share-preview
  // data so the player path (BGM, SFX, narrator volume, page-turn effects) works
  // without DB access. Cleanup resets the stores on unmount.
  useEffect(() => {
    return hydratePlayerStoresFromPayload(book);
  }, [book]);

  // Convert API spreads → PlayableSpread[]
  const playableSpreads = useMemo<PlayableSpread[]>(() => toPlayableSpreads(snapshot), [snapshot]);

  // editions: empty object → all enabled; otherwise use as-is
  const availableEditions = useMemo(
    () => resolveAvailableEditions(shareConfig.editions),
    [shareConfig.editions],
  );

  // languages: empty array → undefined (= no constraint, show all)
  const availableLanguages = useMemo(
    () => resolveAvailableLanguages(shareConfig.languages),
    [shareConfig.languages],
  );

  // sections from snapshot illustration (authoritative source for playback)
  const sections = useMemo<Section[]>(() => toSections(snapshot), [snapshot]);

  // === Playback session lifecycle ===
  // Share always passes sessionId `share:<id>` and no language/edition override.
  const payload: InitializePayload | null = useMemo(() => {
    if (!snapshot) return null;
    return buildInitializePayload({
      sessionId: `share:${book.id}`,
      spreads: playableSpreads,
      availableEditions,
      languages: shareConfig.languages,
      originalLanguage: book.original_language,
    });
  }, [snapshot, playableSpreads, availableEditions, shareConfig.languages, book.id, book.original_language]);

  // Single lifecycle effect: initialize on mount/session-switch, teardown on
  // unmount/session-switch. Same-session re-fires are absorbed by the store's
  // idempotent guard inside `initialize`.
  useLayoutEffect(() => {
    if (!payload) return;
    initialize(payload);
    return () => {
      teardown();
    };
  }, [payload, initialize, teardown]);

  log.info('render', 'share preview viewer', {
    bookId: book.id,
    hasSnapshot: !!snapshot,
    spreadCount: playableSpreads.length,
  });

  // Empty snapshot state
  if (!snapshot) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <span className="text-4xl" aria-hidden="true">📭</span>
        <p className="text-base font-medium">{book.title}</p>
        <p className="text-sm">Sách chưa có nội dung</p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <PlayableSpreadView
        spreads={playableSpreads}
        sections={sections}
        bookTitle={book.title}
        availableEditions={availableEditions}
        availableLanguages={availableLanguages}
        pageNumbering={book.template_layout?.page_numbering}
        isSharePreview={true}
        // Share links open on any device (phones included) — detect the
        // rendition tier from viewport × DPR (⚡260819, was fixed 'web').
        mediaQuality={mediaQuality}
      />
    </div>
  );
}
