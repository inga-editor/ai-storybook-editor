// variant-item.tsx - Accordion item for a single prop variant with image gallery + prompt section

import { useRef, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Upload,
  Download,
  Paperclip,
  X,
  Check,
  Sparkles,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { EditImagePopover } from "@/features/editor/components/shared-components";
import { ImageZoomPreview } from "@/components/ui/image-zoom-preview";
import { Label } from "@/components/ui/label";
import { useSnapshotActions, usePropByKey, useImageTasksForChild } from "@/stores/snapshot-store";
import { useAssetCategories } from "@/stores/asset-category-store";
import { useReferenceImagePicker } from "@/features/editor/hooks/use-reference-image-picker";
import { ensureEntitySavedBeforeGenerate } from "@/features/editor/hooks/ensure-entity-saved-before-generate";
import { useCurrentBook } from '@/stores/book-store';
import type { PropVariant } from "@/types/prop-types";
import { uploadImageToStorage } from "@/apis/storage-api";
import { createLogger } from "@/utils/logger";
import { downloadImage } from "@/utils/download-image";
import { cn } from "@/utils/utils";
import { toast } from "sonner";

const log = createLogger("Editor", "VariantItem");

interface VariantItemProps {
  propKey: string;
  variantData: PropVariant;
  isExpanded: boolean;
  onToggle: () => void;
  /** Collab held-session gate (ADR-044): when false every variant mutation is blocked + disabled. */
  editable: boolean;
}

export function VariantItem({
  propKey,
  variantData,
  isExpanded,
  onToggle,
  editable,
}: VariantItemProps) {
  const { deletePropVariant, updatePropVariant, startGenerateTask, startEditTask } = useSnapshotActions();
  const prop = usePropByKey(propKey);
  const categories = useAssetCategories();
  const book = useCurrentBook();
  const artStyleId = book?.artstyle_id ?? null;
  const { isProcessing } = useImageTasksForChild(propKey, variantData.key);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(variantData.name);

  // Selected illustration is DERIVED from the store's is_selected flag (not local state) so an
  // undo/redo restore of the variant node — or a generate/upload/edit completion — is reflected in
  // the preview. Thumbnail click writes is_selected back to the store (handleSelectIllustration),
  // so selection is itself an undoable edit.
  const selectedIllustrationIndex = Math.max(0, variantData.illustrations.findIndex((ill) => ill.is_selected));
  // Visual description is controlled from the store (write-on-change) for the same reason.
  const visualDescription = variantData.visual_description ?? "";
  const [isEditPopoverOpen, setIsEditPopoverOpen] = useState(false);
  const [editPromptText, setEditPromptText] = useState("");

  // Reference image pickers for generate and edit flows
  const generateRefs = useReferenceImagePicker();
  const editRefs = useReferenceImagePicker();

  // type 0 = base variant, cannot be deleted or have images uploaded
  const isBase = variantData.type === 0;

  const sortedIllustrations = [...variantData.illustrations].sort(
    (a, b) =>
      new Date(b.created_time).getTime() - new Date(a.created_time).getTime()
  );

  const selectedIllustration =
    variantData.illustrations[selectedIllustrationIndex];

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!editable) return; // collab gate
    updatePropVariant(propKey, variantData.key, { visual_description: e.target.value });
  };

  const handleSelectIllustration = (index: number) => {
    if (!editable) return; // collab gate — selection persists via is_selected (undoable)
    const target = variantData.illustrations[index];
    if (!target || target.is_selected) return;
    log.debug("handleSelectIllustration", "select", { propKey, variantKey: variantData.key, index });
    updatePropVariant(propKey, variantData.key, {
      illustrations: variantData.illustrations.map((ill, i) => ({ ...ill, is_selected: i === index })),
    });
  };

  const handleDownload = async () => {
    if (!selectedIllustration) return;
    try {
      await downloadImage(selectedIllustration.media_url, variantData.name);
    } catch (err) {
      log.error("handleDownload", "failed", { error: String(err) });
      alert("Failed to download image");
    }
  };

  const handleEditImage = () => {
    if (!editable) return; // collab gate
    const trimmed = editPromptText.trim();
    if (!trimmed || !selectedIllustration || isProcessing) return;

    log.info("handleEditImage", "start", {
      propKey,
      variantKey: variantData.key,
      prompt: trimmed,
      refCount: editRefs.images.length,
    });
    setIsEditPopoverOpen(false);

    const referenceImages =
      editRefs.images.length > 0
        ? editRefs.images.map(({ base64Data, mimeType }) => ({
            base64Data,
            mimeType,
          }))
        : undefined;

    startEditTask({
      entityType: 'prop',
      entityKey: propKey,
      entityName: prop?.name ?? propKey,
      childKey: variantData.key,
      childName: variantData.name,
      prompt: trimmed,
      imageUrl: selectedIllustration.media_url,
      referenceImages,
    });

    setEditPromptText("");
    editRefs.clearImages();
  };

  // Resolve base state image URL for non-base states
  const basePropImageUrl = !isBase
    ? prop?.variants.find((s) => s.type === 0)?.illustrations.find((ill) => ill.is_selected)?.media_url
    : undefined;

  // Non-base states cannot generate without base illustration; all states need a book art style.
  const isGenerateDisabled = !editable || isProcessing || !visualDescription.trim() || !artStyleId || (!isBase && !basePropImageUrl);

  const handleGenerate = async () => {
    if (!editable) return; // collab gate
    const trimmedPrompt = visualDescription.trim();
    if (!trimmedPrompt || isProcessing) return;

    // Null-guard: require book.artstyle_id (UUID) — contract rejects empty art style with 400.
    if (!artStyleId) {
      log.warn("handleGenerate", "blocked — missing artStyleId", { propKey, variantKey: variantData.key });
      toast.error("Select an art style first");
      return;
    }

    log.info("handleGenerate", "start", { propKey, variantKey: variantData.key, isBase });

    updatePropVariant(propKey, variantData.key, {
      visual_description: trimmedPrompt,
    });

    // GATE (spec §4.2): persist the entity BEFORE generate so the BE save_resource directive can
    // anchor the result. Aborts (with a toast) on a peer lock / save failure — never burns an AI call.
    if (!(await ensureEntitySavedBeforeGenerate('prop', propKey))) return;

    const referenceImages =
      generateRefs.images.length > 0
        ? generateRefs.images.map(({ base64Data, mimeType }) => ({
            base64Data,
            mimeType,
          }))
        : undefined;

    if (isBase) {
      const category = prop?.category_id
        ? categories.find((c) => c.id === prop.category_id)
        : undefined;
      startGenerateTask({
        entityType: 'prop',
        isBase: true,
        entityKey: propKey,
        entityName: prop?.name ?? propKey,
        childKey: variantData.key,
        childName: variantData.name,
        propKey,
        propName: prop?.name ?? propKey,
        propType: (prop?.type as 'narrative' | 'anchor') ?? 'narrative',
        categoryName: category?.name,
        categoryType: category?.type,
        baseStateVisualDescription: trimmedPrompt,
        artStyleId,
        referenceImages,
      });
    } else {
      if (!basePropImageUrl) return;
      startGenerateTask({
        entityType: 'prop',
        isBase: false,
        entityKey: propKey,
        entityName: prop?.name ?? propKey,
        childKey: variantData.key,
        childName: variantData.name,
        variantKey: variantData.key,
        variantVisualDescription: trimmedPrompt,
        basePropImageUrl,
        artStyleId,
        additionalReferenceImages: referenceImages,
      });
    }

    generateRefs.clearImages();
  };

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so same file can be re-selected
    e.target.value = "";
    if (!editable) return; // collab gate

    log.info("handleUpload", "start upload", {
      propKey,
      variantKey: variantData.key,
      fileName: file.name,
      size: file.size,
    });
    setIsUploading(true);
    try {
      const result = await uploadImageToStorage(
        file,
        `props/${propKey}/${variantData.key}`
      );
      log.info("handleUpload", "upload complete", {
        publicUrl: result.publicUrl,
      });

      // Deselect all existing illustrations, prepend new one as selected
      const updatedIllustrations = variantData.illustrations.map((ill) => ({
        ...ill,
        is_selected: false,
      }));
      updatedIllustrations.unshift({
        media_url: result.publicUrl,
        created_time: new Date().toISOString(),
        is_selected: true,
      });

      updatePropVariant(propKey, variantData.key, {
        illustrations: updatedIllustrations,
      });
      toast.success("Image uploaded successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      log.error("handleUpload", "upload failed", { error: msg });
      toast.error(msg);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteVariant = () => {
    if (!editable) return; // collab gate
    log.info("handleDeleteVariant", "delete state", {
      propKey,
      variantKey: variantData.key,
    });
    deletePropVariant(propKey, variantData.key);
  };

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      {/* State header row */}
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-2 border-b border-border/50",
          isExpanded && "bg-muted/30"
        )}
      >
        {/* Expand/collapse chevron + name + key */}
        <CollapsibleTrigger asChild>
          <div className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer group">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <div className="min-w-0">
              {isRenaming ? (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Input
                    className="h-7 text-sm flex-1"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (editable && renameValue.trim() && renameValue.trim() !== variantData.name) {
                          log.info('handleRename', 'renamed', { variantKey: variantData.key, newName: renameValue.trim() });
                          updatePropVariant(propKey, variantData.key, { name: renameValue.trim() });
                        }
                        setIsRenaming(false);
                      }
                      if (e.key === 'Escape') setIsRenaming(false);
                    }}
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => {
                      if (editable && renameValue.trim() && renameValue.trim() !== variantData.name) {
                        log.info('handleRename', 'renamed', { variantKey: variantData.key, newName: renameValue.trim() });
                        updatePropVariant(propKey, variantData.key, { name: renameValue.trim() });
                      }
                      setIsRenaming(false);
                    }}
                    aria-label="Accept rename"
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => setIsRenaming(false)}
                    aria-label="Cancel rename"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm truncate">
                      {variantData.name}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0"
                      disabled={!editable}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!editable) return;
                        setRenameValue(variantData.name);
                        setIsRenaming(true);
                        log.debug('handleStartRename', 'start', { variantKey: variantData.key });
                      }}
                      title={editable ? "Rename variant" : "Click this prop to edit"}
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    /{variantData.key}
                  </span>
                </>
              )}
            </div>
          </div>
        </CollapsibleTrigger>

        {/* Action buttons — always visible */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Hidden file input for upload */}
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={handleFileSelected}
            className="hidden"
          />
          {/* Hidden file input for edit popover references */}
          <input
            ref={editRefs.inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={editRefs.handleFilesSelected}
            className="hidden"
          />
          {/* Upload button — available for all states */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={isUploading || !editable}
            title={editable ? undefined : "Click this prop to edit"}
            onClick={(e) => {
              e.stopPropagation();
              if (!editable) return;
              handleUploadClick();
            }}
          >
            <Upload className="h-3.5 w-3.5" />
            {isUploading ? "Uploading..." : "Upload"}
          </Button>

          {/* Delete button — only for non-base states */}
          {!isBase && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  disabled={!editable}
                  onClick={(e) => e.stopPropagation()}
                  title={editable ? "Delete variant" : "Click this prop to edit"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Variant</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete the variant &ldquo;
                    {variantData.name}&rdquo;? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={handleDeleteVariant}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <CollapsibleContent>
        <div className="space-y-4 px-3 pt-3 pb-3">
          {/* Image Preview + Thumbnail Gallery row — all left-aligned */}
          <div className="flex items-start gap-3">
            {/* Main Preview — fixed 480px wide */}
            <div className="shrink-0 w-[480px] h-[360px]">
              {selectedIllustration ? (
                <div className="relative w-full h-full">
                  <img
                    key={selectedIllustration.media_url}
                    src={selectedIllustration.media_url}
                    alt={variantData.name}
                    className="w-full h-full rounded-md object-contain"
                  />
                  {/* Zoom overlay — click to open fullscreen zoom dialog */}
                  <ImageZoomPreview
                    src={selectedIllustration.media_url}
                    alt={variantData.name}
                    className="absolute inset-0 h-full w-full rounded-md"
                    disabled={isProcessing}
                  />
                  {/* Generating overlay */}
                  {isProcessing && (
                    <div className="absolute inset-0 bg-white/80 rounded-md flex items-center justify-center z-20">
                      <div className="text-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">
                          Generating...
                        </p>
                      </div>
                    </div>
                  )}
                  {/* Floating action buttons — bottom-right on image */}
                  <div className="absolute bottom-2 right-2 flex gap-2 z-20">
                    <EditImagePopover
                      open={isEditPopoverOpen}
                      onOpenChange={setIsEditPopoverOpen}
                      promptValue={editPromptText}
                      onPromptChange={setEditPromptText}
                      onSubmit={handleEditImage}
                      referenceImages={editRefs.images}
                      onAttachClick={editRefs.openPicker}
                      onRemoveReference={editRefs.removeImage}
                      disabled={isProcessing || !editable}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleDownload}
                      disabled={isProcessing}
                      aria-label="Download image"
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="w-full h-full rounded-lg bg-muted flex items-center justify-center">
                  <div className="text-center text-muted-foreground">
                    <ImageIcon className="h-8 w-8 mx-auto mb-2" />
                    <p className="text-sm">No images generated</p>
                  </div>
                </div>
              )}
            </div>

            {/* Thumbnail Gallery — left-aligned, fixed size thumbnails */}
            <div className="shrink-0">
              <div className="mb-2">
                <Label className="text-xs text-muted-foreground">LATEST</Label>
              </div>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-2 max-h-[360px] overflow-y-auto p-0.5">
                {sortedIllustrations.length > 0 ? (
                  sortedIllustrations.map((ill) => {
                    const originalIdx = variantData.illustrations.indexOf(ill);
                    return (
                      <button
                        key={ill.media_url}
                        className={cn(
                          "relative rounded-md transition-all w-[120px] h-[120px]",
                          originalIdx === selectedIllustrationIndex
                            ? "ring-2 ring-primary"
                            : "ring-1 ring-border hover:scale-105"
                        )}
                        onClick={() => handleSelectIllustration(originalIdx)}
                      >
                        <img
                          src={ill.media_url}
                          alt=""
                          className="w-full h-full object-contain rounded-md"
                        />
                        {originalIdx === selectedIllustrationIndex && (
                          <div className="absolute top-1.5 left-1.5">
                            <div className="rounded-full bg-primary p-1">
                              <Check className="h-3 w-3 text-primary-foreground" />
                            </div>
                          </div>
                        )}
                      </button>
                    );
                  })
                ) : (
                  <div className="col-span-2 text-center text-sm text-muted-foreground py-8">
                    No images yet
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Visual Description Section */}
          <div>
            {/* Hidden file input for reference images */}
            <input
              ref={generateRefs.inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={generateRefs.handleFilesSelected}
              className="hidden"
            />
            <div className="flex items-center gap-2 mb-2">
              <Label className="text-xs text-muted-foreground">
                VISUAL DESCRIPTION
              </Label>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={generateRefs.openPicker}
                disabled={isProcessing || !editable}
                aria-label="Attach reference image"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              {generateRefs.images.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {generateRefs.images.length}/5
                </span>
              )}
            </div>
            {/* Attached reference images list */}
            {generateRefs.images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {generateRefs.images.map((img, idx) => (
                  <div
                    key={`${img.label}-${idx}`}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-blue-50 text-blue-700 text-xs"
                  >
                    <span className="truncate max-w-[120px]">{img.label}</span>
                    <button
                      onClick={() => generateRefs.removeImage(idx)}
                      className="hover:bg-blue-100 rounded"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Textarea
              value={visualDescription}
              onChange={handleDescriptionChange}
              placeholder="Describe the visual appearance..."
              className="min-h-[80px]"
              disabled={isProcessing || !editable}
            />
          </div>

          {/* Action buttons row — centered like edit-image modal */}
          <div className="flex flex-col items-center gap-1">
            <Button
              onClick={handleGenerate}
              disabled={isGenerateDisabled}
              title={!artStyleId ? "Select an art style first" : undefined}
              className="w-40"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Generate
                </>
              )}
            </Button>
            {!artStyleId && (
              <span className="text-xs text-muted-foreground">Select an art style first</span>
            )}
            {!isBase && !basePropImageUrl && (
              <span className="text-xs text-muted-foreground">Generate base variant first</span>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
