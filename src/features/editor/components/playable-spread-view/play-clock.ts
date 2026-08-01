// play-clock.ts — clock seam contract for the shared player render core (ADR-035).
//
// The render core is clock-AGNOSTIC: one `PlayerSpreadStage` (DOM) + one
// `buildMasterTimeline` (GSAP, paused). A *driver* attaches to the paused
// timeline and advances it:
//   • live player  → WallClockDriver (tl.play / pause / resume on the rAF ticker)
//   • video render → FrameSeekDriver (tl.seek(frame/fps), deterministic)
// Sharing both = preview === output by construction.
//
// This module is INTERFACE-ONLY. WallClock impl lives in the GSAP engine
// (Phase 04); FrameSeek impl lives in the Remotion composition (Phase 03).

import type { PlayableSpread, PlayEdition } from "@/types/playable-types";
import type {
  SpreadAnimation,
  SpreadTextboxContent,
  WordTiming,
} from "@/types/spread-types";
import type { AutoPicDisplaySource } from "./resolve-auto-pic-display-source";

// LinearStep / LinearTimeline are owned by linearize-spread-timeline.ts (the
// analytic model); re-exported here so consumers import the whole seam from one
// place.
export type { LinearStep, LinearTimeline } from "./linearize-spread-timeline";

// ── Clock drivers ──────────────────────────────────────────────────────────

export type PlayClockMode = "wall-clock" | "frame-seek";

/** Base seam: a driver attaches to a paused master timeline and owns advancement. */
export interface PlayClock {
  readonly mode: PlayClockMode;
  attach(timeline: gsap.core.Timeline): void;
}

/** Live playback — wall-clock driven via GSAP's rAF ticker. */
export interface WallClockDriver extends PlayClock {
  readonly mode: "wall-clock";
  play(): void;
  pause(): void;
  resume(): void;
}

/** Video render — frame-seek driven; pure function of frame → fully deterministic. */
export interface FrameSeekDriver extends PlayClock {
  readonly mode: "frame-seek";
  seek(frame: number, fps: number): void;
}

// ── Stage leaf-renderer + interactivity seams ────────────────────────────────
// PlayerSpreadStage owns the SHARED structure (0×0 wrapper, data-item-id,
// registerRef, staging cull, visibility split, composite z-index). It delegates
// each item's LEAF to an injected per-type renderer so the same stage serves:
//   • live   → returns <Editable*> (byte-identical to the pre-refactor player DOM)
//   • render → returns positioned Remotion primitives (<Img>/<OffthreadVideo>/ThorVG)
// Live/render DOM thus share structure and differ only at the media leaf
// (normalized away in the Phase 05 parity test).

// Item element types are derived from PlayableSpread so the seam never drifts
// from the data model.
type ImageItem = NonNullable<PlayableSpread["images"]>[number];
type ShapeItem = NonNullable<PlayableSpread["shapes"]>[number];
type VideoItem = NonNullable<PlayableSpread["videos"]>[number];
type AutoPicItem = NonNullable<PlayableSpread["auto_pics"]>[number];
type AudioItem = NonNullable<PlayableSpread["audios"]>[number];
type QuizItem = NonNullable<PlayableSpread["quizzes"]>[number];
type AutoAudioItem = NonNullable<PlayableSpread["auto_audios"]>[number];
type PageItemData = PlayableSpread["pages"][number];

/** Resolved textbox content (output of getTextboxContentForLanguage().content). */
export type StageTextboxContent = SpreadTextboxContent;

export type StagePagePosition = "single" | "left" | "right";

/** Per-item-type leaf renderers injected into PlayerSpreadStage. The stage owns
 *  filters / culling / wrapper / z-index; these render only the inner visual.
 *  zIndex nullability mirrors the original player: composite-resolved items
 *  (image/autoPic) get a concrete number; raw items pass `item['z-index']`
 *  which may be undefined. */
export interface StageItemRenderers {
  page: (page: PageItemData, pageIndex: number, position: StagePagePosition) => React.ReactNode;
  image: (image: ImageItem, index: number, zIndex: number) => React.ReactNode;
  shape: (shape: ShapeItem, index: number, zIndex: number | undefined) => React.ReactNode;
  video: (video: VideoItem, index: number, zIndex: number | undefined) => React.ReactNode;
  /** `source` (⚡2026-08-01) = edition-resolved display mode. Stage computes it
   *  (already used it to decide skip) and passes it down so the leaf renderer
   *  need not re-resolve edition: 'static' → <img>/<Img>, 'animated' → runtime. */
  autoPic: (
    autoPic: AutoPicItem,
    index: number,
    zIndex: number,
    source: AutoPicDisplaySource
  ) => React.ReactNode;
  audio: (audio: AudioItem, index: number, zIndex: number | undefined) => React.ReactNode;
  quiz: (quiz: QuizItem, index: number, zIndex: number | undefined) => React.ReactNode;
  textbox: (
    content: StageTextboxContent,
    index: number,
    zIndex: number,
    wordTimings: WordTiming[] | undefined,
    textboxId: string
  ) => React.ReactNode;
  autoAudio: (autoAudio: AutoAudioItem, index: number) => React.ReactNode;
}

export type StageItemKind =
  | "image"
  | "shape"
  | "video"
  | "autoPic"
  | "audio"
  | "quiz"
  | "textbox";

/** What the stage tells `getItemInteractivity` about an item so live can apply
 *  type-specific affordances (autoPic state-machine pass-through, hidden
 *  audio/quiz click-suppression) without the stage importing live-only rules. */
export interface ItemInteractivityContext {
  id: string;
  kind: StageItemKind;
  /** The item object — live may inspect it (e.g. isAutoPicInteractive). */
  item: unknown;
  /** audio/quiz rendered visibility:hidden → live suppresses the click. */
  isHidden?: boolean;
}

/** Live-only per-item interactive affordances. Render mode returns nothing. */
export interface ItemInteractivity {
  /** Pointer + highlight classes applied to the item wrapper. */
  className?: string;
  /** onClickCapture handler for the item wrapper. */
  onClick?: () => void;
}

// ── buildMasterTimeline args ─────────────────────────────────────────────────

/** Per-animation GSAP lifecycle callbacks (live-auto wires store side-effects;
 *  render passes none). Mirrors the engine's `buildAnimCallbacks` return shape. */
export interface AnimTweenCallbacks {
  onTweenStart?: () => void;
  onTweenRepeat?: () => void;
  onTweenComplete?: () => void;
}

export type BuildMasterTimelineMode = "live-auto" | "render";

/**
 * Inputs for `buildMasterTimeline`. Behaviour-preserving extract of the live
 * `buildAndPlayFullTimeline` — position/pacing/quiz/camera logic is identical;
 * `mode` only toggles (a) quiz PLAY → addPause (live) vs duration spacer (render)
 * and (b) imperative side-effects (live) vs none (render — audio is declarative
 * <Audio>, read-along is frame-derived).
 *
 * NOTE: the caller owns `applyInitialStates` — live applies it in its own
 * mount/reset effects; render applies it before building. Keeping it OUT of the
 * builder is what makes live-auto byte-identical to the pre-refactor engine.
 */
export interface BuildMasterTimelineArgs {
  /** Already edition-filtered animations; builder sorts by `order`. */
  animations: SpreadAnimation[];
  /** Item id → mounted DOM element (= PlayerSpreadStage registerRef map). */
  refsMap: Map<string, HTMLElement>;
  container: HTMLElement | null;
  containerWidth: number;
  containerHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  // Optional spread slices — the engine reads these with `?.`, and a spread may
  // legitimately have none.
  composites?: PlayableSpread["composites"];
  textboxes?: PlayableSpread["textboxes"];
  audios?: PlayableSpread["audios"];
  narrationLangCode: string;
  playEdition: PlayEdition;
  /** Lines/Arcs delta source (original item geometry). */
  findItemGeometry: (targetId: string) => { x: number; y: number } | undefined;
  mode: BuildMasterTimelineMode;
  /** Fired when the timeline reaches its end (live: onSpreadComplete). */
  onComplete?: () => void;

  // ── live-auto side-effect wiring (ignored in render mode) ──
  buildCallbacks?: (anim: SpreadAnimation) => AnimTweenCallbacks;
  onQuizPlay?: (quizId: string) => void;
  /** Toggle a quiz anim's active-order highlight (add on true, remove on false). */
  setQuizActiveOrder?: (order: number, active: boolean) => void;
}
