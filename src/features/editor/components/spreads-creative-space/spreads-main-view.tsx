// spreads-main-view.tsx - CanvasSpreadView wrapper for illustration phase (image, textbox, shape only)

import { useCallback, useMemo, useState } from 'react';

import { CanvasSpreadView } from '@/features/editor/components/canvas-spread-view';
import {
  EditableImage,
  EditableTextbox,
  EditableShape,
  GenerateImageModal,
  ExtractImageModal,
  SPACE_TOOL_MATRIX,
} from '@/features/editor/components/shared-components';
import type { ExtractResult, ExtractedTextbox } from '@/features/editor/components/shared-components';
import { buildExtractImages } from '@/features/editor/components/objects-creative-space/hooks/use-image-builders';
import { buildRawTextboxes } from '@/features/editor/components/objects-creative-space/hooks/build-raw-textboxes';
import {
  upsertCropPreset,
  deleteCropPreset,
} from '@/features/editor/components/shared-components/extract-image-modal/crop-preset-utils';
import type { CropPreset } from '@/types/editor';
import {
  cloneItemWithNewId,
  nextTopZInTier,
  shiftTextboxLanguageGeometries,
} from '@/features/editor/utils/duplicate-item-helpers';
import {
  useSnapshotActions,
  useSnapshotId,
} from '@/stores/snapshot-store/selectors';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { getTextboxContentForLanguage } from '@/features/editor/utils/textbox-helpers';
import { useLanguageCode, useCanvasSize } from '@/stores/editor-settings-store';
import { useCurrentBook, useBookTemplateLayout, useBookStepTypography, useBookActions } from '@/stores/book-store';
import { useTemplateLayouts } from '@/hooks/use-template-layouts';
import {
  buildIllustrationItemsFromTemplate,
  findTemplateById,
  mergeItems,
} from '@/utils/template-layout-utils';
import { createLogger } from '@/utils/logger';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import type { SaveResourceDirective } from '@/types/save-resource';
import { toastLockRequired } from '@/utils/collab-save-toasts';
import { useInteractionLayerContext } from '@/features/editor/contexts/interaction-layer-provider';
import { useGlobalHotkey } from '@/features/editor/contexts/use-global-hotkey';
import { SpreadsImageToolbar } from './spreads-image-toolbar';
import { IllustrationEditImageModal } from './illustration-edit-image-modal';
import { SpreadsTextToolbar } from './spreads-text-toolbar';
import { SpreadsShapeToolbar } from './spreads-shape-toolbar';
import { SpreadsPageToolbar } from './spreads-page-toolbar';
import type { SelectedItem } from './utils';
import type { ViewMode } from '@/types/canvas-types';
import type {
  SpreadType,
  BaseSpread,
  ImageItemContext,
  TextItemContext,
  ShapeItemContext,
  ImageToolbarContext,
  TextToolbarContext,
  ShapeToolbarContext,
  PageToolbarContext,
  LayoutOption,
  SpreadItemActionUnion,
  SpreadImage,
  SpreadTextbox,
  SpreadShape,
  PageData,
} from '@/features/editor/components/canvas-spread-view';

const EMPTY_SPREADS: BaseSpread[] = [];
const log = createLogger('Editor', 'SpreadsMainView');

// Whole-spread SCENE lock coords (step 2 / rtype 6) for peer-lock veil + thumbnail badges.
// Module-const → stable identity → SpreadThumbnail's React.memo stays intact.
const SCENE_PEER_LOCK = { step: 2, resourceType: 6 } as const;

const matchCtrlD = (e: KeyboardEvent): boolean =>
  (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd';

const SPREADS_FORBIDDEN = ['page'] as const;

/** Resolve the best available image URL for an illustration spread image.
 *  Priority: final hi-res → selected illustration → first illustration → null */
function resolveIllustrationImageUrl(image: SpreadImage): string | null {
  if (image.final_hires_media_url) return image.final_hires_media_url;
  const selected = image.illustrations?.find((v) => v.is_selected);
  if (selected?.media_url) return selected.media_url;
  if (image.illustrations?.[0]?.media_url) return image.illustrations[0].media_url;
  return null;
}

// Map DB template_layouts → LayoutOption for page toolbar dropdown
function toLayoutOptions(layouts: { id: string; title: string; thumbnail_url: string; type: number }[]): LayoutOption[] {
  return layouts.map((l) => ({
    id: l.id,
    title: l.title,
    thumbnail_url: l.thumbnail_url ?? '',
    type: l.type as 1 | 2,
  }));
}

interface SpreadsMainViewProps {
  selectedSpreadId: string;
  selectedItemId: SelectedItem | null;
  onSpreadSelect: (spreadId: string) => void;
  /** USER-initiated spread selection (filmstrip/grid click) → the per-spread SCENE held-session
   *  lock-on-click seam (ADR-044). Distinct from `onSpreadSelect`, which also fires programmatically. */
  onSpreadUserSelect?: (spreadId: string) => void;
  onItemSelect: (item: SelectedItem | null) => void;
  /** Whether the active spread is currently held by THIS editor's SCENE lock. Gates all in-spread
   *  content editability (grey-out when not held — lock-on-click). */
  spreadEditable: boolean;
  /** Held-session explicit save (forwarded to the illustration Edit-image modal commit). */
  onCommitSave?: () => Promise<boolean>;
  viewMode: ViewMode;
  zoomLevel: number;
  columnsPerRow: number;
  onViewModeChange: (mode: ViewMode) => void;
  onZoomChange: (level: number) => void;
  onColumnsChange: (columns: number) => void;
}

export function SpreadsMainView({
  selectedSpreadId,
  selectedItemId,
  onSpreadSelect,
  onSpreadUserSelect,
  onItemSelect,
  spreadEditable,
  onCommitSave,
  viewMode,
  zoomLevel,
  columnsPerRow,
  onViewModeChange,
  onZoomChange,
  onColumnsChange,
}: SpreadsMainViewProps) {
  // Stable ref: return store array directly, fallback to module-level constant
  const illustrationSpreads = useSnapshotStore(
    (s) => s.illustration?.spreads ?? EMPTY_SPREADS
  );
  const actions = useSnapshotActions();
  // Book-edit context (Spreads space is never remix) → attribute AI extract (Texts OCR) by snapshotId.
  const snapshotId = useSnapshotId();
  const langCode = useLanguageCode();
  const canvasSize = useCanvasSize();
  const book = useCurrentBook();
  const { updateBook } = useBookActions();
  const templateLayout = useBookTemplateLayout();
  const bookTypography = useBookStepTypography('illustration');
  const { spreadLayouts, singlePageLayouts, allLayouts } = useTemplateLayouts(book?.book_type ?? null);

  // DB layouts → LayoutOption[] for page toolbar dropdown (page-item filters by type internally)
  const availableLayouts = useMemo(() => toLayoutOptions(allLayouts), [allLayouts]);

  // === Spread-level handlers ===

  const handleSpreadAdd = useCallback(
    (type: SpreadType) => {
      const nextPageNum = illustrationSpreads.length * 2;
      const basePage: PageData = {
        number: nextPageNum,
        type: 'normal_page',
        layout: null,
        background: { color: '#FFFFFF', texture: null },
      };

      // 'double' = DPS → 1 page spanning two numbers; 'single' = non-DPS → 2 pages
      const pages: PageData[] =
        type === 'double'
          ? [{ ...basePage, number: `${nextPageNum}-${nextPageNum + 1}` }]
          : [basePage, { ...basePage, number: nextPageNum + 1 }];

      // Populate raw_images/raw_textboxes from template (silent empty fallback)
      let raw_images: SpreadImage[] = [];
      let raw_textboxes: SpreadTextbox[] = [];

      if (templateLayout) {
        if (type === 'double') {
          const tpl = findTemplateById(spreadLayouts, templateLayout.spread);
          if (tpl) {
            const items = buildIllustrationItemsFromTemplate(tpl, 'full', langCode, bookTypography);
            raw_images = items.images;
            raw_textboxes = items.textboxes;
          }
        } else {
          const leftTpl = findTemplateById(singlePageLayouts, templateLayout.left_page);
          const rightTpl = findTemplateById(singlePageLayouts, templateLayout.right_page);
          const leftItems = leftTpl
            ? buildIllustrationItemsFromTemplate(leftTpl, 'left', langCode, bookTypography)
            : { images: [] as SpreadImage[], textboxes: [] as SpreadTextbox[] };
          const rightItems = rightTpl
            ? buildIllustrationItemsFromTemplate(rightTpl, 'right', langCode, bookTypography)
            : { images: [] as SpreadImage[], textboxes: [] as SpreadTextbox[] };
          const merged = mergeItems(leftItems, rightItems);
          raw_images = merged.images;
          raw_textboxes = merged.textboxes;
        }
      }

      const newSpread: BaseSpread = {
        id: crypto.randomUUID(),
        pages,
        raw_images,
        raw_textboxes,
        images: [],
        textboxes: [],
      };
      log.info('handleSpreadAdd', 'adding spread', { type, spreadId: newSpread.id });
      actions.addIllustrationSpread(newSpread);
      onSpreadSelect(newSpread.id);
    },
    [actions, illustrationSpreads.length, onSpreadSelect, templateLayout, spreadLayouts, singlePageLayouts, langCode, bookTypography]
  );

  const handleDeleteSpread = useCallback(
    (spreadId: string) => {
      log.info('handleDeleteSpread', 'deleting spread', { spreadId });
      actions.deleteIllustrationSpread(spreadId);
    },
    [actions]
  );

  const handleSpreadReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      log.debug('handleSpreadReorder', 'reorder', { fromIndex, toIndex });
      actions.reorderIllustrationSpreads(fromIndex, toIndex);
    },
    [actions]
  );

  // Unified item action handler — dispatches to illustration store per type
  const handleSpreadItemAction = useCallback(
    (params: SpreadItemActionUnion) => {
      const { spreadId, itemType, action, itemId, data } = params;
      log.debug('handleSpreadItemAction', 'dispatch', { spreadId, itemType, action });

      switch (itemType) {
        case 'image':
          if (action === 'add')
            actions.addRawImage(spreadId, data as SpreadImage);
          else if (action === 'update')
            actions.updateRawImage(spreadId, itemId as string, data as Partial<SpreadImage>);
          else if (action === 'delete')
            actions.deleteRawImage(spreadId, itemId as string);
          break;
        case 'textbox':
          if (action === 'add')
            actions.addRawTextbox(spreadId, data as SpreadTextbox);
          else if (action === 'update')
            actions.updateRawTextbox(spreadId, itemId as string, data as Partial<SpreadTextbox>);
          else if (action === 'delete')
            actions.deleteRawTextbox(spreadId, itemId as string);
          break;
        case 'shape':
          if (action === 'add')
            actions.addRetouchShape(spreadId, data as SpreadShape);
          else if (action === 'update')
            actions.updateRetouchShape(spreadId, itemId as string, data as Partial<SpreadShape>);
          else if (action === 'delete')
            actions.deleteRetouchShape(spreadId, itemId as string);
          break;
        case 'page':
          if (action === 'update' && typeof itemId === 'number') {
            const spread = illustrationSpreads.find((s) => s.id === spreadId);
            if (!spread) break;
            const pageUpdates = data as Partial<PageData>;
            const pageIndex = itemId;

            // Layout change → delete old items on this page, add new items from template
            if (pageUpdates.layout !== undefined && pageUpdates.layout !== null) {
              const template = findTemplateById(allLayouts, pageUpdates.layout);
              const isDPS = spread.pages.length === 1;
              const side: 'full' | 'left' | 'right' = isDPS ? 'full' : pageIndex === 0 ? 'left' : 'right';

              // Filter: keep items NOT on this page
              const isOnThisPage = (x: number) => {
                if (isDPS) return true;
                return pageIndex === 0 ? x < 50 : x >= 50;
              };

              const existingImages = spread.raw_images ?? [];
              const existingTextboxes = spread.raw_textboxes ?? [];

              const keptImages = existingImages.filter((img) => !isOnThisPage(img.geometry.x));
              const keptTextboxes = existingTextboxes.filter((tb) => {
                for (const val of Object.values(tb)) {
                  if (typeof val === 'object' && val !== null && 'geometry' in val) {
                    return !isOnThisPage((val as { geometry: { x: number } }).geometry.x);
                  }
                }
                return true; // no geometry found → keep
              });

              // Build new items from selected template
              let newImages: SpreadImage[] = [];
              let newTextboxes: SpreadTextbox[] = [];
              if (template) {
                const items = buildIllustrationItemsFromTemplate(template, side, langCode, bookTypography);
                newImages = items.images;
                newTextboxes = items.textboxes;
              }

              const newPages = [...spread.pages];
              newPages[pageIndex] = { ...newPages[pageIndex], ...pageUpdates };
              actions.updateIllustrationSpread(spreadId, {
                raw_images: [...keptImages, ...newImages],
                raw_textboxes: [...keptTextboxes, ...newTextboxes],
                pages: newPages,
              });

              log.info('handleSpreadItemAction', 'layout changed — items replaced', {
                spreadId, pageIndex, layoutId: pageUpdates.layout,
                removed: existingImages.length - keptImages.length + existingTextboxes.length - keptTextboxes.length,
                added: newImages.length + newTextboxes.length,
              });
            } else {
              // Non-layout page update (color, texture, etc.)
              const newPages = [...spread.pages];
              newPages[pageIndex] = { ...newPages[pageIndex], ...pageUpdates };
              actions.updateIllustrationSpread(spreadId, { pages: newPages });
            }
          }
          break;
      }
    },
    [actions, illustrationSpreads, allLayouts, langCode, bookTypography]
  );

  // Lock-on-click gate (ADR-044): every IN-SPREAD scene write (canvas raw_image / raw_textbox /
  // shape / page add·update·delete, incl. the Generate modal's image updates which route here)
  // flows through onUpdateSpreadItem → handleSpreadItemAction; block it when this editor does not
  // hold the spread's SCENE lock (else the mutation dirties the node but the held session never
  // saves it). Single choke point for drag/resize/inline-edit/delete on the canvas.
  const gatedSpreadItemAction = useCallback(
    (params: SpreadItemActionUnion) => {
      if (!spreadEditable) {
        log.debug('gatedSpreadItemAction', 'blocked — spread not held', {
          itemType: params.itemType,
          action: params.action,
        });
        toastLockRequired();
        return;
      }
      handleSpreadItemAction(params);
    },
    [spreadEditable, handleSpreadItemAction]
  );

  // === Generate image modal state ===
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [generateModalImageId, setGenerateModalImageId] = useState<string | null>(null);

  // Derive live image from store so modal reflects generation results in real-time
  const generateModalImage = useMemo(() => {
    if (!generateModalImageId) return null;
    const spread = illustrationSpreads.find((s) => s.id === selectedSpreadId);
    return spread?.raw_images?.find((img) => img.id === generateModalImageId) ?? null;
  }, [generateModalImageId, illustrationSpreads, selectedSpreadId]);

  const openGenerateModal = useCallback((image: SpreadImage) => {
    setGenerateModalImageId(image.id);
    setGenerateModalOpen(true);
  }, []);

  const handleGenerateImageUpdate = useCallback(
    (imageId: string, updates: Partial<SpreadImage>) => {
      handleSpreadItemAction({
        spreadId: selectedSpreadId,
        itemType: 'image',
        action: 'update',
        itemId: imageId,
        data: updates,
      });
    },
    [selectedSpreadId, handleSpreadItemAction]
  );

  // === Edit image modal state (matrix unify — net-new for illustration) ===
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editModalImageId, setEditModalImageId] = useState<string | null>(null);

  const openEditModal = useCallback((image: SpreadImage) => {
    setEditModalImageId(image.id);
    setEditModalOpen(true);
  }, []);

  // === Extract image modal state (matrix unify — net-new for illustration) ===
  const [extractModalOpen, setExtractModalOpen] = useState(false);
  const [extractModalImageId, setExtractModalImageId] = useState<string | null>(null);

  // Derive live source image from store (consistent with generateModalImage).
  const extractModalImage = useMemo(() => {
    if (!extractModalImageId) return null;
    const spread = illustrationSpreads.find((s) => s.id === selectedSpreadId);
    return spread?.raw_images?.find((img) => img.id === extractModalImageId) ?? null;
  }, [extractModalImageId, illustrationSpreads, selectedSpreadId]);

  const openExtractModal = useCallback((image: SpreadImage) => {
    setExtractModalImageId(image.id);
    setExtractModalOpen(true);
  }, []);

  // Crops extract (raw space) → spawn the cropped images into the current illustration spread's
  // raw_images[]. Reuses buildExtractImages with the raw add-action + no z-tier (raw_images
  // don't cascade — see handleDuplicateItem). Geometry positions each crop at its box spot.
  const handleExtractCreateImages = useCallback(
    (results: ExtractResult[]) => {
      if (!extractModalImage) {
        log.warn('handleExtractCreateImages', 'no source image — ignored', { count: results.length });
        return;
      }
      // Lock-on-click gate: crops spawn new raw_images (in-spread content) → require the SCENE lock.
      if (!spreadEditable) {
        log.debug('handleExtractCreateImages', 'blocked — spread not held', { count: results.length });
        toastLockRequired();
        return;
      }
      buildExtractImages(results, extractModalImage, selectedSpreadId, illustrationSpreads, actions, {
        addImage: actions.addRawImage,
        zTier: null,
      });
      log.info('handleExtractCreateImages', 'spawned raw images', {
        count: results.length,
        spreadId: selectedSpreadId,
      });
    },
    [extractModalImage, selectedSpreadId, illustrationSpreads, actions, spreadEditable]
  );

  // Texts extract (raw space) → spawn raw_textboxes[] into the current illustration spread
  // (client-side only — no API/upload). Geometry maps each detected box into the source footprint;
  // typography is the book default (Validation S1 — no box-height font heuristic).
  const handleExtractCreateTexts = useCallback(
    (specs: ExtractedTextbox[]) => {
      if (!extractModalImage) {
        log.warn('handleExtractCreateTexts', 'no source image — ignored', { count: specs.length });
        return;
      }
      // Lock-on-click gate: spawning raw_textboxes (in-spread content) requires the SCENE lock.
      if (!spreadEditable) {
        log.debug('handleExtractCreateTexts', 'blocked — spread not held', { count: specs.length });
        toastLockRequired();
        return;
      }
      buildRawTextboxes(specs, extractModalImage, selectedSpreadId, langCode, canvasSize, actions.addRawTextbox, bookTypography);
      log.info('handleExtractCreateTexts', 'spawned raw textboxes', {
        count: specs.length,
        spreadId: selectedSpreadId,
      });
    },
    [extractModalImage, spreadEditable, selectedSpreadId, langCode, canvasSize, actions, bookTypography]
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

  // === Page & deselect handlers ===

  const handlePageSelect = useCallback(
    (pageIndex: number) => onItemSelect({ type: 'page', id: `page-${pageIndex}` }),
    [onItemSelect]
  );

  const handleDeselect = useCallback(
    () => onItemSelect(null),
    [onItemSelect]
  );

  // === Toolbar handlers ===

  const handleDuplicateItem = useCallback(
    (itemType: 'raw_image' | 'raw_textbox' | 'shape', itemId: string) => {
      const spread = illustrationSpreads.find((s) => s.id === selectedSpreadId);
      if (!spread) {
        log.warn('handleDuplicateItem', 'spread not found', { selectedSpreadId });
        return;
      }

      if (itemType === 'raw_image') {
        // raw_images không có z-index → không cascade
        const source = spread.raw_images?.find((i) => i.id === itemId);
        if (!source) { log.warn('handleDuplicateItem', 'source not found', { itemType, itemId }); return; }
        const cloned = cloneItemWithNewId(source);
        actions.addRawImage(selectedSpreadId, cloned);
        log.info('handleDuplicateItem', 'duplicated', { itemType, sourceId: itemId, cloneId: cloned.id });
        onItemSelect({ type: 'raw_image', id: cloned.id });
      } else if (itemType === 'raw_textbox') {
        // raw_textboxes không có z-index → không cascade
        const source = spread.raw_textboxes?.find((t) => t.id === itemId);
        if (!source) { log.warn('handleDuplicateItem', 'source not found', { itemType, itemId }); return; }
        const cloned = cloneItemWithNewId(source);
        shiftTextboxLanguageGeometries(cloned as unknown as Record<string, unknown>);
        actions.addRawTextbox(selectedSpreadId, cloned);
        log.info('handleDuplicateItem', 'duplicated', { itemType, sourceId: itemId, cloneId: cloned.id });
        onItemSelect({ type: 'raw_textbox', id: cloned.id });
      } else if (itemType === 'shape') {
        const source = spread.shapes?.find((s) => s.id === itemId);
        if (!source) { log.warn('handleDuplicateItem', 'source not found', { itemType, itemId }); return; }

        // Top-push: clone goes above all existing mix-tier items regardless of source position.
        const newZ = nextTopZInTier(spread, 'mix');
        const cloned = cloneItemWithNewId(source);
        cloned['z-index'] = newZ;
        actions.addRetouchShape(selectedSpreadId, cloned);
        log.info('handleDuplicateItem', 'duplicated', { itemType, sourceId: itemId, cloneId: cloned.id, newZ });
        onItemSelect({ type: 'shape', id: cloned.id });
      }
    },
    [actions, illustrationSpreads, selectedSpreadId, onItemSelect]
  );

  // Gate duplicate (covers BOTH the toolbar Clone action AND the Ctrl/Cmd+D hotkey — the hotkey
  // bypasses toolbar-visibility gating, so it must be blocked here when the spread is not held).
  const gatedDuplicateItem = useCallback(
    (itemType: 'raw_image' | 'raw_textbox' | 'shape', itemId: string) => {
      if (!spreadEditable) {
        log.debug('gatedDuplicateItem', 'blocked — spread not held', { itemType, itemId });
        toastLockRequired();
        return;
      }
      handleDuplicateItem(itemType, itemId);
    },
    [spreadEditable, handleDuplicateItem]
  );

  const { stackRef } = useInteractionLayerContext();

  useGlobalHotkey(
    matchCtrlD,
    () => {
      if (stackRef.current.modal !== null) {
        log.debug('useGlobalHotkey', 'ctrl-d blocked by modal');
        return;
      }
      if (!selectedItemId) {
        log.debug('useGlobalHotkey', 'ctrl-d no item selected');
        return;
      }
      if ((SPREADS_FORBIDDEN as readonly string[]).includes(selectedItemId.type)) {
        log.debug('useGlobalHotkey', 'ctrl-d forbidden type', { type: selectedItemId.type });
        return;
      }
      log.debug('useGlobalHotkey', 'ctrl-d duplicating', { type: selectedItemId.type, id: selectedItemId.id });
      gatedDuplicateItem(
        selectedItemId.type as 'raw_image' | 'raw_textbox' | 'shape',
        selectedItemId.id
      );
    },
    [selectedItemId, gatedDuplicateItem, stackRef]
  );

  // === Toolbar render props ===

  const renderIllustrationImageToolbar = useCallback(
    (context: ImageToolbarContext<BaseSpread>) => (
      <SpreadsImageToolbar
        context={{
          ...context,
          onGenerateImage: () => openGenerateModal(context.item),
          onEditImage: () => openEditModal(context.item),
          onExtractImage: () => openExtractModal(context.item),
          onClone: () => gatedDuplicateItem('raw_image', context.item.id),
        }}
      />
    ),
    [openGenerateModal, openEditModal, openExtractModal, gatedDuplicateItem]
  );

  const renderIllustrationTextToolbar = useCallback(
    (context: TextToolbarContext<BaseSpread>) => (
      <SpreadsTextToolbar
        context={{
          ...context,
          onClone: () => gatedDuplicateItem('raw_textbox', context.item.id),
        }}
      />
    ),
    [gatedDuplicateItem]
  );

  const renderIllustrationShapeToolbar = useCallback(
    (context: ShapeToolbarContext<BaseSpread>) => (
      <SpreadsShapeToolbar
        context={{
          ...context,
          onClone: () => gatedDuplicateItem('shape', context.item.id),
        }}
      />
    ),
    [gatedDuplicateItem]
  );

  const renderIllustrationPageToolbar = useCallback(
    (context: PageToolbarContext<BaseSpread>) => (
      <SpreadsPageToolbar context={context} />
    ),
    []
  );

  // === Render props ===

  const renderIllustrationImage = useCallback(
    (context: ImageItemContext<BaseSpread>) => {
      const img = context.item as SpreadImage;
      const imageUrl = resolveIllustrationImageUrl(img);
      return (
        <EditableImage
          image={{ ...context.item, media_url: imageUrl ?? undefined }}
          index={context.itemIndex}
          zIndex={context.zIndex}
          isSelected={context.isSelected}
          isEditable={context.isSpreadSelected}
          onSelect={() => {
            context.onSelect();
            onItemSelect({ type: 'raw_image', id: context.item.id });
          }}
          onArtNoteChange={(artNote) => context.onUpdate({ art_note: artNote })}
          onEditingChange={context.onEditingChange}
        />
      );
    },
    [onItemSelect]
  );

  const renderIllustrationTextbox = useCallback(
    (context: TextItemContext<BaseSpread>) => {
      const tb = context.item as SpreadTextbox;
      const result = getTextboxContentForLanguage(tb as unknown as Record<string, unknown>, langCode, bookTypography);
      if (!result) return null;
      const { langKey, content } = result;
      return (
        <EditableTextbox
          textboxContent={content}
          index={context.itemIndex}
          zIndex={context.zIndex}
          isSelected={context.isSelected}
          isSelectable={context.isSpreadSelected}
          isEditable={context.isSpreadSelected}
          isEditing={context.isEditing}
          onSelect={() => {
            context.onSelect();
            onItemSelect({ type: 'raw_textbox', id: context.item.id });
          }}
          onTextChange={(newText) => {
            context.onUpdate({
              [langKey]: { ...content, text: newText },
            } as unknown as Partial<SpreadTextbox>);
          }}
          onEditingChange={context.onEditingChange ?? (() => {})}
        />
      );
    },
    [onItemSelect, langCode, bookTypography]
  );

  const renderIllustrationShape = useCallback(
    (context: ShapeItemContext<BaseSpread>) => {
      return (
        <EditableShape
          shape={context.item}
          index={context.itemIndex}
          zIndex={context.zIndex}
          isSelected={context.isSelected}
          isEditable={context.isSpreadSelected}
          onSelect={() => {
            context.onSelect();
            onItemSelect({ type: 'shape', id: context.item.id });
          }}
        />
      );
    },
    [onItemSelect]
  );

  // === Phase 04: opt-in saveResource directives (anchor = illustration raw_images node) ===
  // Edit → new image_version at the selected raw image; Upload (Generate modal's Upload mode) →
  // the same raw_images anchor, 'upload' action. Snapshot-scoped (Spreads is never remix);
  // undefined snapshot ⇒ omit (caller sends no opt-in double-write directive).
  const editSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (!snapshotId || !editModalImageId) return undefined;
    return buildImageVersionSaveResource(
      `col:illustration/spread:${selectedSpreadId}/key:raw_images/find:id=${editModalImageId}`,
      snapshotId,
      'edit',
    );
  }, [snapshotId, selectedSpreadId, editModalImageId]);

  const uploadSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (!snapshotId || !generateModalImageId) return undefined;
    return buildImageVersionSaveResource(
      `col:illustration/spread:${selectedSpreadId}/key:raw_images/find:id=${generateModalImageId}`,
      snapshotId,
      'upload',
    );
  }, [snapshotId, selectedSpreadId, generateModalImageId]);

  return (
    <>
      <CanvasSpreadView
        spreads={illustrationSpreads}
        selectedSpreadId={selectedSpreadId}
        viewMode={viewMode}
        zoomLevel={zoomLevel}
        columnsPerRow={columnsPerRow}
        peerLock={SCENE_PEER_LOCK}
        renderItems={['raw_image', 'raw_textbox', 'shape']}
        renderRawImage={renderIllustrationImage}
        renderRawTextbox={renderIllustrationTextbox}
        renderShapeItem={renderIllustrationShape}
        renderRawImageToolbar={renderIllustrationImageToolbar}
        renderRawTextboxToolbar={renderIllustrationTextToolbar}
        renderShapeToolbar={renderIllustrationShapeToolbar}
        renderPageToolbar={renderIllustrationPageToolbar}
        availableLayouts={availableLayouts}
        onSpreadSelect={onSpreadSelect}
        onSpreadUserSelect={onSpreadUserSelect}
        onViewModeChange={onViewModeChange}
        onZoomChange={onZoomChange}
        onColumnsChange={onColumnsChange}
        onSpreadReorder={handleSpreadReorder}
        onSpreadAdd={handleSpreadAdd}
        onDeleteSpread={handleDeleteSpread}
        onUpdateSpreadItem={gatedSpreadItemAction}
        // Lock-on-click: in-spread content is editable only while THIS editor holds the spread's
        // SCENE lock. Spread CREATE stays ungated (add a spread); spread DELETE is gated (must hold
        // it) → then explicit collection save; spread REORDER stays ungated (out of held scope).
        isEditable={spreadEditable}
        canAddSpread={true}
        canDeleteSpread={spreadEditable}
        canReorderSpread={true}
        canResizeItem={true}
        canDragItem={true}
        externalSelectedItemId={selectedItemId}
        onPageSelect={handlePageSelect}
        onDeselect={handleDeselect}
        pageNumbering={templateLayout?.page_numbering}
      />
      {generateModalImage && (
        <GenerateImageModal
          open={generateModalOpen}
          onOpenChange={setGenerateModalOpen}
          spreadId={selectedSpreadId}
          image={generateModalImage}
          enabledModes={SPACE_TOOL_MATRIX.raw.generate}
          onUpdateImage={(updates) => {
            handleGenerateImageUpdate(generateModalImage.id, updates);
          }}
          saveResource={uploadSaveResource}
        />
      )}

      {editModalImageId && (
        <IllustrationEditImageModal
          open={editModalOpen}
          onOpenChange={setEditModalOpen}
          spreadId={selectedSpreadId}
          imageId={editModalImageId}
          enabledTools={SPACE_TOOL_MATRIX.raw.edit}
          onCommitSave={onCommitSave}
          saveResource={editSaveResource}
        />
      )}

      {extractModalImage && (
        // Phase 04: NO saveResource — Spreads raw Extract exposes Crop/Texts tabs only (client-spawn
        // via onCreateImages/onCreateTexts). The AI Background tab (the only save_resource seam) is
        // "Coming soon" here, so there is no anchor to double-write. Client-spawn stays the persist path.
        <ExtractImageModal
          open={extractModalOpen}
          onOpenChange={setExtractModalOpen}
          image={extractModalImage}
          enabledTabs={SPACE_TOOL_MATRIX.raw.extract}
          onCreateImages={handleExtractCreateImages}
          onCreateTexts={handleExtractCreateTexts}
          snapshotId={snapshotId || undefined}
          cropPresets={book?.crop_presets ?? undefined}
          onUpsertCropPreset={handleUpsertCropPreset}
          onDeleteCropPreset={handleDeleteCropPreset}
        />
      )}
    </>
  );
}

export default SpreadsMainView;
