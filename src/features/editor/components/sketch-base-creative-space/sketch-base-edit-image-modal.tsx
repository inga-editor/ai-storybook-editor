// sketch-base-edit-image-modal.tsx — Store-binding connector for the shared, store-agnostic
// EditImageModal in the Base space (design README §3.5). Mirrors IllustrationEditImageModal /
// RetouchEditImageModal: resolves `illustrations` + `onUpdateIllustrations` + `pathPrefix` +
// `mediaUrl` + `imageTitle` from the `EditImageTarget` scope, then feeds the controlled modal.
// Mounted only while a target is set, so the store hooks run unconditionally.
//
// Tool availability REUSES ToolSpace 'sketch' (SPACE_TOOL_MATRIX.sketch.edit = inpaint + erasor)
// — no new matrix column (design decision §4.5, KISS). Landing tool = inpaint.

import { useCallback } from 'react';
import { EditImageModal } from '@/features/editor/components/shared-components/edit-image-modal';
import { SPACE_TOOL_MATRIX } from '@/features/editor/components/shared-components/image-tools-space-matrix';
import { useSketchBaseStyles, useSnapshotActions, useSnapshotId } from '@/stores/snapshot-store/selectors';
import { titleCase } from '@/features/editor/components/sketch-variants-creative-space/sketch-variants-constants';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { deriveSheetKindFromKey } from '@/types/sketch';
import { createLogger } from '@/utils/logger';
import { nounForKind, type EditImageTarget } from './sketch-base-constants';
import { persistBaseEntityCloneIfLocked } from './persist-base-entity-clone';

const log = createLogger('Editor', 'SketchBaseEditImageModal');

/** Effective url for the display-only seed: selected version → newest → ''. */
function effectiveUrl(illustrations: Illustration[]): string {
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? '';
}

export interface SketchBaseEditImageModalProps {
  target: EditImageTarget;
  onClose: () => void;
  /** Opt-in double-write directive — pass-through to EditImageModal (path resolved by the opener,
   *  Phase 04). Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function SketchBaseEditImageModal({ target, onClose, saveResource }: SketchBaseEditImageModalProps) {
  const styles = useSketchBaseStyles(target.group);
  const { setSketchBaseStyleIllustrations, setSketchBaseCropIllustrations, recropBaseSheet } =
    useSnapshotActions();
  // Storage folder + title kind = the group's kind (derived from the key — the same fallback the
  // job slice uses; folders are keyed by kind, groups are told apart by the node they write).
  const kind = deriveSheetKindFromKey(target.group);
  // Book-edit context (Sketch space is never remix) → attribute AI edits by snapshotId.
  const snapshotId = useSnapshotId();
  const style = styles[target.styleIndex];

  const illustrations: Illustration[] =
    target.scope === 'raw'
      ? (style?.illustrations ?? [])
      : (style?.crops.find((c) => c.key === target.entityKey)?.illustrations ?? []);

  const handleUpdate = useCallback(
    (next: Illustration[]) => {
      if (target.scope === 'raw') {
        log.debug('handleUpdate', 'persist raw sheet illustrations', {
          group: target.group,
          styleIndex: target.styleIndex,
          count: next.length,
        });
        setSketchBaseStyleIllustrations(target.group, target.styleIndex, next);
        // Editing the RAW sheet invalidates every crop → auto re-crop overwrites styles[i].crops[]
        // from the freshly-written raw (recropBaseSheet reads the effective raw synchronously). Only
        // the raw scope re-crops; a single-crop edit (else branch) must NOT touch its siblings.
        log.info('handleUpdate', 'raw edited — auto re-crop', {
          group: target.group,
          styleIndex: target.styleIndex,
        });
        recropBaseSheet(target.group, target.styleIndex);
      } else {
        log.debug('handleUpdate', 'persist crop illustrations', {
          group: target.group,
          styleIndex: target.styleIndex,
          entityKey: target.entityKey,
          count: next.length,
        });
        setSketchBaseCropIllustrations(target.group, target.styleIndex, target.entityKey, next);
        // LOCKED style → the setter re-cloned this crop into the entity's base variant (grain B,
        // rtype 14) — flush that entity collection now; the sheet release-save only covers grain A.
        void persistBaseEntityCloneIfLocked(target.group, target.styleIndex, target.entityKey);
      }
    },
    [target, setSketchBaseStyleIllustrations, setSketchBaseCropIllustrations, recropBaseSheet],
  );

  // Style removed while the modal was open → nothing to bind; render nothing (parent closes).
  if (!style) return null;

  const pathPrefix =
    target.scope === 'raw'
      ? `sketch/base/${kind}/${target.styleIndex}/raw`
      : `sketch/base/${kind}/${target.styleIndex}/crop/${target.entityKey}`;

  const imageTitle =
    target.scope === 'raw'
      ? `Base sheet — ${titleCase(nounForKind(kind))} · Style ${target.styleIndex + 1}`
      : `Base crop — ${titleCase(target.entityKey)}`;

  return (
    <EditImageModal
      open
      onOpenChange={(open) => !open && onClose()}
      imageTitle={imageTitle}
      illustrations={illustrations}
      mediaUrl={effectiveUrl(illustrations)}
      onUpdateIllustrations={handleUpdate}
      pathPrefix={pathPrefix}
      enabledTools={SPACE_TOOL_MATRIX.sketch.edit}
      initialTool="inpaint"
      attribution={{ snapshotId: snapshotId ?? undefined }}
      saveResource={saveResource}
    />
  );
}
