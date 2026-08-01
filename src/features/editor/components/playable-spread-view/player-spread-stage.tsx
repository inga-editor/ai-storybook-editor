// player-spread-stage.tsx — the shared, clock-agnostic spread render layer (ADR-035).
//
// Extracted from PlayerCanvas's render block. Owns the PARITY-CRITICAL structure:
// staging cull ([-50,150], ADR-023), Player Visibility Split (visual hidden →
// skip; audio/quiz hidden → render visibility:hidden), composite edition filter
// + effective z-index, the 0×0 wrapper carrying `data-item-id` + `registerRef`,
// and page / divider / numbering. Each item's LEAF visual is delegated to an
// injected per-type renderer (live → <Editable*>; render → Remotion primitives)
// and interactivity to `getItemInteractivity` (live only). Same structure for
// both clocks ⇒ preview === output by construction.

import { useMemo } from "react";
import { Z_INDEX, LAYER_CONFIG } from "@/constants/spread-constants";
import type { PlayableSpread, PlayEdition } from "@/types/playable-types";
import type { PageNumberingSettings } from "@/types/editor";
import { PageNumberingOverlay } from "../canvas-spread-view/page-numbering-overlay";
import { getTextboxContentForLanguage } from "../../utils/textbox-helpers";
import { isInStaging } from "./player-utils";
import { isItemPlayerHidden } from "./visibility-utils";
import { resolveAutoPicDisplaySource } from "./resolve-auto-pic-display-source";
import {
  buildPlayerCompositeContextMap,
  isVariantInAnyComposite,
  resolveEffectiveZIndex,
} from "@/features/editor/utils/composite-resolve-helpers";
import { createLogger } from "@/utils/logger";
import type {
  StageItemRenderers,
  ItemInteractivity,
  ItemInteractivityContext,
} from "./play-clock";

const log = createLogger("Editor", "PlayerSpreadStage");

export interface PlayerSpreadStageProps {
  spread: PlayableSpread;
  narrationLangCode: string;
  /** Active edition — drives the composite variant filter + effective z-index. */
  playEdition: PlayEdition;
  /** Callback-ref factory; registers the wrapper's firstElementChild for GSAP. */
  registerRef: (itemId: string) => (el: HTMLElement | null) => void;
  /** Per-item-type leaf renderers (live = Editable*, render = Remotion primitives). */
  renderers: StageItemRenderers;
  /** Live-only interactivity (pointer/highlight/onClick). Render passes none. */
  getItemInteractivity?: (ctx: ItemInteractivityContext) => ItemInteractivity;
  pageNumbering?: PageNumberingSettings | null;
  /** Author context? true → classic auto_pic missing static shows a placeholder;
   *  false → the item is skipped entirely. Live: `!isSharePreview`. Remotion
   *  render: always false (artifact, no authoring hints). Default true. */
  showAuthoringHints?: boolean;
}

const EMPTY_INTERACTIVITY: ItemInteractivity = {};

export function PlayerSpreadStage({
  spread,
  narrationLangCode,
  playEdition,
  registerRef,
  renderers,
  getItemInteractivity,
  pageNumbering,
  showAuthoringHints = true,
}: PlayerSpreadStageProps) {
  // Phase 6 — composite resolve map: on-edition variants get a z-index override;
  // off-edition variants are absent (consumer skips via isVariantInAnyComposite).
  const playerCompositeCtxMap = useMemo(
    () => buildPlayerCompositeContextMap({ composites: spread.composites }, playEdition),
    [spread.composites, playEdition]
  );

  const textboxesWithLang = useMemo(() => {
    if (!spread.textboxes) return [];
    const resolved = spread.textboxes
      .map((textbox) => {
        if (textbox.player_visible === false) return null;
        const result = getTextboxContentForLanguage(textbox, narrationLangCode);
        if (!result?.content?.geometry) return null;
        // Skip empty textboxes in player (no "Click to add text" placeholder)
        if (!result.content.text) return null;
        return { textbox, langKey: result.langKey, data: result.content };
      })
      .filter(Boolean);
    log.debug("textboxesWithLang", "resolved player textboxes", {
      total: spread.textboxes.length,
      rendered: resolved.length,
    });
    return resolved;
  }, [spread.textboxes, narrationLangCode]);

  const ix = (ctx: ItemInteractivityContext): ItemInteractivity =>
    getItemInteractivity?.(ctx) ?? EMPTY_INTERACTIVITY;

  // audio/quiz hidden → keep in DOM for GSAP/modal, but invisible + non-interactive
  const hiddenStyle = (item: { player_visible?: boolean }) =>
    isItemPlayerHidden(item)
      ? ({ visibility: "hidden", pointerEvents: "none" } as const)
      : undefined;

  return (
    <>
      {/* Pages */}
      {spread.pages.map((page, pageIndex) =>
        renderers.page(
          page,
          pageIndex,
          spread.pages.length === 1
            ? "single"
            : pageIndex === 0
            ? "left"
            : "right"
        )
      )}

      {/* Page divider — always visible */}
      <div
        className="absolute top-0 bottom-0 w-px bg-gray-300"
        style={{ left: "50%", zIndex: Z_INDEX.PAGE_BACKGROUND }}
      />

      {/* Page Number Overlay */}
      {pageNumbering && pageNumbering.position !== "none" && (
        <PageNumberingOverlay
          pages={spread.pages}
          position={pageNumbering.position}
          color={pageNumbering.color}
          fontFamily={pageNumbering.font_family}
          fontSize={pageNumbering.font_size}
        />
      )}

      {/* Images — skip empty (no resolved URL) and fully outside staging [-50, 150] */}
      {spread.images?.map((image, index) => {
        if (image.player_visible === false) return null;
        if (!isInStaging(image.geometry)) return null;
        const compositeCtx = playerCompositeCtxMap.get(image.id);
        if (!compositeCtx && isVariantInAnyComposite({ composites: spread.composites }, image.id)) {
          return null;
        }
        const hasUrl =
          image.final_hires_media_url ||
          image.illustrations?.some((i) => i.media_url) ||
          image.media_url;
        if (!hasUrl) return null;
        const effectiveZ = resolveEffectiveZIndex(
          { id: image.id, "z-index": image["z-index"] },
          playerCompositeCtxMap
        );
        const it = ix({ id: image.id, kind: "image", item: image });
        return (
          <div
            key={image.id}
            ref={registerRef(image.id)}
            data-item-id={image.id}
            className={it.className}
            onClickCapture={it.onClick}
          >
            {renderers.image(image, index, effectiveZ)}
          </div>
        );
      })}

      {/* Shapes */}
      {spread.shapes?.map((shape, index) => {
        if (shape.player_visible === false) return null;
        if (!isInStaging(shape.geometry)) return null;
        const it = ix({ id: shape.id, kind: "shape", item: shape });
        return (
          <div
            key={shape.id}
            ref={registerRef(shape.id)}
            data-item-id={shape.id}
            className={it.className}
            onClickCapture={it.onClick}
          >
            {renderers.shape(shape, index, shape["z-index"])}
          </div>
        );
      })}

      {/* Videos — skip empty (no media_url) and fully outside staging [-50, 150] */}
      {spread.videos?.map((video, index) => {
        if (video.player_visible === false) return null;
        if (!isInStaging(video.geometry)) return null;
        if (!video.media_url) return null;
        const it = ix({ id: video.id, kind: "video", item: video });
        return (
          <div
            key={video.id}
            ref={registerRef(video.id)}
            data-item-id={video.id}
            className={it.className}
            onClickCapture={it.onClick}
          >
            {renderers.video(video, index, video["z-index"])}
          </div>
        );
      })}

      {/* Auto Pics — skip empty (no media_url) and fully outside staging [-50, 150].
          Interactive pics (state machine) bypass narration click-loop — handled
          inside getItemInteractivity via the item object. */}
      {spread.auto_pics?.map((autoPic, index) => {
        if (autoPic.player_visible === false) return null;
        if (!isInStaging(autoPic.geometry)) return null;
        const source = resolveAutoPicDisplaySource(autoPic, playEdition);
        if (source.mode === "empty") {
          // dynamic/interactive without media_url — original !media_url skip.
          log.debug("autoPic", "skip: empty", { autoPicId: autoPic.id, edition: playEdition });
          return null;
        }
        if (source.mode === "missing-static" && !showAuthoringHints) {
          // classic missing static, public/render context → hide entirely.
          log.debug("autoPic", "skip: missing-static (no authoring hints)", {
            autoPicId: autoPic.id,
            edition: playEdition,
          });
          return null;
        }
        // (missing-static + authoring → fall through; renderer draws placeholder)
        const compositeCtx = playerCompositeCtxMap.get(autoPic.id);
        if (!compositeCtx && isVariantInAnyComposite({ composites: spread.composites }, autoPic.id)) {
          log.debug("autoPic", "skip: off-edition composite variant", {
            autoPicId: autoPic.id,
            edition: playEdition,
          });
          return null;
        }
        const effectiveZ = resolveEffectiveZIndex(
          { id: autoPic.id, "z-index": autoPic["z-index"] },
          playerCompositeCtxMap
        );
        const it = ix({ id: autoPic.id, kind: "autoPic", item: autoPic });
        return (
          <div
            key={autoPic.id}
            ref={registerRef(autoPic.id)}
            data-item-id={autoPic.id}
            className={it.className}
            onClickCapture={it.onClick}
          >
            {renderers.autoPic(autoPic, index, effectiveZ, source)}
          </div>
        );
      })}

      {/* Audios — skip empty (no media_url); player_visible=false → visibility:hidden
          to keep GSAP .play() working. No data-item-id (not a visual target). */}
      {spread.audios?.map((audio, index) => {
        if (!audio.media_url) return null;
        const hidden = isItemPlayerHidden(audio);
        const it = ix({ id: audio.id, kind: "audio", item: audio, isHidden: hidden });
        return (
          <div
            key={audio.id}
            ref={registerRef(audio.id)}
            className={it.className}
            style={hiddenStyle(audio)}
            onClickCapture={it.onClick}
          >
            {renderers.audio(audio, index, audio["z-index"])}
          </div>
        );
      })}

      {/* Quizzes — player_visible=false → visibility:hidden so quiz modal can still
          trigger via GSAP. No data-item-id. */}
      {spread.quizzes?.map((quiz, index) => {
        const hidden = isItemPlayerHidden(quiz);
        const it = ix({ id: quiz.id, kind: "quiz", item: quiz, isHidden: hidden });
        return (
          <div
            key={quiz.id}
            ref={registerRef(quiz.id)}
            className={it.className}
            style={hiddenStyle(quiz)}
            onClickCapture={it.onClick}
          >
            {renderers.quiz(quiz, index, quiz["z-index"])}
          </div>
        );
      })}

      {/* Textboxes */}
      {textboxesWithLang.map((item, index) => {
        if (!item) return null;
        const { textbox, data } = item;
        if (!isInStaging(data.geometry)) return null;
        const wordTimings = data.audio?.word_timings;
        const zIndex = textbox["z-index"] ?? LAYER_CONFIG.TEXT.min + index;
        const it = ix({ id: textbox.id, kind: "textbox", item: textbox });
        return (
          <div
            key={textbox.id}
            ref={registerRef(textbox.id)}
            data-item-id={textbox.id}
            className={it.className}
            onClickCapture={it.onClick}
          >
            {renderers.textbox(data, index, zIndex, wordTimings, textbox.id)}
          </div>
        );
      })}

      {/* Auto Audios — BGM-style hidden looping <audio> (imperative play()). No ref,
          no wrapper, no pointer events, no click handler (not an animation target). */}
      {(spread.auto_audios ?? []).map((autoAudio, index) => {
        if (!autoAudio.media_url) return null;
        return renderers.autoAudio(autoAudio, index);
      })}
    </>
  );
}
