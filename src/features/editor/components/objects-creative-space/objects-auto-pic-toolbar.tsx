// objects-auto-pic-toolbar.tsx - Floating toolbar for auto_pic items in Objects Creative Space
// Differences from video toolbar: no playback, aspect-locked W/H post-upload, W/H disabled pre-upload,
// variant as free-text, upload accept webp+webm+lottie+riv (.gif blocked — validation session 1)
"use client";

import { useRef, useCallback, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Upload, Trash2, Lock, RotateCcw, Film, ImagePlus } from "lucide-react";
import {
  useToolbarPosition,
  type BaseSpread,
  type AutoPicToolbarContext,
} from "@/features/editor/components/canvas-spread-view";
import { useCanvasWidth, useCanvasHeight } from "@/stores/editor-settings-store";
import { createLogger } from "@/utils/logger";
import type { SpreadTag } from "@/types/spread-types";
import {
  clampGeometry,
  GeometryInput,
  ToolbarIconButton,
} from "@/features/editor/components/shared-components";
import { ItemTagsSection } from "@/features/editor/components/objects-creative-space/item-tags-section";
import { StaticImageSection } from "@/features/editor/components/objects-creative-space/auto-pic-static-image-section";
import { resolveEffectiveStaticUrl } from "@/features/editor/components/playable-spread-view/resolve-auto-pic-display-source";
import { deriveMediaKind, useAutoPicUpload } from "./use-auto-pic-upload";

const log = createLogger("Editor", "ObjectsAutoPicToolbar");

// .gif blocked client-side — validation session 1
// .lottie/.riv validated by extension only (MIME unreliable — browser returns application/octet-stream)
const AUTO_PIC_ACCEPT = "image/webp,video/webm,.lottie,.riv";
// Static image (Classic/Print) — still-frame only, no animated formats.
const STATIC_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

// "__none__" used as Select sentinel since SelectItem cannot have empty-string value
const NONE_VALUE = "__none__";

interface ObjectsAutoPicToolbarProps<TSpread extends BaseSpread> {
  context: AutoPicToolbarContext<TSpread>;
}

export function ObjectsAutoPicToolbar<TSpread extends BaseSpread>({
  context,
}: ObjectsAutoPicToolbarProps<TSpread>) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const staticFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const canvasWidth = useCanvasWidth();
  const canvasHeight = useCanvasHeight();
  const { item, onUpdate, onDelete, selectedGeometry, canvasRef } = context;
  const { geometry } = item;

  const position = useToolbarPosition({
    geometry: selectedGeometry,
    canvasRef,
    toolbarRef,
  });

  // hasMedia gates W/H inputs and aspect-lock (validation session 1)
  const hasMedia = !!item.media_url;
  const mediaKind = useMemo(() => deriveMediaKind(item.media_url), [item.media_url]);
  // Effective static URL (Classic/Print). NEVER falls back to media_url (animated file).
  const staticUrl = useMemo(
    () => resolveEffectiveStaticUrl(item.static_image),
    [item.static_image]
  );

  // Upload + inspection logic (animated + static) lives in the hook to keep this
  // file under 500 lines. riveMeta/lottieMeta drive the interactivity dropdowns.
  const {
    isUploading,
    isUploadingStatic,
    riveMeta,
    lottieMeta,
    handleFileChange,
    handleStaticFileChange,
  } = useAutoPicUpload({
    item,
    geometry,
    mediaKind,
    canvasWidth,
    canvasHeight,
    onUpdate,
    canvasRef,
  });

  // Aspect ratio derived from stored geometry — set accurately on upload, so ratio persists
  const aspectRatio = useMemo(
    () => (hasMedia && geometry.h > 0 ? geometry.w / geometry.h : null),
    [hasMedia, geometry.w, geometry.h]
  );

  const handleTagsChange = useCallback(
    (tags: SpreadTag[]) => {
      log.info("handleTagsChange", "commit tags", { itemId: item.id, tagsCount: tags.length });
      onUpdate({ tags });
    },
    [item.id, onUpdate]
  );

  const handleGeometryChange = useCallback(
    (field: "x" | "y" | "w" | "h", value: string) => {
      const numValue = parseFloat(value);
      if (isNaN(numValue)) return;
      // W/H blocked pre-upload (defensive — inputs are visually disabled too)
      if ((field === "w" || field === "h") && !hasMedia) return;

      let clamped = clampGeometry(field, numValue);
      if (field === "x") clamped = Math.min(clamped, 200 - geometry.w);
      if (field === "y") clamped = Math.min(clamped, 200 - geometry.h);
      if (field === "w") clamped = Math.min(clamped, 200 - geometry.x);
      if (field === "h") clamped = Math.min(clamped, 200 - geometry.y);

      if (aspectRatio !== null) {
        if (field === "w") {
          const newH = clampGeometry("h", Math.min(clamped / aspectRatio, 200 - geometry.y));
          log.debug("handleGeometryChange", "aspect-locked W→H", { w: clamped, h: newH });
          onUpdate({ geometry: { ...geometry, w: clamped, h: newH } });
          return;
        }
        if (field === "h") {
          const newW = clampGeometry("w", Math.min(clamped * aspectRatio, 200 - geometry.x));
          log.debug("handleGeometryChange", "aspect-locked H→W", { w: newW, h: clamped });
          onUpdate({ geometry: { ...geometry, w: newW, h: clamped } });
          return;
        }
      }

      log.debug("handleGeometryChange", "update", { field, value: clamped });
      onUpdate({ geometry: { ...geometry, [field]: clamped } });
    },
    [geometry, hasMedia, aspectRatio, onUpdate]
  );

  const handleRotationChange = useCallback(
    (value: string) => {
      const numValue = parseFloat(value);
      if (isNaN(numValue)) return;
      const clamped = (((numValue % 360) + 540) % 360) - 180;
      log.debug("handleRotationChange", "update", { value: numValue, clamped });
      onUpdate({ geometry: { ...geometry, rotation: clamped } });
    },
    [geometry, onUpdate]
  );

  const handleRotationReset = useCallback(() => {
    log.debug("handleRotationReset", "reset to 0");
    onUpdate({ geometry: { ...geometry, rotation: 0 } });
  }, [geometry, onUpdate]);

  const handleUploadClick = useCallback(() => {
    setUploadMenuOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleUploadStaticClick = useCallback(() => {
    setUploadMenuOpen(false);
    staticFileInputRef.current?.click();
  }, []);

  // === Interactivity config handlers ===

  const handleRiveStateMachineChange = useCallback(
    (value: string) => {
      const next = value === NONE_VALUE ? undefined : value;
      log.debug("handleRiveStateMachineChange", "select", { value: next });
      onUpdate({ rive: { ...(item.rive ?? {}), state_machine: next } });
    },
    [item.rive, onUpdate],
  );

  const handleLottieStateMachineChange = useCallback(
    (value: string) => {
      const next = value === NONE_VALUE ? undefined : value;
      log.debug("handleLottieStateMachineChange", "select", { value: next });
      onUpdate({ lottie: { ...(item.lottie ?? {}), state_machine: next } });
    },
    [item.lottie, onUpdate],
  );

  const toolbarStyle: React.CSSProperties = position
    ? { position: "fixed", top: `${position.top}px`, left: `${position.left}px` }
    : { position: "fixed", opacity: 0, pointerEvents: "none" };

  if (typeof document === "undefined") return null;

  const toolbarContent = (
    <TooltipProvider delayDuration={300}>
      <div
        ref={toolbarRef}
        data-toolbar="auto_pic"
        role="toolbar"
        aria-label="Animated pic formatting toolbar"
        className="min-w-[280px] rounded-lg border bg-popover p-3 shadow-2xl flex flex-col gap-3"
        style={toolbarStyle}
      >
        {/* Tags */}
        <ItemTagsSection
          value={item.tags}
          onChange={handleTagsChange}
          ariaLabel="Animated pic tags"
        />

        {/* MediaKind badge (read-only, derived from media_url extension) */}
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground w-14 shrink-0">
            Media
          </Label>
          <span className="text-xs px-2 py-0.5 rounded bg-secondary text-muted-foreground">
            {mediaKind ?? "—"}
          </span>
        </div>

        {/* Static image status (derived from effective static URL) */}
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground w-14 shrink-0">
            Static
          </Label>
          <span className="text-xs text-muted-foreground">
            {staticUrl ? "◉ Static image ready" : "○ No static image (Classic/PDF)"}
          </span>
        </div>

        {/* Row 3b: Interactivity — Rive state machine (present → item is interactive in play mode) */}
        {mediaKind === "riv" && (
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground w-14 shrink-0">
              State
            </Label>
            <Select
              value={item.rive?.state_machine ?? NONE_VALUE}
              onValueChange={handleRiveStateMachineChange}
              disabled={!riveMeta || riveMeta.stateMachines.length === 0}
            >
              <SelectTrigger className="h-7 text-sm flex-1" aria-label="Rive state machine">
                <SelectValue placeholder={riveMeta ? "No state machine" : "Loading..."} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>None (linear)</SelectItem>
                {riveMeta?.stateMachines.map((sm) => (
                  <SelectItem key={sm} value={sm}>{sm}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Row 3c: Interactivity — Lottie state machine */}
        {mediaKind === "lottie" && (
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground w-14 shrink-0">
              State
            </Label>
            <Select
              value={item.lottie?.state_machine ?? NONE_VALUE}
              onValueChange={handleLottieStateMachineChange}
              disabled={!lottieMeta || lottieMeta.stateMachines.length === 0}
            >
              <SelectTrigger className="h-7 text-sm flex-1" aria-label="Lottie state machine">
                <SelectValue placeholder={lottieMeta ? "No state machine" : "Loading..."} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>None (linear)</SelectItem>
                {lottieMeta?.stateMachines.map((sm) => (
                  <SelectItem key={sm} value={sm}>{sm}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Row 4-5: Geometry — W/H disabled pre-upload, aspect-locked post-upload */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground uppercase">
            Geometry
          </Label>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground w-14">
                Position
              </Label>
              <GeometryInput
                label="X"
                value={geometry.x}
                onChange={(v) => handleGeometryChange("x", v)}
                ariaLabel="Position X"
              />
              <GeometryInput
                label="Y"
                value={geometry.y}
                onChange={(v) => handleGeometryChange("y", v)}
                ariaLabel="Position Y"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground w-14">
                Size
              </Label>
              {hasMedia ? (
                <>
                  <GeometryInput
                    label="W"
                    value={geometry.w}
                    onChange={(v) => handleGeometryChange("w", v)}
                    ariaLabel="Size W"
                  />
                  <Lock className="w-3 h-3 text-muted-foreground shrink-0" aria-hidden />
                  <GeometryInput
                    label="H"
                    value={geometry.h}
                    onChange={(v) => handleGeometryChange("h", v)}
                    ariaLabel="Size H"
                  />
                </>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 opacity-50 cursor-not-allowed select-none">
                      <div className="flex items-center border border-border rounded-lg bg-secondary overflow-hidden h-7">
                        <span className="px-2 text-sm text-muted-foreground border-r border-border">
                          W
                        </span>
                        <span className="w-12 px-1 text-sm text-center text-muted-foreground">
                          {Math.round(geometry.w)}
                        </span>
                        <span className="px-1.5 text-sm text-muted-foreground border-l border-border">
                          %
                        </span>
                      </div>
                      <div className="flex items-center border border-border rounded-lg bg-secondary overflow-hidden h-7">
                        <span className="px-2 text-sm text-muted-foreground border-r border-border">
                          H
                        </span>
                        <span className="w-12 px-1 text-sm text-center text-muted-foreground">
                          {Math.round(geometry.h)}
                        </span>
                        <span className="px-1.5 text-sm text-muted-foreground border-l border-border">
                          %
                        </span>
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Upload media to resize
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground w-14">
                Rotation
              </Label>
              <GeometryInput
                label="R"
                value={geometry.rotation ?? 0}
                onChange={handleRotationChange}
                ariaLabel="Rotation degrees"
                unit="°"
              />
              <button
                type="button"
                onClick={handleRotationReset}
                aria-label="Reset rotation to 0"
                title="Reset rotation"
                className="h-7 px-2 inline-flex items-center justify-center rounded-lg border border-border bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Static image (Classic/Print) preview */}
        <StaticImageSection staticUrl={staticUrl} />

        {/* Footer */}
        <div className="flex items-center justify-between gap-1 border-t border-border pt-2">
          <div className="flex items-center gap-1">
            <Popover open={uploadMenuOpen} onOpenChange={setUploadMenuOpen}>
              <PopoverTrigger asChild>
                {/* span so PopoverTrigger's cloned onClick/ref land on a plain
                    element; the inner button has no onClick — the Popover owns
                    open/close (controlled), avoiding a double toggle. */}
                <span>
                  <ToolbarIconButton
                    icon={Upload}
                    label={
                      isUploading || isUploadingStatic ? "Uploading..." : "Upload media"
                    }
                    disabled={isUploading || isUploadingStatic}
                  />
                </span>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-56 p-1">
                <button
                  type="button"
                  onClick={handleUploadClick}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <Film className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Animated media</span>
                </button>
                <button
                  type="button"
                  onClick={handleUploadStaticClick}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <ImagePlus className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Static image (Classic/Print)</span>
                </button>
              </PopoverContent>
            </Popover>
          </div>
          <ToolbarIconButton
            icon={Trash2}
            label="Delete animated pic"
            onClick={onDelete}
            variant="destructive"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={AUTO_PIC_ACCEPT}
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={staticFileInputRef}
            type="file"
            accept={STATIC_IMAGE_ACCEPT}
            className="hidden"
            onChange={handleStaticFileChange}
          />
        </div>
      </div>
    </TooltipProvider>
  );

  return createPortal(toolbarContent, document.body);
}
