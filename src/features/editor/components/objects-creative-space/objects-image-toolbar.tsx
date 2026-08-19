// objects-image-toolbar.tsx - Floating toolbar for image items on canvas in Objects Creative Space
"use client";

import { useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { Sparkles, Pencil, Layers, Copy, Trash2, Disc } from "lucide-react";
import { toast } from "sonner";
import {
  useToolbarPosition,
  type BaseSpread,
  type ImageToolbarContext,
} from "@/features/editor/components/canvas-spread-view";
import { useCanvasAspectRatio } from "@/stores/editor-settings-store";
import { createLogger } from "@/utils/logger";
import type { SpreadTag } from "@/types/spread-types";
import {
  clampGeometry,
  GeometrySection,
  ToolbarIconButton,
} from "@/features/editor/components/shared-components";
import { ItemTagsSection } from "@/features/editor/components/objects-creative-space/item-tags-section";
// Util-only import (NOT the extract barrel) — keeps the modal component out of the toolbar chunk.
import { resolveSourceImageUrl } from "@/features/editor/components/shared-components/extract-image-modal/extract-image-modal-utils";
import {
  ItemSlotSection,
  ItemSlotToolbarButton,
} from "@/features/editor/components/objects-creative-space/item-slot-section";
// Imported from the logic module, NOT the barrel: the barrel also re-exports the modal
// component, which would pin it into the toolbar chunk (toolbar mounts per selected image).
import { describeItemSlot } from "@/features/editor/components/objects-creative-space/item-slot-modal/item-slot-logic";
import { useCurrentBook } from "@/stores/book-store";
import { useCharacters } from "@/stores/snapshot-store/selectors";
import {
  ASPECT_RATIOS,
  type AspectRatio,
} from "@/constants/aspect-ratio-constants";
import {
  calculateGeometryForRatio,
  detectRatioFromGeometry,
} from "@/utils/aspect-ratio-utils";

const log = createLogger("Editor", "ObjectsImageToolbar");

// === Component ===

interface ObjectsImageToolbarProps<TSpread extends BaseSpread> {
  context: ImageToolbarContext<TSpread>;
}

export function ObjectsImageToolbar<TSpread extends BaseSpread>({
  context,
}: ObjectsImageToolbarProps<TSpread>) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const canvasAspectRatio = useCanvasAspectRatio();
  const {
    item,
    onUpdate,
    onDelete,
    onGenerateImage,
    onEditImage,
    onExtractImage,
    onExtractLottie,
    onClone,
    onConfigureSlot,
    selectedGeometry,
    canvasRef,
  } = context;
  const { geometry } = item;
  const book = useCurrentBook();
  const characters = useCharacters();

  const position = useToolbarPosition({
    geometry: selectedGeometry,
    canvasRef,
    toolbarRef,
  });

  // Detect current aspect ratio from geometry
  const detectedRatio = useMemo(() => {
    if (item.aspect_ratio) return item.aspect_ratio;
    return detectRatioFromGeometry(geometry.w, geometry.h, canvasAspectRatio);
  }, [item.aspect_ratio, geometry.w, geometry.h, canvasAspectRatio]);

  // describeItemSlot() re-normalizes the book config on every call — memoize.
  const slotDescriptor = useMemo(
    () => describeItemSlot(item, book, characters),
    [item, book, characters]
  );

  // === Handlers ===

  const handleTagsChange = useCallback(
    (tags: SpreadTag[]) => {
      log.info("handleTagsChange", "commit tags", { itemId: item.id, tagsCount: tags.length });
      onUpdate({ tags });
    },
    [item.id, onUpdate]
  );

  const handleRatioSelect = useCallback(
    (ratioValue: AspectRatio) => {
      log.debug("ObjectsImageToolbar", "ratio change", { ratio: ratioValue });
      const newGeometry = calculateGeometryForRatio(geometry, ratioValue, canvasAspectRatio, clampGeometry);
      onUpdate({ geometry: newGeometry, aspect_ratio: ratioValue });
    },
    [geometry, onUpdate, canvasAspectRatio]
  );

  const handleGeometryChange = useCallback(
    (field: "x" | "y" | "w" | "h", value: string) => {
      const numValue = parseFloat(value);
      if (isNaN(numValue)) return;
      let clamped = clampGeometry(field, numValue);
      // Allow items into bleed+staging zone (OVERFLOW_MAX=100 beyond each trim edge)
      if (field === "x") clamped = Math.min(clamped, 200 - geometry.w);
      if (field === "y") clamped = Math.min(clamped, 200 - geometry.h);
      if (field === "w") clamped = Math.min(clamped, 200 - geometry.x);
      if (field === "h") clamped = Math.min(clamped, 200 - geometry.y);
      log.debug("ObjectsImageToolbar", "geometry change", {
        field,
        value: clamped,
      });
      onUpdate({ geometry: { ...geometry, [field]: clamped } });
    },
    [geometry, onUpdate]
  );

  const handleRotationChange = useCallback(
    (value: string) => {
      const numValue = parseFloat(value);
      if (isNaN(numValue)) return;
      const clamped = (((numValue % 360) + 540) % 360) - 180;
      log.debug("ObjectsImageToolbar", "rotation change", {
        value: numValue,
        clamped,
      });
      onUpdate({ geometry: { ...geometry, rotation: clamped } });
    },
    [geometry, onUpdate]
  );

  const handleRotationReset = useCallback(() => {
    log.debug("ObjectsImageToolbar", "rotation reset");
    onUpdate({ geometry: { ...geometry, rotation: 0 } });
  }, [geometry, onUpdate]);

  const handleGenerate = useCallback(() => {
    log.info("handleGenerate", "open generate modal", { itemId: item.id });
    onGenerateImage();
  }, [onGenerateImage, item.id]);

  const handleEdit = useCallback(() => {
    if (onEditImage) {
      log.info("handleEdit", "open edit modal", { itemId: item.id });
      onEditImage();
    } else {
      toast.info("Edit feature not available");
    }
  }, [onEditImage, item.id]);

  const handleExtract = useCallback(() => {
    if (onExtractImage) {
      onExtractImage();
    } else {
      toast.info("Extract feature not available");
    }
  }, [onExtractImage]);

  // Lottie extract needs a resolvable source image (media_url / selected illustration). Absent →
  // button renders disabled with a why-tooltip (never-hide convention).
  const lottieSource = resolveSourceImageUrl(item);
  const handleExtractLottie = useCallback(() => {
    if (onExtractLottie) {
      log.info("handleExtractLottie", "open lottie modal", { itemId: item.id });
      onExtractLottie();
    } else {
      toast.info("Coming soon");
    }
  }, [onExtractLottie, item.id]);

  const handleDuplicate = useCallback(() => {
    if (onClone) {
      log.info("handleDuplicate", "duplicate retouch image", { itemId: item.id });
      onClone();
    } else {
      toast.info("Duplicate feature not available");
    }
  }, [onClone, item.id]);

  const handleConfigureSlot = useCallback(() => {
    if (!onConfigureSlot) {
      toast.info("Coming soon");
      return;
    }
    log.debug("handleConfigureSlot", "open slot modal", {
      itemId: item.id,
      slotType: slotDescriptor?.type ?? "none",
    });
    onConfigureSlot();
  }, [onConfigureSlot, item.id, slotDescriptor?.type]);

  // === Positioning ===

  const toolbarStyle: React.CSSProperties = position
    ? {
        position: "fixed",
        top: `${position.top}px`,
        left: `${position.left}px`,
      }
    : { position: "fixed", opacity: 0, pointerEvents: "none" };

  // === Render ===

  if (typeof document === "undefined") return null;

  const toolbarContent = (
    <TooltipProvider delayDuration={300}>
      <div
        ref={toolbarRef}
        data-toolbar="image"
        role="toolbar"
        aria-label="Image formatting toolbar"
        className="min-w-[280px] rounded-lg border bg-popover p-3 shadow-2xl flex flex-col gap-3"
        style={toolbarStyle}
      >
        {/* === BODY === */}

        {/* Tags section */}
        <ItemTagsSection
          value={item.tags}
          onChange={handleTagsChange}
          ariaLabel="Image tags"
        />

        {/* Row 3: Aspect Ratio */}
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground w-14 shrink-0">
            Ratio
          </Label>
          <Select
            value={detectedRatio ?? ""}
            onValueChange={(v) => handleRatioSelect(v as AspectRatio)}
          >
            <SelectTrigger
              className="h-7 text-sm flex-1"
              aria-label="Aspect ratio"
            >
              <SelectValue placeholder="Select ratio..." />
            </SelectTrigger>
            <SelectContent>
              {ASPECT_RATIOS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Row 4-5: Geometry */}
        <GeometrySection
          geometry={geometry}
          onGeometryChange={handleGeometryChange}
          rotation={geometry.rotation ?? 0}
          onRotationChange={handleRotationChange}
          onRotationReset={handleRotationReset}
        />

        {/* Row 6: Slot (read-only summary, click = footer Slot button) */}
        <ItemSlotSection
          descriptor={slotDescriptor}
          onClick={handleConfigureSlot}
        />

        {/* === FOOTER === Generate · Edit · Extract · Duplicate · Slot | Delete (matrix unify) */}
        <div className="flex items-center justify-between gap-1 border-t border-border pt-2">
          <div className="flex items-center gap-1">
            <ToolbarIconButton
              icon={Sparkles}
              label="Generate"
              onClick={handleGenerate}
            />
            <ToolbarIconButton
              icon={Pencil}
              label="Edit image"
              onClick={handleEdit}
            />
            <ToolbarIconButton
              icon={Layers}
              label="Extract"
              onClick={handleExtract}
            />
            <ToolbarIconButton
              icon={Disc}
              label={lottieSource ? "Extract Lottie" : "No image to extract"}
              onClick={handleExtractLottie}
              disabled={!lottieSource}
            />
            <ToolbarIconButton
              icon={Copy}
              label="Duplicate"
              onClick={handleDuplicate}
            />
            <ItemSlotToolbarButton
              descriptor={slotDescriptor}
              hasHandler={!!onConfigureSlot}
              onClick={handleConfigureSlot}
            />
          </div>
          <ToolbarIconButton
            icon={Trash2}
            label="Delete image"
            onClick={onDelete}
            variant="destructive"
          />
        </div>
      </div>
    </TooltipProvider>
  );

  return createPortal(toolbarContent, document.body);
}

