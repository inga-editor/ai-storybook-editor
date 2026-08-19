// player-viewer.tsx — Adapter: PlayableBookPayload → store hydration → PlayableSpreadView.
//
// Mirrors share-preview-viewer.tsx (same player-core hydration helpers, single source
// of truth) with the sub-app extras: init-options overrides (language/edition/start),
// a `player:<bookId>` session id, and event taps (spread-change / complete) emitted to
// the embedding parent. Deliberately imports the render core from the .tsx DIRECTLY (not
// the barrel) to keep the sub-app bundle from pulling in editor-only re-exports.
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { PlayableSpreadView } from '@/features/editor/components/playable-spread-view/playable-spread-view';
import { detectDeviceTier, type DeviceTier } from '@/features/editor/components/playable-spread-view/media-tier';
import { resolveBookSequence } from '@/features/editor/components/playable-spread-view/resolve-book-sequence';
import type { PlayableSpread } from '@/types/playable-types';
import type { Section } from '@/types/illustration-types';
import {
  usePlaybackActions,
  usePlayerPhase,
  type InitializePayload,
} from '@/stores/animation-playback-store';
import { useSetCanvasSize } from '@/stores/editor-settings-store';
import { hydratePlayerStoresFromPayload } from '@/features/player-core/hydration/hydrate-player-stores';
import { toPlayableSpreads, toSections } from '@/features/player-core/hydration/to-playable-spreads';
import {
  resolveAvailableEditions,
  resolveAvailableLanguages,
  type LanguageOption,
} from '@/features/player-core/hydration/resolve-view-options';
import { buildInitializePayload } from '@/features/player-core/hydration/build-initialize-payload';
import type { PlayableBookPayload } from './data/player-types';
import type { PlayerInitOptions, PlayerOutboundEvent } from './embed/player-messages';
import { EmptySnapshotState } from './states/empty-snapshot-state';
import { createLogger } from '@/utils/logger';

const log = createLogger('Player', 'PlayerViewer');

export interface PlayerViewerProps {
  payload: PlayableBookPayload;
  /** Parent-supplied init options (language/edition/start/autoplay). May be null. */
  options: PlayerInitOptions | null;
  /** Emit an outbound event to the embedding parent (no-op when standalone). */
  onEvent: (event: PlayerOutboundEvent) => void;
}

export function PlayerViewer({ payload, options, onEvent }: PlayerViewerProps) {
  const { book, snapshot, viewConfig } = payload;
  const opts = options ?? {};

  const setCanvasSize = useSetCanvasSize();
  const { initialize, teardown } = usePlaybackActions();
  const phase = usePlayerPhase();

  // Book mode: viewConfig.languages[].name === '' → fill `name || code` so the language
  // dropdown never renders a blank row (phase-03 helper keeps names verbatim, so we
  // normalize here at the call site). `code` is untouched.
  const normalizedLanguages = useMemo<LanguageOption[]>(
    () => viewConfig.languages.map((l) => ({ name: l.name || l.code, code: l.code })),
    [viewConfig.languages],
  );

  const availableEditions = useMemo(
    () => resolveAvailableEditions(viewConfig.editions),
    [viewConfig.editions],
  );
  const availableLanguages = useMemo(
    () => resolveAvailableLanguages(normalizedLanguages),
    [normalizedLanguages],
  );

  // Media rendition tier (ADR-057): parent override wins (sanitized by the embed
  // bridge), otherwise detect once from viewport × DPR. Re-resolves when a new
  // player:init carries a different deviceTier.
  const mediaTier = useMemo<DeviceTier>(
    () => opts.deviceTier ?? detectDeviceTier(),
    [opts.deviceTier],
  );

  const spreads = useMemo<PlayableSpread[]>(() => toPlayableSpreads(snapshot), [snapshot]);
  const sections = useMemo<Section[]>(() => toSections(snapshot), [snapshot]);

  // Sync book dimension → canvas size so PlayerCanvas renders at correct spread ratio.
  useEffect(() => {
    log.debug('useEffect:dimension', 'set canvas size', { dimension: book.dimension });
    setCanvasSize(book.dimension ?? null);
  }, [book.dimension, setCanvasSize]);

  // Hydrate book/musics/sounds stores from the denormalized payload (BGM/SFX/narrator
  // without DB access). Cleanup resets the stores on unmount.
  useEffect(() => hydratePlayerStoresFromPayload(book), [book]);

  // Atomic playback session. sessionId is stable across token refresh (same bookId) →
  // no re-init → no playback stutter (phase-07 §Insight 4). Null when no spreads.
  const initPayload = useMemo<InitializePayload | null>(
    () =>
      buildInitializePayload({
        sessionId: `player:${book.id}`,
        spreads,
        availableEditions,
        languages: normalizedLanguages,
        originalLanguage: book.original_language,
        languageOverride: opts.language,
        editionOverride: opts.edition,
        startSpreadId: opts.startSpreadId,
      }),
    [
      book.id,
      book.original_language,
      spreads,
      availableEditions,
      normalizedLanguages,
      opts.language,
      opts.edition,
      opts.startSpreadId,
    ],
  );

  useLayoutEffect(() => {
    if (!initPayload) return;
    initialize(initPayload);
    return () => teardown();
  }, [initPayload, initialize, teardown]);

  // === Current spread tracking (for spread-change + complete taps) ===
  // PlayableSpreadView is self-controlled; its visible first spread is spreads[0]
  // (localSelectedSpreadId init). Mirror that default so the last-spread check aligns.
  const [currentSpreadId, setCurrentSpreadId] = useState<string | null>(
    () => opts.startSpreadId ?? spreads[0]?.id ?? null,
  );

  const handleSpreadSelect = useCallback(
    (spreadId: string) => {
      const index = spreads.findIndex((s) => s.id === spreadId);
      setCurrentSpreadId(spreadId);
      log.debug('handleSpreadSelect', 'spread changed', { index, total: spreads.length });
      onEvent({ v: 1, type: 'player:spread-change', spreadId, index, total: spreads.length });
    },
    [spreads, onEvent],
  );

  // Last spread of the RESOLVED linear sequence (branch-end counts). The walker is
  // edition-independent (void opts.edition) → passing 'classic' is a parity-of-call.
  const lastSpreadId = useMemo<string | null>(() => {
    if (spreads.length === 0) return null;
    const seq = resolveBookSequence(spreads, sections, {
      edition: 'classic',
      startSpreadId: opts.startSpreadId,
    });
    return seq.ordered[seq.ordered.length - 1]?.spreadId ?? null;
  }, [spreads, sections, opts.startSpreadId]);

  const lastSpreadReached = currentSpreadId != null && currentSpreadId === lastSpreadId;

  // Complete tap — narrow semantics (phase-07 §Insight 3): phase 'complete' (all spread
  // animations finished) AND standing on the last spread of the sequence. Merely
  // "standing" on the last spread (idle phase) does NOT satisfy `phase === 'complete'`.
  useEffect(() => {
    if (phase === 'complete' && lastSpreadReached) {
      log.info('useEffect:complete', 'book complete', { spreadId: currentSpreadId });
      onEvent({ v: 1, type: 'player:complete' });
    }
  }, [phase, lastSpreadReached, currentSpreadId, onEvent]);

  log.info('render', 'player viewer', {
    bookId: book.id,
    hasSnapshot: snapshot !== null,
    spreadCount: spreads.length,
  });

  // Defensive: unreachable with the real backend (no-snapshot ⇒ 404 NOT_FOUND ⇒ error
  // state upstream). Kept per design 02/04. All hooks above run unconditionally first.
  if (snapshot === null) {
    return <EmptySnapshotState title={book.title} />;
  }

  return (
    <div className="h-dvh">
      <PlayableSpreadView
        spreads={spreads}
        sections={sections}
        bookTitle={book.title}
        availableEditions={availableEditions}
        availableLanguages={availableLanguages}
        pageNumbering={book.template_layout?.page_numbering}
        isSharePreview
        onSpreadSelect={handleSpreadSelect}
        mediaTier={mediaTier}
      />
    </div>
  );
}
