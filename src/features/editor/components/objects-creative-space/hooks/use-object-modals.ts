// use-object-modals.ts - Modal state management for generate/edit/extract/editAudio/slot modals
// spreadId is captured at open time to prevent stale-spread updates if selection changes while modal is open
//
// Toolbar unify (matrix): the Objects image footer now has SEPARATE Generate and Edit buttons.
//   • generate slice → GenerateImageModal (upload-only, object.generate)
//   • edit slice     → RetouchEditImageModal (object.edit)
// The crop slice is gone — box-crop now lives in the Extract `get_object` tab.

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { createLogger } from "@/utils/logger";
import { useSnapshotActions } from "@/stores/snapshot-store/selectors";
import type { ExtractTabKey } from "@/features/editor/components/shared-components";
import type {
  SpreadImage,
  SpreadAudio,
  SpreadAutoAudio,
} from "@/types/canvas-types";

const log = createLogger("Editor", "useObjectModals");

type SnapshotActions = ReturnType<typeof useSnapshotActions>;

/** Edit-audio modal handles both regular audio and auto_audio items. The `kind`
 *  field discriminates which slice action to dispatch on completion. */
export type EditAudioKind = "audio" | "auto_audio";

export interface UseObjectModalsReturn {
  /** GenerateImageModal (upload-only in Objects). */
  generate: { open: boolean; imageId: string | null; spreadId: string };
  /** RetouchEditImageModal (Inpaint / Outpaint / Upscale / Remove BG / Erasor). */
  edit: { open: boolean; imageId: string | null; spreadId: string };
  /** Consolidated Extract modal (Objects / Segments / Layers / Background). */
  extract: {
    open: boolean;
    image: SpreadImage | null;
    spreadId: string;
    initialTab: ExtractTabKey;
  };
  /** Standalone ExtractLottieModal (cut image → parts → static .lottie v2 rig + auto_pic spawn). */
  lottie: { open: boolean; image: SpreadImage | null; spreadId: string };
  editAudio: {
    open: boolean;
    item: SpreadAudio | SpreadAutoAudio | null;
    spreadId: string;
    kind: EditAudioKind | null;
  };
  /** ItemSlotModal — INIT-ONLY. Only ever holds an image that carries NO slot
   *  (see `openSlot` routing below). Keeps the whole image, not just the id:
   *  the modal seeds itself from `illustrations` / `tags` / `media_url`. */
  slot: { open: boolean; image: SpreadImage | null; spreadId: string };
  /** EditParametricSlotModal — item that ALREADY carries a `parametric_slot`.
   *  ⚡ Holds the ID, not the image object (unlike `slot`): this modal WRITES `values[]` and
   *  must re-render from the live store item, so ObjectsMainView re-resolves it per render.
   *  A captured snapshot would freeze the version grid after the first generate. */
  parametric: { open: boolean; imageId: string | null; spreadId: string };

  openGenerate: (img: SpreadImage) => void;
  closeGenerate: (open: boolean) => void;
  openEdit: (img: SpreadImage) => void;
  closeEdit: (open: boolean) => void;
  openExtract: (img: SpreadImage, initialTab?: ExtractTabKey) => void;
  closeExtract: (open: boolean) => void;
  openLottie: (img: SpreadImage) => void;
  closeLottie: () => void;
  openEditAudio: (
    item: SpreadAudio | SpreadAutoAudio,
    kind: EditAudioKind
  ) => void;
  closeEditAudio: () => void;
  /** Toolbar "Slot" entry point. Routes by item state (03-image-toolbar §4.9):
   *   • `casting_slot`      → NO-OP + "Coming soon" toast (EditCastingSlotModal has no design yet;
   *     its `actants`/`actors` shape differs from `values[]`, so it cannot reuse this shell).
   *   • `parametric_slot`   → opens EditParametricSlotModal (edit)
   *   • no slot at all      → opens ItemSlotModal (init)
   *  Routing lives here rather than in ObjectsMainView to keep that ~1.4k-LOC file lean. */
  openSlot: (img: SpreadImage) => void;
  closeSlot: () => void;
  closeParametric: () => void;
  handleEditAudioComplete: (result: {
    mediaUrl: string;
    description: string;
  }) => void;
}

export function useObjectModals(
  selectedSpreadId: string,
  actions: SnapshotActions
): UseObjectModalsReturn {
  // Generate image modal (upload-only)
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateImageId, setGenerateImageId] = useState<string | null>(null);
  const [generateSpreadId, setGenerateSpreadId] = useState<string>("");

  // Edit image modal (RetouchEditImageModal)
  const [editOpen, setEditOpen] = useState(false);
  const [editImageId, setEditImageId] = useState<string | null>(null);
  const [editSpreadId, setEditSpreadId] = useState<string>("");

  // Extract image modal (consolidated Objects + Segments + Layers + Background)
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractImage, setExtractImage] = useState<SpreadImage | null>(null);
  const [extractSpreadId, setExtractSpreadId] = useState<string>("");
  const [extractInitialTab, setExtractInitialTab] =
    useState<ExtractTabKey>("get_object");

  // Extract-Lottie modal (standalone — cut parts → .lottie v2 + auto_pic spawn)
  const [lottieOpen, setLottieOpen] = useState(false);
  const [lottieImage, setLottieImage] = useState<SpreadImage | null>(null);
  const [lottieSpreadId, setLottieSpreadId] = useState<string>("");

  // Edit audio modal — covers audio + auto_audio (discriminated via kind)
  const [editAudioOpen, setEditAudioOpen] = useState(false);
  const [editAudioItem, setEditAudioItem] = useState<
    SpreadAudio | SpreadAutoAudio | null
  >(null);
  const [editAudioSpreadId, setEditAudioSpreadId] = useState<string>("");
  const [editAudioKind, setEditAudioKind] = useState<EditAudioKind | null>(
    null
  );

  // Item slot modal (parametric_slot | casting_slot init)
  const [slotOpen, setSlotOpen] = useState(false);
  const [slotImage, setSlotImage] = useState<SpreadImage | null>(null);
  const [slotSpreadId, setSlotSpreadId] = useState<string>("");

  // Edit-parametric-slot modal (item already carries a parametric_slot)
  const [parametricOpen, setParametricOpen] = useState(false);
  const [parametricImageId, setParametricImageId] = useState<string | null>(null);
  const [parametricSpreadId, setParametricSpreadId] = useState<string>("");

  // CRITICAL: deps include selectedSpreadId to capture it at open time
  const openGenerate = useCallback(
    (img: SpreadImage) => {
      setGenerateImageId(img.id);
      setGenerateSpreadId(selectedSpreadId);
      setGenerateOpen(true);
    },
    [selectedSpreadId]
  );

  const closeGenerate = useCallback((open: boolean) => {
    setGenerateOpen(open);
    if (!open) setGenerateImageId(null);
  }, []);

  const openEdit = useCallback(
    (img: SpreadImage) => {
      setEditImageId(img.id);
      setEditSpreadId(selectedSpreadId);
      setEditOpen(true);
    },
    [selectedSpreadId]
  );

  const closeEdit = useCallback((open: boolean) => {
    setEditOpen(open);
    if (!open) setEditImageId(null);
  }, []);

  const openExtract = useCallback(
    // Default entry (toolbar "Extract") opens the Objects tab; the split entry passes
    // "layering" explicitly. Segments is no longer the default landing tab.
    (img: SpreadImage, initialTab: ExtractTabKey = "get_object") => {
      setExtractImage(img);
      setExtractSpreadId(selectedSpreadId);
      setExtractInitialTab(initialTab);
      setExtractOpen(true);
    },
    [selectedSpreadId]
  );

  const closeExtract = useCallback((open: boolean) => {
    setExtractOpen(open);
    if (!open) setExtractImage(null);
  }, []);

  const openLottie = useCallback(
    (img: SpreadImage) => {
      setLottieImage(img);
      setLottieSpreadId(selectedSpreadId);
      setLottieOpen(true);
    },
    [selectedSpreadId]
  );

  const closeLottie = useCallback(() => {
    setLottieOpen(false);
    setLottieImage(null);
    // Clear the captured spread too — a stale id would survive into the next open (parity closeSlot).
    setLottieSpreadId("");
  }, []);

  const openEditAudio = useCallback(
    (item: SpreadAudio | SpreadAutoAudio, kind: EditAudioKind) => {
      setEditAudioItem(item);
      setEditAudioSpreadId(selectedSpreadId);
      setEditAudioKind(kind);
      setEditAudioOpen(true);
    },
    [selectedSpreadId]
  );

  const closeEditAudio = useCallback(() => {
    setEditAudioOpen(false);
    setEditAudioItem(null);
    setEditAudioKind(null);
  }, []);

  const openSlot = useCallback(
    (img: SpreadImage) => {
      // Presence MUST be a truthy check: the write path sets the unused slot key to
      // `undefined`, so `'casting_slot' in img` would report a slot that does not exist.
      if (img.casting_slot) {
        log.debug("openSlot", "casting edit modal not implemented, skip", {
          itemId: img.id,
        });
        toast.info("Coming soon");
        return;
      }
      if (img.parametric_slot) {
        log.info("openSlot", "open parametric edit modal", {
          itemId: img.id,
          spreadId: selectedSpreadId,
          key: img.parametric_slot.key,
          valueCount: img.parametric_slot.values.length,
        });
        setParametricImageId(img.id);
        setParametricSpreadId(selectedSpreadId);
        setParametricOpen(true);
        return;
      }
      setSlotImage(img);
      setSlotSpreadId(selectedSpreadId);
      setSlotOpen(true);
    },
    [selectedSpreadId]
  );

  const closeParametric = useCallback(() => {
    setParametricOpen(false);
    setParametricImageId(null);
    // Clear the captured spread too — a stale id would survive into the next open and be read
    // by the drift guard (parity closeSlot).
    setParametricSpreadId("");
  }, []);

  const closeSlot = useCallback(() => {
    setSlotOpen(false);
    setSlotImage(null);
    // Clear the captured spread too (matching closeEditAudio) — a stale id would otherwise
    // survive into the next open and be read by the submit-time spread-selection guard.
    setSlotSpreadId("");
  }, []);

  const handleEditAudioComplete = useCallback(
    (result: { mediaUrl: string; description: string }) => {
      if (!editAudioItem || !editAudioSpreadId || !editAudioKind) {
        log.warn("handleEditAudioComplete", "missing state, skip", {
          hasItem: !!editAudioItem,
          spreadId: editAudioSpreadId,
          kind: editAudioKind,
        });
        return;
      }
      const patch = {
        media_url: result.mediaUrl,
        description: result.description,
      };
      switch (editAudioKind) {
        case "audio":
          actions.updateRetouchAudio(
            editAudioSpreadId,
            editAudioItem.id,
            patch
          );
          log.info("handleEditAudioComplete", "audio saved", {
            audioId: editAudioItem.id,
            spreadId: editAudioSpreadId,
            mediaUrl: result.mediaUrl,
            descLen: result.description.length,
          });
          break;
        case "auto_audio":
          actions.updateRetouchAutoAudio(
            editAudioSpreadId,
            editAudioItem.id,
            patch
          );
          log.info("handleEditAudioComplete", "auto_audio saved", {
            autoAudioId: editAudioItem.id,
            spreadId: editAudioSpreadId,
            mediaUrl: result.mediaUrl,
            descLen: result.description.length,
          });
          break;
      }
      setEditAudioOpen(false);
      setEditAudioItem(null);
      setEditAudioKind(null);
    },
    [editAudioItem, editAudioSpreadId, editAudioKind, actions]
  );

  return {
    generate: { open: generateOpen, imageId: generateImageId, spreadId: generateSpreadId },
    edit: { open: editOpen, imageId: editImageId, spreadId: editSpreadId },
    extract: {
      open: extractOpen,
      image: extractImage,
      spreadId: extractSpreadId,
      initialTab: extractInitialTab,
    },
    lottie: { open: lottieOpen, image: lottieImage, spreadId: lottieSpreadId },
    editAudio: {
      open: editAudioOpen,
      item: editAudioItem,
      spreadId: editAudioSpreadId,
      kind: editAudioKind,
    },
    slot: { open: slotOpen, image: slotImage, spreadId: slotSpreadId },
    parametric: {
      open: parametricOpen,
      imageId: parametricImageId,
      spreadId: parametricSpreadId,
    },
    openGenerate,
    closeGenerate,
    openEdit,
    closeEdit,
    openExtract,
    closeExtract,
    openLottie,
    closeLottie,
    openEditAudio,
    closeEditAudio,
    openSlot,
    closeSlot,
    closeParametric,
    handleEditAudioComplete,
  };
}
