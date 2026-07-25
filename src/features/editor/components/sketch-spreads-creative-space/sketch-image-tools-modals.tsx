// sketch-image-tools-modals.tsx — mounts the SHARED Edit/Extract image modals for a selected
// sketch page image and maps their results back to a NEW page-image version (caller-owns-write).
// Extracted from SketchSpreadCanvas to keep that file under the size cap; this is the single place
// the sketch↔shared-modal adapters are wired.
//
// The parent gates mounting (only when an image is selected AND no generate job is running), so
// this component can assume a live `image`. It never touches the sketch store directly — it emits
// the resolved url(s) + (Edit path) the committed version's provenance via `onPersistVersion`,
// which the parent turns into addSketchSpreadImageVersion(spreadId, image.type, url, meta).
'use client';

import { useMemo } from 'react';
import { EditImageModal } from '@/features/editor/components/shared-components/edit-image-modal/edit-image-modal';
import { ExtractImageModal } from '@/features/editor/components/shared-components/extract-image-modal/extract-image-modal';
import { SPACE_TOOL_MATRIX } from '@/features/editor/components/shared-components/image-tools-space-matrix';
import { useSnapshotId } from '@/stores/snapshot-store/selectors';
import { SKETCH_PAGE_GEOMETRY } from '@/types/sketch';
import type { SketchSpreadImage } from '@/types/sketch';
import type { CropPreset } from '@/types/editor';
import type { SaveResourceDirective } from '@/types/save-resource';
import { buildImageVersionSaveResource } from '@/utils/save-resource-path';
import { createLogger } from '@/utils/logger';
import {
  toIllustrations,
  classifyEditCommit,
  toSpreadImage,
  type PersistVersionMeta,
} from './sketch-image-modal-adapters';

const log = createLogger('Editor', 'SketchImageToolsModals');

export interface SketchImageToolsModalsProps {
  /** Which shared modal to mount for the selected page image. */
  activeModal: 'edit' | 'extract';
  /** The live selected page image (its `illustrations` are the version history). */
  image: SketchSpreadImage;
  /** Effective (currently-selected) media url of the page image. */
  imageUrl: string | null;
  /** 1-based page ordinal for the modal title. */
  ordinal: number;
  spreadId: string;
  cropPresets: CropPreset[] | undefined;
  onUpsertCropPreset: (preset: CropPreset) => void;
  onDeleteCropPreset: (presetId: string) => void;
  /** Append `url` as a new version of this page image (parent owns the store write). `meta` carries
   *  the committed version's provenance (Edit path only — Extract crops have none). */
  onPersistVersion: (url: string, meta?: PersistVersionMeta) => void;
  /** Re-select an EXISTING version (flip is_selected) when the Edit modal re-picks an older
   *  variant — parent owns the store write. */
  onSelectVersion: (url: string) => void;
  /** Close the active modal (clears the parent's activeModal). */
  onClose: () => void;
}

export function SketchImageToolsModals({
  activeModal,
  image,
  imageUrl,
  ordinal,
  spreadId,
  cropPresets,
  onUpsertCropPreset,
  onDeleteCropPreset,
  onPersistVersion,
  onSelectVersion,
  onClose,
}: SketchImageToolsModalsProps) {
  // Book-edit context (Sketch space is never remix) → attribute AI edits by snapshotId.
  const snapshotId = useSnapshotId();

  // Phase 04: opt-in saveResource for the Edit path — a sketch page-image edit writes a new
  // image_version at that page node (`col:sketch/spread/key:images/find:id`). Undefined snapshot ⇒
  // omit. Memoized so a fresh directive object per render doesn't churn the modal's tab-hook deps.
  const editSaveResource = useMemo<SaveResourceDirective | undefined>(
    () =>
      snapshotId
        ? buildImageVersionSaveResource(
            `col:sketch/spread:${spreadId}/key:images/find:id=${image.id}`,
            snapshotId,
            'edit',
          )
        : undefined,
    [snapshotId, spreadId, image.id],
  );

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  if (activeModal === 'edit') {
    return (
      <EditImageModal
        open
        onOpenChange={handleOpenChange}
        imageTitle={`Spread page ${ordinal} sketch`}
        illustrations={toIllustrations(image.illustrations)}
        mediaUrl={imageUrl ?? ''}
        pathPrefix={`sketch/${spreadId}/${image.type}/edited`}
        enabledTools={SPACE_TOOL_MATRIX.sketch.edit}
        initialTool="inpaint"
        attribution={{ snapshotId: snapshotId ?? undefined }}
        saveResource={editSaveResource}
        onUpdateIllustrations={(next) => {
          // The modal emits this for BOTH a fresh edit (new url → append a version) AND any
          // variant re-selection (existing url → flip is_selected). Route each to its own write;
          // dedupe append against the WHOLE version list so re-selection never re-appends.
          const commit = classifyEditCommit(
            next,
            image.illustrations.map((i) => i.media_url),
          );
          if (commit.kind === 'noop') {
            log.debug('onUpdateIllustrations', 'edit commit no-op', { pageType: image.type });
            return;
          }
          if (commit.kind === 'select') {
            log.info('onUpdateIllustrations', 're-select existing page-image version', {
              pageType: image.type,
            });
            onSelectVersion(commit.url);
            return;
          }
          // Provenance rides along: the modal's committed entry carries type='edited' +
          // original_url (+ ai_request_id when the tool actually called AI). classifyEditCommit
          // already omits absent keys, so the rest-spread IS the meta — nothing fabricated.
          const { kind: _kind, url, ...meta } = commit;
          log.info('onUpdateIllustrations', 'append edited page-image version', {
            pageType: image.type,
            // Boolean only — never log the id value.
            hasAiRequestId: !!meta.aiRequestId,
          });
          onPersistVersion(url, meta);
        }}
      />
    );
  }

  // Phase 04 RESERVED: NO saveResource on Extract — the sketch Extract exposes the Crop tab only
  // (CV cut, no AI provider call → no anchor to double-write). The extracted cells persist as new
  // page-image versions via onCreateImages/onPersistVersion (client-owned). The 'create' anchor
  // (`col:sketch/spread/key:images/find:id`) is reserved until an AI Extract seam is enabled here.
  return (
    <ExtractImageModal
      open
      onOpenChange={handleOpenChange}
      image={toSpreadImage(image, SKETCH_PAGE_GEOMETRY[image.type], imageUrl)}
      enabledTabs={SPACE_TOOL_MATRIX.sketch.extract}
      initialTab="crop"
      cropPresets={cropPresets}
      onUpsertCropPreset={onUpsertCropPreset}
      onDeleteCropPreset={onDeleteCropPreset}
      onCreateImages={(results) => {
        log.info('onCreateImages', 'append extracted page-image versions', {
          count: results.length,
          pageType: image.type,
        });
        results.forEach((r) => onPersistVersion(r.media_url));
      }}
    />
  );
}

export default SketchImageToolsModals;
