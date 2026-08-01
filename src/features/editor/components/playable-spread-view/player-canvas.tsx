// player-canvas.tsx - Animation playback canvas wired to Zustand store + GSAP engine hook
"use client";

import { useState, useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from "react";
import {
  EditableTextbox,
  EditableImage,
  EditableShape,
  EditableVideo,
  EditableAudio,
  EditableQuiz,
  EditableAutoPic,
  EditableAutoAudio,
} from "../shared-components";
import { getScaledDimensions } from "../../utils/coordinate-utils";
import { useCanvasSize, useSetZoomLevel } from "@/stores/editor-settings-store";
import { useNarrationLanguage } from "@/stores/animation-playback-store";
import { PageItem } from "../canvas-spread-view/page-item";
import type {
  PlayableSpread,
  PlayMode,
  PlayEdition,
  AnimationStep,
} from "@/types/playable-types";
import type { Geometry } from "@/types/spread-types";
import {
  isReplayableClick,
  buildAnimationSteps,
  filterAnimationsForEdition,
} from "./player-utils";
import { usePlayerGsapEngine } from "./hooks/use-player-gsap-engine";
import {
  usePlaybackStore,
  usePlaybackActions,
  usePlayerPhase,
  useCurrentStepIndex,
  usePendingClickTargetId,
  useReplayableItems,
  useLifecycle,
} from "@/stores/animation-playback-store";
import { PlayerControlSidebar } from "./player-control-sidebar";
import type { PageNumberingSettings } from "@/types/editor";
import { createLogger } from "@/utils/logger";
import { isAutoPicInteractive } from "../shared-components/auto-pic-players/inspect-auto-pic";
import { usePlayerOrientation } from "./hooks/use-player-orientation";
import { useContainerFit } from "./hooks/use-container-fit";
import { MobileFullPageZoomOverlay } from "./mobile-full-page-zoom-overlay";
import { PlayerSpreadStage } from "./player-spread-stage";
import type {
  StageItemRenderers,
  ItemInteractivity,
  ItemInteractivityContext,
} from "./play-clock";

// === Types ===
export type FullPageMode = "spread" | "left" | "right";

/** Imperative handle exposed via `forwardRef`. Currently exposes a read-only
 *  getter for the spread container DOM — consumed by `useSpreadTurnTransition`
 *  (Phase 5/6) to snapshot the spread before a turn animation. */
export interface PlayerCanvasHandle {
  getSpreadContainer: () => HTMLElement | null;
}

// === Constants ===
const RAPID_NEXT_THRESHOLD = 150; // ms

// === Props Interface ===
export interface PlayerCanvasProps {
  spread: PlayableSpread;
  zoomLevel: number;
  playMode: PlayMode;
  playEdition: PlayEdition;
  hasNext: boolean;
  hasPrevious: boolean;
  onSpreadComplete: (spreadId: string) => void;
  onSkipSpread: (direction: "next" | "prev") => void;
  onPlayModeChange: (mode: PlayMode) => void;
  onEditionChange: (edition: PlayEdition) => void;
  availableEditions?: {
    classic?: boolean;
    dynamic?: boolean;
    interactive?: boolean;
  };
  availableLanguages?: { name: string; code: string }[];
  pageNumbering?: PageNumberingSettings | null;
  /** When true, auto-fit spread to container and enable responsive control bar */
  isSharePreview?: boolean;
}

const log = createLogger("Editor", "PlayerCanvas");

// === CSS for click-hint-pulse ===
// IMPORTANT: Apply to the CHILD element (> :first-child), not the wrapper div.
// The wrapper div is 0x0 (children are position:absolute with their own geometry).
const CLICK_HINT_STYLE = `
@keyframes click-hint-pulse {
  0%, 100% { opacity: 1; filter: drop-shadow(0 0 0px rgba(255, 165, 0, 0)); }
  50% { opacity: 0.7; filter: drop-shadow(0 0 10px rgba(255, 165, 0, 0.7)); }
}
.click-hint-pulse > :first-child {
  animation: click-hint-pulse 1.2s ease-in-out infinite;
}
.read-along-word {
  transition: background-color 0.15s ease, color 0.15s ease;
  border-radius: 0.1em;
  padding: 0;
}
.read-along-active-word {
  background-color: rgba(59, 130, 246, 0.25);
  color: #1d4ed8;
}
`;

export const PlayerCanvas = forwardRef<PlayerCanvasHandle, PlayerCanvasProps>(function PlayerCanvas(
  {
    spread,
    zoomLevel,
    playMode,
    playEdition,
    hasNext,
    hasPrevious,
    onSpreadComplete,
    onSkipSpread,
    onPlayModeChange,
    onEditionChange,
    availableEditions,
    availableLanguages,
    pageNumbering,
    isSharePreview = false,
  },
  ref,
) {
  // === Responsive hooks (share preview only) ===
  const orientation = usePlayerOrientation();
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // === Store selectors ===
  const lifecycle = useLifecycle();
  const playbackActions = usePlaybackActions();
  const phase = usePlayerPhase();
  const currentStepIndex = useCurrentStepIndex();
  const pendingClickTargetId = usePendingClickTargetId();
  const replayableItems = useReplayableItems();
  const steps = usePlaybackStore((s) => s.steps);
  const narrationLangCode = useNarrationLanguage();
  // ⚡ ADR-023: full bleed canvas — unified with editor/print
  const { width: canvasWidth, height: canvasHeight } = useCanvasSize();

  // === Full page zoom state (mobile portrait share preview only) ===
  const [fullPageMode, setFullPageMode] = useState<FullPageMode>("spread");

  // === Quiz modal state ===
  const [activeQuizId, setActiveQuizId] = useState<string | null>(null);

  const handleQuizPlay = useCallback((quizId: string) => {
    log.info("handleQuizPlay", "quiz modal opened", { quizId });
    setActiveQuizId(quizId);
  }, []);

  // === Edition-filtered animations (shared seam with the video render) ===
  const filteredAnimations = useMemo(
    () => filterAnimationsForEdition(spread.animations, playEdition),
    [spread.animations, playEdition]
  );

  // Auto-fit zoom — overrides prop zoomLevel with computed fit
  // In full page mode, useContainerFit fits half the canvas width (one page)
  const fitZoom = useContainerFit(
    canvasContainerRef,
    canvasWidth,
    canvasHeight,
    orientation,
    true,
    fullPageMode
  );
  const effectiveZoom = fitZoom ?? zoomLevel;
  const isPortrait = isSharePreview && orientation === "portrait";

  // Sync effective zoom to global store so child components (EditableTextbox etc.)
  // that read zoomLevel via useZoomLevel() get the correct scale factor
  const setStoreZoomLevel = useSetZoomLevel();
  useEffect(() => {
    setStoreZoomLevel(effectiveZoom);
  }, [effectiveZoom, setStoreZoomLevel]);

  // === GSAP engine hook ===
  const {
    spreadContainerRef,
    registerRef,
    handleClickLoopReplay,
    killTimeline,
    applyStepFinalStates,
    reApplyInitialStates,
    handleQuizComplete,
  } = usePlayerGsapEngine({
    spread,
    filteredAnimations,
    playEdition,
    zoomLevel: effectiveZoom,
    narrationLangCode,
    onSpreadComplete,
    onQuizPlay: handleQuizPlay,
  });

  // TODO(quiz-v2): wire back a quiz player UI for 5 quiz types — previously PlayQuizModal.
  // handleQuizComplete() đã sẵn sàng để re-use khi UI mới hoàn thành quiz step.
  void handleQuizComplete;

  // === Imperative handle — exposes the spread container DOM to PlayableSpreadView
  // for the spread-turn transition (Phase 6). Read-only getter — callers cannot
  // mutate the underlying ref. `[]` deps + lazy `.current` read avoids stale closure. ===
  useImperativeHandle(
    ref,
    () => ({
      getSpreadContainer: () => spreadContainerRef.current,
    }),
    [spreadContainerRef],
  );

  const { width: scaledWidth, height: scaledHeight } = getScaledDimensions(
    canvasWidth,
    canvasHeight,
    effectiveZoom
  );

  // === Store sync effects ===

  // 1. Sync playMode from props into store
  // Guarded: store actions noop until lifecycle === 'ready'; effect re-runs when
  // lifecycle flips so playMode + reset/play land on the live session.
  const prevPlayModeRef = useRef<PlayMode>(playMode);
  useEffect(() => {
    if (lifecycle !== "ready") return;
    const prevMode = prevPlayModeRef.current;
    prevPlayModeRef.current = playMode;
    playbackActions.setPlayMode(playMode);

    // Mode transition (off↔auto): reset store to clean state
    // - off→auto: clears stale pendingClickTargetId, phase, replayableItems
    // - auto→off: restarts step-based playback from beginning
    if (prevMode !== playMode) {
      const newSteps = buildAnimationSteps(
        filteredAnimations,
        spread,
        spread.id
      );
      playbackActions.reset(newSteps);
      playbackActions.play();
    }
  }, [lifecycle, playMode, playbackActions, filteredAnimations]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2. Reset steps on spread change or edition change & ensure playback starts.
  // fullPageMode is preserved across spread changes — user staying on left/right
  // page should remain on the same side after page turn.
  useEffect(() => {
    if (lifecycle !== "ready") return;
    setActiveQuizId(null); // Clear any open quiz modal from previous spread
    const newSteps = buildAnimationSteps(filteredAnimations, spread, spread.id);
    playbackActions.reset(newSteps);
    playbackActions.play();
  }, [lifecycle, spread.id, filteredAnimations]); // eslint-disable-line

  // 3. (removed) Init spread history on mount — `initialize` seeds history atomically in the container.

  // 3b. Reset fullPageMode to 'spread' when orientation switches to landscape
  useEffect(() => {
    if (orientation === "landscape" && fullPageMode !== "spread") {
      setFullPageMode("spread"); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [orientation]); // eslint-disable-line react-hooks/exhaustive-deps

  // 4. (removed) Cleanup on unmount → `teardown()` happens at container (PreviewCreativeSpace).

  // 5. Keyboard shortcuts: volume/mute — NOT lifecycle-gated (user-pref only, never guarded).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      )
        return;
      switch (e.key) {
        case "m":
        case "M":
          playbackActions.toggleMute();
          break;
        case "ArrowUp":
          e.preventDefault();
          playbackActions.setVolume(usePlaybackStore.getState().volume + 10);
          break;
        case "ArrowDown":
          e.preventDefault();
          playbackActions.setVolume(usePlaybackStore.getState().volume - 10);
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playbackActions]);

  // === Navigation handlers ===

  const lastNextTimeRef = useRef<number>(0);
  const lastBackTimeRef = useRef<number>(0);

  const handleNext = useCallback(() => {
    if (playMode !== "off") return;
    // Dismiss quiz modal if open before skipping
    if (activeQuizId) setActiveQuizId(null);
    // No animations on this spread — skip state machine, navigate immediately
    if (steps.length === 0) {
      if (hasNext) onSkipSpread("next");
      return;
    }
    if (phase === "playing") {
      const currentStep = steps[currentStepIndex];
      if (currentStep?.mustComplete) return;
      const now = Date.now();
      if (now - lastNextTimeRef.current < RAPID_NEXT_THRESHOLD) return;
      lastNextTimeRef.current = now;
      killTimeline();
      if (currentStep) applyStepFinalStates(currentStep);
      const isLastStep = currentStepIndex >= steps.length - 1;
      playbackActions.cancelAndNext();
      if (isLastStep && hasNext) onSkipSpread("next");
      return;
    }
    if (phase === "complete") {
      if (hasNext) onSkipSpread("next");
      return;
    }
    playbackActions.userNext();
  }, [
    playMode,
    phase,
    steps,
    currentStepIndex,
    hasNext,
    activeQuizId,
    killTimeline,
    applyStepFinalStates,
    playbackActions,
    onSkipSpread,
  ]);

  const handleBack = useCallback(() => {
    if (playMode !== "off") return;
    if (activeQuizId) setActiveQuizId(null);

    // Before any step played → navigate to previous spread
    if (currentStepIndex < 0) {
      if (hasPrevious) onSkipSpread("prev");
      return;
    }

    // Rate limit rapid presses
    const now = Date.now();
    if (now - lastBackTimeRef.current < RAPID_NEXT_THRESHOLD) return;
    lastBackTimeRef.current = now;

    // Block back during mustComplete step
    if (phase === "playing") {
      const currentStep = steps[currentStepIndex];
      if (currentStep?.mustComplete) return;
    }

    // Kill active timeline (safe no-op if none running) + pause media
    killTimeline();
    // Revert visual state of current step (works for both playing and completed steps)
    reApplyInitialStates(currentStepIndex);
    // Decrement currentStepIndex, set phase=awaiting_next (no auto-play)
    playbackActions.userBack();
  }, [
    playMode,
    currentStepIndex,
    hasPrevious,
    phase,
    steps,
    activeQuizId,
    killTimeline,
    reApplyInitialStates,
    playbackActions,
    onSkipSpread,
  ]);

  const handleItemClick = useCallback(
    (itemId: string) => {
      if (playMode !== "off") return;
      log.info("handleItemClick", "item clicked", {
        itemId,
        phase,
        pendingClickTargetId,
      });
      if (pendingClickTargetId === itemId) {
        playbackActions.userClick(itemId);
        return;
      }
      if (isReplayableClick(replayableItems, itemId) && phase !== "playing") {
        const result = playbackActions.clickLoopReplay(itemId);
        if (result.shouldReplay && result.step)
          handleClickLoopReplay(result.step as AnimationStep);
        return;
      }
      playbackActions.userClick(itemId);
    },
    [
      playMode,
      pendingClickTargetId,
      replayableItems,
      phase,
      playbackActions,
      handleClickLoopReplay,
    ]
  );

  // === Pointer & Highlight Logic ===

  const getPointerClasses = useCallback(
    (itemId: string): string => {
      if (playMode === "off") {
        if (pendingClickTargetId === itemId)
          return "pointer-events-auto cursor-pointer";
        if (isReplayableClick(replayableItems, itemId))
          return "pointer-events-auto cursor-pointer";
      }
      return "pointer-events-none";
    },
    [playMode, pendingClickTargetId, replayableItems]
  );

  const getHighlightClass = useCallback(
    (itemId: string): string => {
      return pendingClickTargetId === itemId ? "click-hint-pulse" : "";
    },
    [pendingClickTargetId]
  );

  // === Computed navigation state ===

  const canGoBack = useMemo(() => {
    if (playMode !== "off") return false;
    // Before any step → can go back only if previous spread exists
    if (currentStepIndex < 0) return hasPrevious;
    // During mustComplete step → can't go back
    if (phase === "playing") {
      const step = steps[currentStepIndex];
      return !step?.mustComplete;
    }
    return true;
  }, [playMode, currentStepIndex, hasPrevious, phase, steps]);

  const canGoNext = useMemo(() => {
    if (playMode !== "off") return false;
    if (phase === "playing") {
      const step = steps[currentStepIndex];
      return !step?.mustComplete;
    }
    if (phase === "complete") return hasNext;
    return true;
  }, [playMode, phase, currentStepIndex, steps, hasNext]);

  // === Full page zoom: hidden click target detection ===
  // Determines if the pending on_click target is on the hidden page
  const hiddenPageClickTarget = useMemo((): "left" | "right" | null => {
    if (fullPageMode === "spread") return null;
    if (phase !== "awaiting_click" || !pendingClickTargetId) return null;

    // Find which page side the target item is on via geometry center point
    const allItems = [
      ...(spread.images ?? []),
      ...(spread.shapes ?? []),
      ...(spread.videos ?? []),
      ...(spread.auto_pics ?? []),
      ...(spread.audios ?? []),
      ...(spread.textboxes ?? []),
      ...(spread.quizzes ?? []),
    ];
    const targetItem = allItems.find(
      (item) => item.id === pendingClickTargetId
    );
    if (!targetItem?.geometry) return null;

    const geo = targetItem.geometry as Geometry;
    const targetSide = geo.x + geo.w / 2 < 50 ? "left" : "right";
    // Blink only when target is on the HIDDEN page (not the currently viewed page)
    return targetSide !== fullPageMode ? targetSide : null;
  }, [fullPageMode, phase, pendingClickTargetId, spread]);

  // === Full page zoom: pan offset ===
  // Pan offset: left page shifts 1px to show divider at right edge; right page divider is naturally at left edge
  const halfScaled = scaledWidth / 2;
  const panOffsetX = useMemo(() => {
    if (fullPageMode === "left") return -1; // shift 1px left → divider peeks on right edge
    if (fullPageMode === "right") return -halfScaled; // divider already visible at left edge
    return 0;
  }, [fullPageMode, halfScaled]);

  // === Live stage renderers + interactivity (clock = wall-clock) ===
  // Per-item-type leaf renderers return the SAME <Editable*> the player has
  // always rendered — so PlayerSpreadStage reproduces the live DOM byte-for-byte.
  const liveRenderers = useMemo<StageItemRenderers>(
    () => ({
      page: (page, pageIndex, position) => (
        <PageItem
          key={pageIndex}
          page={page}
          pageIndex={pageIndex}
          spread={spread}
          spreadId={spread.id}
          position={position}
          isSelected={false}
          onUpdatePage={() => {}}
          availableLayouts={[]}
        />
      ),
      image: (image, index, zIndex) => (
        <EditableImage
          image={image}
          index={index}
          zIndex={zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={() => {}}
        />
      ),
      shape: (shape, index, zIndex) => (
        <EditableShape
          shape={shape}
          index={index}
          zIndex={zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={() => {}}
        />
      ),
      video: (video, index, zIndex) => (
        <EditableVideo
          video={video}
          index={index}
          zIndex={zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={() => {}}
        />
      ),
      autoPic: (autoPic, index, zIndex, source) => (
        <EditableAutoPic
          autoPic={autoPic}
          index={index}
          zIndex={zIndex}
          isSelected={false}
          isEditable={false}
          displaySource={source}
          onSelect={() => {}}
        />
      ),
      audio: (audio, index, zIndex) => (
        <EditableAudio
          audio={audio}
          index={index}
          zIndex={zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={() => {}}
        />
      ),
      quiz: (quiz, index, zIndex) => (
        <EditableQuiz
          quiz={quiz}
          index={index}
          zIndex={zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={() => {}}
        />
      ),
      textbox: (data, index, zIndex, wordTimings) => (
        <EditableTextbox
          textboxContent={data}
          index={index}
          zIndex={zIndex}
          isSelected={false}
          isSelectable={false}
          isEditable={false}
          onSelect={() => {}}
          onTextChange={() => {}}
          onEditingChange={() => {}}
          wordTimings={wordTimings}
        />
      ),
      autoAudio: (autoAudio, index) => (
        <EditableAutoAudio
          key={autoAudio.id}
          autoAudio={autoAudio}
          index={index}
          isSelected={false}
          isEditable={false}
          onSelect={() => {}}
        />
      ),
    }),
    // No playEdition dep: the autoPic leaf is edition-aware purely via the
    // `source` argument the stage computes (the stage re-renders on edition
    // change and passes a fresh source), so the renderer closure never reads it.
    [spread]
  );

  const getItemInteractivity = useCallback(
    (ctx: ItemInteractivityContext): ItemInteractivity => {
      const { id, kind, item, isHidden } = ctx;
      const highlight = getHighlightClass(id);
      if (kind === "autoPic") {
        // Interactive pics (Rive/Lottie state machine) bypass narration
        // click-loop: pointer events route to the runtime canvas.
        const interactive = isAutoPicInteractive(
          item as NonNullable<PlayableSpread["auto_pics"]>[number]
        );
        return {
          className: `${
            interactive
              ? "pointer-events-auto cursor-pointer"
              : getPointerClasses(id)
          } ${highlight}`,
          onClick: interactive ? undefined : () => handleItemClick(id),
        };
      }
      if (kind === "audio" || kind === "quiz") {
        return {
          className: `${getPointerClasses(id)} ${highlight}`,
          onClick: () => {
            if (!isHidden) handleItemClick(id);
          },
        };
      }
      // image / shape / video / textbox
      return {
        className: `${getPointerClasses(id)} ${highlight}`,
        onClick: () => handleItemClick(id),
      };
    },
    [getPointerClasses, getHighlightClass, handleItemClick]
  );

  // === Render ===
  // Share preview: no padding around canvas, only reserve space for control bar
  // Editor: original padding for comfortable editing
  const isFullPage = fullPageMode !== "spread";
  const containerClassName = isSharePreview
    ? isPortrait
      ? "relative flex-1 overflow-hidden flex items-center justify-center pb-14 bg-muted/30"
      : "relative flex-1 overflow-hidden flex items-center justify-center pr-14 bg-muted/30"
    : "relative flex-1 overflow-hidden flex items-center justify-center pr-14 bg-muted/30";

  return (
    <div ref={canvasContainerRef} className={containerClassName}>
      <style>{CLICK_HINT_STYLE}</style>

      {/* Spread + controls wrapper: flex column so overlay sits right below the spread */}
      <div
        className="flex flex-col items-center"
        style={isPortrait ? { transition: "all 0.3s ease" } : undefined}
      >
        {/* Clip wrapper: in full page mode, clips to half the spread width (one page).
           In spread mode, matches full spread dimensions (no clipping). */}
        <div
          style={{
            width: isFullPage ? halfScaled : scaledWidth,
            height: scaledHeight,
            overflow: "hidden",
            ...(isPortrait && {
              transition: "width 0.3s ease, height 0.3s ease",
            }),
          }}
        >
          {/* Spread container */}
          <div
            ref={spreadContainerRef}
            data-full-page-mode={fullPageMode}
            className="relative bg-white shadow-lg"
            style={{
              width: scaledWidth,
              height: scaledHeight,
              willChange: "transform",
              ...(isPortrait && {
                transform: `translateX(${panOffsetX}px)`,
                transition:
                  "width 0.3s ease, height 0.3s ease, transform 0.3s ease",
              }),
            }}
          >
            <PlayerSpreadStage
              spread={spread}
              narrationLangCode={narrationLangCode}
              playEdition={playEdition}
              registerRef={registerRef}
              renderers={liveRenderers}
              getItemInteractivity={getItemInteractivity}
              pageNumbering={pageNumbering}
              showAuthoringHints={!isSharePreview}
            />
          </div>
        </div>
        {/* end clip wrapper */}

        {/* Full page zoom overlay (mobile portrait share preview only) — sits right below spread */}
        {isPortrait && (
          <MobileFullPageZoomOverlay
            fullPageMode={fullPageMode}
            onModeChange={setFullPageMode}
            hiddenPageClickTarget={hiddenPageClickTarget}
            spreadWidth={isFullPage ? halfScaled : scaledWidth}
          />
        )}
      </div>
      {/* end spread + controls wrapper */}

      {/* Player controls sidebar / bottom bar */}
      <PlayerControlSidebar
        onPlayModeChange={onPlayModeChange}
        onNext={handleNext}
        onBack={handleBack}
        canNext={canGoNext}
        canBack={canGoBack}
        orientation={isSharePreview ? orientation : "landscape"}
        playEdition={playEdition}
        onEditionChange={onEditionChange}
        availableEditions={availableEditions}
        availableLanguages={availableLanguages}
      />

      {/* Quiz modal: player UI cho 5 quiz types sẽ được design lại sau Quiz v2 migration */}
    </div>
  );
});
PlayerCanvas.displayName = "PlayerCanvas";
