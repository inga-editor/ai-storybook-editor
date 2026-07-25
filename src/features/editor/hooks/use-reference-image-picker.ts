// use-reference-image-picker.ts - Hook encapsulating reference image selection, validation, and base64 conversion

import { useRef, useState, useCallback } from "react";
import { fileToBase64 } from "@/utils/file-utils";
import { createLogger } from "@/utils/logger";
import { toast } from "sonner";
import type { ReferenceImage } from "@/types/remix";
// Type-only import (no runtime cycle — utils never imports this hook). `PickedReferenceImage`
// widens `ReferenceImage` with optional picker metadata (id/thumbUrl/description/source).
import type { PickedReferenceImage } from "@/features/editor/components/shared-components/edit-image-modal/edit-image-modal-utils";

// Canonical `ReferenceImage` shape lives in `@/types/remix` (single source of
// truth, shared with the crop-sheet swap modal). Re-exported here so existing
// consumers importing it from the hook keep working.
export type { ReferenceImage };

const log = createLogger("Editor", "ReferenceImagePicker");

const DEFAULT_MAX_IMAGES = 5;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function useReferenceImagePicker(maxImages = DEFAULT_MAX_IMAGES) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Widened to PickedReferenceImage (all added fields optional → existing runtime values stay
  // valid). Upload items now carry source/id/thumbUrl; picked items are appended via addReferenceImages.
  const [images, setImages] = useState<PickedReferenceImage[]>([]);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const fileArray = Array.from(files);
      e.target.value = "";

      const remaining = maxImages - images.length;
      if (remaining <= 0) {
        toast.warning(`Maximum ${maxImages} reference images allowed`);
        return;
      }

      const validFiles: File[] = [];
      for (const file of fileArray) {
        if (!ACCEPTED_TYPES.includes(file.type)) {
          log.warn("handleFilesSelected", "invalid mime type", { name: file.name, type: file.type });
          toast.warning(`${file.name}: only PNG, JPEG, WebP accepted`);
          continue;
        }
        if (file.size > DEFAULT_MAX_FILE_SIZE) {
          log.warn("handleFilesSelected", "file too large", { name: file.name, size: file.size });
          toast.warning(`${file.name}: exceeds 10MB limit`);
          continue;
        }
        validFiles.push(file);
      }

      const toProcess = validFiles.slice(0, remaining);
      if (validFiles.length > remaining) {
        toast.warning(
          `Only ${remaining} more reference image(s) can be added (max ${maxImages})`
        );
      }

      log.debug("handleFilesSelected", "converting files", { count: toProcess.length });
      try {
        const newImages: PickedReferenceImage[] = await Promise.all(
          toProcess.map(async (file) => {
            const base64Data = await fileToBase64(file);
            return {
              label: file.name,
              base64Data,
              mimeType: file.type,
              source: "upload" as const,
              id: `upload:${crypto.randomUUID()}`,
              // Rebuild the data-URI from the base64 we already have (no object URL to revoke).
              thumbUrl: `data:${file.type};base64,${base64Data}`,
            };
          })
        );
        setImages((prev) => [...prev, ...newImages]);
      } catch (err) {
        log.error("handleFilesSelected", "conversion failed", { error: err });
        toast.error("Failed to process reference image(s)");
      }
    },
    [images.length, maxImages]
  );

  // Append pre-converted items (e.g. a picked provenance ref already fetched → base64), respecting the
  // remaining cap + deduping by `id`. The seam Inpaint's onPick uses; upload path stays separate.
  const addReferenceImages = useCallback(
    (items: PickedReferenceImage[]) => {
      setImages((prev) => {
        const remaining = maxImages - prev.length;
        if (remaining <= 0) {
          toast.warning(`Maximum ${maxImages} reference images allowed`);
          return prev;
        }
        const existingIds = new Set(prev.map((i) => i.id).filter(Boolean));
        const fresh = items.filter((i) => !i.id || !existingIds.has(i.id));
        const toAdd = fresh.slice(0, remaining);
        if (fresh.length > remaining) {
          toast.warning(`Only ${remaining} more reference image(s) can be added (max ${maxImages})`);
        }
        log.debug("addReferenceImages", "appended", { added: toAdd.length, total: prev.length + toAdd.length });
        return [...prev, ...toAdd];
      });
    },
    [maxImages]
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
  }, []);

  return {
    images,
    inputRef,
    openPicker,
    handleFilesSelected,
    addReferenceImages,
    removeImage,
    clearImages,
  };
}
