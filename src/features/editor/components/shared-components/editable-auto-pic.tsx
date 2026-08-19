// editable-auto-pic.tsx - Canvas component for auto_pic items (WebP/WebM auto-loop)
"use client";

import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/utils/utils";
import type { SpreadAutoPic } from "@/types/spread-types";
import { COLORS, DIMMED_BY_OVERLAP_OPACITY } from "@/constants/spread-constants";
import { createLogger } from "@/utils/logger";
import { useZoomLevel } from "@/stores/editor-settings-store";
import type { AutoPicDisplaySource } from "@/features/editor/components/playable-spread-view/resolve-auto-pic-display-source";
import { applyMediaQuality } from "@/features/editor/components/playable-spread-view/media-quality";

const log = createLogger("Editor", "EditableAutoPic");

const DotLottiePlayer = lazy(() =>
  import("./auto-pic-players/dot-lottie-player").then((m) => ({ default: m.DotLottiePlayer })),
);
const RivePlayer = lazy(() =>
  import("./auto-pic-players/rive-player").then((m) => ({ default: m.RivePlayer })),
);

const lazyFallback = (
  <div className="absolute inset-0 flex items-center justify-center bg-muted">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
);

type MediaKind = "webp" | "webm" | "lottie" | "riv" | "unknown";

function detectMediaKind(url: string | undefined): MediaKind {
  if (!url) return "unknown";
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".lottie")) return "lottie";
  if (lower.endsWith(".riv")) return "riv";
  return "unknown";
}

interface AutoPicPlaceholderProps {
  name: string;
  type: string;
  /** Extra instruction line (e.g. classic missing-static hint). */
  hint?: string;
  /** Thumbnail mode — icon only, no text/badge (too small to read). */
  iconOnly?: boolean;
}

/** Dashed placeholder for an auto_pic with no renderable media. Exported so the
 *  player can reuse it for the classic "missing static image" author overlay. */
export function AutoPicPlaceholder({ name, type, hint, iconOnly = false }: AutoPicPlaceholderProps) {
  const zoomFactor = useZoomLevel() / 100;
  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center gap-2 p-2 border-2 border-dashed"
      style={{
        backgroundColor: COLORS.PLACEHOLDER_BG,
        borderColor: COLORS.PLACEHOLDER_BORDER,
      }}
    >
      <Sparkles className="h-6 w-6 text-muted-foreground" />
      {!iconOnly && (
        <>
          <p
            className={cn("text-center line-clamp-2", !name && "italic")}
            style={{ color: COLORS.PLACEHOLDER_TEXT, fontSize: `${12 * zoomFactor}px` }}
          >
            {name || "No animated pic"}
          </p>
          {hint && (
            <p
              className="text-center line-clamp-2"
              style={{ color: COLORS.PLACEHOLDER_TEXT, fontSize: `${10 * zoomFactor}px` }}
            >
              {hint}
            </p>
          )}
          <span
            className="rounded"
            style={{
              backgroundColor: COLORS.PLACEHOLDER_BORDER,
              color: COLORS.PLACEHOLDER_TEXT,
              fontSize: `${10 * zoomFactor}px`,
              padding: `0 ${4 * zoomFactor}px`,
            }}
          >
            {type}
          </span>
        </>
      )}
    </div>
  );
}

interface EditableAutoPicProps {
  autoPic: SpreadAutoPic;
  index: number;
  zIndex?: number;
  isSelected: boolean;
  isEditable: boolean;
  isThumbnail?: boolean;
  /** Show persistent item border (muted outline) — only in retouch/objects space */
  showItemBorder?: boolean;
  /** Canvas-level controlled hover (ADR-029 smart hit-test). */
  isHoveredByCanvas?: boolean;
  /** ADR-029 dim — set true when this auto_pic fully covers a selected item with lower z. */
  dimmedByOverlap?: boolean;
  /** ⚡ Edition-aware display (player/thumbnail only). Absent = legacy animated
   *  behavior (editor canvas — Objects/Remix/Actors — always renders media_url).
   *  'static' → render the static <img>; 'missing-static' → author placeholder. */
  displaySource?: AutoPicDisplaySource;
  onSelect: () => void;
}

export function EditableAutoPic({
  autoPic,
  index,
  zIndex,
  isSelected,
  isEditable,
  isThumbnail = false,
  showItemBorder,
  isHoveredByCanvas,
  dimmedByOverlap = false,
  displaySource,
  onSelect,
}: EditableAutoPicProps) {
  const [isHoveredLocal, setIsHoveredLocal] = useState(false);
  const isHovered = isHoveredByCanvas ?? isHoveredLocal;
  const useLocalHover = isHoveredByCanvas === undefined;
  const [isLoading, setIsLoading] = useState(!!autoPic.media_url);
  const [hasError, setHasError] = useState(false);

  const mediaKind = detectMediaKind(autoPic.media_url);
  const showMedia = !!autoPic.media_url && !hasError && mediaKind !== "unknown";
  // Quality rendition (ADR-057): rewrites only when a player quality is active
  // (MediaQualityHost mounted) — edit canvases pass through unchanged.
  // `.riv` has no sibling rendition; the appended param is harmlessly ignored.
  const qualityMediaUrl = autoPic.media_url ? applyMediaQuality(autoPic.media_url) : undefined;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isEditable && !isThumbnail) {
        log.info("handleClick", "auto_pic selected", { index, id: autoPic.id });
        onSelect();
      }
    },
    [isEditable, isThumbnail, onSelect, index, autoPic.id]
  );

  const handleLoaded = useCallback(() => setIsLoading(false), []);
  const handleError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
    log.warn("handleError", "auto_pic media load failed", { id: autoPic.id, url: autoPic.media_url, mediaKind });
  }, [autoPic.id, autoPic.media_url, mediaKind]);

  useEffect(() => {
    if (mediaKind === "lottie" || mediaKind === "riv") {
      log.debug("render", `${mediaKind} player dispatched`, { isThumbnail, id: autoPic.id });
    }
  }, [mediaKind, isThumbnail, autoPic.id]);

  return (
    <div
      role="img"
      aria-label={autoPic.title || `Auto Pic ${index + 1}`}
      tabIndex={isEditable ? 0 : -1}
      data-item-id={autoPic.id}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && isEditable && !isThumbnail && onSelect()}
      onMouseEnter={useLocalHover ? () => setIsHoveredLocal(true) : undefined}
      onMouseLeave={useLocalHover ? () => setIsHoveredLocal(false) : undefined}
      data-rotation={Number.isFinite(autoPic.geometry.rotation) ? autoPic.geometry.rotation : 0}
      className={cn(
        "absolute overflow-hidden transition-opacity",
        isEditable && !isThumbnail && "cursor-pointer",
        !isSelected && (showItemBorder || isHovered) && "outline outline-1"
      )}
      style={{
        left: `${autoPic.geometry.x}%`,
        top: `${autoPic.geometry.y}%`,
        width: `${autoPic.geometry.w}%`,
        height: `${autoPic.geometry.h}%`,
        transform: `rotate(${Number.isFinite(autoPic.geometry.rotation) ? autoPic.geometry.rotation : 0}deg)`,
        transformOrigin: "center center",
        willChange: "transform",
        zIndex,
        opacity: dimmedByOverlap ? DIMMED_BY_OVERLAP_OPACITY : 1,
        transition: "opacity 150ms ease-out",
        outlineColor: !isSelected
          ? isHovered
            ? COLORS.ITEM_BORDER_HOVER
            : COLORS.ITEM_BORDER_AUTO_PIC
          : undefined,
      }}
    >
      {displaySource?.mode === "static" ? (
        // Edition classic — render the resolved static image only. No animated
        // runtime (lottie/riv/video) is mounted regardless of media_url.
        <img
          src={applyMediaQuality(displaySource.url)}
          alt={autoPic.title || ""}
          className="w-full h-full object-contain"
        />
      ) : displaySource?.mode === "missing-static" ? (
        // Edition classic, no static image — author placeholder (public/render
        // contexts never reach here; the stage skips them).
        <AutoPicPlaceholder
          name={autoPic.title || "Auto pic"}
          type="static missing"
          hint={isThumbnail ? undefined : "Cần upload ảnh tĩnh cho edition Classic"}
          iconOnly={isThumbnail}
        />
      ) : showMedia ? (
        <>
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {mediaKind === "webp" ? (
            // Animated WebP loops natively — same element for full and thumbnail modes
            <img
              src={qualityMediaUrl}
              alt={autoPic.title || ""}
              className="w-full h-full object-contain"
              onLoad={handleLoaded}
              onError={handleError}
            />
          ) : mediaKind === "lottie" ? (
            <Suspense fallback={lazyFallback}>
              <DotLottiePlayer
                src={qualityMediaUrl!}
                isThumbnail={isThumbnail}
                options={autoPic.lottie}
                onLoad={handleLoaded}
                onError={handleError}
              />
            </Suspense>
          ) : mediaKind === "riv" ? (
            <Suspense fallback={lazyFallback}>
              <RivePlayer
                src={qualityMediaUrl!}
                isThumbnail={isThumbnail}
                options={autoPic.rive}
                onLoad={handleLoaded}
                onError={handleError}
              />
            </Suspense>
          ) : (
            // WebM: thumbnail uses preload=metadata (first frame, no autoplay).
            // onLoadedMetadata fires reliably with preload=metadata on Firefox/Safari;
            // onLoadedData may not fire when the browser stops after metadata.
            isThumbnail ? (
              <video
                src={qualityMediaUrl}
                className="w-full h-full object-contain"
                preload="metadata"
                muted
                playsInline
                onLoadedMetadata={handleLoaded}
                onError={handleError}
              />
            ) : (
              <video
                src={qualityMediaUrl}
                className="w-full h-full object-contain"
                autoPlay
                muted
                loop
                playsInline
                onLoadedData={handleLoaded}
                onError={handleError}
              />
            )
          )}
        </>
      ) : (
        <AutoPicPlaceholder
          name={autoPic.title || ""}
          type={mediaKind}
        />
      )}
    </div>
  );
}

export default EditableAutoPic;
