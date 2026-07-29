// spread-thumbnail-list.tsx
'use client';

import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { cn } from '@/utils/utils';
import { SpreadThumbnail } from './spread-thumbnail';
import { NewSpreadButton, type SpreadType } from './new-spread-button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type {
  BaseSpread,
  ItemType,
  ThumbnailListLayout,
  ImageItemContext,
  TextItemContext,
  ShapeItemContext,
  VideoItemContext,
  AudioItemContext,
  AutoAudioItemContext,
  QuizItemContext,
  AutoPicItemContext,
} from '@/types/canvas-types';
import { COLUMNS } from '@/constants/spread-constants';

export interface SpreadThumbnailListRef {
  /** Trigger delete for a spread by id — shows confirm dialog if spread has content. */
  triggerDelete: (spreadId: string) => void;
}

interface SpreadThumbnailListProps<TSpread extends BaseSpread> {
  // Data
  spreads: TSpread[];
  selectedId: string | null;

  // Layout
  layout: ThumbnailListLayout;
  columnsPerRow?: number;

  // Render configuration (optional - skip rendering if not provided)
  renderItems: ItemType[];
  renderImageItem?: (context: ImageItemContext<TSpread>) => ReactNode;
  renderTextItem?: (context: TextItemContext<TSpread>) => ReactNode;
  renderShapeItem?: (context: ShapeItemContext<TSpread>) => ReactNode;
  renderVideoItem?: (context: VideoItemContext<TSpread>) => ReactNode;
  renderAudioItem?: (context: AudioItemContext<TSpread>) => ReactNode;
  renderAutoAudioItem?: (context: AutoAudioItemContext<TSpread>) => ReactNode;
  renderQuizItem?: (context: QuizItemContext<TSpread>) => ReactNode;
  renderAutoPicItem?: (context: AutoPicItemContext<TSpread>) => ReactNode;

  // Raw item render functions (illustration layer)
  renderRawImage?: (context: ImageItemContext<TSpread>) => ReactNode;
  renderRawTextbox?: (context: TextItemContext<TSpread>) => ReactNode;

  // Collab peer-lock config (opt-in) — forwarded to each SpreadThumbnail so a spread held by
  // another editor dims + shows a lock badge. Omitted by non-collab spaces.
  peerLock?: { step: number; resourceType: number };

  /** Opt-in dot indicator (Actors space) — spreads whose id is in this set show a
   *  small dot on their thumbnail. Omitted → no dot, unchanged for other spaces. */
  spreadIndicatorIds?: Set<string>;

  // Feature flags
  canAdd: boolean;
  canReorder: boolean;
  canDelete: boolean;

  // Callbacks
  onSpreadClick: (spreadId: string) => void;
  onSpreadDoubleClick?: (spreadId: string) => void;
  onSpreadReorder?: (fromIndex: number, toIndex: number) => void;
  onSpreadAdd?: (type: SpreadType) => void;
  onDeleteSpread?: (spreadId: string) => void;
  checkSpreadHasContent?: (spread: TSpread) => boolean;
}

// forwardRef with generic props — cast required because forwardRef doesn't support generic components
export const SpreadThumbnailList = forwardRef(function SpreadThumbnailListInner<TSpread extends BaseSpread>({
  spreads,
  selectedId,
  layout,
  columnsPerRow = COLUMNS.DEFAULT,
  renderItems,
  renderImageItem,
  renderTextItem,
  renderShapeItem,
  renderVideoItem,
  renderAudioItem,
  renderAutoAudioItem,
  renderQuizItem,
  renderAutoPicItem,
  renderRawImage,
  renderRawTextbox,
  peerLock,
  spreadIndicatorIds,
  canAdd,
  canReorder,
  canDelete,
  onSpreadClick,
  onSpreadDoubleClick,
  onSpreadReorder,
  onSpreadAdd,
  onDeleteSpread,
  checkSpreadHasContent,
}: SpreadThumbnailListProps<TSpread>, ref: React.ForwardedRef<SpreadThumbnailListRef>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TSpread | null>(null);

  // Auto-scroll selected thumbnail into view
  useEffect(() => {
    if (!selectedId || !containerRef.current) return;

    const selected = containerRef.current.querySelector(`[data-spread-id="${selectedId}"]`);
    selected?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedId]);

  // Helper: Check if spread has content.
  // Checks both raw layers (illustration phase) and playable layers (retouch phase).
  const hasDefaultContent = useCallback((spread: TSpread) => {
    return (
      (spread.raw_images?.length ?? 0) > 0 ||
      (spread.raw_textboxes?.length ?? 0) > 0 ||
      spread.images.length > 0 ||
      spread.textboxes.length > 0 ||
      (spread.shapes?.length ?? 0) > 0 ||
      (spread.videos?.length ?? 0) > 0 ||
      (spread.audios?.length ?? 0) > 0 ||
      (spread.quizzes?.length ?? 0) > 0 ||
      (spread.auto_pics?.length ?? 0) > 0 ||
      (spread.auto_audios?.length ?? 0) > 0
    );
  }, []);

  // Delete handler with confirmation
  const handleDelete = useCallback((spread: TSpread) => {
    const hasContent = checkSpreadHasContent?.(spread) ?? hasDefaultContent(spread);

    if (hasContent) {
      setConfirmDelete(spread);
    } else {
      onDeleteSpread?.(spread.id);
    }
  }, [checkSpreadHasContent, hasDefaultContent, onDeleteSpread]);

  // Expose triggerDelete so CanvasSpreadView keyboard path can delegate here.
  // Placed AFTER handleDelete so deps are resolvable; deps array re-binds imperative
  // ref when spreads or handleDelete identity changes.
  useImperativeHandle(
    ref,
    () => ({
      triggerDelete: (spreadId: string) => {
        const spread = spreads.find((s) => s.id === spreadId);
        if (spread) handleDelete(spread);
      },
    }),
    [spreads, handleDelete],
  );

  // Confirm delete handler
  const confirmDeleteHandler = useCallback(() => {
    if (confirmDelete) {
      onDeleteSpread?.(confirmDelete.id);
      setConfirmDelete(null);
    }
  }, [confirmDelete, onDeleteSpread]);

  // Drag-drop handlers
  const handleDragStart = (spreadId: string) => {
    if (!canReorder) return;
    setDraggedId(spreadId);
  };

  const handleDragOver = (spreadId: string) => {
    if (!canReorder || spreadId === draggedId) return;
    setDropTargetId(spreadId);
  };

  const handleDragEnd = () => {
    if (draggedId && dropTargetId && draggedId !== dropTargetId) {
      const fromIndex = spreads.findIndex((s) => s.id === draggedId);
      const toIndex = spreads.findIndex((s) => s.id === dropTargetId);
      onSpreadReorder?.(fromIndex, toIndex);
    }
    setDraggedId(null);
    setDropTargetId(null);
  };

  // Keyboard navigation handler
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!selectedId) return;

    const currentIndex = spreads.findIndex(s => s.id === selectedId);
    if (currentIndex === -1) return;

    const scrollIntoView = (index: number) => {
      if (!containerRef.current) return;
      const target = containerRef.current.querySelector(`[data-spread-id="${spreads[index].id}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    };

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        if (currentIndex > 0) {
          onSpreadClick(spreads[currentIndex - 1].id);
          scrollIntoView(currentIndex - 1);
        }
        break;

      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        if (currentIndex < spreads.length - 1) {
          onSpreadClick(spreads[currentIndex + 1].id);
          scrollIntoView(currentIndex + 1);
        }
        break;

      case 'Home':
        event.preventDefault();
        onSpreadClick(spreads[0].id);
        scrollIntoView(0);
        break;

      case 'End':
        event.preventDefault();
        onSpreadClick(spreads[spreads.length - 1].id);
        scrollIntoView(spreads.length - 1);
        break;

      case 'Enter':
        if (layout === 'grid') {
          onSpreadDoubleClick?.(selectedId);
        }
        break;
    }
  }, [selectedId, spreads, layout, onSpreadClick, onSpreadDoubleClick]);

  const isHorizontal = layout === 'horizontal';
  const thumbnailSize = isHorizontal ? 'small' : 'medium';

  // Defensive: empty state is owned by parent (CanvasSpreadView renders EmptyState and
  // skips mounting this list). If contract is violated, render nothing.
  if (spreads.length === 0) {
    return null;
  }

  return (
    <>
      <div
        ref={containerRef}
        role="listbox"
        tabIndex={0}
        aria-label="Spread thumbnails"
        aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
        onKeyDown={handleKeyDown}
        className={cn(
          isHorizontal
            ? 'flex gap-2 overflow-x-auto p-2 scroll-snap-x scroll-snap-mandatory'
            : 'grid gap-4 p-4 overflow-y-auto items-start',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset',
        )}
        style={!isHorizontal ? {
          gridTemplateColumns: `repeat(${columnsPerRow}, 1fr)`,
        } : undefined}
      >
        {spreads.map((spread, index) => (
          <div key={spread.id} data-spread-id={spread.id}>
            <SpreadThumbnail
              spread={spread}
              spreadIndex={index}
              isSelected={spread.id === selectedId}
              size={thumbnailSize}
              renderItems={renderItems}
              renderImageItem={renderImageItem}
              renderTextItem={renderTextItem}
              renderShapeItem={renderShapeItem}
              renderVideoItem={renderVideoItem}
              renderAudioItem={renderAudioItem}
              renderAutoAudioItem={renderAutoAudioItem}
              renderQuizItem={renderQuizItem}
              renderAutoPicItem={renderAutoPicItem}
              renderRawImage={renderRawImage}
              renderRawTextbox={renderRawTextbox}
              peerLock={peerLock}
              showIndicatorDot={spreadIndicatorIds?.has(spread.id) ?? false}
              isDragEnabled={canReorder}
              isDragging={spread.id === draggedId}
              isDropTarget={spread.id === dropTargetId}
              onClick={() => onSpreadClick(spread.id)}
              onDoubleClick={() => onSpreadDoubleClick?.(spread.id)}
              onDelete={() => handleDelete(spread)}
              canDelete={canDelete}
              isLastSpread={spreads.length === 1}
              onDragStart={() => handleDragStart(spread.id)}
              onDragOver={() => handleDragOver(spread.id)}
              onDragEnd={handleDragEnd}
            />
          </div>
        ))}

        {canAdd && onSpreadAdd && (
          <NewSpreadButton size={thumbnailSize} onAdd={onSpreadAdd} />
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={confirmDelete !== null} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete spread?</AlertDialogTitle>
            <AlertDialogDescription>
              This spread has content. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteHandler} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}) as <TSpread extends BaseSpread>(
  props: SpreadThumbnailListProps<TSpread> & { ref?: React.Ref<SpreadThumbnailListRef> }
) => React.ReactElement;

export default SpreadThumbnailList;
