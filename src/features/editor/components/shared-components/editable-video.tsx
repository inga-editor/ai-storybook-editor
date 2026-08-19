// editable-video.tsx - Utility component for displaying videos in CanvasSpreadView
"use client";

import { useState, useCallback } from "react";
import { Video, Loader2 } from "lucide-react";
import { cn } from "@/utils/utils";
import type { SpreadVideo } from "@/types/spread-types";
import { COLORS, DIMMED_BY_OVERLAP_OPACITY } from "@/constants/spread-constants";
import { applyMediaQuality } from "@/features/editor/components/playable-spread-view/media-quality";

interface EditableVideoProps {
  video: SpreadVideo;
  index: number;
  zIndex?: number;
  isSelected: boolean;
  isEditable: boolean;
  isThumbnail?: boolean;
  /** Show persistent item border (muted black outline) — only in retouch/objects space */
  showItemBorder?: boolean;
  /** Canvas-level controlled hover (ADR-029 smart hit-test). */
  isHoveredByCanvas?: boolean;
  /** ADR-029 dim — set true when this video fully covers a selected item with lower z. */
  dimmedByOverlap?: boolean;
  onSelect: () => void;
}

export function EditableVideo({
  video,
  index,
  zIndex,
  isSelected,
  isEditable,
  isThumbnail = false,
  showItemBorder,
  isHoveredByCanvas,
  dimmedByOverlap = false,
  onSelect,
}: EditableVideoProps) {
  const [isHoveredLocal, setIsHoveredLocal] = useState(false);
  const isHovered = isHoveredByCanvas ?? isHoveredLocal;
  const useLocalHover = isHoveredByCanvas === undefined;
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isEditable) {
        onSelect();
      }
    },
    [isEditable, onSelect]
  );

  const handleLoadedData = useCallback(() => {
    setIsLoading(false);
  }, []);

  const handleError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  const showVideo = video.media_url && !hasError;
  // Quality rendition (ADR-057): rewrites only when a player quality is active
  // (MediaQualityHost mounted) — edit canvases pass through unchanged.
  const videoSrc = video.media_url ? applyMediaQuality(video.media_url) : undefined;

  return (
    <div
      role="img"
      aria-label={video.title || `Video ${index + 1}`}
      tabIndex={isEditable ? 0 : -1}
      data-item-id={video.id}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && isEditable && onSelect()}
      onMouseEnter={useLocalHover ? () => setIsHoveredLocal(true) : undefined}
      onMouseLeave={useLocalHover ? () => setIsHoveredLocal(false) : undefined}
      className={cn(
        "absolute overflow-hidden transition-opacity",
        isEditable && "cursor-pointer",
        !isSelected && (showItemBorder || isHovered) && "outline outline-1"
      )}
      style={{
        left: `${video.geometry.x}%`,
        top: `${video.geometry.y}%`,
        width: `${video.geometry.w}%`,
        height: `${video.geometry.h}%`,
        zIndex,
        opacity: dimmedByOverlap ? DIMMED_BY_OVERLAP_OPACITY : 1,
        transition: "opacity 150ms ease-out",
        outlineColor: !isSelected
          ? isHovered
            ? COLORS.ITEM_BORDER_HOVER
            : COLORS.ITEM_BORDER_VIDEO
          : undefined,
      }}
    >
      {showVideo ? (
        <>
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {isThumbnail ? (
            // Show first frame as poster in thumbnail mode
            <video
              src={videoSrc}
              className="w-full h-full object-contain"
              preload="metadata"
              onLoadedData={handleLoadedData}
              onError={handleError}
            />
          ) : (
            <video
              src={videoSrc}
              className="w-full h-full object-contain"
              preload="metadata"
              onLoadedData={handleLoadedData}
              onError={handleError}
            />
          )}
        </>
      ) : (
        <VideoPlaceholder name={video.title || ""} />
      )}
    </div>
  );
}

interface VideoPlaceholderProps {
  name: string;
}

function VideoPlaceholder({ name }: VideoPlaceholderProps) {
  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center gap-2 p-2 border-2 border-dashed"
      style={{
        backgroundColor: COLORS.PLACEHOLDER_BG,
        borderColor: COLORS.PLACEHOLDER_BORDER,
      }}
    >
      <Video className="h-6 w-6 text-muted-foreground" />
      <p
        className={cn("text-center line-clamp-2 text-xs", !name && "italic")}
        style={{ color: COLORS.PLACEHOLDER_TEXT }}
      >
        {name || "No video"}
      </p>
    </div>
  );
}

export default EditableVideo;
