"use client";

// generate-image-modal.tsx — Root orchestrator for the full-screen "Creating Image"
// workspace (design generate-image-modal.md). Owns ALL state + handlers + ILS registration;
// the 4 regions (header / generated-sidebar / canvas / parameters) are presentational.
//
// Two modes share one image.illustrations[] (filtered by provenance `type`):
//   • Generate (AI)  → entries type='created' (startGenerateTask, forwards modelParams + edgeTreatment;
//                       snapshotId is injected at the slice from meta.id).
//   • Upload (no AI) → entries type='uploaded' (uploadImageToStorageWithNormalize → addUploadedIllustration),
//                       refit geometry bound-longest so the box never grows.
// The single mode-aware [+] (GeneratedSidebar header) is the only action trigger.

import { useState, useRef, useCallback, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useInteractionLayer } from "@/features/editor/contexts";
import {
  useSnapshotActions,
  useStages,
  useImageTasksForChild,
} from "@/stores/snapshot-store";
import type { ImageTaskEntityType } from "@/stores/snapshot-store/types";
import { useCurrentBook } from "@/stores/book-store";
import { useReferenceImagePicker } from "@/features/editor/hooks/use-reference-image-picker";
import {
  uploadImageToStorageWithNormalize,
  ImageTooTallError,
} from "@/apis/storage-api";
import { useCanvasAspectRatio } from "@/stores/editor-settings-store";
import {
  calculateGeometryForRatio,
  detectRatioFromGeometry,
  findClosestRatio,
} from "@/utils/aspect-ratio-utils";
import { clampGeometry } from "../shared-toolbar-components";
import { createLogger } from "@/utils/logger";
import { coerceIllustrationType } from "@/types/prop-types";
import type { SpreadImage } from "@/types/spread-types";
import type { SaveResourceDirective } from "@/types/save-resource";
import {
  SWAP_MODAL_TOKENS,
  Z_INDEX,
} from "../../remix-creative-space/swap-crop-sheet-modal/swap-modal-constants";
import {
  DEFAULT_MODEL,
  DEFAULT_EDGE_TREATMENT,
  ZOOM,
  UPLOAD,
  type GenerateModalMode,
} from "./generate-image-modal-constants";
import {
  flattenStageVariants,
  resolveStageVariantImageUrl,
} from "./generate-image-modal-helpers";
import { GenerateImageModalHeader } from "./generate-image-modal-header";
import { GeneratedSidebar } from "./generated-sidebar";
import { GenerateCanvas } from "./generate-canvas";
import { ParametersSidebar } from "./parameters-sidebar";

const log = createLogger("Editor", "GenerateImageModal");

interface GenerateImageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spreadId: string;
  image: SpreadImage;
  onUpdateImage: (updates: Partial<SpreadImage>) => void;
  /** Per-space mode availability (matrix gate). `undefined` → both modes (legacy). Modes not in
   *  the list render disabled ("Coming soon") in the header; the modal lands on the leftmost
   *  ENABLED mode (e.g. Object = `['upload']` → starts on Upload, Generate shown but inert), so
   *  the generate machinery is never reachable from the UI. */
  enabledModes?: GenerateModalMode[];
  /** Target section for the Upload-mode prepend. Defaults to 'illustration_image' (raw_images,
   *  spreads space); Objects passes 'retouch_image' so uploads land in the retouch image. */
  uploadEntityType?: ImageTaskEntityType;
  /** Opt-in double-write directive (parent/opener resolves the path). Threaded into the UPLOAD-mode
   *  normalize call only. Generate mode does NOT use it — save-on-generate is slice-injected
   *  (Phase 03). Undefined → the upload payload omits the field. */
  saveResource?: SaveResourceDirective;
}

const ACCEPTED_UPLOAD_TYPES = UPLOAD.accept.split(",");

export function GenerateImageModal({
  open,
  onOpenChange,
  spreadId,
  image,
  onUpdateImage,
  enabledModes,
  uploadEntityType = "illustration_image",
  saveResource,
}: GenerateImageModalProps) {
  // Landing mode = leftmost available mode (TABS order: generate, upload). Plain const (cheap)
  // so it can seed useState below + feed resetState. `undefined`/empty → 'generate' (legacy).
  const defaultMode: GenerateModalMode =
    !enabledModes || enabledModes.length === 0
      ? "generate"
      : enabledModes.includes("generate")
        ? "generate"
        : enabledModes[0];

  // ── Local state ──────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<GenerateModalMode>(defaultMode);
  const [prompt, setPrompt] = useState(image.visual_description ?? "");
  const [selectedStageVariant, setSelectedStageVariant] = useState<string | null>(
    image.stage_variant ?? null,
  );
  const [edgeTreatment, setEdgeTreatment] = useState(DEFAULT_EDGE_TREATMENT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [zoomLevel, setZoomLevel] = useState<number>(ZOOM.default);
  const [isUploading, setIsUploading] = useState(false);

  const dialogContentRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // ── Store + hooks ──────────────────────────────────────────────────────────────
  const { startGenerateTask, addUploadedIllustration } = useSnapshotActions();
  const stages = useStages();
  const book = useCurrentBook();
  const artStyleId = book?.artstyle_id ?? null;
  const { isProcessing } = useImageTasksForChild(spreadId, image.id);
  const canvasAspectRatio = useCanvasAspectRatio();
  const generateRefs = useReferenceImagePicker();

  // ── Derived (useMemo; no set-state-in-effect — React 19 lint) ───────────────────
  const stageVariants = useMemo(() => flattenStageVariants(stages), [stages]);

  // Per-mode history: filter the SAME illustrations[] by provenance, newest-first.
  // Keyed on the raw illustrations ref + mode to avoid the fresh-array re-render loop.
  const modeList = useMemo(() => {
    const wanted = mode === "generate" ? "created" : "uploaded";
    const list = (image.illustrations ?? []).filter(
      (ill) => coerceIllustrationType(ill) === wanted,
    );
    return [...list].sort(
      (a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime(),
    );
  }, [image.illustrations, mode]);

  // Canvas preview: the selected item in THIS tab, else the newest (browse fallback so
  // the canvas isn't blank while you scan a tab you haven't selected from).
  const canvasSelected = useMemo(
    () => modeList.find((i) => i.is_selected) ?? modeList[0] ?? null,
    [modeList],
  );

  // Sidebar checkmark: the GLOBAL selection (1 per layer across BOTH lists). Must NOT
  // reuse canvasSelected's newest-fallback, or the tab that doesn't own the selection
  // would show a phantom check. Only the owning tab highlights its image.
  const globalSelectedUrl = useMemo(
    () => (image.illustrations ?? []).find((i) => i.is_selected)?.media_url ?? null,
    [image.illustrations],
  );

  const addDisabled =
    mode === "generate"
      ? isProcessing || !prompt.trim() || !artStyleId
      : isUploading;

  // ── State reset / close ──────────────────────────────────────────────────────
  const resetState = useCallback(() => {
    setMode(defaultMode);
    setPrompt(image.visual_description ?? "");
    setSelectedStageVariant(image.stage_variant ?? null);
    setEdgeTreatment(DEFAULT_EDGE_TREATMENT);
    setModel(DEFAULT_MODEL);
    setZoomLevel(ZOOM.default);
    setIsUploading(false);
    generateRefs.clearImages();
  }, [defaultMode, image.visual_description, image.stage_variant, generateRefs]);

  const handleClose = useCallback(() => {
    if (isProcessing || isUploading) {
      log.debug("handleClose", "blocked — busy", { isProcessing, isUploading });
      return;
    }
    resetState();
    onOpenChange(false);
  }, [isProcessing, isUploading, resetState, onOpenChange]);

  // Route any Radix-driven close through the guard+reset path.
  const handleDialogOpenChange = useCallback(
    (next: boolean) => {
      if (!next) handleClose();
    },
    [handleClose],
  );

  // ── Interaction Layer Stack (top modal slot) ────────────────────────────────────
  useInteractionLayer(
    "modal",
    open
      ? {
          id: "generate-image-modal",
          ref: dialogContentRef,
          hotkeys: ["Escape"],
          captureClickOutside: true,
          portalSelectors: [
            "[data-radix-popper-content-wrapper]",
            "[data-radix-select-content]",
            '[role="listbox"]',
          ],
          // Picking a Select option unmounts the popper synchronously; dropdownSelectors
          // let the Provider keep the modal open instead of mis-closing it (see memory).
          dropdownSelectors: [
            "[data-radix-select-content]",
            "[data-radix-popper-content-wrapper]",
          ],
          onHotkey: (key) => {
            if (key === "Escape") handleClose();
          },
          onClickOutside: () => handleClose(),
          // Spread switch / target-entity delete → force close + reset (bypasses busy guard).
          onForcePop: () => {
            log.debug("onForcePop", "force close + reset", { spreadId, imageId: image.id });
            resetState();
            onOpenChange(false);
          },
        }
      : null,
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleGenerate = useCallback(() => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isProcessing) return;

    if (!artStyleId) {
      log.warn("handleGenerate", "blocked — missing artStyleId", { spreadId, imageId: image.id });
      toast.error("Select an art style first");
      return;
    }

    onUpdateImage({ visual_description: trimmedPrompt });

    log.info("handleGenerate", "start", {
      spreadId,
      imageId: image.id,
      promptLength: trimmedPrompt.length,
      refCount: generateRefs.images.length,
      stageVariant: selectedStageVariant,
      model,
      edgeTreatment,
    });

    const referenceImages =
      generateRefs.images.length > 0
        ? generateRefs.images.map(({ base64Data, mimeType }) => ({ base64Data, mimeType }))
        : undefined;

    // image.aspect_ratio is optional and often unset on freshly-created raw images;
    // when absent, derive the visual ratio from the image's geometry box so the
    // backend never silently falls back to 1:1 (geometry w/h is canvas-normalized →
    // ×canvasAspectRatio gives the true ratio). Prefer stored → exact preset → nearest.
    const aspectRatio =
      image.aspect_ratio ??
      detectRatioFromGeometry(image.geometry.w, image.geometry.h, canvasAspectRatio) ??
      findClosestRatio(image.geometry.w * canvasAspectRatio, image.geometry.h);

    startGenerateTask({
      entityType: "illustration_image",
      entityKey: spreadId,
      entityName: image.title || "Spread",
      childKey: image.id,
      childName: image.title || "Image",
      visualDescription: trimmedPrompt,
      artStyleId,
      stageVariantImageUrl: resolveStageVariantImageUrl(selectedStageVariant, stages),
      referenceImages,
      aspectRatio,
      modelParams: { model },
      edgeTreatment,
      // snapshotId injected at the slice (= meta.id)
    });

    generateRefs.clearImages();
  }, [
    prompt,
    isProcessing,
    artStyleId,
    spreadId,
    image.id,
    image.title,
    image.aspect_ratio,
    image.geometry,
    canvasAspectRatio,
    generateRefs,
    selectedStageVariant,
    stages,
    model,
    edgeTreatment,
    startGenerateTask,
    onUpdateImage,
  ]);

  const openUploadPicker = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadFiles = useCallback(
    async (files: FileList) => {
      const file = files[0];
      if (!file) return;

      if (!ACCEPTED_UPLOAD_TYPES.includes(file.type)) {
        log.warn("handleUploadFiles", "invalid type", { name: file.name, type: file.type });
        toast.warning("Only PNG, JPEG, or WebP images are allowed");
        return;
      }
      if (file.size > UPLOAD.maxSizeMB * 1024 * 1024) {
        log.warn("handleUploadFiles", "file too large", { name: file.name, size: file.size });
        toast.warning(`File exceeds ${UPLOAD.maxSizeMB}MB limit`);
        return;
      }

      log.info("handleUploadFiles", "start", { spreadId, imageId: image.id, size: file.size });
      setIsUploading(true);
      try {
        // outputPrefix is a CATEGORY folder only — the normalize-ratio endpoint
        // appends a server-generated `{timestamp}-{uuid}.png` filename, so no per-
        // spread UUID segment is needed (and the regex rejects digit-leading
        // segments). Matches the sibling spreads-image-toolbar uploader.
        // Opt-in double-write: thread the parent-resolved directive into the normalize call. The
        // soft-fail warn (data.saved === false) is emitted once inside normalizeImage → storage-api
        // (DRY — shared warnIfSaveResourceFailed), so no duplicate warn here. Undefined → omitted.
        const { publicUrl, ratio } = await uploadImageToStorageWithNormalize(
          file,
          "illustrations",
          saveResource,
        );

        addUploadedIllustration({
          entityKey: spreadId,
          childKey: image.id,
          mediaUrl: publicUrl,
          entityType: uploadEntityType,
        });

        // Fixed ratio from the normalize step → canvas-aware refit (canonical helper, same path
        // as the spreads/objects image toolbars). aspect_ratio + geometry are written together.
        if (ratio) {
          const geometry = calculateGeometryForRatio(
            image.geometry,
            ratio,
            canvasAspectRatio,
            clampGeometry,
          );
          onUpdateImage({ aspect_ratio: ratio, geometry });
        }
        log.info("handleUploadFiles", "done", { spreadId, imageId: image.id, ratio });
      } catch (err) {
        if (err instanceof ImageTooTallError) {
          log.warn("handleUploadFiles", "image too tall", { srcRatio: err.srcRatio });
          toast.warning("Image is too tall (below 9:16). Please crop and try again.");
          return;
        }
        const msg = err instanceof Error ? err.message : "Upload failed";
        log.error("handleUploadFiles", "failed", { spreadId, imageId: image.id, error: msg });
        toast.error("Failed to upload image");
      } finally {
        setIsUploading(false);
      }
    },
    [spreadId, image.id, image.geometry, canvasAspectRatio, addUploadedIllustration, onUpdateImage, uploadEntityType, saveResource],
  );

  const handleUploadInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      // Hand off BEFORE clearing value: input.files is a LIVE FileList that
      // `value = ""` empties in place, so resetting first would null the
      // selection before handleUploadFiles reads it (silent no-op upload).
      // handleUploadFiles' prologue captures files[0] synchronously, so the
      // reset below can't race the in-flight upload. Re-selecting the same
      // file still re-fires onChange because value is cleared right after.
      if (files && files.length > 0) void handleUploadFiles(files);
      e.target.value = "";
    },
    [handleUploadFiles],
  );

  // The single mode-aware action trigger.
  const handleSidebarAdd = useCallback(() => {
    if (mode === "generate") handleGenerate();
    else openUploadPicker();
  }, [mode, handleGenerate, openUploadPicker]);

  const handleGallerySelect = useCallback(
    (mediaUrl: string) => {
      if (!image.illustrations) return;
      // is_selected is GLOBAL (1 selected per layer) — logic preserved from the old modal.
      const updated = image.illustrations.map((ill) => ({
        ...ill,
        is_selected: ill.media_url === mediaUrl,
      }));
      onUpdateImage({ illustrations: updated });
    },
    [image.illustrations, onUpdateImage],
  );

  const handleStageVariantSelect = useCallback(
    (ref: string | null) => {
      setSelectedStageVariant(ref);
      onUpdateImage({ stage_variant: ref ?? undefined });
    },
    [onUpdateImage],
  );

  const handleZoomChange = useCallback((z: number) => {
    setZoomLevel(Math.min(Math.max(z, ZOOM.min), ZOOM.max));
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        ref={dialogContentRef}
        aria-labelledby="generate-image-modal-title"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        style={{ ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.swapModal } as React.CSSProperties}
        className="inset-0 left-0 top-0 flex h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[var(--swap-modal-bg)] p-0 text-[var(--swap-modal-text-primary)] [&>button]:hidden"
      >
        <DialogTitle className="sr-only">Creating Image</DialogTitle>
        <DialogDescription className="sr-only">
          Generate hoặc upload ảnh cho spread image.
        </DialogDescription>

        <GenerateImageModalHeader
          mode={mode}
          onModeChange={setMode}
          onClose={handleClose}
          enabledModes={enabledModes}
        />

        <div className="flex min-h-0 flex-1">
          <GeneratedSidebar
            mode={mode}
            items={modeList}
            selectedUrl={globalSelectedUrl}
            addDisabled={addDisabled}
            busy={isProcessing || isUploading}
            onAdd={handleSidebarAdd}
            onSelect={handleGallerySelect}
          />

          <GenerateCanvas
            selected={canvasSelected}
            zoomLevel={zoomLevel}
            onZoomChange={handleZoomChange}
            mode={mode}
            isProcessing={isProcessing}
            isUploading={isUploading}
            onDropFiles={handleUploadFiles}
          />

          <ParametersSidebar
            mode={mode}
            model={model}
            onModelChange={setModel}
            prompt={prompt}
            onPromptChange={setPrompt}
            onPromptSubmit={handleGenerate}
            generateRefs={generateRefs}
            stageVariants={stageVariants}
            selectedStageVariant={selectedStageVariant}
            onStageVariantSelect={handleStageVariantSelect}
            edgeTreatment={edgeTreatment}
            onEdgeTreatmentSelect={setEdgeTreatment}
            isProcessing={isProcessing}
            isUploading={isUploading}
            onDropFiles={handleUploadFiles}
            openUploadPicker={openUploadPicker}
          />
        </div>

        {/* Hidden upload picker — fed by the [+] trigger in Upload mode. */}
        <input
          ref={uploadInputRef}
          type="file"
          accept={UPLOAD.accept}
          onChange={handleUploadInputChange}
          className="hidden"
        />

        {/* Hidden reference-image picker for Generate mode (owns generateRefs). */}
        <input
          ref={generateRefs.inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={generateRefs.handleFilesSelected}
          className="hidden"
        />
      </DialogContent>
    </Dialog>
  );
}
