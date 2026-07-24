// objects-text-toolbar.tsx - Floating toolbar for textbox items on canvas in Objects Creative Space
"use client";

import { useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import {
  Scissors,
  AudioLines,
  Trash2,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import {
  useToolbarPosition,
  type BaseSpread,
  type TextToolbarContext,
} from "@/features/editor/components/canvas-spread-view";
import { createLogger } from "@/utils/logger";
import { InlineAudioPlayer } from "@/components/audio/inline-audio-player";
import {
  clampGeometry,
  GeometrySection,
  ToolbarIconButton,
} from "@/features/editor/components/shared-components";
import { useLanguageCode } from "@/stores/editor-settings-store";
import { getTextboxContentForLanguage } from "@/features/editor/utils/textbox-helpers";
import { GenerateNarrationModal } from "@/features/editor/components/shared-components/generate-narration-modal";
import type {
  SpreadTextboxContent,
  TextboxAudio,
} from "@/types/spread-types";

const log = createLogger("Editor", "ObjectsTextToolbar");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ObjectsTextToolbarProps<TSpread extends BaseSpread> {
  context: TextToolbarContext<TSpread>;
}

export function ObjectsTextToolbar<TSpread extends BaseSpread>({
  context,
}: ObjectsTextToolbarProps<TSpread>) {
  // --- Refs ---
  const toolbarRef = useRef<HTMLDivElement>(null);

  // --- State ---
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);

  // --- Context destructuring ---
  const {
    item,
    spreadId,
    onUpdate,
    onDelete,
    onSplitTextbox,
    onEditText,
    selectedGeometry,
    canvasRef,
  } = context;

  // --- Hooks ---
  const position = useToolbarPosition({
    geometry: selectedGeometry,
    canvasRef,
    toolbarRef,
  });

  const editorLangCode = useLanguageCode();
  const langResult = getTextboxContentForLanguage(
    item as unknown as Record<string, unknown>,
    editorLangCode
  );
  const langCode = langResult?.langKey ?? editorLangCode;
  const content = langResult?.content;

  // --- Derived data ---
  const geometry = content?.geometry;
  const audio = content?.audio;
  const hasText = !!content?.text;
  const audioUrl = audio?.combined_audio_url ?? null;
  // Toolbar reads raw snapshot (not adapter-coerced). Legacy data may carry
  // `script_synced` instead of `is_sync` until the modal opens and bubbles
  // the migrated shape. Defensive fallback prevents spurious isStale=true.
  const audioIsSync =
    audio?.is_sync ??
    (audio as { script_synced?: boolean } | undefined)?.script_synced ??
    true;
  const isStale = audio != null && audio.combined_audio_url != null && !audioIsSync;

  log.debug("render", "toolbar state", {
    itemId: item.id,
    langCode,
    hasAudio: !!audioUrl,
    isStale,
  });

  // --- Geometry change handler ---
  // CRITICAL: geometry lives inside the language content, NOT on the item root
  const handleGeometryChange = useCallback(
    (field: "x" | "y" | "w" | "h", value: string) => {
      if (!geometry || !content) {
        log.warn("handleGeometryChange", "no geometry for current language", {
          langCode,
        });
        return;
      }
      const numValue = parseFloat(value);
      if (isNaN(numValue)) return;

      let clamped = clampGeometry(field, numValue);
      if (field === "x") clamped = Math.min(clamped, 200 - geometry.w);
      if (field === "y") clamped = Math.min(clamped, 200 - geometry.h);
      if (field === "w") clamped = Math.min(clamped, 200 - geometry.x);
      if (field === "h") clamped = Math.min(clamped, 200 - geometry.y);

      log.debug("handleGeometryChange", "geometry change", {
        field,
        value: clamped,
      });

      onUpdate({
        [langCode]: {
          ...content,
          geometry: { ...geometry, [field]: clamped },
        },
      });
    },
    [geometry, content, langCode, onUpdate]
  );

  // --- Rotation handlers (per-language) ---
  const handleRotationChange = useCallback(
    (value: string) => {
      if (!geometry || !content) {
        log.warn("handleRotationChange", "no geometry for current language", {
          langCode,
        });
        return;
      }
      const numValue = parseFloat(value);
      if (isNaN(numValue)) return;
      const clamped = (((numValue % 360) + 540) % 360) - 180;
      log.debug("handleRotationChange", "update", {
        value: numValue,
        clamped,
        langCode,
      });
      onUpdate({
        [langCode]: {
          ...content,
          geometry: { ...geometry, rotation: clamped },
        },
      });
    },
    [geometry, content, langCode, onUpdate]
  );

  const handleRotationReset = useCallback(() => {
    if (!geometry || !content) return;
    log.debug("handleRotationReset", "reset to 0", { langCode });
    onUpdate({
      [langCode]: {
        ...content,
        geometry: { ...geometry, rotation: 0 },
      },
    });
  }, [geometry, content, langCode, onUpdate]);

  // --- Footer action handlers ---
  const handleSplit = useCallback(() => {
    if (onSplitTextbox) {
      log.info("handleSplit", "splitting textbox", { itemId: item.id });
      onSplitTextbox();
    } else {
      toast.info("Split not available");
      log.debug("handleSplit", "split not available — handler missing");
    }
  }, [onSplitTextbox, item.id]);

  const handleGenerateNarration = useCallback(() => {
    setIsGenerateModalOpen(true);
    log.info("handleGenerateNarration", "opening generate narration modal", {
      itemId: item.id,
    });
  }, [item.id]);

  // --- Narration audio change handler (persist on every modal mutation) ---
  const handleNarrationAudioChange = useCallback(
    (narrationAudio: TextboxAudio) => {
      if (!content) return;
      onUpdate({
        [langCode]: { ...content, audio: narrationAudio } as SpreadTextboxContent,
      });
      log.debug("handleNarrationAudioChange", "audio bubble", {
        itemId: item.id,
        chunkCount: narrationAudio.chunks.length,
        hasCombinedAudio: narrationAudio.combined_audio_url != null,
        isSync: narrationAudio.is_sync,
      });
    },
    [content, langCode, onUpdate, item.id]
  );

  // --- Positioning style ---
  const toolbarStyle: React.CSSProperties = position
    ? {
        position: "fixed",
        top: `${position.top}px`,
        left: `${position.left}px`,
      }
    : { position: "fixed", opacity: 0, pointerEvents: "none" };

  // --- SSR guard ---
  if (typeof document === "undefined") return null;

  // --- Render ---
  const toolbarContent = (
    <TooltipProvider delayDuration={300}>
      <div
        ref={toolbarRef}
        data-toolbar="textbox"
        role="toolbar"
        aria-label="Text formatting toolbar"
        className="min-w-[280px] rounded-lg border bg-popover p-3 shadow-2xl flex flex-col gap-3"
        style={toolbarStyle}
      >
        {/* Geometry Section — fallback to zeros when no content for current language */}
        <GeometrySection
          geometry={geometry ?? { x: 0, y: 0, w: 0, h: 0 }}
          onGeometryChange={handleGeometryChange}
          rotation={geometry?.rotation ?? 0}
          onRotationChange={handleRotationChange}
          onRotationReset={handleRotationReset}
        />

        {/* Narration Section */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground uppercase font-semibold">
              Narration
            </Label>
            {isStale && (
              <span
                className="text-[10px] uppercase font-semibold rounded px-1.5 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                title="Script changed — re-generate to refresh narration"
              >
                Out of sync
              </span>
            )}
          </div>
          {audioUrl ? (
            <InlineAudioPlayer
              key={audioUrl}
              src={audioUrl}
              isActive
              onPlayStart={() => {}}
              className="border-0 px-0 py-0"
            />
          ) : (
            <div className="flex h-10 items-center justify-center rounded-md border border-dashed bg-muted/30 px-3 text-xs text-muted-foreground">
              No narration audio
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-1 border-t border-border pt-2">
          <div className="flex items-center gap-1">
            <ToolbarIconButton
              icon={Pencil}
              label="Edit text"
              onClick={onEditText}
              disabled={!onEditText}
            />
            <ToolbarIconButton
              icon={Scissors}
              label="Split textbox"
              onClick={handleSplit}
            />
            <ToolbarIconButton
              icon={AudioLines}
              label={
                hasText ? "Generate narration" : "No text for current language"
              }
              onClick={handleGenerateNarration}
              disabled={!hasText}
            />
          </div>
          <ToolbarIconButton
            icon={Trash2}
            label="Delete textbox"
            onClick={onDelete}
            variant="destructive"
          />
        </div>

        {isGenerateModalOpen && (
          <GenerateNarrationModal
            isOpen={isGenerateModalOpen}
            onClose={() => setIsGenerateModalOpen(false)}
            textboxTitle={item.title}
            textboxText={content?.text ?? ""}
            existingAudio={audio ?? null}
            currentLanguage={langCode}
            spreadId={spreadId}
            textboxId={item.id}
            onAudioChange={handleNarrationAudioChange}
          />
        )}
      </div>
    </TooltipProvider>
  );

  return createPortal(toolbarContent, document.body);
}
