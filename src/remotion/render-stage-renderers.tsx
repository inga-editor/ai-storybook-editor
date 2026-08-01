// remotion/render-stage-renderers.tsx
// Render-mode StageItemRenderers for PlayerSpreadStage (ADR-035). The deterministic
// counterpart of the live <Editable*> renderers: each leaf is a positioned
// (`position:absolute`, % geometry) div — the wrapper's firstElementChild that
// registerRef grabs and GSAP drives — containing a Remotion primitive
// (<Img>/<OffthreadVideo>/ThorVG) instead of an editor component. Same geometry +
// z-index as live ⇒ preview === output. Audio/quiz/auto-audio render nothing here:
// audio is declarative <Audio> in the composition, quiz collapses to a timing
// spacer (mode:'render'), and pages are drawn by the composition background.

import { Fragment } from "react";
import { Img, OffthreadVideo, Sequence } from "remotion";
import type { Typography } from "@/types/spread-types";
// Frame-deterministic lottie player (ThorVG via @lottiefiles/dotlottie-web), driven
// by setFrame + per-frame 'render' gate — used in BOTH <Player> preview and worker
// render so lottie pixels match (preview===output). WASM resolved via bundled ?url.
import { DotLottiePlayer } from "@/remotion/lottie/thorvg-lottie-player";
import { createLogger } from "@/utils/logger";
import type { StageItemRenderers } from "@/features/editor/components/playable-spread-view/play-clock";

const log = createLogger("Remotion", "RenderStageRenderers");

const ACTIVE_WORD_STYLE: React.CSSProperties = {
  backgroundColor: "#ffe58a",
  borderRadius: 3,
  boxDecorationBreak: "clone",
  WebkitBoxDecorationBreak: "clone",
};

// Mirrors the live EditableTextbox inner wrapper (`whitespace-pre-wrap break-words`):
// preserves authored newlines + wraps long words identically ⇒ same line count and
// block height as the player. Without this, plain (non-read-along) text collapses
// newlines (white-space:normal) and the rendered box height diverges from preview.
const TEXT_BLOCK_STYLE: React.CSSProperties = {
  width: "100%",
  height: "100%",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
};

function geoStyle(geo: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return {
    position: "absolute",
    left: `${geo.x}%`,
    top: `${geo.y}%`,
    width: `${geo.w}%`,
    height: `${geo.h}%`,
  };
}

/**
 * Typography → CSS, with absolute-px values (fontSize, letterSpacing) multiplied by
 * `fontScale` = compositionWidth / designCanvasWidth. The live player scales these by
 * zoomFactor (= scaledCanvasWidth / designCanvasWidth); since geometry is %-based and
 * resolution-independent, font/canvas-width is the zoom-invariant `size/designWidth`.
 * Without this, raw design-px fonts render tiny inside the 1920-wide composition.
 * lineHeight is unitless (a multiplier) → never scaled.
 */
function typographyStyle(t: Typography, fontScale: number): React.CSSProperties {
  return {
    fontSize: t.size != null ? t.size * fontScale : undefined,
    fontWeight: t.weight,
    fontStyle: t.style,
    fontFamily: t.family,
    color: t.color,
    // Mirror live EditableTextbox fallback (`typography?.lineHeight || 1.5`): a
    // missing/0 lineHeight renders at 1.5 in the player; without this the render
    // falls to the browser default (~1.2) → shorter lines, different wrap/height.
    lineHeight: t.lineHeight || 1.5,
    letterSpacing: t.letterSpacing != null ? t.letterSpacing * fontScale : undefined,
    textAlign: t.textAlign as React.CSSProperties["textAlign"],
    textTransform: t.textTransform as React.CSSProperties["textTransform"],
    textDecoration: t.decoration,
  };
}

/**
 * Read-along text as per-word spans (newlines → <br/>) with the active word
 * highlighted — render-mode equivalent of the player's span[data-word-index] +
 * .read-along-active-word class, driven by frame instead of audio.currentTime.
 */
function renderWordSpans(text: string, activeIndex: number): React.ReactNode {
  const segments = text.split(/(\s+)/);
  let wordIndex = -1;
  return segments.map((seg, i) => {
    if (/^\s+$/.test(seg) || seg === "") {
      if (seg.includes("\n")) return <br key={`br-${i}`} />;
      return <Fragment key={`ws-${i}`}>{seg}</Fragment>;
    }
    wordIndex += 1;
    const isActive = wordIndex === activeIndex;
    return (
      <span
        key={`w-${i}`}
        data-word-index={wordIndex}
        style={isActive ? ACTIVE_WORD_STYLE : undefined}
      >
        {seg}
      </span>
    );
  });
}

/** Resolve the best display URL for an image — mirrors PlayerSpreadStage's hasUrl
 *  priority so render shows the same pixels the live player resolves. */
function resolveImageUrl(image: {
  final_hires_media_url?: string | null;
  illustrations?: { media_url?: string | null }[];
  media_url?: string | null;
}): string {
  return (
    image.final_hires_media_url ||
    image.illustrations?.find((i) => i.media_url)?.media_url ||
    image.media_url ||
    ""
  );
}

/**
 * Build the render-mode renderer set.
 * - `activeWordByTextbox` (id → active word index, per frame) drives read-along highlight.
 * - `fontScale` = compositionWidth / designCanvasWidth — scales absolute-px typography +
 *   shape borders so text/outlines match the live player's zoom-scaled sizes.
 * - `videoStartByItem` (videoId → start frame from the PLAY step) gates each <OffthreadVideo>
 *   inside a <Sequence> so it begins exactly when its PLAY animation fires — not from frame 0
 *   (which would play the audio immediately and finish before the entrance reveals it).
 */
export function createRenderStageRenderers(
  activeWordByTextbox: Record<string, number>,
  fontScale: number,
  videoStartByItem: Record<string, number>
): StageItemRenderers {
  return {
    // Pages drawn by the composition background (white) — same as the validated spike.
    page: () => null,

    // Remotion <Img> registers delayRender() on mount; pauseWhenLoading blocks the
    // frame snapshot until decode() resolves — without it, plain <img> lets Remotion
    // capture the frame before the bitmap is decoded → white flash + fade-in in the
    // output video. See design spec 03-14-player-render-core §2.3.
    image: (image, _index, zIndex) => {
      const src = resolveImageUrl(image);
      return (
        <div data-base-opacity={1} style={{ ...geoStyle(image.geometry), zIndex: zIndex ?? 100 }}>
          <Img
            src={src}
            crossOrigin="anonymous"
            pauseWhenLoading
            onError={(e) => {
              log.warn("renderImage", "image decode failed in render", {
                src: src.split("?")[0],
                itemId: image.id,
                err: String(e),
              });
            }}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        </div>
      );
    },

    shape: (shape, _index, zIndex) => {
      const opacity = shape.fill?.opacity ?? 1;
      return (
        <div
          data-base-opacity={opacity}
          style={{
            ...geoStyle(shape.geometry),
            zIndex: zIndex ?? 150,
            backgroundColor: shape.fill?.is_filled ? shape.fill.color : "transparent",
            opacity,
            border: shape.outline
              ? `${shape.outline.width * fontScale}px solid ${shape.outline.color}`
              : undefined,
            borderRadius: (shape.outline?.radius ?? 0) * fontScale,
          }}
        />
      );
    },

    video: (video, _index, zIndex) => {
      // PLAY-gated start: <Sequence from> shifts the video's internal clock so frame 0
      // plays at its PLAY-animation frame (live calls mediaEl.play() then). Without a PLAY
      // step (rare — factory + real data always pair video with PLAY) it falls back to 0.
      const startFrame = videoStartByItem[video.id] ?? 0;
      return (
        <div data-base-opacity={1} style={{ ...geoStyle(video.geometry), zIndex: zIndex ?? 200 }}>
          {video.media_url ? (
            <Sequence from={startFrame} layout="none">
              <OffthreadVideo
                src={video.media_url}
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            </Sequence>
          ) : null}
        </div>
      );
    },

    autoPic: (autoPic, _index, zIndex, source) => {
      // 'static' (classic) → deterministic <Img pauseWhenLoading>, no animated
      //   runtime. 'animated' → lottie / <Img> as before, driven by source.url.
      //   'missing-static' | 'empty' → null (stage already skips; safety net).
      if (source.mode === "static") {
        return (
          <div data-base-opacity={1} style={{ ...geoStyle(autoPic.geometry), zIndex: zIndex ?? 210 }}>
            <Img
              src={source.url}
              pauseWhenLoading
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          </div>
        );
      }
      if (source.mode !== "animated") return null;
      const url = source.url.toLowerCase().split("?")[0];
      const isLottie = url.endsWith(".lottie");
      return (
        <div data-base-opacity={1} style={{ ...geoStyle(autoPic.geometry), zIndex: zIndex ?? 210 }}>
          {isLottie ? (
            <DotLottiePlayer src={source.url} options={autoPic.lottie} />
          ) : (
            <Img
              src={source.url}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          )}
        </div>
      );
    },

    // Audio is declarative <Audio> in the composition; no DOM here.
    audio: () => null,
    // Quiz collapses to a timing spacer (mode:'render'); no modal in render.
    quiz: () => null,
    // BGM auto-audio has no render-mode equivalent (muxed audio is per-step).
    autoAudio: () => null,

    textbox: (content, _index, zIndex, _wordTimings, textboxId) => {
      const isReadAlong = (content.audio?.word_timings?.length ?? 0) > 0;
      const activeIndex = activeWordByTextbox[textboxId] ?? -1;
      return (
        <div
          data-base-opacity={1}
          style={{
            ...geoStyle(content.geometry),
            zIndex: zIndex ?? 200,
            ...typographyStyle(content.typography, fontScale),
            overflow: "hidden",
          }}
        >
          <div style={TEXT_BLOCK_STYLE}>
            {isReadAlong ? renderWordSpans(content.text, activeIndex) : content.text}
          </div>
        </div>
      );
    },
  };
}
