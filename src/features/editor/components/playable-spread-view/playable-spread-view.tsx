// playable-spread-view.tsx - Root container component for playable spread view
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { PageNumberingSettings } from "@/types/editor";
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'PlayableSpreadView');
import type {
  PlayEdition,
  PlayableSpread,
} from "@/types/playable-types";
import type { Section } from "@/types/illustration-types";
import { PLAYABLE_ZOOM } from "@/constants/playable-constants";
import {
  useSpreadHistories,
  useCurrentSection,
  usePlaybackActions,
  useVolume,
  useIsMuted,
  usePlayEdition,
  usePlayMode,
} from '@/stores/animation-playback-store';
import {
  useBookMusic,
  useBookSound,
  useBookNarratorVolume,
  useBookEffects,
} from '@/stores/book-store';
import { usePlayerAudioStore } from '@/stores/player-audio-store';
import { PlayableThumbnailList } from "./playable-thumbnail-list";
import { PlayerCanvas, type PlayerCanvasHandle } from "./player-canvas";
import { BranchPathModal } from "./branch-path-modal";
import { FirstGestureGate } from "./first-gesture-gate";
import { PlayerAudioMixerHost } from "./audio/player-audio-mixer-host";
import { PlayerSpreadPreloadHost } from "./preload/player-spread-preload-host";
import { MediaQualityHost } from "./media-quality-host";
import type { MediaQuality } from "./media-quality";
import { BookBackgroundMusicPlayer } from "./audio/book-background-music-player";
import { useMusicMediaUrl } from "./audio/use-music-media-url";
import { useSoundMediaUrl } from "./audio/use-sound-media-url";
import { createMixedAudio } from "./audio/create-mixed-audio";
import type { BookAudioSettings } from "./audio/audio-mixer-types";
import { useSpreadTurnTransition } from "./page-turn-transition/use-spread-turn-transition";
import { resolveTransitionStrategy } from "./page-turn-transition/spread-turn-strategy";
import { SpreadTurnOverlay } from "./page-turn-transition/spread-turn-overlay";
import type { TurnDirection } from "./page-turn-transition/spread-turn-types";

// === Types ===

type NextSpreadResult =
  | { type: 'branch' }             // spread has branch_setting → show modal
  | { type: 'spread'; id: string } // navigate directly
  | null;                           // end of story

// === Pure helpers (outside component) ===

function resolveNextSpreadId(
  spread: PlayableSpread | undefined,
  spreads: PlayableSpread[],
  currentSection: Section | null,
): NextSpreadResult {
  if (!spread) return null;
  if (spread.branch_setting) return { type: 'branch' };
  if (currentSection && spread.id === currentSection.end_spread_id && currentSection.next_spread_id) {
    return { type: 'spread', id: currentSection.next_spread_id };
  }
  const linearNext = spreads[spreads.findIndex((s) => s.id === spread.id) + 1]?.id;
  if (linearNext) return { type: 'spread', id: linearNext };
  return null;
}

function autoResolveNextSpread(
  spread: PlayableSpread | undefined,
  spreads: PlayableSpread[],
  sections: Section[] | undefined,
  currentSection: Section | null,
): string | null {
  if (!spread) return null;
  if (spread.branch_setting) {
    const defaultBranch =
      spread.branch_setting.branches.find((b) => b.is_default) ??
      spread.branch_setting.branches[0];
    const section = sections?.find((s) => s.id === defaultBranch?.section_id);
    return section?.start_spread_id ?? null;
  }
  const result = resolveNextSpreadId(spread, spreads, currentSection);
  if (result?.type === 'spread') return result.id;
  return null;
}

// === Props ===

interface PlayableSpreadViewProps {
  spreads: PlayableSpread[];
  sections?: Section[];
  onSpreadSelect?: (spreadId: string) => void;
  // Share preview context — optional, undefined = default editor behavior
  bookTitle?: string;
  availableEditions?: { classic?: boolean; dynamic?: boolean; interactive?: boolean };
  availableLanguages?: { name: string; code: string }[];
  // Page numbering overlay settings (null/undefined = hidden)
  pageNumbering?: PageNumberingSettings | null;
  /**
   * When true: hide the thumbnail rail + show book title overlay (share preview UX).
   * Navigation in this mode is sidebar-only (Next/Prev). Default `false`.
   */
  isSharePreview?: boolean;
  // Controlled-or-uncontrolled props (ADR-021)
  selectedSpreadId?: string | null;      // controlled from parent
  /**
   * Stable key identifying the spread source (e.g. `original:<bookId>`,
   * `remix:<remixId>`). Forwarded to the preload host so source switches
   * (Original ↔ Remix) re-fire the preload window and evict stale pooled audio.
   * Omit in single-source contexts (share preview) — defaults to a stable
   * undefined and the preload behaves as a one-shot per active spread.
   */
  sourceKey?: string;
  /**
   * Media quality (convert-width) for rendition resolve (ADR-057). When set,
   * mounts MediaQualityHost so render/preload call sites append `?quality=` to
   * visual media URLs. Omit in edit-modes and video render — original URLs are
   * served.
   */
  mediaQuality?: MediaQuality;
}

const KEYBOARD_SHORTCUTS = {
  PREV_SPREAD: 'ArrowLeft',
  NEXT_SPREAD: 'ArrowRight',
  TOGGLE_MUTE: 'm',
  VOLUME_UP: 'ArrowUp',
  VOLUME_DOWN: 'ArrowDown',
  FIRST_SPREAD: 'Home',
  LAST_SPREAD: 'End',
} as const;

export const PlayableSpreadView: React.FC<PlayableSpreadViewProps> = ({
  spreads,
  sections,
  onSpreadSelect,
  bookTitle,
  availableEditions,
  availableLanguages,
  pageNumbering,
  isSharePreview = false,
  selectedSpreadId: propSelectedSpreadId,
  sourceKey,
  mediaQuality,
}) => {

  // === Internal State ===
  // First-gesture gate: required to unlock browser autoplay before PlayerCanvas mounts.
  const [playerGestureCaptured, setPlayerGestureCaptured] = useState(false);

  // Outer wrapper ref — passed to PlayerAudioMixerHost so the MutationObserver
  // installed by useAudioMixerLifecycle can scan the entire player subtree
  // (BookBackgroundMusicPlayer + PlayerCanvas) for declarative <audio> nodes.
  const rootRef = useRef<HTMLDivElement>(null);

  // Imperative handle to PlayerCanvas — exposes `getSpreadContainer()` for the
  // spread-turn transition snapshot. Wired into `useSpreadTurnTransition` below.
  const playerCanvasHandleRef = useRef<PlayerCanvasHandle>(null);

  // === Audio mixer inputs ===
  const masterVolume = useVolume();
  const isMuted = useIsMuted();
  const music = useBookMusic();
  const sound = useBookSound();
  const narratorVolumeScale = useBookNarratorVolume();

  const bookAudio: BookAudioSettings = useMemo(() => ({
    music: music ?? { background_id: null, volume_scale: 1.0 },
    sound: sound ?? {
      transition_id: null,
      true_id: null,
      wrong_id: null,
      volume_scale: 1.0,
    },
    narratorVolumeScale,
  }), [music, sound, narratorVolumeScale]);

  const bgmMediaUrl = useMusicMediaUrl(music?.background_id ?? null);
  // Resolved SFX URL for spread transition. Played fire-and-forget at the start
  // of every `swapWithTurn` (both turn-animation and instant-bypass paths) so
  // navigation feedback stays consistent regardless of effects strategy.
  const transitionSfxUrl = useSoundMediaUrl(sound?.transition_id ?? null);
  const transitionSfxUrlRef = useRef<string | null>(null);
  useEffect(() => {
    transitionSfxUrlRef.current = transitionSfxUrl;
  }, [transitionSfxUrl]);
  const playTransitionSfx = useCallback(() => {
    const url = transitionSfxUrlRef.current;
    if (!url) return;
    try {
      const sfx = createMixedAudio(url, 'sfx');
      sfx.play().catch((err) => {
        log.debug('playTransitionSfx', 'play_rejected', { error: String(err) });
        sfx.remove();
      });
    } catch (err) {
      log.warn('playTransitionSfx', 'create_failed', { error: String(err) });
    }
  }, []);

  // Centralized first-gesture handler: resume the AudioContext (flushing the
  // autoStartQueue inside playerAudioStore) BEFORE flipping the gate state.
  // This ensures any pre-mounted <audio data-audio-channel> nodes that were
  // queued for autoplay start the moment the gate dismisses.
  const handleGestureCapture = useCallback(async () => {
    try {
      await usePlayerAudioStore.getState().resumeContext();
    } catch (e) {
      log.warn('handleGestureCapture', 'resume_failed', { error: String(e) });
    }
    setPlayerGestureCaptured(true);
  }, []);

  // playMode is store-owned — single source of truth across PlayableSpreadView,
  // PlayerCanvas, control sidebar, and use-player-gsap-engine. Initial value
  // is `'off'` (see store INITIAL_STATE); not persisted across reloads.
  const playMode = usePlayMode();
  const defaultEdition = useMemo<PlayEdition>(() => {
    // undefined = no constraint (internal editor) → all editions available → pick highest
    if (!availableEditions || availableEditions.interactive) return 'interactive';
    if (availableEditions.dynamic) return 'dynamic';
    return 'classic';
  }, [availableEditions]);
  // Edition lives in the playback store (single source of truth — sidebar +
  // canvas both read it from there). Default falls back when stored value is
  // disallowed by availableEditions (see edition-correction effect below).
  const playEdition = usePlayEdition();
  const [localSelectedSpreadId, setLocalSelectedSpreadId] = useState<string | null>(
    spreads[0]?.id ?? null
  );
  const [showBranchModal, setShowBranchModal] = useState(false);
  const [pendingBranchSpreadId, setPendingBranchSpreadId] = useState<string | null>(null);

  // PlayerCanvas manages its own fit-zoom — no controlled zoom from parent.
  const effectiveZoomLevel = PLAYABLE_ZOOM.DEFAULT;
  const effectiveSelectedSpreadId =
    propSelectedSpreadId !== undefined ? propSelectedSpreadId : localSelectedSpreadId;

  const applySelectedSpreadChange = useCallback((spreadId: string) => {
    if (propSelectedSpreadId !== undefined) {
      onSpreadSelect?.(spreadId);
    } else {
      setLocalSelectedSpreadId(spreadId);
      onSpreadSelect?.(spreadId);
    }
  }, [propSelectedSpreadId, onSpreadSelect]);

  // Zoom: PlayerCanvas manages its own fitZoom → no global store sync needed
  // in player-only world (was conditional on non-player canvas, now always skipped).

  // === Store ===
  const spreadHistories = useSpreadHistories();
  const currentSection = useCurrentSection();
  const playbackActions = usePlaybackActions();
  const { pushSpreadHistory, popSpreadHistory, setCurrentSection, setPlayEdition, setPlayMode } = playbackActions;

  // Edition seeding is now handled by container `initialize(payload)` — removed.
  // `defaultEdition` still feeds the payload composition upstream (share-preview,
  // demo, editor). PlayableSpreadView itself no longer writes to the store on mount.
  void defaultEdition;

  // === Spread turn transition ===
  // `transition_type` lives in book.effects (JSONB). Default to 'turn' for
  // legacy books with null effects so they pick up the new behavior.
  const bookEffects = useBookEffects();
  const transitionStrategy = useMemo(
    () => resolveTransitionStrategy(bookEffects?.transition_type ?? null),
    [bookEffects?.transition_type],
  );
  // Always-player component: turn transition gated solely by strategy choice.
  const turnEnabled = transitionStrategy === 'turn';

  const turn = useSpreadTurnTransition({
    enabled: turnEnabled,
    spreadContainerGetter: () =>
      playerCanvasHandleRef.current?.getSpreadContainer() ?? null,
    onSwap: (toId) => applySelectedSpreadChange(toId),
  });

  /** Centralized swap helper: dispatch through turn transition when enabled,
   *  otherwise fall through to instant `applySelectedSpreadChange`. The hook's
   *  bypass paths (reduced-motion, debug-disable, no container, snapshot fail)
   *  also call `applySelectedSpreadChange` via `onSwap`, so callers are guaranteed
   *  exactly-once swap semantics regardless of strategy. */
  const swapWithTurn = useCallback(
    (targetId: string, direction: TurnDirection, fromId: string | null) => {
      // No-op when source === target (re-click on same spread); skip SFX too.
      if (fromId && fromId === targetId) return;
      playTransitionSfx();
      if (turnEnabled) {
        turn.startTurn({
          fromSpreadId: fromId ?? '',
          toSpreadId: targetId,
          direction,
        });
        // Dev-only invariant: hook must commit `onSwap` synchronously inside
        // `startTurn`, so by the time we return here the caller's pending
        // selectedSpreadId state should match `targetId`. We can't read state
        // mid-render, so we re-call applySelectedSpreadChange's logic? No — we
        // simply assert that `targetId` is non-empty (cheap sanity guard); the
        // real synchronous-swap proof lives in the hook's startTurn body.
        if (import.meta.env.DEV) {
          console.assert(
            typeof targetId === 'string' && targetId.length > 0,
            'swapWithTurn invariant: targetId must be a non-empty string',
          );
        }
      } else {
        applySelectedSpreadChange(targetId);
      }
    },
    [turnEnabled, turn, applySelectedSpreadChange, playTransitionSfx],
  );

  // === Derived State ===
  const selectedSpread = spreads.find((s) => s.id === effectiveSelectedSpreadId);
  const hasPrevious = spreadHistories.length > 1;
  const nextResult = resolveNextSpreadId(selectedSpread, spreads, currentSection);
  const hasNext = nextResult !== null;

  // Edition change: PlayerCanvas resets steps internally (no canvas remount needed).
  const handleEditionChange = useCallback((edition: PlayEdition) => {
    log.info('handleEditionChange', 'edition switching', { edition });
    setPlayEdition(edition);
  }, [setPlayEdition]);

  // === Navigation Handlers ===

  const handleSkipSpread = useCallback((direction: 'next' | 'prev') => {
    if (direction === 'prev') {
      if (spreadHistories.length <= 1) return;
      const entry = popSpreadHistory();
      if (entry) {
        log.debug('handleSkipSpread', 'back to prev', { spreadId: entry.spreadId });
        swapWithTurn(entry.spreadId, 'prev', effectiveSelectedSpreadId);
      }
      return;
    }

    // direction === 'next'
    const result = resolveNextSpreadId(selectedSpread, spreads, currentSection);
    if (!result) return;

    if (result.type === 'branch') {
      if (playEdition === 'interactive') {
        log.info('handleSkipSpread', 'branch detected, showing modal', { spreadId: effectiveSelectedSpreadId });
        setPendingBranchSpreadId(effectiveSelectedSpreadId);
        setShowBranchModal(true);
      } else {
        // Classic/Dynamic: auto-resolve via default branch, no modal
        const targetId = autoResolveNextSpread(selectedSpread, spreads, sections, currentSection);
        if (targetId) {
          log.debug('handleSkipSpread', 'branch auto-resolved', { targetId, playEdition });
          pushSpreadHistory(targetId, currentSection);
          swapWithTurn(targetId, 'next', effectiveSelectedSpreadId);
        }
      }
      return;
    }
    if (result.type === 'spread') {
      log.debug('handleSkipSpread', 'next spread', { targetId: result.id });
      pushSpreadHistory(result.id, currentSection);
      swapWithTurn(result.id, 'next', effectiveSelectedSpreadId);
    }
  }, [spreadHistories, selectedSpread, spreads, sections, currentSection, playEdition, effectiveSelectedSpreadId, popSpreadHistory, pushSpreadHistory, swapWithTurn]);

  // === Branch Modal Handlers ===

  const handleBranchSelect = useCallback((targetSpreadId: string, section: Section) => {
    log.info('handleBranchSelect', 'branch chosen', { targetSpreadId, sectionId: section.id });
    setShowBranchModal(false);
    setPendingBranchSpreadId(null);
    setCurrentSection(section);
    pushSpreadHistory(targetSpreadId, section);
    swapWithTurn(targetSpreadId, 'next', effectiveSelectedSpreadId);
  }, [setCurrentSection, pushSpreadHistory, swapWithTurn, effectiveSelectedSpreadId]);

  const handleBranchDismiss = useCallback(() => {
    setShowBranchModal(false);
    setPendingBranchSpreadId(null);
    const branchSetting = selectedSpread?.branch_setting;
    if (!branchSetting) return;
    const defaultBranch =
      branchSetting.branches.find((b) => b.is_default) ?? branchSetting.branches[0];
    const section = sections?.find((s) => s.id === defaultBranch?.section_id);
    if (section) {
      log.info('handleBranchDismiss', 'dismissed, following default branch', { targetId: section.start_spread_id, sectionId: section.id });
      setCurrentSection(section);
      pushSpreadHistory(section.start_spread_id, section);
      swapWithTurn(section.start_spread_id, 'next', effectiveSelectedSpreadId);
    } else {
      log.debug('handleBranchDismiss', 'dismissed, no default branch section found');
    }
  }, [selectedSpread, sections, setCurrentSection, pushSpreadHistory, swapWithTurn, effectiveSelectedSpreadId]);

  // === Spread Selection Handler (thumbnail) ===
  const handleSpreadClick = useCallback(
    (spreadId: string) => {
      log.debug('handleSpreadClick', 'thumbnail clicked', { spreadId });
      // Compute direction from index delta — forward jump → 'next', back jump → 'prev'.
      // Same-spread click is a no-op for swapWithTurn (caller upstream).
      const curIdx = spreads.findIndex((s) => s.id === effectiveSelectedSpreadId);
      const newIdx = spreads.findIndex((s) => s.id === spreadId);
      const direction: TurnDirection = newIdx >= curIdx ? 'next' : 'prev';
      pushSpreadHistory(spreadId, currentSection);
      swapWithTurn(spreadId, direction, effectiveSelectedSpreadId);
    },
    [currentSection, pushSpreadHistory, swapWithTurn, spreads, effectiveSelectedSpreadId]
  );

  // === Spread Complete Handler ===
  const handleSpreadComplete = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (_spreadId: string) => {
      if (playMode !== 'auto') return;
      const targetId = autoResolveNextSpread(selectedSpread, spreads, sections, currentSection);
      if (!targetId) {
        playbackActions.pause();
        return;
      }
      const fromId = effectiveSelectedSpreadId;
      setTimeout(() => {
        pushSpreadHistory(targetId, currentSection);
        swapWithTurn(targetId, 'next', fromId);
      }, 1000);
    },
    [playMode, selectedSpread, spreads, sections, currentSection, playbackActions, pushSpreadHistory, swapWithTurn, effectiveSelectedSpreadId]
  );

  // === Keyboard Shortcuts ===
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return;
      }

      if (spreads.length === 0) return;

      switch (e.key) {
        case KEYBOARD_SHORTCUTS.PREV_SPREAD:
          handleSkipSpread('prev');
          break;
        case KEYBOARD_SHORTCUTS.NEXT_SPREAD:
          handleSkipSpread('next');
          break;
        case KEYBOARD_SHORTCUTS.FIRST_SPREAD: {
          e.preventDefault();
          const firstSpread = spreads[0];
          if (firstSpread) {
            applySelectedSpreadChange(firstSpread.id);
          }
          break;
        }
        case KEYBOARD_SHORTCUTS.LAST_SPREAD: {
          e.preventDefault();
          const lastSpread = spreads[spreads.length - 1];
          if (lastSpread) {
            applySelectedSpreadChange(lastSpread.id);
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    spreads,
    handleSkipSpread,
    applySelectedSpreadChange,
  ]);

  // === Render ===
  return (
    <div ref={rootRef} className="relative flex flex-col h-full">
      {/* Media quality host — mounted only when the host surface specifies a
          quality (player sub-app / preview / share-preview). Unmount resets it to
          null. MUST stay BEFORE PlayerSpreadPreloadHost: the quality is set in an
          effect, and sibling effects run in mount order — the preload collector
          reads the singleton and must see the quality already applied. */}
      {mediaQuality != null && <MediaQualityHost quality={mediaQuality} />}

      {/* Player audio mixer host — always mounted (pure player component). */}
      <PlayerAudioMixerHost
        rootRef={rootRef}
        masterVolume={masterVolume}
        isMuted={isMuted}
        bookAudio={bookAudio}
      />

      {/* Spread media preload host — sliding window N+1/N+2 across media types. */}
      {effectiveSelectedSpreadId && (
        <PlayerSpreadPreloadHost
          spreads={spreads}
          activeSpreadId={effectiveSelectedSpreadId}
          sourceKey={sourceKey}
        />
      )}

      {/* Canvas Area - full height (no header row) */}
      <div className="flex-1 overflow-hidden flex relative">
        {/* Book title overlay — share preview only */}
        {isSharePreview && bookTitle && (
          <div className="absolute top-3 left-3 bg-black/40 text-white text-sm font-medium px-3 py-1.5 rounded-md max-w-[60%] truncate opacity-80 hover:opacity-100 z-10 transition-opacity pointer-events-none">
            {bookTitle}
          </div>
        )}

        {selectedSpread ? (
          <>
            {/* PRE-MOUNT: BookBGM + PlayerCanvas mount immediately so per-spread
                auto_audios wire into the suspended AudioContext + binary preload
                BEFORE the user clicks the gesture gate. */}
            <BookBackgroundMusicPlayer mediaUrl={bgmMediaUrl} />
            <PlayerCanvas
              ref={playerCanvasHandleRef}
              spread={selectedSpread}
              zoomLevel={effectiveZoomLevel}
              playMode={playMode}
              playEdition={playEdition}
              hasNext={hasNext}
              hasPrevious={hasPrevious}
              onSpreadComplete={handleSpreadComplete}
              onSkipSpread={handleSkipSpread}
              onPlayModeChange={setPlayMode}
              onEditionChange={handleEditionChange}
              availableEditions={availableEditions}
              availableLanguages={availableLanguages}
              pageNumbering={pageNumbering}
              isSharePreview={isSharePreview}
            />
            {/* Spread-turn overlay — portal'd under document.body, sits above the
                canvas (z=50) but below FirstGestureGate (z=100). */}
            {turn.overlayProps && (
              <SpreadTurnOverlay {...turn.overlayProps} />
            )}
            {/* Gate overlay (z-100) covers the canvas until the user gesture is
                captured. */}
            {!playerGestureCaptured && (
              <FirstGestureGate onCapture={handleGestureCapture} />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            No spread selected
          </div>
        )}
      </div>

      {/* Thumbnail List — hidden in share-preview mode (sidebar-only navigation). */}
      {!isSharePreview && (
        <div className="h-[120px] flex-shrink-0">
          <PlayableThumbnailList
            spreads={spreads}
            selectedId={effectiveSelectedSpreadId}
            onSpreadClick={handleSpreadClick}
          />
        </div>
      )}

      {/* Branch Path Modal */}
      {showBranchModal && pendingBranchSpreadId && (() => {
        const branchSpread = spreads.find((s) => s.id === pendingBranchSpreadId);
        if (!branchSpread?.branch_setting) return null;
        return (
          <BranchPathModal
            branchSetting={branchSpread.branch_setting}
            sections={sections ?? []}
            onSelect={handleBranchSelect}
            onDismiss={handleBranchDismiss}
          />
        );
      })()}
    </div>
  );
};
