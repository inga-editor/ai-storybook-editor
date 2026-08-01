// playable-thumbnail-list.tsx - Footer thumbnail list for spread navigation
"use client";

import React, { useRef, useEffect, useMemo } from "react";
import { cn } from "@/utils/utils";
import {
  EditableTextbox,
  EditableImage,
  EditableShape,
  EditableVideo,
  EditableAudio,
  EditableAutoPic,
  EditableAutoAudio,
} from "../shared-components";
import { getTextboxContentForLanguage } from "../../utils/textbox-helpers";
import { useNarrationLanguage, usePlayEdition } from "@/stores/animation-playback-store";
import { resolveAutoPicDisplaySource } from "./resolve-auto-pic-display-source";
import { useCanvasWidth, useCanvasAspectRatio } from "@/stores/editor-settings-store";
import { LAYER_CONFIG, Z_INDEX } from "@/constants/spread-constants";
import type { PlayableSpread } from "@/types/playable-types";

// === Layout Constants ===
const LAYOUT = {
  FOOTER_HEIGHT: 120,
  THUMBNAIL_WIDTH: 100,
  LABEL_HEIGHT: 20,
  THUMBNAIL_GAP: 8,
} as const;

// === Thumbnail Styles ===
const THUMBNAIL_STYLES = {
  SELECTED_BORDER: "2px solid #2196F3",
  UNSELECTED_BORDER: "1px solid #E0E0E0",
  HOVER_BG: "#E3F2FD",
  BORDER_RADIUS: 4,
} as const;

// === Props Interface ===
export interface PlayableThumbnailListProps {
  spreads: PlayableSpread[];
  selectedId: string | null;
  onSpreadClick: (spreadId: string) => void;
}

// === PlayableThumbnail Item Component ===
interface PlayableThumbnailProps {
  spread: PlayableSpread;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}

const PlayableThumbnail = React.memo(function PlayableThumbnail({
  spread,
  index,
  isSelected,
  onClick,
}: PlayableThumbnailProps) {
  const narrationLangCode = useNarrationLanguage();
  const playEdition = usePlayEdition();
  const canvasWidth = useCanvasWidth();
  const canvasAspectRatio = useCanvasAspectRatio();
  const canvasHeight = canvasWidth / canvasAspectRatio;
  // Scale factor: thumbnail width / canvas width
  const scale = LAYOUT.THUMBNAIL_WIDTH / canvasWidth;

  // Page label
  const pageLabel = useMemo(() => {
    if (spread.pages.length === 1) {
      return `Page ${spread.pages[0].number}`;
    }
    return `Pages ${spread.pages[0].number}-${spread.pages[1].number}`;
  }, [spread.pages]);

  const textboxesWithLang = useMemo(() => {
    if (!spread.textboxes) return [];
    return spread.textboxes
      .map((textbox) => {
        if (textbox.player_visible === false) return null;
        const result = getTextboxContentForLanguage(textbox, narrationLangCode);
        if (!result?.content?.geometry) return null;
        return { textbox, langKey: result.langKey, data: result.content };
      })
      .filter(Boolean);
  }, [spread.textboxes, narrationLangCode]);

  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      aria-label={`Spread ${index + 1}, ${pageLabel}`}
      tabIndex={isSelected ? 0 : -1}
      data-spread-id={spread.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex-shrink-0 flex flex-col overflow-hidden rounded",
        "transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        isSelected
          ? "border-2 border-primary"
          : "border border-border hover:bg-accent"
      )}
      style={{
        width: LAYOUT.THUMBNAIL_WIDTH,
        borderRadius: THUMBNAIL_STYLES.BORDER_RADIUS,
        cursor: "pointer",
      }}
    >
      {/* Preview Area — aspectRatio matches canvas so thumbnail has no extra padding below */}
      <div
        className="relative bg-white overflow-hidden w-full"
        style={{ aspectRatio: `${canvasAspectRatio}` }}
      >
        {/* Scaled Content Container. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: canvasWidth,
            height: canvasHeight,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            pointerEvents: "none",
          }}
        >
          {/* Page Backgrounds — z-index matches canvas convention so items
              with item["z-index"] stack above pages consistently. */}
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

          {/* Page Divider — always visible, khớp với player-canvas */}
          <div
            className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-300"
            style={{ zIndex: Z_INDEX.PAGE_BACKGROUND }}
          />

          {/* Items below forward item["z-index"] to Editable components so
              thumbnail stacking matches player-canvas.tsx behaviour. */}

          {/* Images (using EditableImage component) */}
          {spread.images?.map((image, idx) => {
            if (image.player_visible === false) return null;
            return (
              <EditableImage
                key={image.id || idx}
                image={image}
                index={idx}
                zIndex={image["z-index"]}
                isSelected={false}
                isEditable={false}
                onSelect={() => {}}
              />
            );
          })}

          {/* Videos (thumbnail - static) */}
          {spread.videos?.map((video, idx) => {
            if (video.player_visible === false) return null;
            return (
              <EditableVideo
                key={video.id || idx}
                video={video}
                index={idx}
                zIndex={video["z-index"]}
                isSelected={false}
                isEditable={false}
                onSelect={() => {}}
              />
            );
          })}

          {/* Auto Pics (thumbnail - auto-loop). Thumbnails are ALWAYS author
              context ⇒ classic missing-static shows a mini placeholder (never
              skipped). Empty (dynamic, no media_url) → skip, as before. */}
          {spread.auto_pics?.map((autoPic, idx) => {
            if (autoPic.player_visible === false) return null;
            const source = resolveAutoPicDisplaySource(autoPic, playEdition);
            if (source.mode === "empty") return null;
            return (
              <EditableAutoPic
                key={autoPic.id || idx}
                autoPic={autoPic}
                index={idx}
                zIndex={autoPic["z-index"]}
                isSelected={false}
                isEditable={false}
                isThumbnail={true}
                displaySource={source}
                onSelect={() => {}}
              />
            );
          })}

          {/* Shapes (thumbnail) */}
          {spread.shapes?.map((shape, idx) => {
            if (shape.player_visible === false) return null;
            return (
              <EditableShape
                key={shape.id || idx}
                shape={shape}
                index={idx}
                zIndex={shape["z-index"]}
                isSelected={false}
                isEditable={false}
                onSelect={() => {}}
              />
            );
          })}

          {/* Audios (thumbnail - icon only) */}
          {spread.audios?.map((audio, idx) => {
            if (audio.player_visible === false) return null;
            return (
              <EditableAudio
                key={audio.id || idx}
                audio={audio}
                index={idx}
                zIndex={audio["z-index"]}
                isSelected={false}
                isEditable={false}
                onSelect={() => {}}
              />
            );
          })}

          {/* Auto Audios (thumbnail - Music icon, no playback) */}
          {(spread.auto_audios ?? [])
            .filter((a) => a.editor_visible !== false)
            .map((autoAudio, idx) => (
              <EditableAutoAudio
                key={autoAudio.id || idx}
                autoAudio={autoAudio}
                index={idx}
                zIndex={autoAudio["z-index"]}
                isSelected={false}
                isEditable={true}
                isThumbnail={true}
                onSelect={() => {}}
              />
            ))}

          {/* Textboxes (using EditableTextbox component) */}
          {textboxesWithLang.map((item, idx) => {
            if (!item) return null;
            const { textbox, data } = item;
            return (
              <EditableTextbox
                key={textbox.id || idx}
                textboxContent={data}
                index={idx}
                zIndex={textbox["z-index"] ?? LAYER_CONFIG.TEXT.min + idx}
                isSelected={false}
                isSelectable={false}
                isEditable={false}
                onSelect={() => {}}
                onTextChange={() => {}}
                onEditingChange={() => {}}
              />
            );
          })}
        </div>
      </div>

      {/* Page Number Label */}
      <div
        className="h-5 px-1 text-xs text-center truncate bg-muted/50 flex items-center justify-center"
        style={{ fontSize: "10px" }}
      >
        {pageLabel}
      </div>
    </button>
  );
});

// === PlayableThumbnailList Component ===
export function PlayableThumbnailList({
  spreads,
  selectedId,
  onSpreadClick,
}: PlayableThumbnailListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll selected thumbnail into view
  useEffect(() => {
    if (!selectedId || !scrollContainerRef.current) return;

    const selectedElement = scrollContainerRef.current.querySelector(
      `[data-spread-id="${selectedId}"]`
    );

    if (selectedElement) {
      selectedElement.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [selectedId]);

  // Note: Keyboard navigation (ArrowLeft/Right) is handled by parent PlayableSpreadView
  // to avoid double handling and ensure consistent behavior

  return (
    <div
      role="listbox"
      aria-label="Spread thumbnails"
      aria-orientation="horizontal"
      className="h-[120px] flex items-center px-4 border-t bg-background"
      style={{
        height: LAYOUT.FOOTER_HEIGHT,
      }}
    >
      {/* Scroll Container */}
      <div
        ref={scrollContainerRef}
        className="flex overflow-x-auto"
        style={{
          gap: LAYOUT.THUMBNAIL_GAP,
          scrollbarWidth: "thin",
        }}
      >
        {spreads.map((spread, index) => (
          <PlayableThumbnail
            key={spread.id}
            spread={spread}
            index={index}
            isSelected={spread.id === selectedId}
            onClick={() => onSpreadClick(spread.id)}
          />
        ))}
      </div>
    </div>
  );
}
