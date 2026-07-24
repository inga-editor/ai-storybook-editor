// remix-display-canvas-area.tsx — CanvasSpreadView wrapper for the active remix.
// Image layers are the ONE editable exception (selectable + floating Edit toolbar →
// EditImageModal); the other 7 item types stay display-only. NO drag/resize/delete/geometry
// edit, NO spread add/delete/reorder. Image writes go through `updateRemixSpreadImage`.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { toast } from 'sonner';
import { CanvasSpreadView } from '@/features/editor/components/canvas-spread-view';
import { EmptyState } from '@/features/editor/components/canvas-spread-view/empty-state';
import {
  EditableImage,
  EditableTextbox,
  EditableShape,
  EditableVideo,
  EditableAutoPic,
  EditableAudio,
  EditableAutoAudio,
  EditableQuiz,
  EditImageModal,
  SPACE_TOOL_MATRIX,
} from '@/features/editor/components/shared-components';
import { useIllustrationPropRefCandidates } from '@/features/editor/components/shared-components/edit-image-modal';
import { RemixImageToolbar } from './remix-image-toolbar';
import { useRemixActions } from '@/stores/remix-store/selectors';
import { useSpaceViewSlot, useEditorSpaceViewStore } from '@/stores/editor-space-view-store';
import { useLanguageCode } from '@/stores/editor-settings-store';
import { useBookStepTypography, useCurrentBook } from '@/stores/book-store';
import { getTextboxContentForLanguage } from '@/features/editor/utils/textbox-helpers';
import { createLogger } from '@/utils/logger';
import type { Illustration } from '@/types/prop-types';
import type { ItemType, ViewMode } from '@/types/canvas-types';
import type { PageNumberingSettings } from '@/types/editor';
import type { RemixSpread, RemixSpreadImage } from '@/types/remix';
import type { SaveResourceDirective } from '@/types/save-resource';

const log = createLogger('Editor', 'RemixDisplayCanvasArea');

/** Resolve the media_url to persist after an edit: selected version → first version. */
function selectedMediaUrl(illustrations: Illustration[]): string | undefined {
  return illustrations.find((v) => v.is_selected)?.media_url ?? illustrations[0]?.media_url;
}

/** Local mount-state for the Edit modal (image identified by id → derived live from `spreads`). */
type EditModalState = { kind: 'none' } | { kind: 'edit'; spreadId: string; imageId: string };

const RENDER_ITEMS: ItemType[] = [
  'image',
  'textbox',
  'shape',
  'video',
  'auto_pic',
  'audio',
  'auto_audio',
  'quiz',
];

const noop = () => {};

interface Props {
  spreads: RemixSpread[];
  /** Active remix id — binds the image-edit persist (`updateRemixSpreadImage`). */
  remixId: string;
  pageNumbering?: PageNumberingSettings | null;
}

export function RemixDisplayCanvasArea({ spreads, remixId, pageNumbering }: Props) {
  const book = useCurrentBook();
  const bookId = book?.id ?? '';
  const langCode = useLanguageCode();
  const bookTypography = useBookStepTypography('retouch');
  const state = useSpaceViewSlot(bookId, 'remix');
  const patchSpace = useEditorSpaceViewStore((s) => s.patchSpace);
  const { updateRemixSpreadImage } = useRemixActions();

  // Inpaint reference candidates (book prop variants). Remix reuses the illustration props (user
  // decision 2026-07-22) — NOT remix.props (crop-sheet clone). Hook runs before any early return.
  const referenceImageCandidates = useIllustrationPropRefCandidates();

  const activeSpreadId = state.activeSpreadId ?? null;
  const viewMode: ViewMode = state.viewMode ?? 'edit';
  const zoomLevel = state.zoomLevel ?? 100;
  const columnsPerRow = state.columnsPerRow ?? 4;

  // ── Edit-image modal (local) — image derived LIVE from `spreads` so commits reflect instantly
  //    (mirrors SpreadsMainView's generate/extract modal derivation; avoids a stale snapshot). ──
  const [editModal, setEditModal] = useState<EditModalState>({ kind: 'none' });

  const editImage = useMemo<RemixSpreadImage | null>(() => {
    if (editModal.kind !== 'edit') return null;
    const spread = spreads.find((s) => s.id === editModal.spreadId);
    return spread?.images.find((img) => img.id === editModal.imageId) ?? null;
  }, [editModal, spreads]);

  // Phase 04: opt-in double-write for the remix image edit. Backend B (remix) — ABSOLUTE
  // `table:remixes` anchor, NO snapshot root (built literal; withSnapshotRoot would pass a
  // `table:` path through unchanged). Memoized so the modal's tab-hook deps don't churn per render.
  const editSaveResource = useMemo<SaveResourceDirective | undefined>(() => {
    if (editModal.kind !== 'edit') return undefined;
    return {
      type: 'image_version',
      path: `table:remixes/id:${remixId}/col:illustration/spread:${editModal.spreadId}/key:images/find:id=${editModal.imageId}`,
      action: 'edit',
    };
  }, [editModal, remixId]);

  // Persist one image-layer patch; store action owns optimistic set + rollback.
  const handleImageUpdate = useCallback(
    (spreadId: string, imageId: string, patch: Partial<RemixSpreadImage>) => {
      updateRemixSpreadImage(remixId, spreadId, imageId, patch).catch((err) => {
        log.error('handleImageUpdate', 'persist failed', {
          remixId,
          spreadId,
          imageId,
          error: err instanceof Error ? err.message : String(err),
        });
        toast.error('Lưu ảnh thất bại. Đã hoàn tác thay đổi.');
      });
    },
    [remixId, updateRemixSpreadImage],
  );

  // Reset selectedSpreadId when active remix switches (id no longer in list).
  useEffect(() => {
    if (!bookId) return;
    if (activeSpreadId && !spreads.find((s) => s.id === activeSpreadId)) {
      log.debug('reset-selected-spread', 'active spread missing', { prev: activeSpreadId });
      patchSpace(bookId, 'remix', { activeSpreadId: spreads[0]?.id ?? null });
    }
  }, [bookId, spreads, activeSpreadId, patchSpace]);

  if (spreads.length === 0) {
    return (
      <EmptyState
        icon={<ImageOff className="h-12 w-12" />}
        title="No spreads in this remix"
        description="Remix was cloned without playable spreads."
      />
    );
  }

  return (
    <>
    <CanvasSpreadView<RemixSpread>
      spreads={spreads}
      selectedSpreadId={activeSpreadId ?? spreads[0].id}
      viewMode={viewMode}
      zoomLevel={zoomLevel}
      columnsPerRow={columnsPerRow}
      onSpreadSelect={(id) => patchSpace(bookId, 'remix', { activeSpreadId: id })}
      onViewModeChange={(mode) => patchSpace(bookId, 'remix', { viewMode: mode })}
      onZoomChange={(z) => patchSpace(bookId, 'remix', { zoomLevel: z })}
      onColumnsChange={(c) => patchSpace(bookId, 'remix', { columnsPerRow: c })}
      // isEditable enables the selection/toolbar machinery; per-item gates below keep all
      // 7 non-image types display-only. NO geometry edit (no onUpdateSpreadItem), NO
      // drag/resize/delete, NO spread add/delete/reorder.
      isEditable={true}
      canAddSpread={false}
      canDeleteSpread={false}
      canReorderSpread={false}
      canResizeItem={false}
      canDragItem={false}
      preventEditRawItem={true}
      pageNumbering={pageNumbering ?? undefined}
      renderItems={RENDER_ITEMS}
      renderImageItem={(ctx) => (
        // Image = the ONE editable layer: selectable + floating Edit toolbar (no drag/resize).
        <EditableImage
          image={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={ctx.isSelected}
          isSelectable={ctx.isSpreadSelected}
          isEditable={ctx.isSpreadSelected}
          onSelect={ctx.onSelect}
        />
      )}
      renderImageToolbar={(ctx) => (
        <RemixImageToolbar
          context={{
            item: ctx.item,
            selectedGeometry: ctx.selectedGeometry,
            canvasRef: ctx.canvasRef,
            onEditImage: () =>
              setEditModal({ kind: 'edit', spreadId: ctx.spreadId, imageId: ctx.item.id }),
            // Phase 2: inject onGenerateImage + mount GenerateImageModal once it is
            // generalized to be store-agnostic (currently snapshot-bound).
          }}
        />
      )}
      renderTextItem={(ctx) => {
        const resolved = getTextboxContentForLanguage(
          ctx.item as unknown as Record<string, unknown>,
          langCode,
          bookTypography,
        );
        if (!resolved) return null;
        return (
          <EditableTextbox
            textboxContent={resolved.content}
            index={ctx.itemIndex}
            zIndex={ctx.zIndex}
            isSelected={false}
            isSelectable={false}
            isEditable={false}
            onSelect={noop}
            onTextChange={noop as (text: string) => void}
            onEditingChange={noop as (isEditing: boolean) => void}
          />
        );
      }}
      renderShapeItem={(ctx) => (
        <EditableShape
          shape={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderVideoItem={(ctx) => (
        <EditableVideo
          video={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderAutoPicItem={(ctx) => (
        <EditableAutoPic
          autoPic={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderAudioItem={(ctx) => (
        <EditableAudio
          audio={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
      renderAutoAudioItem={(ctx) => (
        // Divergence per design §3.6 — keep isEditable=true so icon stays visible.
        <EditableAutoAudio
          autoAudio={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={true}
          onSelect={noop}
        />
      )}
      renderQuizItem={(ctx) => (
        <EditableQuiz
          quiz={ctx.item}
          index={ctx.itemIndex}
          zIndex={ctx.zIndex}
          isSelected={false}
          isEditable={false}
          onSelect={noop}
        />
      )}
    />

    {/* Edit-image workspace (store-agnostic, controlled). Mounted only while an image is open;
        image derived live from `spreads` so committed versions appear without reopening. */}
    {editModal.kind === 'edit' && editImage && (
      <EditImageModal
        open
        onOpenChange={(o) => {
          if (!o) setEditModal({ kind: 'none' });
        }}
        imageTitle={editImage.title ?? 'Image'}
        illustrations={editImage.illustrations ?? []}
        mediaUrl={editImage.media_url ?? ''}
        pathPrefix={`remix/${remixId}/${editImage.id}/edited`}
        enabledTools={SPACE_TOOL_MATRIX.remix.edit}
        initialTool="inpaint"
        referenceImageCandidates={referenceImageCandidates}
        attribution={{ remixId }}
        saveResource={editSaveResource}
        onUpdateIllustrations={(next) =>
          handleImageUpdate(editModal.spreadId, editModal.imageId, {
            illustrations: next,
            media_url: selectedMediaUrl(next),
          })
        }
      />
    )}
    </>
  );
}
