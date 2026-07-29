// canvas-spread-view.tsx - Root component composing all child components (controlled — ADR-021)
// Parent owns view state (selectedSpreadId, viewMode, zoomLevel, columnsPerRow).
'use client';

import { useCallback, useMemo, useEffect, useRef, type ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import { SpreadViewHeader } from './spread-view-header';
import { SpreadEditorPanel } from './spread-editor-panel';
import { SpreadThumbnailList, type SpreadThumbnailListRef } from './spread-thumbnail-list';
import { NewSpreadButton, type SpreadType } from './new-spread-button';
import { EmptyState } from './empty-state';
import type { ViewMode } from '@/types/canvas-types';
import { useSetZoomLevel } from '@/stores/editor-settings-store';
import { useInteractionLayer } from '../../contexts';
import type { PageNumberingSettings } from '@/types/editor';
import { createLogger } from '@/utils/logger';
import type { SpreadAnimation } from '@/types/spread-types';
import type { ZoomAreaGeometry } from './overlays/zoom-area-overlay-utils';
import type { MotionLineGeometry } from './overlays/motion-line-overlay-utils';
import type {
  BaseSpread,
  ItemType,
  ImageItemContext,
  TextItemContext,
  ShapeItemContext,
  VideoItemContext,
  AudioItemContext,
  AutoAudioItemContext,
  QuizItemContext,
  ImageToolbarContext,
  TextToolbarContext,
  PageToolbarContext,
  ShapeToolbarContext,
  VideoToolbarContext,
  AutoPicItemContext,
  AutoPicToolbarContext,
  AudioToolbarContext,
  AutoAudioToolbarContext,
  LayoutOption,
  OnUpdateSpreadItemFn,
  SpreadItemActionUnion,
} from '@/types/canvas-types';

const log = createLogger('Editor', 'CanvasSpreadView');

// === Props Interface ===
interface CanvasSpreadViewProps<TSpread extends BaseSpread> {
  // Data
  spreads: TSpread[];

  // Controlled view state (required — parent owns all four fields)
  selectedSpreadId: string | null;
  viewMode: ViewMode;
  zoomLevel: number;
  columnsPerRow: number;
  onSpreadSelect: (spreadId: string) => void; // keep legacy name (Validation Session 1)
  /** Fires ONLY on a genuine USER spread selection (filmstrip/grid click or double-click) — never
   *  from the programmatic auto-select effects that also call `onSpreadSelect`. The Objects space
   *  uses it as the lock-on-click choke point for the per-spread retouch held session (ADR-044): the
   *  edit-lock must NEVER auto-acquire on a programmatic re-select. Additive/opt-in — other spaces
   *  omit it and behave unchanged. */
  onSpreadUserSelect?: (spreadId: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onZoomChange: (level: number) => void;
  onColumnsChange: (columns: number) => void;

  // Render configuration
  renderItems: ItemType[];

  // Item render functions (optional - skip rendering if not provided)
  renderImageItem?: (context: ImageItemContext<TSpread>) => ReactNode;
  renderTextItem?: (context: TextItemContext<TSpread>) => ReactNode;
  renderShapeItem?: (context: ShapeItemContext<TSpread>) => ReactNode;
  renderVideoItem?: (context: VideoItemContext<TSpread>) => ReactNode;
  renderAudioItem?: (context: AudioItemContext<TSpread>) => ReactNode;
  renderQuizItem?: (context: QuizItemContext<TSpread>) => ReactNode;
  renderAutoPicItem?: (context: AutoPicItemContext<TSpread>) => ReactNode;
  renderAutoAudioItem?: (context: AutoAudioItemContext<TSpread>) => ReactNode;

  // Toolbar render functions (optional)
  renderImageToolbar?: (context: ImageToolbarContext<TSpread>) => ReactNode;
  renderTextToolbar?: (context: TextToolbarContext<TSpread>) => ReactNode;
  renderPageToolbar?: (context: PageToolbarContext<TSpread>) => ReactNode;
  renderShapeToolbar?: (context: ShapeToolbarContext<TSpread>) => ReactNode;
  renderVideoToolbar?: (context: VideoToolbarContext<TSpread>) => ReactNode;
  renderAudioToolbar?: (context: AudioToolbarContext<TSpread>) => ReactNode;
  renderAutoPicToolbar?: (context: AutoPicToolbarContext<TSpread>) => ReactNode;
  renderAutoAudioToolbar?: (context: AutoAudioToolbarContext<TSpread>) => ReactNode;

  // Raw item render functions (illustration layer)
  renderRawImage?: (context: ImageItemContext<TSpread>) => ReactNode;
  renderRawTextbox?: (context: TextItemContext<TSpread>) => ReactNode;
  renderRawImageToolbar?: (context: ImageToolbarContext<TSpread>) => ReactNode;
  renderRawTextboxToolbar?: (context: TextToolbarContext<TSpread>) => ReactNode;

  // Spread-level callbacks
  onSpreadReorder?: (fromIndex: number, toIndex: number) => void;
  onSpreadAdd?: (type: SpreadType) => void;
  onDeleteSpread?: (spreadId: string) => void;

  // Item-level callbacks - Unified API
  onUpdateSpreadItem?: OnUpdateSpreadItemFn;

  // Collab peer-lock config (opt-in): whole-spread lock coordinates for THIS space —
  // SCENE `{step:2,resourceType:6}` (spreads) / RETOUCH `{step:3,resourceType:10}` (objects).
  // Threaded to the active-canvas overlay + every thumbnail so a spread held by another editor
  // dims + shows a lock/holder badge. Omitted by non-collab spaces → zero behavior change.
  peerLock?: { step: number; resourceType: number };

  /** Opt-in thumbnail dot indicator (Actors space, phase 06): spreads whose id is in
   *  this set render a small dot on their thumbnail. Omitted → no dot, zero behavior
   *  change for every other space. */
  spreadIndicatorIds?: Set<string>;

  // Feature flags
  isEditable?: boolean;
  canAddSpread?: boolean;
  canReorderSpread?: boolean;
  canDeleteSpread?: boolean;
  canResizeItem?: boolean;
  canDragItem?: boolean;
  canRotateItem?: boolean;
  preventEditRawItem?: boolean;

  // Layout config
  availableLayouts?: LayoutOption[];

  // External item selection (sidebar → canvas)
  externalSelectedItemId?: { type: string; id: string } | null;

  // Callback when page background selected in canvas (canvas → sidebar)
  onPageSelect?: (pageIndex: number) => void;

  // Callback when selection is cleared (click outside canvas)
  onDeselect?: () => void;

  /** ADR-029 — canvas → parent sync for smart hit-test driven selections.
   *  Forwarded to SpreadEditorPanel. ObjectsMainView wires it to its own
   *  onItemSelect so sidebar / animation list track hit-test overrides. */
  onCanvasItemSelect?: (selected: { type: string; id: string }) => void;

  // Page numbering overlay settings (null/undefined = hidden)
  pageNumbering?: PageNumberingSettings | null;

  // Force a specific language code for textbox operations (overrides editor language).
  // Used by DummyMainView to lock dummies to the book's original_language.
  forceLanguageCode?: string;

  // Header config
  showViewToggle?: boolean;
  leftActions?: ReactNode;

  // === Animation overlay props (opt-in — all optional; default undefined → no overlay rendered) ===
  // Used by ObjectsCreativeSpace (phase-04) to surface ZoomArea/MotionLine/DrawZoomArea on canvas.
  // All other spaces (dummy, sketch, illustration, share) omit these props → zero behavior change.
  expandedAnimation?: SpreadAnimation | null;
  expandedAnimationIndex?: number | null;
  /** All animations of current spread — needed for label resolution (#N counter). */
  allAnimations?: SpreadAnimation[];
  onCameraZoomGeometryChange?: (animationIndex: number, geometry: ZoomAreaGeometry) => void;
  onMotionLineGeometryChange?: (animationIndex: number, geometry: MotionLineGeometry) => void;
  drawZoomAreaMode?: boolean;
  onDrawZoomAreaComplete?: (geometry: ZoomAreaGeometry) => void;
  onDrawZoomAreaCancel?: () => void;

  /** ADR-029 — opt-in for smart hit-test (Objects creative space only). */
  smartHitTestEnabled?: boolean;
}

// === Main Component ===
export function CanvasSpreadView<TSpread extends BaseSpread>({
  spreads,
  selectedSpreadId,
  viewMode,
  zoomLevel,
  columnsPerRow,
  onSpreadSelect,
  onSpreadUserSelect,
  onViewModeChange,
  onZoomChange,
  onColumnsChange,
  renderItems,
  renderImageItem,
  renderTextItem,
  renderShapeItem,
  renderVideoItem,
  renderAudioItem,
  renderQuizItem,
  renderImageToolbar,
  renderTextToolbar,
  renderPageToolbar,
  renderShapeToolbar,
  renderVideoToolbar,
  renderAudioToolbar,
  renderAutoPicItem,
  renderAutoPicToolbar,
  renderAutoAudioItem,
  renderAutoAudioToolbar,
  renderRawImage,
  renderRawTextbox,
  renderRawImageToolbar,
  renderRawTextboxToolbar,
  onSpreadReorder,
  onSpreadAdd,
  onDeleteSpread,
  onUpdateSpreadItem,
  peerLock,
  spreadIndicatorIds,
  isEditable = true,
  canAddSpread = false,
  canReorderSpread = false,
  canDeleteSpread = false,
  canResizeItem = true,
  canDragItem = true,
  canRotateItem = false,
  preventEditRawItem = false,
  availableLayouts = [],
  externalSelectedItemId,
  onPageSelect,
  onDeselect,
  onCanvasItemSelect,
  pageNumbering,
  forceLanguageCode,
  showViewToggle = true,
  leftActions,
  expandedAnimation,
  expandedAnimationIndex,
  allAnimations,
  onCameraZoomGeometryChange,
  onMotionLineGeometryChange,
  drawZoomAreaMode,
  onDrawZoomAreaComplete,
  onDrawZoomAreaCancel,
  smartHitTestEnabled,
}: CanvasSpreadViewProps<TSpread>) {

  // Ref to the currently mounted SpreadThumbnailList (either the edit-mode
  // filmstrip OR the grid-mode grid — only one mounts at a time).
  // Used by keyboard delete to delegate the confirmation dialog logic so it
  // lives in exactly one place (SpreadThumbnailList.triggerDelete).
  const filmstripRef = useRef<SpreadThumbnailListRef>(null);

  // Sync zoom level to global store for shared components (EditableTextbox, EditableShape, etc.)
  // zoomLevel is prop-driven → broadcast follows parent's source of truth.
  const setStoreZoomLevel = useSetZoomLevel();
  useEffect(() => {
    setStoreZoomLevel(zoomLevel);
  }, [zoomLevel, setStoreZoomLevel]);

  // Auto-select first spread when selection is null but spreads exist.
  // Covers: fresh store slot (no persisted value yet), dummy space mount with null localState,
  // and any case where parent resets selectedSpreadId to null.
  useEffect(() => {
    if (!selectedSpreadId && spreads.length > 0) {
      onSpreadSelect(spreads[0].id);
    }
  }, [selectedSpreadId, spreads, onSpreadSelect]);

  // Auto-select spread when spreads list changes:
  //   - Complete replacement (no shared IDs): select first spread
  //   - Single addition: select last (newly added) spread
  const prevSpreadIdsRef = useRef<string[]>(spreads.map((s) => s.id));
  useEffect(() => {
    if (spreads.length === 0) {
      prevSpreadIdsRef.current = [];
      return;
    }

    const prevIds = new Set(prevSpreadIdsRef.current);
    const currentIds = spreads.map((s) => s.id);
    const hasSharedIds = currentIds.some((id) => prevIds.has(id));

    if (!hasSharedIds && spreads.length > 0) {
      // Complete replacement (no shared IDs) → select first
      onSpreadSelect(spreads[0].id);
    } else if (spreads.length > prevSpreadIdsRef.current.length) {
      // Addition → select last (newly added)
      onSpreadSelect(spreads[spreads.length - 1].id);
    }

    prevSpreadIdsRef.current = currentIds;
  }, [spreads, onSpreadSelect]);

  // === Derived State ===
  const selectedSpread = useMemo(
    () => spreads.find((s) => s.id === selectedSpreadId) ?? null,
    [spreads, selectedSpreadId]
  );

  const selectedIndex = useMemo(
    () => spreads.findIndex((s) => s.id === selectedSpreadId),
    [spreads, selectedSpreadId]
  );

  // === Handlers ===
  const handleViewModeToggle = useCallback(() => {
    const newMode = viewMode === 'edit' ? 'grid' : 'edit';
    log.info('handleViewModeToggle', 'mode changed', { prev: viewMode, newMode });

    // Auto-select first spread when switching to Edit without selection
    if (newMode === 'edit' && !selectedSpreadId && spreads.length > 0) {
      onSpreadSelect(spreads[0].id);
    }

    onViewModeChange(newMode);
  }, [viewMode, selectedSpreadId, spreads, onSpreadSelect, onViewModeChange]);

  const handleZoomChange = useCallback((level: number) => {
    onZoomChange(level);
  }, [onZoomChange]);

  const handleColumnsChange = useCallback((columns: number) => {
    onColumnsChange(columns);
  }, [onColumnsChange]);

  const handleSpreadClick = useCallback((spreadId: string) => {
    log.info('handleSpreadClick', 'spread selected', { spreadId });
    onSpreadSelect(spreadId);
    // User-initiated → also drive the opt-in lock-on-click seam (never the auto-select effects).
    onSpreadUserSelect?.(spreadId);
  }, [onSpreadSelect, onSpreadUserSelect]);

  const handleSpreadDoubleClick = useCallback((spreadId: string) => {
    // Grid mode: select and switch to Edit
    onSpreadSelect(spreadId);
    onSpreadUserSelect?.(spreadId);
    onViewModeChange('edit');
  }, [onSpreadSelect, onSpreadUserSelect, onViewModeChange]);

  const handleDeleteSpread = useCallback((spreadId: string) => {
    const deletingIndex = spreads.findIndex(s => s.id === spreadId);
    if (deletingIndex === -1) return;

    // Only update selection if deleting the currently selected spread
    const isDeletingSelected = spreadId === selectedSpreadId;

    // Call parent delete callback
    onDeleteSpread?.(spreadId);

    // Update selection only if deleting current spread
    if (isDeletingSelected && spreads.length > 1) {
      let nextId: string | null = null;
      if (deletingIndex < spreads.length - 1) {
        nextId = spreads[deletingIndex + 1].id;
      } else {
        nextId = spreads[deletingIndex - 1].id;
      }
      if (nextId) {
        onSpreadSelect(nextId);
      }
    } else if (isDeletingSelected) {
      // last spread deleted — nothing to select (parent handles null case)
    }
  }, [spreads, selectedSpreadId, onDeleteSpread, onSpreadSelect]);

  // Delete currently selected spread via keyboard — delegates to the currently
  // mounted SpreadThumbnailList's triggerDelete so confirmation logic (content
  // check + dialog) lives in exactly one place. Works in BOTH edit and grid mode
  // because filmstripRef is attached to whichever list is currently rendered.
  const handleDeleteCurrentSpread = useCallback(() => {
    if (!selectedSpreadId) return;
    filmstripRef.current?.triggerDelete(selectedSpreadId);
  }, [selectedSpreadId]);

  // === Interaction Layer Stack — slot 'spread' registration ===
  //
  // Registered at CanvasSpreadView level (not SpreadEditorPanel) so that:
  //   1. Slot stays active in BOTH edit mode AND grid mode
  //   2. Keyboard Delete can remove the selected spread regardless of view mode
  //   3. SpreadEditorPanel unmounts in grid mode — registering there would
  //      make the slot disappear when switching to grid view
  //
  // No onClickOutside handler — spread slot must stay registered regardless
  // of where the user clicks (filmstrip, sidebar, toolbars, grid cells, etc.).
  const spreadViewRef = useRef<HTMLDivElement>(null);
  const spreadLayer = useMemo(() => {
    if (!selectedSpreadId) return null;
    return {
      id: selectedSpreadId,
      ref: spreadViewRef,
      hotkeys: canDeleteSpread ? ['Delete', 'Backspace'] : [],
      onHotkey: canDeleteSpread ? () => handleDeleteCurrentSpread() : undefined,
    };
  }, [selectedSpreadId, canDeleteSpread, handleDeleteCurrentSpread]);
  useInteractionLayer('spread', spreadLayer);

  // Unified spread item action handler (injects spreadId)
  const handleSpreadItemAction = useCallback(
    (params: Omit<SpreadItemActionUnion, 'spreadId'>) => {
      if (!selectedSpreadId || !onUpdateSpreadItem) return;
      onUpdateSpreadItem({ ...params, spreadId: selectedSpreadId } as SpreadItemActionUnion);
    },
    [onUpdateSpreadItem, selectedSpreadId]
  );

  // === Global Keyboard Shortcuts ===
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'home':
          if (spreads.length > 0) {
            onSpreadSelect(spreads[0].id);
          }
          break;
        case 'end':
          if (spreads.length > 0) {
            onSpreadSelect(spreads[spreads.length - 1].id);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [spreads, onSpreadSelect]);

  return (
    <div ref={spreadViewRef} className="flex flex-col h-full bg-background">
      {/* Header */}
      <SpreadViewHeader
        viewMode={viewMode}
        zoomLevel={zoomLevel}
        columnsPerRow={columnsPerRow}
        onViewModeToggle={handleViewModeToggle}
        onZoomChange={handleZoomChange}
        onColumnsChange={handleColumnsChange}
        enableKeyboardShortcuts={true}
        showViewToggle={showViewToggle}
        leftActions={leftActions}
      />

      {/* Content */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {spreads.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-12 w-12" />}
            title="No spreads yet"
            description={
              canAddSpread
                ? 'Add your first spread to start designing'
                : 'Add spreads in Illustration first'
            }
            action={
              canAddSpread && onSpreadAdd ? (
                <NewSpreadButton variant="solid" label="Add First Spread" onAdd={onSpreadAdd} />
              ) : null
            }
          />
        ) : viewMode === 'edit' ? (
          <>
            {/* Edit Mode: Editor Panel */}
            {selectedSpread && (
              <SpreadEditorPanel
                spread={selectedSpread}
                spreadIndex={selectedIndex}
                zoomLevel={zoomLevel}
                isEditable={isEditable}
                peerLock={peerLock}
                renderItems={renderItems}
                renderImageItem={renderImageItem}
                renderTextItem={renderTextItem}
                renderShapeItem={renderShapeItem}
                renderVideoItem={renderVideoItem}
                renderAudioItem={renderAudioItem}
                renderQuizItem={renderQuizItem}
                renderAutoPicItem={renderAutoPicItem}
                renderAutoAudioItem={renderAutoAudioItem}
                renderImageToolbar={renderImageToolbar}
                renderTextToolbar={renderTextToolbar}
                renderPageToolbar={renderPageToolbar}
                renderShapeToolbar={renderShapeToolbar}
                renderVideoToolbar={renderVideoToolbar}
                renderAudioToolbar={renderAudioToolbar}
                renderAutoPicToolbar={renderAutoPicToolbar}
                renderAutoAudioToolbar={renderAutoAudioToolbar}
                renderRawImage={renderRawImage}
                renderRawTextbox={renderRawTextbox}
                renderRawImageToolbar={renderRawImageToolbar}
                renderRawTextboxToolbar={renderRawTextboxToolbar}
                onSpreadItemAction={handleSpreadItemAction}
                canResizeItem={canResizeItem}
                canDragItem={canDragItem}
                canRotateItem={canRotateItem}
                preventEditRawItem={preventEditRawItem}
                availableLayouts={availableLayouts}
                externalSelectedItemId={externalSelectedItemId}
                onPageSelect={onPageSelect}
                onDeselect={onDeselect}
                onCanvasItemSelect={onCanvasItemSelect}
                pageNumbering={pageNumbering}
                forceLanguageCode={forceLanguageCode}
                expandedAnimation={expandedAnimation}
                expandedAnimationIndex={expandedAnimationIndex}
                allAnimations={allAnimations}
                onCameraZoomGeometryChange={onCameraZoomGeometryChange}
                onMotionLineGeometryChange={onMotionLineGeometryChange}
                drawZoomAreaMode={drawZoomAreaMode}
                onDrawZoomAreaComplete={onDrawZoomAreaComplete}
                onDrawZoomAreaCancel={onDrawZoomAreaCancel}
                smartHitTestEnabled={smartHitTestEnabled}
              />
            )}

            {/* Edit Mode: Thumbnail Filmstrip */}
            <div className="border-t overflow-hidden">
              <SpreadThumbnailList
                ref={filmstripRef}
                spreads={spreads}
                selectedId={selectedSpreadId}
                layout="horizontal"
                peerLock={peerLock}
                spreadIndicatorIds={spreadIndicatorIds}
                renderItems={renderItems}
                renderImageItem={renderImageItem}
                renderTextItem={renderTextItem}
                renderShapeItem={renderShapeItem}
                renderVideoItem={renderVideoItem}
                renderAudioItem={renderAudioItem}
                renderAutoPicItem={renderAutoPicItem}
                renderAutoAudioItem={renderAutoAudioItem}
                renderQuizItem={renderQuizItem}
                renderRawImage={renderRawImage}
                renderRawTextbox={renderRawTextbox}
                canAdd={canAddSpread}
                canReorder={canReorderSpread}
                canDelete={canDeleteSpread}
                onSpreadClick={handleSpreadClick}
                onSpreadDoubleClick={undefined}
                onSpreadReorder={onSpreadReorder}
                onSpreadAdd={onSpreadAdd}
                onDeleteSpread={handleDeleteSpread}
              />
            </div>
          </>
        ) : (
          /* Grid Mode: Thumbnail Grid */
          <SpreadThumbnailList
            ref={filmstripRef}
            spreads={spreads}
            selectedId={selectedSpreadId}
            layout="grid"
            columnsPerRow={columnsPerRow}
            peerLock={peerLock}
            spreadIndicatorIds={spreadIndicatorIds}
            renderItems={renderItems}
            renderImageItem={renderImageItem}
            renderTextItem={renderTextItem}
            renderShapeItem={renderShapeItem}
            renderVideoItem={renderVideoItem}
            renderAudioItem={renderAudioItem}
            renderAutoPicItem={renderAutoPicItem}
            renderAutoAudioItem={renderAutoAudioItem}
            renderQuizItem={renderQuizItem}
            renderRawImage={renderRawImage}
            renderRawTextbox={renderRawTextbox}
            canAdd={canAddSpread}
            canReorder={canReorderSpread}
            canDelete={canDeleteSpread}
            onSpreadClick={handleSpreadClick}
            onSpreadDoubleClick={handleSpreadDoubleClick}
            onSpreadReorder={onSpreadReorder}
            onSpreadAdd={onSpreadAdd}
            onDeleteSpread={handleDeleteSpread}
          />
        )}
      </div>

    </div>
  );
}

export default CanvasSpreadView;
