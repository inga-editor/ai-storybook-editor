// use-auto-pic-upload.ts - Upload + inspection logic for the auto_pic toolbar.
// Extracted from objects-auto-pic-toolbar.tsx to keep that file under 500 lines.
// Owns: animated-media upload (webp/webm/lottie/riv), static-image upload
// (Classic/Print), and rive/lottie inspection metadata (fresh on upload +
// lazy-from-URL on mount).

import { useCallback, useEffect, useState, type RefObject } from "react";
import { toast } from "sonner";
import { uploadAutoPicToStorage, uploadImageToStorage } from "@/apis/storage-api";
import {
  inspectLottie,
  inspectRive,
  inspectLottieFromUrl,
  inspectRiveFromUrl,
  type LottieInspection,
  type RiveInspection,
} from "@/features/editor/components/shared-components/auto-pic-players/inspect-auto-pic";
import { computeGeometryOnMediaReplace } from "@/features/editor/components/shared-components";
import { createLogger } from "@/utils/logger";
import type { Geometry, SpreadAutoPic } from "@/types/spread-types";
import { buildStaticImageAfterUpload } from "./build-static-image-after-upload";

const log = createLogger("Editor", "ObjectsAutoPicToolbar");

// .gif blocked client-side — validation session 1
// .lottie/.riv validated by extension only (MIME unreliable — browser returns application/octet-stream)
const VALID_MIME_TYPES = ["image/webp", "video/webm"];
// Static image (Classic/Print) — still-frame only, no animated formats.
const STATIC_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

export type DerivedMediaKind = "webp" | "webm" | "lottie" | "riv" | null;

export function isValidAutoPicFile(file: File): boolean {
  if (VALID_MIME_TYPES.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return name.endsWith(".lottie") || name.endsWith(".riv");
}

export function deriveMediaKind(mediaUrl: string | undefined): DerivedMediaKind {
  if (!mediaUrl) return null;
  const ext = mediaUrl.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "webm") return "webm";
  if (ext === "webp") return "webp";
  if (ext === "lottie") return "lottie";
  if (ext === "riv") return "riv";
  return null;
}

function detectImageDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to read image dimensions"));
    };
    img.src = url;
  });
}

function detectVideoDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to read video dimensions"));
    };
    video.src = url;
  });
}

interface UseAutoPicUploadParams {
  item: SpreadAutoPic;
  geometry: Geometry;
  mediaKind: DerivedMediaKind;
  canvasWidth: number;
  canvasHeight: number;
  onUpdate: (updates: Partial<SpreadAutoPic>) => void;
  canvasRef: RefObject<HTMLDivElement | null>;
}

export function useAutoPicUpload({
  item,
  geometry,
  mediaKind,
  canvasWidth,
  canvasHeight,
  onUpdate,
  canvasRef,
}: UseAutoPicUploadParams) {
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingStatic, setIsUploadingStatic] = useState(false);

  // Inspection metadata — populated on upload (fresh inspect) or on mount for existing
  // items (lazy fetch+probe from stored URL, with module-level cache).
  const [riveMeta, setRiveMeta] = useState<RiveInspection | null>(null);
  const [lottieMeta, setLottieMeta] = useState<LottieInspection | null>(null);

  useEffect(() => {
    if (!item.media_url) {
      setRiveMeta(null);
      setLottieMeta(null);
      return;
    }
    const url = item.media_url;
    let cancelled = false;
    if (mediaKind === "riv") {
      inspectRiveFromUrl(url)
        .then((m) => { if (!cancelled) setRiveMeta(m); })
        .catch((err) => {
          log.warn("useEffect", "rive inspect-from-url failed", { error: String(err) });
          if (!cancelled) setRiveMeta(null);
        });
    } else if (mediaKind === "lottie") {
      inspectLottieFromUrl(url)
        .then((m) => { if (!cancelled) setLottieMeta(m); })
        .catch((err) => {
          log.warn("useEffect", "lottie inspect-from-url failed", { error: String(err) });
          if (!cancelled) setLottieMeta(null);
        });
    } else {
      setRiveMeta(null);
      setLottieMeta(null);
    }
    return () => { cancelled = true; };
  }, [item.media_url, mediaKind]);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";

      if (!isValidAutoPicFile(file)) {
        toast.error(
          "Please use .webp, .webm, .lottie, or .riv format. .gif is not supported."
        );
        log.warn("handleFileChange", "rejected invalid type", { type: file.type, name: file.name });
        return;
      }

      setIsUploading(true);
      log.info("handleFileChange", "upload started", {
        picId: item.id,
        name: file.name,
        size: file.size,
        type: file.type,
      });

      try {
        const lowerName = file.name.toLowerCase();
        const isLottie = lowerName.endsWith(".lottie");
        const isRive = lowerName.endsWith(".riv");

        type Probe =
          | { kind: "image" | "video"; dims: { width: number; height: number } }
          | { kind: "lottie"; inspection: LottieInspection }
          | { kind: "rive"; inspection: RiveInspection }
          | null;

        const probePromise: Promise<Probe> =
          file.type === "image/webp"
            ? detectImageDimensions(file).then((d) => ({ kind: "image" as const, dims: d })).catch(() => null)
            : file.type === "video/webm"
            ? detectVideoDimensions(file).then((d) => ({ kind: "video" as const, dims: d })).catch(() => null)
            : isLottie
            ? inspectLottie(file).then((i) => ({ kind: "lottie" as const, inspection: i })).catch((err) => {
                log.warn("handleFileChange", "lottie inspect failed", { error: String(err) });
                return null;
              })
            : isRive
            ? inspectRive(file).then((i) => ({ kind: "rive" as const, inspection: i })).catch((err) => {
                log.warn("handleFileChange", "rive inspect failed", { error: String(err) });
                return null;
              })
            : Promise.resolve(null);

        const [{ publicUrl }, probe] = await Promise.all([
          uploadAutoPicToStorage(file, "auto-pics"),
          probePromise,
        ]);

        const dims = probe && "inspection" in probe
          ? { width: probe.inspection.width, height: probe.inspection.height }
          : probe && "dims" in probe
          ? probe.dims
          : null;

        const updates: Partial<SpreadAutoPic> = { media_url: publicUrl };

        if (dims) {
          log.debug("handleFileChange", "detected dimensions", {
            kind: file.type || lowerName.split(".").pop(),
            w: dims.width,
            h: dims.height,
          });
          updates.geometry = computeGeometryOnMediaReplace({
            old: geometry,
            naturalW: dims.width,
            naturalH: dims.height,
            canvasW: canvasWidth,
            canvasH: canvasHeight,
          });
        }

        // Auto-select first state machine when present → item becomes interactive by default.
        // User can clear via dropdown to fall back to linear animation.
        if (probe?.kind === "rive") {
          setRiveMeta(probe.inspection);
          const autoSm = probe.inspection.stateMachines[0];
          updates.rive = {
            ...(item.rive ?? {}),
            ...(autoSm ? { state_machine: autoSm } : {}),
          };
        } else if (probe?.kind === "lottie") {
          setLottieMeta(probe.inspection);
          const autoSm = probe.inspection.stateMachines[0];
          updates.lottie = {
            ...(item.lottie ?? {}),
            ...(autoSm ? { state_machine: autoSm } : {}),
          };
        }

        onUpdate(updates);

        toast.success("Animated pic uploaded");
        canvasRef.current?.click();
        log.info("handleFileChange", "upload success", { picId: item.id, name: file.name });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(message);
        log.error("handleFileChange", "upload failed", {
          picId: item.id,
          error: message,
        });
      } finally {
        setIsUploading(false);
      }
    },
    [geometry, item.id, item.rive, item.lottie, onUpdate, canvasRef, canvasWidth, canvasHeight]
  );

  // Upload a STATIC image (Classic/Print). Kept entirely inside the toolbar flow —
  // it prepends an Illustration Entry to `static_image` and calls onUpdate, which
  // routes through updateRetouchAutoPic + the held-session collab writer.
  //
  // ⚠ Intentional spec divergence (spec 12 §2, chốt 2026-08-01): we do NOT add
  //   an `onUploadStaticImage` callback to AutoPicToolbarContext. Its sibling
  //   `onReplaceAutoPic` is a stub no-op; a static callback in the context would
  //   be dead code. The toolbar owns the whole upload flow.
  const handleStaticFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";

      // `accept` is not a security control — guard MIME at runtime too.
      if (!STATIC_MIME_TYPES.includes(file.type)) {
        toast.error("Please use a PNG, JPEG, or WebP image.");
        log.warn("handleStaticFileChange", "rejected invalid type", {
          type: file.type,
          name: file.name,
        });
        return;
      }

      setIsUploadingStatic(true);
      log.info("handleStaticFileChange", "static upload started", {
        picId: item.id,
        name: file.name,
        size: file.size,
      });

      try {
        // Plain image upload (no ratio normalize — geometry is preserved).
        const { publicUrl } = await uploadImageToStorage(file, "auto-pics/static");
        const prevIllustrations = item.static_image?.illustrations ?? [];
        const hadHires = !!item.static_image?.final_hires_media_url;

        // ⚠ WYSIWYG (chốt 2026-08-01): buildStaticImageAfterUpload ALWAYS sets
        //   final_hires_media_url: undefined. Do NOT spread ...item.static_image —
        //   a stale hi-res URL would make the just-uploaded image never show.
        const static_image = buildStaticImageAfterUpload(
          prevIllustrations,
          publicUrl,
          new Date().toISOString()
        );
        onUpdate({ static_image }); // geometry untouched — static uses the same frame

        toast.success("Static image uploaded");
        log.info("handleStaticFileChange", "static upload done", {
          picId: item.id,
          count: static_image.illustrations.length,
          clearedHires: hadHires,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(message);
        log.error("handleStaticFileChange", "static upload failed", {
          picId: item.id,
          name: file.name,
          size: file.size,
          error: message,
        });
      } finally {
        setIsUploadingStatic(false);
      }
    },
    [item.id, item.static_image, onUpdate]
  );

  return {
    isUploading,
    isUploadingStatic,
    riveMeta,
    lottieMeta,
    handleFileChange,
    handleStaticFileChange,
  };
}
