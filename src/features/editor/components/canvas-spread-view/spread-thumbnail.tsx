// spread-thumbnail.tsx
"use client";

import React, {
  Fragment,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { cn } from "@/utils/utils";
import {
  buildViewOnlyImageContext,
  buildViewOnlyTextContext,
  buildViewOnlyShapeContext,
  buildViewOnlyVideoContext,
  buildViewOnlyAudioContext,
  buildViewOnlyQuizContext,
  buildViewOnlyAutoPicContext,
  buildViewOnlyAutoAudioContext,
} from "./utils/context-builders";
import { resolveItemZIndex } from "./utils/resolve-item-z-index";
import { THUMBNAIL, Z_INDEX } from "@/constants/spread-constants";
import { useCanvasWidth, useCanvasAspectRatio } from "@/stores/editor-settings-store";
import { Lock } from "lucide-react";
import { useSpreadPeerLockName } from "@/stores/resource-lock-store";
import type {
  BaseSpread,
  ItemType,
  ImageItemContext,
  TextItemContext,
  ShapeItemContext,
  VideoItemContext,
  AudioItemContext,
  AutoAudioItemContext,
  QuizItemContext,
  AutoPicItemContext,
} from "@/types/canvas-types";

interface SpreadThumbnailProps<TSpread extends BaseSpread> {
  // Data
  spread: TSpread;
  spreadIndex: number;

  // State
  isSelected: boolean;
  size: "small" | "medium";

  // Render configuration (optional - skip rendering if not provided)
  renderItems: ItemType[];
  renderImageItem?: (context: ImageItemContext<TSpread>) => ReactNode;
  renderTextItem?: (context: TextItemContext<TSpread>) => ReactNode;
  renderShapeItem?: (context: ShapeItemContext<TSpread>) => ReactNode;
  renderVideoItem?: (context: VideoItemContext<TSpread>) => ReactNode;
  renderAudioItem?: (context: AudioItemContext<TSpread>) => ReactNode;
  renderAutoAudioItem?: (context: AutoAudioItemContext<TSpread>) => ReactNode;
  renderQuizItem?: (context: QuizItemContext<TSpread>) => ReactNode;
  renderAutoPicItem?: (context: AutoPicItemContext<TSpread>) => ReactNode;

  // Raw item render functions (illustration layer)
  renderRawImage?: (context: ImageItemContext<TSpread>) => ReactNode;
  renderRawTextbox?: (context: TextItemContext<TSpread>) => ReactNode;

  // Collab peer-lock config (opt-in): when a whole-spread lock of {step, resourceType} is held by
  // ANOTHER editor, the thumbnail dims + shows a lock/holder badge. Omitted by non-collab spaces
  // (preview/dummy) → no lock lookup, no badge. Stable module-const object from the space → memo-safe.
  peerLock?: { step: number; resourceType: number };

  /** Opt-in dot indicator (Actors space) — draws a small primary dot on the
   *  thumbnail (top-right) when true. Default false → unchanged for other spaces. */
  showIndicatorDot?: boolean;

  // Drag state
  isDragEnabled?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;

  // Callbacks
  onClick: () => void;
  onDoubleClick?: () => void; // Grid mode: switch to Edit
  onDelete?: () => void; // Delete spread
  canDelete?: boolean; // Enable delete feature
  isLastSpread?: boolean; // Hide delete if true (can't delete last spread)
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragEnd?: () => void;
}

function SpreadThumbnailInner<TSpread extends BaseSpread>({
  spread,
  spreadIndex,
  isSelected,
  size,
  renderItems,
  renderImageItem,
  renderTextItem,
  renderShapeItem,
  renderVideoItem,
  renderAudioItem,
  renderAutoAudioItem,
  renderQuizItem,
  renderAutoPicItem,
  renderRawImage,
  renderRawTextbox,
  peerLock,
  showIndicatorDot = false,
  isDragEnabled = false,
  isDragging = false,
  isDropTarget = false,
  onClick,
  onDoubleClick,
  onDelete,
  canDelete = false,
  isLastSpread = false,
  onDragStart,
  onDragOver,
  onDragEnd,
}: SpreadThumbnailProps<TSpread>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const canvasWidth = useCanvasWidth();
  const canvasAspectRatio = useCanvasAspectRatio();

  // Collab: non-null when ANOTHER editor holds this spread's whole-spread lock (live). Reactive —
  // re-renders past React.memo on any registry/holder-name change. Null when free/mine or not
  // lock-aware (peerLock omitted) → no badge.
  const peerLockName = useSpreadPeerLockName(spread.id, peerLock?.step, peerLock?.resourceType);

  // Track container width for medium mode scaling
  useLayoutEffect(() => {
    if (size !== "medium" || !containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [size]);

  // Scale factor: calculated from container width (unified for both sizes)
  const effectiveWidth =
    size === "small" ? THUMBNAIL.SMALL_WIDTH : containerWidth;
  const scale = effectiveWidth > 0 ? effectiveWidth / canvasWidth : 0;

  // Page label
  const label = useMemo(() => {
    if (spread.pages.length === 1) {
      return `Page ${spread.pages[0].number}`;
    }
    return `Pages ${spread.pages[0].number}-${spread.pages[1].number}`;
  }, [spread.pages]);

  // Resolve z-index per item via shared helper so thumbnails, editor panel,
  // and selection frame share a single stacking-order source of truth.

  const rawImageContexts = useMemo(() => {
    if (!renderItems.includes("raw_image") || !renderRawImage) return [];
    return (spread.raw_images ?? []).map((img, idx) => {
      const context = buildViewOnlyImageContext(img, idx, spread);
      context.zIndex = resolveItemZIndex("raw_image", idx, spread);
      return { image: img, context };
    });
  }, [spread, renderItems, renderRawImage]);

  const imageContexts = useMemo(() => {
    if (!renderItems.includes("image") || !renderImageItem) return [];
    return (spread.images ?? []).map((img, idx) => {
      const context = buildViewOnlyImageContext(img, idx, spread);
      context.zIndex = resolveItemZIndex("image", idx, spread);
      return { image: img, context };
    });
  }, [spread, renderItems, renderImageItem]);

  const rawTextboxContexts = useMemo(() => {
    if (!renderItems.includes("raw_textbox") || !renderRawTextbox) return [];
    return (spread.raw_textboxes ?? []).map((textbox, idx) => {
      const context = buildViewOnlyTextContext(textbox, idx, spread);
      context.zIndex = resolveItemZIndex("raw_textbox", idx, spread);
      return { textbox, context };
    });
  }, [spread, renderItems, renderRawTextbox]);

  const textContexts = useMemo(() => {
    if (!renderItems.includes("textbox") || !renderTextItem) return [];
    return (spread.textboxes ?? []).map((textbox, idx) => {
      const context = buildViewOnlyTextContext(textbox, idx, spread);
      context.zIndex = resolveItemZIndex("textbox", idx, spread);
      return { textbox, context };
    });
  }, [spread, renderItems, renderTextItem]);

  const shapeContexts = useMemo(() => {
    if (!renderItems.includes("shape") || !renderShapeItem || !spread.shapes)
      return [];
    return spread.shapes.map((shape, idx) => {
      const context = buildViewOnlyShapeContext(shape, idx, spread);
      context.zIndex = resolveItemZIndex("shape", idx, spread);
      return { shape, context };
    });
  }, [spread, renderItems, renderShapeItem]);

  const videoContexts = useMemo(() => {
    if (!renderItems.includes("video") || !renderVideoItem || !spread.videos)
      return [];
    return spread.videos.map((video, idx) => {
      const context = buildViewOnlyVideoContext(video, idx, spread);
      context.zIndex = resolveItemZIndex("video", idx, spread);
      return { video, context };
    });
  }, [spread, renderItems, renderVideoItem]);

  const autoPicContexts = useMemo(() => {
    if (!renderItems.includes("auto_pic") || !renderAutoPicItem || !spread.auto_pics) {
      return [];
    }
    return spread.auto_pics.map((autoPic, idx) => {
      const context = buildViewOnlyAutoPicContext(autoPic, idx, spread);
      context.zIndex = resolveItemZIndex("auto_pic", idx, spread);
      return { autoPic, context };
    });
  }, [spread, renderItems, renderAutoPicItem]);

  const audioContexts = useMemo(() => {
    if (!renderItems.includes("audio") || !renderAudioItem || !spread.audios)
      return [];
    return spread.audios.map((audio, idx) => {
      const context = buildViewOnlyAudioContext(audio, idx, spread);
      context.zIndex = resolveItemZIndex("audio", idx, spread);
      return { audio, context };
    });
  }, [spread, renderItems, renderAudioItem]);

  const autoAudioContexts = useMemo(() => {
    if (!renderItems.includes("auto_audio") || !renderAutoAudioItem || !spread.auto_audios)
      return [];
    return spread.auto_audios.map((autoAudio, idx) => {
      const context = buildViewOnlyAutoAudioContext(autoAudio, idx, spread);
      context.zIndex = resolveItemZIndex("auto_audio", idx, spread);
      return { autoAudio, context };
    });
  }, [spread, renderItems, renderAutoAudioItem]);

  const quizContexts = useMemo(() => {
    if (!renderItems.includes("quiz") || !renderQuizItem || !spread.quizzes)
      return [];
    return spread.quizzes.map((quiz, idx) => {
      const context = buildViewOnlyQuizContext(quiz, idx, spread);
      context.zIndex = resolveItemZIndex("quiz", idx, spread);
      return { quiz, context };
    });
  }, [spread, renderItems, renderQuizItem]);

  // Cursor style: grabbing while dragging, grab when can drag, pointer otherwise
  const cursor = isDragging ? "grabbing" : isDragEnabled ? "grab" : "pointer";

  // Show delete button when hovering and not last spread
  const showDeleteButton = canDelete && !isLastSpread;

  return (
    <div
      role="option"
      aria-selected={isSelected}
      aria-label={`Spread ${spreadIndex + 1}, ${label}`}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className={cn(
        "flex-shrink-0 transition-all scroll-snap-align-start",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
        isDragging && "opacity-50",
        isDropTarget && "ring-2 ring-dashed ring-blue-400"
      )}
      draggable={isDragEnabled}
      aria-grabbed={isDragging}
      onDragStart={(e) => {
        if (!isDragEnabled) return;
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragOver={(e) => {
        if (!isDragEnabled) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver?.();
      }}
      onDragEnd={onDragEnd}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      }}
    >
      {/* Thumbnail Container - responsive width with fixed aspect ratio */}
      <div
        ref={containerRef}
        className={cn(
          "thumbnail-container relative overflow-hidden rounded-md bg-white shadow-sm",
          "hover:shadow-md transition-shadow",
          size === "medium" && "w-full", // Medium: fill grid cell, Small: fixed
          isSelected && "ring-2 ring-blue-500"
        )}
        style={{
          // Maintain canvas aspect ratio regardless of container width
          aspectRatio: `${canvasAspectRatio}`,
          // Small size: fixed width, Medium: responsive (aspectRatio handles height)
          ...(size === "small" && { width: THUMBNAIL.SMALL_WIDTH }),
          contain: "layout style paint",
        }}
      >
        {/* Scaled Content: render at canvas size, scale down to fit container */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: canvasWidth,
            height: canvasWidth / canvasAspectRatio,
            transform: scale > 0 ? `scale(${scale})` : "scale(0)",
            transformOrigin: "top left",
            pointerEvents: "none",
            // Hide until scale is calculated (prevents flash)
            visibility: scale > 0 ? "visible" : "hidden",
          }}
        >
          {/* Page Backgrounds */}
          {spread.pages.map((page, pageIndex) => {
            const isDPS = spread.pages.length === 1;
            const positionStyle: React.CSSProperties = isDPS
              ? { left: 0, top: 0, width: "100%", height: "100%" }
              : pageIndex === 0
              ? { left: 0, top: 0, width: "50%", height: "100%" }
              : { left: "50%", top: 0, width: "50%", height: "100%" };

            return (
              <div
                key={pageIndex}
                className="absolute"
                style={{
                  ...positionStyle,
                  backgroundColor: page.background.color,
                  backgroundImage: page.background.texture
                    ? `url(/textures/${page.background.texture}.png)`
                    : "none",
                  backgroundRepeat: "repeat",
                  backgroundSize: "256px 256px",
                  zIndex: Z_INDEX.PAGE_BACKGROUND,
                }}
              />
            );
          })}

          {/* Page Divider — always visible, khớp với spread-editor-panel */}
          <div
            className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-300"
            style={{ zIndex: Z_INDEX.PAGE_BACKGROUND }}
          />

          {/* NOTE: Items render via Fragment (not wrapper div) so each item's
              resolved z-index stacks within the scaled-content stacking
              context. A wrapper div is not positioned and would force items
              into DOM-order flow on browsers that collapse z-index across
              sibling subtrees. */}

          {/* Raw Images (illustration layer, view-only) */}
          {renderRawImage &&
            rawImageContexts.map(({ image, context }, index) => (
              <Fragment key={image.id || `raw-img-${index}`}>
                {renderRawImage(context)}
              </Fragment>
            ))}

          {/* Images (playable layer, view-only) */}
          {renderImageItem &&
            imageContexts.map(({ image, context }, index) => (
              <Fragment key={image.id || `img-${index}`}>
                {renderImageItem(context)}
              </Fragment>
            ))}

          {/* Videos (view-only) - skip if renderVideoItem not provided */}
          {renderVideoItem &&
            videoContexts.map(({ video, context }, index) => (
              <Fragment key={video.id || `vid-${index}`}>
                {renderVideoItem(context)}
              </Fragment>
            ))}

          {/* Auto Pics (view-only) - skip if renderAutoPicItem not provided */}
          {renderAutoPicItem &&
            autoPicContexts.map(({ autoPic, context }, index) => (
              <Fragment key={autoPic.id || `anim-${index}`}>
                {renderAutoPicItem(context)}
              </Fragment>
            ))}

          {/* Shapes (view-only) - skip if renderShapeItem not provided */}
          {renderShapeItem &&
            shapeContexts.map(({ shape, context }, index) => (
              <Fragment key={shape.id || `shp-${index}`}>
                {renderShapeItem(context)}
              </Fragment>
            ))}

          {/* Raw Textboxes (illustration layer, view-only) */}
          {renderRawTextbox &&
            rawTextboxContexts.map(({ textbox, context }, index) => (
              <Fragment key={textbox.id || `raw-txt-${index}`}>
                {renderRawTextbox(context)}
              </Fragment>
            ))}

          {/* Textboxes (playable layer, view-only) */}
          {renderTextItem &&
            textContexts.map(({ textbox, context }, index) => (
              <Fragment key={textbox.id || `txt-${index}`}>
                {renderTextItem(context)}
              </Fragment>
            ))}

          {/* Audios (view-only) - skip if renderAudioItem not provided */}
          {renderAudioItem &&
            audioContexts.map(({ audio, context }, index) => (
              <Fragment key={audio.id || `aud-${index}`}>
                {renderAudioItem(context)}
              </Fragment>
            ))}

          {/* Auto Audios (view-only) - skip if renderAutoAudioItem not provided */}
          {renderAutoAudioItem &&
            autoAudioContexts.map(({ autoAudio, context }, index) => (
              <Fragment key={autoAudio.id || `aaud-${index}`}>
                {renderAutoAudioItem(context)}
              </Fragment>
            ))}

          {/* Quizzes (view-only) - skip if renderQuizItem not provided */}
          {renderQuizItem &&
            quizContexts.map(({ quiz, context }, index) => (
              <Fragment key={quiz.id || `quiz-${index}`}>
                {renderQuizItem(context)}
              </Fragment>
            ))}
        </div>

        {/* Click Overlay - captures all clicks/double-clicks */}
        <div
          className="absolute inset-0"
          style={{
            zIndex: 10,
            cursor,
            pointerEvents: "auto",
          }}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
        />

        {/* Delete Button - shows on hover */}
        {showDeleteButton && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete?.();
            }}
            className={cn(
              "delete-button absolute top-1 right-1 z-20",
              "w-6 h-6 rounded-full bg-red-500 text-white",
              "flex items-center justify-center",
              "opacity-0 transition-opacity duration-150",
              "hover:bg-red-600"
            )}
            aria-label="Delete spread"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6m4-6v6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}

        {/* Casting indicator dot (Actors space, opt-in) — spread contains a layer of the
            selected actant. Top-right, non-interactive. */}
        {showIndicatorDot && (
          <span
            className="absolute top-1 right-1 z-30 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-white pointer-events-none"
            aria-label="Casts selected actant"
          />
        )}

        {/* Collab peer-lock — light dim + centered lock icon (holder name in tooltip). Above content
            (z:10) and delete (z:20) but pointer-events:none so a click still selects the spread. */}
        {peerLockName && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-background/40 pointer-events-none"
            title={`${peerLockName} is editing`}
            aria-label={`Locked by ${peerLockName}`}
          >
            <span className="flex items-center justify-center rounded-full bg-background/90 p-1.5 shadow-sm">
              <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
          </div>
        )}
      </div>

      {/* Label */}
      <p className="mt-1 text-xs text-center text-muted-foreground truncate">
        {label}
      </p>

      {/* CSS for delete button hover visibility */}
      <style>{`
        .thumbnail-container:hover .delete-button {
          opacity: 1;
        }
      `}</style>
    </div>
  );
}

// Export memoized component
export const SpreadThumbnail = React.memo(
  SpreadThumbnailInner
) as typeof SpreadThumbnailInner;

export default SpreadThumbnail;
