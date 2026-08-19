// objects-main-view.tsx - CanvasSpreadView wrapper with retouch render props
"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Languages, Mic, MessageSquare } from "lucide-react";
import { createLogger } from "@/utils/logger";
import { buildImageVersionSaveResource } from "@/utils/save-resource-path";
import type { SaveResourceDirective } from "@/types/save-resource";
import { toastLockRequired, toastSpreadSelectionMoved } from "@/utils/collab-save-toasts";
import { TranslateSpreadModal, type ApplyTranslationsPayload } from "./translate-spread-modal";
import {
  EnhanceSpreadNarrationModal,
  type ApplyEnhancementsPayload,
} from "./enhance-spread-narration-modal";
import {
  EnhanceImageAnnotationModal,
  type ApplyAnnotationsPayload,
} from "./enhance-image-annotation-modal";
import { buildAnnotationImages } from "./build-annotation-images";
import {
  buildNarrationReaders,
  buildNarrationReaderToVoice,
} from "./utils/build-narration-readers";
import { applySpreadNarrationEnhancements } from "./utils/apply-spread-narration-enhancements";
import { buildBookContext } from "./utils/build-book-context";
import type { SpreadAnimation, SpreadTextboxContent } from "@/types/spread-types";
import type { ZoomAreaGeometry } from "@/features/editor/components/canvas-spread-view/overlays/zoom-area-overlay-utils";
import type { MotionLineGeometry } from "@/features/editor/components/canvas-spread-view/overlays/motion-line-overlay-utils";
import { CanvasSpreadView } from "@/features/editor/components/canvas-spread-view";
import {
  EditableImage,
  EditableTextbox,
  EditableShape,
  EditableVideo,
  EditableAudio,
  EditableAutoAudio,
  EditableAutoPic,
  ExtractImageModal,
  EditAudioModal,
  SoundLibraryModal,
  resolveEffectiveImageUrl,
  SPACE_TOOL_MATRIX,
} from "@/features/editor/components/shared-components";
import type {
  ExtractResult,
  LibrarySound,
  BackgroundRemoveCandidate,
} from "@/features/editor/components/shared-components";
// Standalone Extract-Lottie modal — imported from its own folder (not the shared barrel) so it
// only loads when Objects mounts it. Spawns an auto_pic via addRetouchAutoPic on Extract.
import { ExtractLottieModal } from "@/features/editor/components/shared-components/extract-lottie-modal";
import type { NewAutoPicFromLottie } from "@/features/editor/components/shared-components/extract-lottie-modal";
import { nextTopZInTier } from "@/features/editor/utils/duplicate-item-helpers";
import {
  upsertCropPreset,
  deleteCropPreset,
} from "@/features/editor/components/shared-components/extract-image-modal/crop-preset-utils";
import type { CropPreset } from "@/types/editor";
import { useSounds } from "@/stores/sounds-store";
import { ItemSlotModal, type SlotPatch } from "./item-slot-modal";
import {
  EditParametricSlotModal,
  buildParametricValueSaveResourcePath,
} from "./edit-parametric-slot-modal";
import { RetouchEditImageModal } from "./retouch-edit-image-modal";
import { RetouchGenerateImageModal } from "./retouch-generate-image-modal";
import { ObjectsImageToolbar } from "./objects-image-toolbar";
import { ObjectsVideoToolbar } from "./objects-video-toolbar";
import { ObjectsAudioToolbar } from "./objects-audio-toolbar";
import { ObjectsShapeToolbar } from "./objects-shape-toolbar";
import { ObjectsTextToolbar } from "./objects-text-toolbar";
import { ObjectsRawImageToolbar } from "./objects-raw-image-toolbar";
import { ObjectsRawTextboxToolbar } from "./objects-raw-textbox-toolbar";
import { ObjectsAutoPicToolbar } from "./objects-auto-pic-toolbar";
import { PlayerHiddenBadge } from "./player-hidden-badge";
import { CompositeMemberBadge } from "./composite-member-badge";
import {
  useRetouchSpreads,
  useSnapshotActions,
  useCharacters,
  useProps,
  useSnapshotId,
} from "@/stores/snapshot-store/selectors";
import { useArtStyleDescription } from "@/stores/art-style-store";
import { getTextboxContentForLanguage } from "@/features/editor/utils/textbox-helpers";
import { useLanguageCode } from "@/stores/editor-settings-store";
import { useBookTemplateLayout, useCurrentBook, useBookActions } from "@/stores/book-store";
import { useSaveSessionStore, type SaveOutcome } from "@/stores/save-session-store";
import { useCanvasWidth, useCanvasHeight } from "@/stores/editor-settings-store";
import { useInteractionLayerContext } from "@/features/editor/contexts/interaction-layer-provider";
import { COLUMNS, DEFAULT_AUDIO_TITLES } from "@/constants/spread-constants";
import {
  useSpreadHandlers,
  useSpreadItemDispatch,
  buildExtractImages,
  sceneLineageOfPlayableSource,
  useSplitTextbox,
  useObjectModals,
  useCloneRaw,
  useDuplicateItem,
  useDuplicateHotkey,
} from "./hooks";
import type { SelectedItem, ObjectElementType } from "./objects-creative-space";
import type {
  BaseSpread,
  ImageItemContext,
  ImageToolbarContext,
  TextToolbarContext,
  ShapeToolbarContext,
  VideoToolbarContext,
  AudioToolbarContext,
  AutoAudioItemContext,
  AutoAudioToolbarContext,
  AutoPicItemContext,
  AutoPicToolbarContext,
  TextItemContext,
  ShapeItemContext,
  VideoItemContext,
  AudioItemContext,
  SpreadImage,
  SpreadTextbox,
  SpreadShape,
  SpreadVideo,
  SpreadAudio,
  SpreadAutoAudio,
  SpreadAutoPic,
} from "@/types/canvas-types";
import type { ItemParametricSlot, SpreadComposite } from "@/types/spread-types";
import {
  buildEditorCompositeContextMap,
  resolveEffectiveZIndex,
  buildCompositeNumberMap,
  findCompositeIdForVariant,
} from "@/features/editor/utils/composite-resolve-helpers";

const log = createLogger("UI", "ObjectsMainView");

// Whole-spread RETOUCH lock coords (step 3 / rtype 10) for peer-lock veil + thumbnail badges.
// Module-const → stable identity → SpreadThumbnail's React.memo stays intact.
const RETOUCH_PEER_LOCK = { step: 3, resourceType: 10 } as const;

interface ObjectsMainViewProps {
  selectedSpreadId: string;
  selectedItemId: SelectedItem | null;
  onSpreadSelect: (spreadId: string) => void;
  /** USER-initiated spread selection (filmstrip/grid click) → the per-spread retouch held-session
   *  lock-on-click seam (ADR-044). Distinct from `onSpreadSelect`, which also fires programmatically. */
  onSpreadUserSelect?: (spreadId: string) => void;
  onItemSelect: (item: SelectedItem | null) => void;
  /** Whether the active spread is currently held by THIS editor's retouch lock. Gates canvas item
   *  editability (grey-out when not held — lock-on-click). */
  spreadEditable: boolean;
  /** Held-session commit-on-modal-close (fire-and-forget) forwarded to every spread-level retouch
   *  modal. STABLE from the engine; self-guards (no-op when clean / not held). */
  onCommitSave?: () => void;
  /** First-click lock gate (`useLockFirstAction`): header modal buttons (Translate / Narration /
   *  Annotations) route their open through this so the first click acquires the retouch lock. */
  runWithLock?: (action: () => void) => void;
  zoomLevel: number;
  onZoomChange: (level: number) => void;
  // === Animation overlay props (all optional — forwarded to CanvasSpreadView) ===
  expandedAnimation?: SpreadAnimation | null;
  expandedAnimationIndex?: number | null;
  allAnimations?: SpreadAnimation[];
  onCameraZoomGeometryChange?: (animationIndex: number, geometry: ZoomAreaGeometry) => void;
  onMotionLineGeometryChange?: (animationIndex: number, geometry: MotionLineGeometry) => void;
  drawZoomAreaMode?: boolean;
  onDrawZoomAreaComplete?: (geometry: ZoomAreaGeometry) => void;
  onDrawZoomAreaCancel?: () => void;
}

export function ObjectsMainView({
  selectedSpreadId,
  selectedItemId,
  onSpreadSelect,
  onSpreadUserSelect,
  onItemSelect,
  spreadEditable,
  onCommitSave,
  runWithLock,
  zoomLevel,
  onZoomChange,
  expandedAnimation,
  expandedAnimationIndex,
  allAnimations,
  onCameraZoomGeometryChange,
  onMotionLineGeometryChange,
  drawZoomAreaMode,
  onDrawZoomAreaComplete,
  onDrawZoomAreaCancel,
}: ObjectsMainViewProps) {
  const retouchSpreads = useRetouchSpreads();
  const actions = useSnapshotActions();
  const langCode = useLanguageCode();
  const canvasWidth = useCanvasWidth();
  const canvasHeight = useCanvasHeight();
  const templateLayout = useBookTemplateLayout();
  const book = useCurrentBook();
  const { updateBook } = useBookActions();

  const [translateModalOpen, setTranslateModalOpen] = useState(false);
  const [narrationSpreadModalOpen, setNarrationSpreadModalOpen] = useState(false);
  const [annotationModalOpen, setAnnotationModalOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState<{
    itemId: string;
    spreadId: string;
    kind: "audio" | "auto_audio";
  } | null>(null);
  const sounds = useSounds();

  const characters = useCharacters();
  const props = useProps();
  // Detect-objects context (07 §Parameters): scene visualDescription + snapshotId. Resolved
  // per-image at the modal mount; absent (non-scene image / no snapshot) → Detect disabled.
  const snapshotId = useSnapshotId();
  const annotationArtStyle = useArtStyleDescription() ?? undefined;

  const selectedSpread = useMemo(
    () => retouchSpreads.find(s => s.id === selectedSpreadId),
    [retouchSpreads, selectedSpreadId]
  );

  // Composite membership lookup: variantId → 1-based composite ordinal.
  // Memoized on the active spread's composites — rebuilds only when group
  // membership changes, not on unrelated item edits.
  const composites = useMemo<SpreadComposite[]>(
    () => selectedSpread?.composites ?? [],
    [selectedSpread?.composites]
  );
  const compositeNumberByVariantId = useMemo(
    () => buildCompositeNumberMap(composites),
    [composites]
  );
  // Phase 6 — runtime z-index override for variants belonging to a composite.
  // Editor map covers ALL variants regardless of edition (editor renders every
  // variant for inspection/editing). Visibility is NOT in this map — Phase 1
  // store cascade already mutates variant.editor_visible directly.
  const editorCompositeCtxMap = useMemo(
    () => buildEditorCompositeContextMap({ composites }),
    [composites]
  );
  const handleSelectComposite = useCallback(
    (variantId: string) => {
      const compositeId = findCompositeIdForVariant(composites, variantId);
      if (!compositeId) {
        log.warn("handleSelectComposite", "no composite for variant", { variantId });
        return;
      }
      log.debug("handleSelectComposite", "select composite", {
        variantId,
        compositeId,
      });
      onItemSelect({ type: "composite", id: compositeId });
    },
    [composites, onItemSelect]
  );

  const originalLanguage = book?.original_language ?? "en_US";

  const enhanceReaders = useMemo(
    () => buildNarrationReaders(book ?? null, characters),
    [book, characters]
  );
  const enhanceReaderToVoice = useMemo(
    () => buildNarrationReaderToVoice(book ?? null, characters, langCode),
    [book, characters, langCode]
  );

  const bookContext = useMemo(
    () => buildBookContext(book, retouchSpreads, selectedSpread),
    [book, retouchSpreads, selectedSpread]
  );

  // Annotation modal rows — filter tagged char/prop images + resolve subjects +
  // effective URL. Single-lang fields → NOT keyed on editorLang.
  const annotationImages = useMemo(
    () => buildAnnotationImages(selectedSpread, characters, props),
    [selectedSpread, characters, props]
  );

  // Language LOCKED = book.original_language (NOT editorLang). Fallback 'en_US'.
  const annotationLanguage = useMemo(() => {
    const lang = book?.original_language;
    if (!lang) {
      log.warn("annotationLanguage", "original_language empty, fallback en_US");
      return "en_US";
    }
    return lang;
  }, [book?.original_language]);

  const handleApplyTranslations = useCallback(
    (payload: ApplyTranslationsPayload) => {
      if (!spreadEditable) {
        log.debug("handleApplyTranslations", "blocked — spread not held", { spreadId: payload.spreadId });
        toastLockRequired();
        return;
      }
      const spread = retouchSpreads.find(s => s.id === payload.spreadId);
      if (!spread) {
        log.warn("handleApplyTranslations", "spread not found", { spreadId: payload.spreadId });
        return;
      }
      log.info("handleApplyTranslations", "start", {
        spreadId: payload.spreadId,
        count: payload.results.length,
        targetLang: payload.targetLang,
      });
      for (const { id, translated_text } of payload.results) {
        const textbox = spread.textboxes.find(tb => tb.id === id);
        if (!textbox) {
          log.debug("handleApplyTranslations", "textbox missing", { id });
          continue;
        }
        const existing = (textbox as Record<string, unknown>)[payload.targetLang] as
          | SpreadTextboxContent
          | undefined;
        let newContent: SpreadTextboxContent;
        if (existing && typeof existing === "object" && "text" in existing) {
          newContent = { ...existing, text: translated_text };
        } else {
          const baseline = (textbox as Record<string, unknown>)[originalLanguage] as
            | SpreadTextboxContent
            | undefined;
          if (!baseline || typeof baseline !== "object" || !("text" in baseline)) {
            log.warn("handleApplyTranslations", "baseline missing, skip", { id });
            continue;
          }
          newContent = {
            text: translated_text,
            geometry: { ...baseline.geometry },
            typography: { ...baseline.typography },
          };
        }
        actions.updateRetouchTextbox(payload.spreadId, id, {
          [payload.targetLang]: newContent,
        } as Partial<SpreadTextbox>);
      }
      log.info("handleApplyTranslations", "done", { spreadId: payload.spreadId });
    },
    [retouchSpreads, actions, originalLanguage, spreadEditable]
  );

  const handleApplyEnhancements = useCallback(
    (payload: ApplyEnhancementsPayload) => {
      if (!spreadEditable) {
        log.debug("handleApplyEnhancements", "blocked — spread not held", { spreadId: payload.spreadId });
        toastLockRequired();
        return;
      }
      log.info("handleApplyEnhancements", "start", {
        spreadId: payload.spreadId,
        lang: payload.language,
        count: payload.results.length,
      });
      const spread = retouchSpreads.find(s => s.id === payload.spreadId);
      if (!spread) {
        log.warn("handleApplyEnhancements", "spread not found", {
          spreadId: payload.spreadId,
        });
        return;
      }
      applySpreadNarrationEnhancements({
        spread,
        payload,
        updateRetouchTextbox: actions.updateRetouchTextbox,
      });
    },
    [retouchSpreads, actions, spreadEditable]
  );

  const handleApplyAnnotations = useCallback(
    (payload: ApplyAnnotationsPayload) => {
      if (!spreadEditable) {
        log.debug("handleApplyAnnotations", "blocked — spread not held", { spreadId: payload.spreadId });
        toastLockRequired();
        return;
      }
      log.info("handleApplyAnnotations", "start", {
        spreadId: payload.spreadId,
        count: payload.results.length,
      });
      const spread = retouchSpreads.find(s => s.id === payload.spreadId);
      if (!spread) {
        log.warn("handleApplyAnnotations", "spread not found", {
          spreadId: payload.spreadId,
        });
        return;
      }
      let applied = 0;
      for (const { imageId, description } of payload.results) {
        const image = spread.images.find(img => img.id === imageId);
        if (!image) {
          log.debug("handleApplyAnnotations", "image missing", { imageId });
          continue;
        }
        const existing = image.annotation?.description ?? "";
        if (existing === description) {
          log.debug("handleApplyAnnotations", "unchanged, skip", { imageId });
          continue; // no-op guard
        }
        actions.updateRetouchImage(payload.spreadId, imageId, {
          annotation: {
            ...(image.annotation ?? {}), // extensible — preserve future fields
            description,
          },
        });
        applied += 1;
      }
      log.info("handleApplyAnnotations", "done", {
        spreadId: payload.spreadId,
        applied,
      });
    },
    [retouchSpreads, actions, spreadEditable]
  );

  // First-click lock gate: the 3 header modals mutate the spread on apply, so their SESSION must be
  // held before the modal opens (baseline captured at acquire). With `runWithLock` the first click
  // acquires the lock and the modal opens on HELD; without it (legacy caller) the buttons stay
  // disabled until the lock is held some other way.
  const openModalWithLock = useCallback(
    (open: () => void) => {
      if (runWithLock) runWithLock(open);
      else open();
    },
    [runWithLock]
  );
  const modalButtonsDisabled =
    !selectedSpreadId || !selectedSpread || (!runWithLock && !spreadEditable);

  const translateLeftAction = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          log.info("translateButton", "click", { spreadId: selectedSpreadId });
          openModalWithLock(() => setTranslateModalOpen(true));
        }}
        disabled={modalButtonsDisabled}
        aria-label="Translate spread"
      >
        <Languages className="h-4 w-4 mr-1.5" />
        Translate
      </Button>
    ),
    [selectedSpreadId, modalButtonsDisabled, openModalWithLock]
  );

  const narrationLeftAction = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          log.info("narrationButton", "click", { spreadId: selectedSpreadId });
          openModalWithLock(() => setNarrationSpreadModalOpen(true));
        }}
        disabled={modalButtonsDisabled}
        aria-label="Enhance narration"
      >
        <Mic className="h-4 w-4 mr-1.5" />
        Narration
      </Button>
    ),
    [selectedSpreadId, modalButtonsDisabled, openModalWithLock]
  );

  const annotationLeftAction = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          log.info("annotationButton", "click", { spreadId: selectedSpreadId });
          openModalWithLock(() => setAnnotationModalOpen(true));
        }}
        disabled={modalButtonsDisabled}
        aria-label="Enhance image annotations"
      >
        <MessageSquare className="h-4 w-4 mr-1.5" />
        Annotations
      </Button>
    ),
    [selectedSpreadId, modalButtonsDisabled, openModalWithLock]
  );

  const combinedLeftActions = useMemo(
    () => (
      <>
        {translateLeftAction}
        {narrationLeftAction}
        {annotationLeftAction}
      </>
    ),
    [translateLeftAction, narrationLeftAction, annotationLeftAction]
  );

  const handleDeselect = useCallback(() => onItemSelect(null), [onItemSelect]);

  const { splitTextbox } = useSplitTextbox(actions, onItemSelect, langCode, canvasWidth, canvasHeight);

  const modals = useObjectModals(selectedSpreadId, actions);
  const { openGenerate, openEdit, openExtract, openLottie, closeLottie, openEditAudio, openSlot, closeSlot, closeParametric } =
    modals;


  // === Phase 04: opt-in saveResource directive (anchor = retouch images node) ===
  // Only the Edit path is wired: a retouch layer edit writes a new image_version at the existing
  // image. Snapshot-scoped (Objects is never remix); undefined snapshot ⇒ omit.
  // RESERVED (comment-only, no directive): Upload (RetouchGenerateImageModal) is snapshot-coupled —
  // its persist is the held-session saveNow + updateRetouchImage; and Extract Background is a
  // CREATE-node against a client-minted id not yet accepted by the BE. Both keep client-persist as
  // the sole path until the store-agnostic generalize task.
  const editSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (!snapshotId || !modals.edit.imageId) return undefined;
    return buildImageVersionSaveResource(
      `col:illustration/spread:${modals.edit.spreadId}/key:images/find:id=${modals.edit.imageId}`,
      snapshotId,
      "edit",
    );
  }, [snapshotId, modals.edit.spreadId, modals.edit.imageId]);

  const handleExtractCreateImages = useCallback(
    (results: ExtractResult[]) => {
      if (!modals.extract.image) return;
      if (!spreadEditable) {
        log.debug("handleExtractCreateImages", "blocked — spread not held", { count: results.length });
        toastLockRequired();
        return;
      }
      // Scene lineage (L2/L3): source is a playable images[] entry → inherit ONLY, via the shared
      // helper (its JSDoc + unit test pin why `?? source.id` is forbidden here).
      buildExtractImages(results, modals.extract.image, modals.extract.spreadId, retouchSpreads, actions, {
        originalImageId: sceneLineageOfPlayableSource(modals.extract.image),
      });
    },
    [modals.extract.image, modals.extract.spreadId, retouchSpreads, actions, spreadEditable]
  );

  // Extract-Lottie → spawn a static auto_pic (static_image = original; media_url ABSENT — the
  // finished .lottie is uploaded later via the auto-pic toolbar). Mutates the held spread node →
  // dirty → persisted by the existing objects held-session save.
  const handleCreateAutoPicFromLottie = useCallback(
    (payload: NewAutoPicFromLottie): boolean => {
      const sourceImage = modals.lottie.image;
      if (!sourceImage) return false;
      if (!spreadEditable) {
        log.debug("handleCreateAutoPicFromLottie", "blocked — spread not held", {
          sourceId: payload.sourceImageId,
        });
        toastLockRequired();
        return false;
      }
      const spread = retouchSpreads.find((s) => s.id === modals.lottie.spreadId);
      if (!spread) return false;
      const autoPic: SpreadAutoPic = {
        id: crypto.randomUUID(),
        title: payload.suggestedTitle,
        geometry: { ...sourceImage.geometry },
        "z-index": nextTopZInTier(spread, "pictorial"),
        player_visible: true,
        editor_visible: true,
        // Scene lineage (L2): inherit ONLY — `?? sourceImage.id` is FORBIDDEN (flat root ref).
        ...(sourceImage.original_image_id !== undefined
          ? { original_image_id: sourceImage.original_image_id }
          : {}),
        tags: sourceImage.tags ?? [],
        static_image: {
          illustrations: [
            {
              media_url: payload.staticImageUrl,
              is_selected: true,
              type: "uploaded",
              created_time: new Date().toISOString(),
            },
          ],
        },
      };
      actions.addRetouchAutoPic(modals.lottie.spreadId, autoPic);
      log.info("handleCreateAutoPicFromLottie", "auto_pic spawned", {
        autoPicId: autoPic.id,
        spreadId: modals.lottie.spreadId,
      });
      return true;
    },
    [modals.lottie.image, modals.lottie.spreadId, retouchSpreads, actions, spreadEditable]
  );

  // ── Crop presets (books.crop_presets[]) — controlled persistence via updateBook ──
  const handleUpsertCropPreset = useCallback(
    (preset: CropPreset) => {
      if (!book) return;
      void updateBook(book.id, { crop_presets: upsertCropPreset(book.crop_presets ?? [], preset) });
    },
    [book, updateBook]
  );
  const handleDeleteCropPreset = useCallback(
    (presetId: string) => {
      if (!book) return;
      void updateBook(book.id, { crop_presets: deleteCropPreset(book.crop_presets ?? [], presetId) });
    },
    [book, updateBook]
  );

  // Background tab remove-targets: every OTHER image in the source's spread (effective URL,
  // source excluded). API ignores objects it can't match, so seeding all is safe (no tag filter).
  const backgroundRemoveCandidates = useMemo<BackgroundRemoveCandidate[]>(() => {
    const sourceId = modals.extract.image?.id;
    const spread = retouchSpreads.find((s) => s.id === modals.extract.spreadId);
    if (!spread || !sourceId) return [];
    const out: BackgroundRemoveCandidate[] = [];
    for (const img of spread.images) {
      if (img.id === sourceId) continue;
      const media_url = resolveEffectiveImageUrl(img); // skip images with no resolvable URL
      if (!media_url) continue;
      const tagType = img.tags?.[0]?.type;
      out.push({
        id: img.id,
        media_url,
        title: img.title,
        type: tagType === "character" || tagType === "prop" ? tagType : undefined,
      });
    }
    return out;
  }, [retouchSpreads, modals.extract.spreadId, modals.extract.image?.id]);

  const { handleDeleteSpread, handleSpreadReorder } = useSpreadHandlers(actions);
  const { handleSpreadItemAction } = useSpreadItemDispatch(actions, retouchSpreads);

  // Lock-on-click gate (ADR-044): every canvas item add/update/delete flows through
  // onUpdateSpreadItem → handleSpreadItemAction; block it when this editor does not hold the spread's
  // retouch lock (else the mutation dirties the node but the held session never saves it). This is
  // the single choke point covering drag/resize/rotate, inline text/art-note edits, and deletes.
  const gatedSpreadItemAction = useCallback(
    (params: Parameters<typeof handleSpreadItemAction>[0]) => {
      if (!spreadEditable) {
        log.debug("gatedSpreadItemAction", "blocked — spread not held", {
          itemType: params.itemType,
          action: params.action,
        });
        toastLockRequired();
        return;
      }
      handleSpreadItemAction(params);
    },
    [spreadEditable, handleSpreadItemAction],
  );

  // Slot init write. The patch always carries BOTH slot keys with exactly one of them `undefined`
  // (mutual exclusion). `updateRetouchImage` applies it with `Object.assign` on the immer draft, so
  // the `undefined` key IS materialized on the in-store item — it is neither dropped nor deleted.
  // The save path's `JSON.stringify` then omits it, so the server blob stays clean. CONSEQUENCE:
  // every slot existence check MUST be truthy (`!!item.casting_slot`) — never `'casting_slot' in
  // item` nor `Object.keys(item).includes(...)`, which would report a slot that does not exist.
  // Single writer: gate → useSpreadItemDispatch → updateRetouchImage. Persist is the held-session
  // release/saveNow (ADR-044, rtype 10) — deliberately NO saveResource/autoSaveSnapshot here, and
  // deliberately NO commitOnModalClose either (unlike Translate/Narration/Annotation): a slot write
  // is a plain canvas mutation like drag/resize, so it rides the normal release/saveNow flush.
  const handleSlotSubmit = useCallback(
    (patch: SlotPatch) => {
      const image = modals.slot.image;
      const spreadId = modals.slot.spreadId;
      if (!image || !spreadId) {
        log.warn("handleSlotSubmit", "missing slot modal state, skip", { hasImage: !!image, spreadId });
        return;
      }
      // `spreadEditable` (checked by the gate) describes the SELECTED spread, while this write
      // targets the spread captured at open time. If selection moved and the lock was re-acquired
      // elsewhere, the gate would pass but the captured spread's held session is already over ⇒ the
      // mutation would dirty the store and never persist. Bail rather than lose the write silently.
      if (spreadId !== selectedSpreadId) {
        log.warn("handleSlotSubmit", "spread selection changed since open, skip", { spreadId, selectedSpreadId });
        // Closing without a toast would read as "it worked" — the modal just vanishes and nothing
        // is written. Tell the user WHY the init was dropped (never hide a silent no-op).
        toastSpreadSelectionMoved();
        closeSlot();
        return;
      }
      log.info("handleSlotSubmit", "write slot patch", {
        itemId: image.id,
        spreadId,
        slotType: patch.casting_slot ? "casting" : "parametric",
      });
      gatedSpreadItemAction({ spreadId, itemType: "image", action: "update", itemId: image.id, data: patch });
      closeSlot();
    },
    // Depend on the primitives, not `modals.slot` — the hook rebuilds that object literal every
    // render, so an object dep would defeat the memo (same reason the extract handler above
    // destructures `modals.extract.image` / `.spreadId`).
    [modals.slot.image, modals.slot.spreadId, selectedSpreadId, gatedSpreadItemAction, closeSlot]
  );

  // === EditParametricSlotModal wiring (edit-parametric-slot-modal/README §4.4) ===
  // The item is re-resolved from the store on EVERY render (the hook only keeps its id): this
  // modal WRITES `values[]`, so a captured snapshot would freeze the version grid after the
  // first generate. Vanishes (→ modal unmounts) when the item is deleted by a peer.
  const parametricImageId = modals.parametric.imageId;
  const parametricSpreadId = modals.parametric.spreadId;
  const parametricItem = useMemo<SpreadImage | null>(() => {
    if (!parametricImageId || !parametricSpreadId) return null;
    const spread = retouchSpreads.find(s => s.id === parametricSpreadId);
    return (spread?.images as SpreadImage[] | undefined)?.find(i => i.id === parametricImageId) ?? null;
  }, [retouchSpreads, parametricSpreadId, parametricImageId]);

  // Writes are only legal while THIS editor holds the lock of the spread captured at open time.
  // Selection drift ⇒ read-only (mirrors handleSlotSubmit's guard, but non-destructive: the user
  // keeps browsing values/zoom — chốt validation S1-Q3, never hide, just disable).
  const parametricCanEdit = spreadEditable && parametricSpreadId === selectedSpreadId;

  const handleParametricUpdate = useCallback(
    (next: ItemParametricSlot) => {
      if (!parametricImageId || !parametricSpreadId) return;
      // The slot is gone (removed here, or by a peer) but a generate/upload started earlier is
      // still resolving: writing `next` would REBUILD the slot from a stale closure and undo the
      // removal. The modal unmounts in that case without bumping runIdRef, so this is the guard.
      if (!parametricItem?.parametric_slot) {
        log.warn("handleParametricUpdate", "item no longer carries a parametric_slot, skip", {
          itemId: parametricImageId,
          spreadId: parametricSpreadId,
        });
        return;
      }
      if (parametricSpreadId !== selectedSpreadId) {
        log.warn("handleParametricUpdate", "spread selection changed since open, skip", {
          spreadId: parametricSpreadId,
          selectedSpreadId,
        });
        toastSpreadSelectionMoved();
        closeParametric();
        return;
      }
      gatedSpreadItemAction({
        spreadId: parametricSpreadId,
        itemType: "image",
        action: "update",
        itemId: parametricImageId,
        data: { parametric_slot: next },
      });
    },
    [
      parametricImageId,
      parametricSpreadId,
      parametricItem,
      selectedSpreadId,
      gatedSpreadItemAction,
      closeParametric,
    ],
  );

  // Mutual exclusion, same contract as the init patch: BOTH slot keys travel, one of them
  // `undefined` (see handleSlotSubmit's note on truthy existence checks).
  const handleParametricRemove = useCallback(() => {
    if (!parametricImageId || !parametricSpreadId) return;
    log.info("handleParametricRemove", "remove slot from item", {
      itemId: parametricImageId,
      spreadId: parametricSpreadId,
    });
    gatedSpreadItemAction({
      spreadId: parametricSpreadId,
      itemType: "image",
      action: "update",
      itemId: parametricImageId,
      data: { parametric_slot: undefined, casting_slot: undefined },
    });
    closeParametric();
  }, [parametricImageId, parametricSpreadId, gatedSpreadItemAction, closeParametric]);

  /** Flush the held retouch sub-tree NOW and REJECT when it did not land. The modal awaits this
   *  before a generate POST so the BE `saveResource` anchor (`find:value=…`) already exists; a
   *  rejection aborts the run, so a failed persist never burns an AI call (README §4.4). This is
   *  the one deliberate exception to "slot writes ride the normal release/saveNow flush". */
  const handleParametricCommitSave = useCallback((): Promise<SaveOutcome> => {
    // Tri-state persist of the held retouch spread (unified-item-save-spec §4.2). `ensureSaved`
    // reuses the held retouch session (save-while-held + rebase — no extra lock churn) and reports
    // saved|clean|blocked|failed, so the modal can distinguish a peer lock from a transient failure
    // (the old boolean `onCommitSave` conflated them). Reachable only with a selected spread.
    return useSaveSessionStore.getState().ensureSaved("retouch-spread", selectedSpreadId);
  }, [selectedSpreadId]);

  // Thin wrapper — the path grammar itself lives in `parametric-slot-utils` (pure + unit-tested;
  // it is COLUMN-RELATIVE by contract and percent-encodes the value). Only reachable while the
  // modal is open, i.e. with a non-null image id.
  const buildParametricSaveResourcePath = useCallback(
    (value: string) =>
      buildParametricValueSaveResourcePath(parametricSpreadId, parametricImageId ?? "", value),
    [parametricSpreadId, parametricImageId],
  );

  const parametricAttribution = useMemo(
    () => ({ snapshotId: snapshotId || undefined }),
    [snapshotId],
  );

  const { stackRef } = useInteractionLayerContext();
  const { handleDuplicateItem } = useDuplicateItem(retouchSpreads, selectedSpreadId, actions, onItemSelect);
  // Gate duplicate (covers BOTH the toolbar Clone action AND the Ctrl/Cmd+D hotkey — the hotkey
  // bypasses toolbar-visibility gating, so it must be blocked here when the spread is not held).
  const gatedDuplicateItem = useCallback(
    (itemType: Parameters<typeof handleDuplicateItem>[0], itemId: string) => {
      if (!spreadEditable) {
        log.debug("gatedDuplicateItem", "blocked — spread not held", { itemType, itemId });
        toastLockRequired();
        return;
      }
      handleDuplicateItem(itemType, itemId);
    },
    [spreadEditable, handleDuplicateItem],
  );
  useDuplicateHotkey(stackRef, selectedItemId, gatedDuplicateItem);

  // === Render props for 6 item types ===

  const renderRetouchImage = useCallback(
    (context: ImageItemContext<BaseSpread>) => {
      const img = context.item as SpreadImage;
      if (img.editor_visible === false) return null;
      const compositeNumber = compositeNumberByVariantId.get(img.id);
      // Phase 6 — apply composite z-index override when variant belongs to a
      // composite; standalone items keep their own z-index (context.zIndex).
      const effectiveZ = resolveEffectiveZIndex(
        { id: img.id, 'z-index': context.zIndex },
        editorCompositeCtxMap
      );
      return (
        <>
          <EditableImage
            image={context.item}
            index={context.itemIndex}
            zIndex={effectiveZ}
            isSelected={context.isSelected}
            isEditable={context.isSpreadSelected}
            showItemBorder={true}
            isHoveredByCanvas={context.isHoveredByCanvas}
            dimmedByOverlap={context.dimmedByOverlap}
            onSelect={() => {
              context.onSelect();
              onItemSelect({ type: "image", id: context.item.id });
            }}
            onArtNoteChange={(artNote) =>
              context.onUpdate({ art_note: artNote })
            }
            onEditingChange={context.onEditingChange}
          />
          {img.player_visible === false && (
            <PlayerHiddenBadge
              geometry={img.geometry}
              zIndex={effectiveZ}
            />
          )}
          {compositeNumber !== undefined && (
            <CompositeMemberBadge
              compositeNumber={compositeNumber}
              geometry={img.geometry}
              zIndex={effectiveZ}
              onClick={() => handleSelectComposite(img.id)}
            />
          )}
        </>
      );
    },
    [onItemSelect, compositeNumberByVariantId, handleSelectComposite, editorCompositeCtxMap]
  );

  const renderRetouchTextbox = useCallback(
    (context: TextItemContext<BaseSpread>) => {
      const tb = context.item as SpreadTextbox;
      if (tb.editor_visible === false) return null;
      const result = getTextboxContentForLanguage(tb, langCode);
      if (!result) return null;
      const { langKey, content } = result;

      return (
        <>
          <EditableTextbox
            textboxContent={content}
            index={context.itemIndex}
            zIndex={context.zIndex}
            isSelected={context.isSelected}
            isSelectable={context.isSpreadSelected}
            isEditable={context.isSpreadSelected}
            isEditing={context.isEditing}
            showItemBorder={true}
            isHoveredByCanvas={context.isHoveredByCanvas}
            dimmedByOverlap={context.dimmedByOverlap}
            itemId={context.item.id}
            onSelect={() => {
              context.onSelect();
              onItemSelect({ type: "textbox", id: context.item.id });
            }}
            onTextChange={(newText) => {
              // Atomic single onUpdate per spec §4.3: when media exists, flip
              // is_sync=false in the SAME call as the text change. Two
              // separate updates would hit a stale-closure overwrite.
              // DB-CHANGELOG 2026-04-29: rollup `script_synced` → `is_sync`.
              const audio = content.audio;
              const nextContent: SpreadTextboxContent =
                audio?.combined_audio_url
                  ? {
                      ...content,
                      text: newText,
                      audio: { ...audio, is_sync: false },
                    }
                  : { ...content, text: newText };
              context.onUpdate({
                [langKey]: nextContent,
              } as unknown as Partial<SpreadTextbox>);
            }}
            onEditingChange={context.onEditingChange ?? (() => {})}
          />
          {tb.player_visible === false && (
            <PlayerHiddenBadge
              geometry={content.geometry}
              zIndex={context.zIndex}
            />
          )}
        </>
      );
    },
    [onItemSelect, langCode]
  );

  const renderRetouchShape = useCallback(
    (context: ShapeItemContext<BaseSpread>) => {
      const shape = context.item as SpreadShape;
      if (shape.editor_visible === false) return null;
      return (
        <>
          <EditableShape
            shape={context.item}
            index={context.itemIndex}
            zIndex={context.zIndex}
            isSelected={context.isSelected}
            isEditable={context.isSpreadSelected}
            isHoveredByCanvas={context.isHoveredByCanvas}
            dimmedByOverlap={context.dimmedByOverlap}
            onSelect={() => {
              context.onSelect();
              onItemSelect({ type: "shape", id: context.item.id });
            }}
          />
          {shape.player_visible === false && (
            <PlayerHiddenBadge
              geometry={shape.geometry}
              zIndex={context.zIndex}
            />
          )}
        </>
      );
    },
    [onItemSelect]
  );

  const renderRetouchVideo = useCallback(
    (context: VideoItemContext<BaseSpread>) => {
      const video = context.item as SpreadVideo;
      if (video.editor_visible === false) return null;
      return (
        <>
          <EditableVideo
            video={context.item}
            index={context.itemIndex}
            zIndex={context.zIndex}
            isSelected={context.isSelected}
            isEditable={context.isSpreadSelected}
            isThumbnail={context.isThumbnail}
            showItemBorder={true}
            isHoveredByCanvas={context.isHoveredByCanvas}
            dimmedByOverlap={context.dimmedByOverlap}
            onSelect={() => {
              context.onSelect();
              onItemSelect({ type: "video", id: context.item.id });
            }}
          />
          {video.player_visible === false && (
            <PlayerHiddenBadge
              geometry={video.geometry}
              zIndex={context.zIndex}
            />
          )}
        </>
      );
    },
    [onItemSelect]
  );

  const renderRetouchAudio = useCallback(
    (context: AudioItemContext<BaseSpread>) => {
      const audio = context.item as SpreadAudio;
      if (audio.editor_visible === false) return null;
      return (
        <>
          <EditableAudio
            audio={context.item}
            index={context.itemIndex}
            zIndex={context.zIndex}
            isSelected={context.isSelected}
            isEditable={context.isSpreadSelected}
            onSelect={() => {
              context.onSelect();
              onItemSelect({ type: "audio", id: context.item.id });
            }}
          />
          {audio.player_visible === false && (
            <PlayerHiddenBadge
              geometry={audio.geometry}
              zIndex={context.zIndex}
              isIcon
            />
          )}
        </>
      );
    },
    [onItemSelect]
  );

  const renderRetouchAutoAudio = useCallback(
    (context: AutoAudioItemContext<BaseSpread>) => {
      const aa = context.item as SpreadAutoAudio;
      if (aa.editor_visible === false) return null;
      // No PlayerHiddenBadge: player_visible locked false is design intent for auto_audio (BGM),
      // not a divergence to hint at.
      // In editor (Objects creative space), never trigger the player <audio
      // autoPlay> branch — toolbar preview is the sound check. Force
      // isEditable=true so all spreads (selected + thumbnails) render icon-only.
      return (
        <EditableAutoAudio
          autoAudio={aa}
          index={context.itemIndex}
          zIndex={context.zIndex}
          isSelected={context.isSelected}
          isEditable={true}
          isThumbnail={context.isThumbnail}
          onSelect={() => {
            context.onSelect();
            onItemSelect({ type: "auto_audio", id: aa.id });
          }}
        />
      );
    },
    [onItemSelect]
  );

  const renderRetouchAutoPic = useCallback(
    (context: AutoPicItemContext<BaseSpread>) => {
      const ap = context.item as SpreadAutoPic;
      if (ap.editor_visible === false) return null;
      const compositeNumber = compositeNumberByVariantId.get(ap.id);
      // Phase 6 — composite z-index override for auto_pic variants.
      const effectiveZ = resolveEffectiveZIndex(
        { id: ap.id, 'z-index': context.zIndex },
        editorCompositeCtxMap
      );
      return (
        <>
          <EditableAutoPic
            autoPic={context.item}
            index={context.itemIndex}
            zIndex={effectiveZ}
            isSelected={context.isSelected}
            isEditable={context.isSpreadSelected}
            isThumbnail={context.isThumbnail}
            showItemBorder={true}
            isHoveredByCanvas={context.isHoveredByCanvas}
            dimmedByOverlap={context.dimmedByOverlap}
            onSelect={() => {
              context.onSelect();
              onItemSelect({ type: 'auto_pic', id: context.item.id });
            }}
          />
          {ap.player_visible === false && (
            <PlayerHiddenBadge
              geometry={ap.geometry}
              zIndex={effectiveZ}
            />
          )}
          {compositeNumber !== undefined && (
            <CompositeMemberBadge
              compositeNumber={compositeNumber}
              geometry={ap.geometry}
              zIndex={effectiveZ}
              onClick={() => handleSelectComposite(ap.id)}
            />
          )}
        </>
      );
    },
    [onItemSelect, compositeNumberByVariantId, handleSelectComposite, editorCompositeCtxMap]
  );

  // === Raw item render props (illustration layer — read-only on canvas) ===

  const renderRawImage = useCallback(
    (context: ImageItemContext<BaseSpread>) => {
      const img = context.item as SpreadImage;
      if (img.editor_visible === false) return null;
      return (
        <EditableImage
          image={context.item}
          index={context.itemIndex}
          zIndex={context.zIndex}
          isSelected={context.isSelected}
          isSelectable={true}
          isEditable={false}
          dimmed={true}
          onSelect={() => {
            context.onSelect();
            onItemSelect({ type: "raw_image", id: context.item.id });
          }}
        />
      );
    },
    [onItemSelect]
  );

  const renderRawTextbox = useCallback(
    (context: TextItemContext<BaseSpread>) => {
      const tb = context.item as SpreadTextbox;
      if (tb.editor_visible === false) return null;
      const result = getTextboxContentForLanguage(tb, langCode);
      if (!result) return null;
      const { content } = result;
      return (
        <EditableTextbox
          textboxContent={content}
          index={context.itemIndex}
          zIndex={context.zIndex}
          isSelected={context.isSelected}
          isSelectable={context.isSpreadSelected}
          isEditable={false}
          dimmed={true}
          onSelect={() => {
            context.onSelect();
            onItemSelect({ type: "raw_textbox", id: context.item.id });
          }}
          onTextChange={() => {}}
          onEditingChange={() => {}}
        />
      );
    },
    [onItemSelect, langCode]
  );

  // === Toolbar render props ===

  const renderRetouchImageToolbar = useCallback(
    (context: ImageToolbarContext<BaseSpread>) => (
      <ObjectsImageToolbar
        context={{
          ...context,
          onGenerateImage: () => openGenerate(context.item),
          onEditImage: () => openEdit(context.item),
          onExtractImage: () => openExtract(context.item),
          onExtractLottie: () => openLottie(context.item),
          onClone: () => gatedDuplicateItem("image", context.item.id),
          // openSlot routes: no slot ⇒ init modal; already-slotted ⇒ "Coming soon" toast.
          onConfigureSlot: () => openSlot(context.item),
        }}
      />
    ),
    [openGenerate, openEdit, openExtract, openLottie, gatedDuplicateItem, openSlot]
  );

  const { cloneRawImage, cloneRawTextbox } = useCloneRaw(retouchSpreads, selectedSpreadId, actions);

  const renderRawImageToolbar = useCallback(
    (context: ImageToolbarContext<BaseSpread>) => (
      <ObjectsRawImageToolbar
        context={{
          ...context,
          onClone: () => cloneRawImage(context.item as SpreadImage),
        }}
      />
    ),
    [cloneRawImage]
  );

  // NOTE (phase 3): the local `commitOnModalClose` wrapper was removed — `onCommitSave` IS now the
  // engine's stable `commitOnModalClose` (fire-and-forget saveNow that self-guards on clean/not-held),
  // so the spread-level modals below call `onCommitSave?.()` directly on close.

  const renderRetouchTextToolbar = useCallback(
    (context: TextToolbarContext<BaseSpread>) => (
      <ObjectsTextToolbar
        context={{
          ...context,
          onSplitTextbox: () =>
            splitTextbox(selectedSpreadId, context.item, { deleteSource: true, inheritVisibility: true }),
        }}
        onCommitSave={onCommitSave}
      />
    ),
    [selectedSpreadId, splitTextbox, onCommitSave]
  );


  const renderRawTextboxToolbar = useCallback(
    (context: TextToolbarContext<BaseSpread>) => (
      <ObjectsRawTextboxToolbar
        context={{
          ...context,
          onSplitTextbox: () =>
            splitTextbox(selectedSpreadId, context.item, { deleteSource: false, inheritVisibility: false }),
          onClone: () => cloneRawTextbox(context.item),
        }}
      />
    ),
    [selectedSpreadId, splitTextbox, cloneRawTextbox]
  );

  // === Shape toolbar render prop ===
  const renderRetouchShapeToolbar = useCallback(
    (context: ShapeToolbarContext<BaseSpread>) => (
      <ObjectsShapeToolbar context={context} />
    ),
    []
  );

  // === Video toolbar render prop ===
  const renderRetouchVideoToolbar = useCallback(
    (context: VideoToolbarContext<BaseSpread>) => (
      <ObjectsVideoToolbar context={context} />
    ),
    []
  );

  // === AutoPic toolbar render prop ===
  const renderRetouchAutoPicToolbar = useCallback(
    (context: AutoPicToolbarContext<BaseSpread>) => (
      <ObjectsAutoPicToolbar context={context} />
    ),
    []
  );

  // === Audio toolbar render prop ===
  const renderRetouchAudioToolbar = useCallback(
    (context: AudioToolbarContext<BaseSpread>) => (
      <ObjectsAudioToolbar
        variant="audio"
        context={{
          ...context,
          onBrowseSound: () => {
            log.info("renderRetouchAudioToolbar", "open library", {
              itemId: context.item.id,
              kind: "audio",
            });
            setBrowseOpen({
              itemId: context.item.id,
              spreadId: selectedSpreadId,
              kind: "audio",
            });
          },
          onEditAudio: () =>
            openEditAudio(context.item as SpreadAudio, "audio"),
        }}
      />
    ),
    [openEditAudio, selectedSpreadId]
  );

  // === Auto-audio toolbar render prop (variant of ObjectsAudioToolbar) ===
  const renderRetouchAutoAudioToolbar = useCallback(
    (context: AutoAudioToolbarContext<BaseSpread>) => (
      <ObjectsAudioToolbar
        variant="auto_audio"
        context={{
          ...context,
          onBrowseSound: () => {
            log.info("renderRetouchAutoAudioToolbar", "open library", {
              itemId: context.item.id,
              kind: "auto_audio",
            });
            setBrowseOpen({
              itemId: context.item.id,
              spreadId: selectedSpreadId,
              kind: "auto_audio",
            });
          },
          onEditAudio: () =>
            openEditAudio(context.item as SpreadAutoAudio, "auto_audio"),
        }}
      />
    ),
    [openEditAudio, selectedSpreadId]
  );

  return (
    <>
      <CanvasSpreadView
        spreads={retouchSpreads}
        selectedSpreadId={selectedSpreadId}
        viewMode="edit"
        zoomLevel={zoomLevel}
        columnsPerRow={COLUMNS.DEFAULT}
        peerLock={RETOUCH_PEER_LOCK}
        onViewModeChange={() => {}}
        onZoomChange={onZoomChange}
        onColumnsChange={() => {}}
        renderItems={[
          "raw_image",
          "raw_textbox",
          "image",
          "textbox",
          "shape",
          "video",
          "auto_pic",
          "audio",
          "auto_audio",
        ]}
        renderImageItem={renderRetouchImage}
        renderTextItem={renderRetouchTextbox}
        renderShapeItem={renderRetouchShape}
        renderVideoItem={renderRetouchVideo}
        renderAutoPicItem={renderRetouchAutoPic}
        renderAudioItem={renderRetouchAudio}
        renderAutoAudioItem={renderRetouchAutoAudio}
        renderRawImage={renderRawImage}
        renderRawTextbox={renderRawTextbox}
        renderImageToolbar={renderRetouchImageToolbar}
        renderTextToolbar={renderRetouchTextToolbar}
        renderShapeToolbar={renderRetouchShapeToolbar}
        renderVideoToolbar={renderRetouchVideoToolbar}
        renderAutoPicToolbar={renderRetouchAutoPicToolbar}
        renderAudioToolbar={renderRetouchAudioToolbar}
        renderAutoAudioToolbar={renderRetouchAutoAudioToolbar}
        renderRawImageToolbar={renderRawImageToolbar}
        renderRawTextboxToolbar={renderRawTextboxToolbar}
        onSpreadSelect={onSpreadSelect}
        onSpreadUserSelect={onSpreadUserSelect}
        onSpreadReorder={handleSpreadReorder}
        onDeleteSpread={handleDeleteSpread}
        onUpdateSpreadItem={gatedSpreadItemAction}
        isEditable={spreadEditable}
        preventEditRawItem={true}
        canAddSpread={false}
        canReorderSpread={false}
        canDeleteSpread={false}
        showViewToggle={false}
        leftActions={combinedLeftActions}
        canResizeItem={true}
        canDragItem={true}
        canRotateItem={true}
        externalSelectedItemId={selectedItemId}
        onDeselect={handleDeselect}
        onCanvasItemSelect={(sel) => {
          // ADR-029 bug-fix: smart hit-test bypasses per-item render-prop wrapper,
          // so we mirror the (type, id) up to ObjectsCreativeSpace for sidebar +
          // animation list sync. Quiz won't fire here (not in Objects renderItems),
          // but cast guard rejects it defensively.
          const t = sel.type as ObjectElementType;
          if (t === "image" || t === "textbox" || t === "shape" || t === "video"
              || t === "auto_pic" || t === "audio" || t === "auto_audio") {
            onItemSelect({ type: t, id: sel.id });
          }
        }}
        pageNumbering={templateLayout?.page_numbering}
        expandedAnimation={expandedAnimation}
        expandedAnimationIndex={expandedAnimationIndex}
        allAnimations={allAnimations}
        onCameraZoomGeometryChange={onCameraZoomGeometryChange}
        onMotionLineGeometryChange={onMotionLineGeometryChange}
        drawZoomAreaMode={drawZoomAreaMode}
        onDrawZoomAreaComplete={onDrawZoomAreaComplete}
        onDrawZoomAreaCancel={onDrawZoomAreaCancel}
        smartHitTestEnabled={true}
      />

      {modals.generate.imageId && (
        // Phase 04 RESERVED: NO saveResource — object Upload is snapshot-coupled (persist =
        // held-session saveNow + updateRetouchImage). Deferred to the store-agnostic generalize task.
        <RetouchGenerateImageModal
          open={modals.generate.open}
          onOpenChange={modals.closeGenerate}
          spreadId={modals.generate.spreadId}
          imageId={modals.generate.imageId}
          onCommitSave={onCommitSave}
        />
      )}

      {modals.edit.imageId && (
        <RetouchEditImageModal
          open={modals.edit.open}
          onOpenChange={modals.closeEdit}
          spreadId={modals.edit.spreadId}
          imageId={modals.edit.imageId}
          enabledTools={SPACE_TOOL_MATRIX.object.edit}
          onCommitSave={onCommitSave}
          saveResource={editSaveResource}
        />
      )}

      {modals.slot.image && (
        <ItemSlotModal
          open={modals.slot.open}
          item={modals.slot.image}
          book={book}
          characters={characters}
          props={props}
          isSpreadEditable={spreadEditable}
          onSubmit={handleSlotSubmit}
          onClose={() => {
            closeSlot();
            // Commit-on-close (spec §4.2 — uniform for every spread-level modal). A slot write
            // dirties the held retouch node like any canvas mutation; this fire-and-forget saveNow
            // persists it now (no-op when clean / not held), the release/auto-save is the net.
            onCommitSave?.();
          }}
        />
      )}

      {/* `key={item.id}` remounts the shell when the parent swaps items, so its internal state
          (selected value / zoom / busy / runId) can never leak across items — the shell's own
          reset only runs on ITS close path. `parametric_slot` is re-checked because a peer edit
          can remove the slot while the modal is open. */}
      {parametricItem?.parametric_slot && (
        <EditParametricSlotModal
          key={parametricItem.id}
          open={modals.parametric.open}
          onOpenChange={(next) => {
            if (!next) closeParametric();
          }}
          item={parametricItem}
          slot={parametricItem.parametric_slot}
          book={book}
          characters={characters}
          onUpdateSlot={handleParametricUpdate}
          onRemoveSlot={handleParametricRemove}
          canEdit={parametricCanEdit}
          onCommitSave={handleParametricCommitSave}
          pathPrefix={`parametric/${parametricItem.id}`}
          buildSaveResourcePath={buildParametricSaveResourcePath}
          attribution={parametricAttribution}
        />
      )}

      {modals.extract.image && (
        // Phase 04 RESERVED: NO saveResource — the Extract Background op is a CREATE-node against a
        // client-minted image id (`col:illustration/spread/key:images/find:id=<newImageId>`), which
        // the BE nested-create does not yet accept for retouch layers. Client-spawn (onCreateImages
        // → buildExtractImages) stays the persist path until that create-node contract lands.
        // NO onCommitSave (phase 3, user-confirmed): Extract SPAWNS a new illustration version via
        // onCreateImages — it does not mutate the held spread node, so there is no dirty to commit
        // on close (a commitOnModalClose here would be a pure no-op). Kept non-committing on purpose.
        <ExtractImageModal
          open={modals.extract.open}
          onOpenChange={modals.closeExtract}
          image={modals.extract.image}
          initialTab={modals.extract.initialTab}
          enabledTabs={SPACE_TOOL_MATRIX.object.extract}
          onCreateImages={handleExtractCreateImages}
          snapshotId={snapshotId || undefined}
          detectContext={
            modals.extract.image.visual_description?.trim() && snapshotId
              ? {
                  visualDescription: modals.extract.image.visual_description.trim(),
                  snapshotId,
                }
              : undefined
          }
          backgroundRemoveCandidates={backgroundRemoveCandidates}
          cropPresets={book?.crop_presets ?? undefined}
          onUpsertCropPreset={handleUpsertCropPreset}
          onDeleteCropPreset={handleDeleteCropPreset}
        />
      )}

      {modals.lottie.image && (
        <ExtractLottieModal
          open={modals.lottie.open}
          image={modals.lottie.image}
          spreadId={modals.lottie.spreadId}
          attribution={{ snapshotId: snapshotId || undefined }}
          onClose={closeLottie}
          onCreateAutoPic={handleCreateAutoPicFromLottie}
        />
      )}

      {selectedSpread && (
        <TranslateSpreadModal
          isOpen={translateModalOpen}
          onClose={() => {
            setTranslateModalOpen(false);
            onCommitSave?.();
          }}
          spreadId={selectedSpreadId}
          textboxes={selectedSpread.textboxes ?? []}
          originalLang={originalLanguage}
          editorLang={langCode}
          context={bookContext}
          snapshotId={snapshotId || undefined}
          onApplyTranslations={handleApplyTranslations}
        />
      )}

      {selectedSpread && (
        <EnhanceSpreadNarrationModal
          isOpen={narrationSpreadModalOpen}
          onClose={() => {
            setNarrationSpreadModalOpen(false);
            onCommitSave?.();
          }}
          spreadId={selectedSpreadId}
          textboxes={selectedSpread.textboxes ?? []}
          editorLang={langCode}
          readers={enhanceReaders}
          readerToVoice={enhanceReaderToVoice}
          context={bookContext}
          snapshotId={snapshotId || undefined}
          onApplyEnhancements={handleApplyEnhancements}
        />
      )}

      {selectedSpread && (
        <EnhanceImageAnnotationModal
          isOpen={annotationModalOpen}
          onClose={() => {
            setAnnotationModalOpen(false);
            onCommitSave?.();
          }}
          spreadId={selectedSpreadId}
          images={annotationImages}
          language={annotationLanguage}
          artStyle={annotationArtStyle}
          snapshotId={snapshotId || undefined}
          onApplyAnnotations={handleApplyAnnotations}
        />
      )}

      {modals.editAudio.item?.media_url && (
        <EditAudioModal
          isOpen={modals.editAudio.open}
          onClose={modals.closeEditAudio}
          audioName={modals.editAudio.item.title ?? "Audio"}
          mediaUrl={modals.editAudio.item.media_url}
          description={modals.editAudio.item.description ?? ""}
          onSave={(result) => {
            if (!spreadEditable) {
              log.debug("editAudioSave", "blocked — spread not held", {});
              toastLockRequired();
              modals.closeEditAudio();
              return;
            }
            modals.handleEditAudioComplete(result);
          }}
        />
      )}

      {browseOpen && (
        <SoundLibraryModal
          isOpen
          onClose={() => setBrowseOpen(null)}
          initialSoundId={(() => {
            const spread = retouchSpreads.find(
              s => s.id === browseOpen.spreadId
            );
            if (!spread) return null;
            const item =
              browseOpen.kind === "audio"
                ? spread.audios?.find(a => a.id === browseOpen.itemId)
                : spread.auto_audios?.find(a => a.id === browseOpen.itemId);
            const url = item?.media_url;
            if (!url) return null;
            return sounds.find(s => s.mediaUrl === url)?.id ?? null;
          })()}
          onSelect={(sound: LibrarySound) => {
            // Lock-on-click gate: block sound assignment when the spread is not held (defense-in-depth
            // — the library opens from a gated toolbar, but could persist across a lock loss).
            if (!spreadEditable) {
              log.debug("handleSoundSelect", "blocked — spread not held", { spreadId: browseOpen.spreadId });
              toastLockRequired();
              setBrowseOpen(null);
              return;
            }
            const spread = retouchSpreads.find(
              s => s.id === browseOpen.spreadId
            );
            if (!spread) {
              log.warn("handleSoundSelect", "spread not found", {
                spreadId: browseOpen.spreadId,
              });
              setBrowseOpen(null);
              return;
            }
            const item =
              browseOpen.kind === "audio"
                ? spread.audios?.find(a => a.id === browseOpen.itemId)
                : spread.auto_audios?.find(a => a.id === browseOpen.itemId);
            if (!item) {
              log.warn("handleSoundSelect", "item not found", {
                itemId: browseOpen.itemId,
              });
              setBrowseOpen(null);
              return;
            }
            const shouldOverwriteTitle =
              !item.title?.trim() || DEFAULT_AUDIO_TITLES.has(item.title);
            const shouldOverwriteDescription = !item.description?.trim();
            const patch: Partial<SpreadAudio> = {
              media_url: sound.media_url,
              ...(shouldOverwriteTitle ? { title: sound.name } : {}),
              ...(shouldOverwriteDescription
                ? { description: sound.description }
                : {}),
            };
            log.info("handleSoundSelect", "sound selected", {
              soundId: sound.id,
              soundName: sound.name,
              itemId: browseOpen.itemId,
              kind: browseOpen.kind,
              overwriteTitle: shouldOverwriteTitle,
              overwriteDescription: shouldOverwriteDescription,
            });
            try {
              if (browseOpen.kind === "audio") {
                actions.updateRetouchAudio(
                  browseOpen.spreadId,
                  browseOpen.itemId,
                  patch
                );
              } else {
                actions.updateRetouchAutoAudio(
                  browseOpen.spreadId,
                  browseOpen.itemId,
                  patch as Partial<SpreadAutoAudio>
                );
              }
            } catch (err) {
              log.error("handleSoundSelect", "patch failed", {
                itemId: browseOpen.itemId,
                error: String(err),
              });
            }
            setBrowseOpen(null);
          }}
        />
      )}
    </>
  );
}

export default ObjectsMainView;
