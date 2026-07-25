// variant-edit-image-modal.tsx — store-binding connector for the shared, store-agnostic
// EditImageModal in the Variant space (design README §3.4). Mirrors SketchBaseEditImageModal:
// resolves `illustrations` + `onUpdateIllustrations` + `pathPrefix` + `mediaUrl` + `imageTitle`
// from the `EditImageTarget` SCOPE, then feeds the controlled modal. Mounted only while a target is
// set, so the store hooks run unconditionally.
//
// Two scopes (2026-07-16 rework — the raw sheet is VISIBLE + editable in the Raw tab now):
//   • raw  → the 21:9 sheet. Committing an edit AUTO re-cuts the 4 cells (overwrites crops[]).
//   • crop → one of the 4 candidate cells. Edits that cell ONLY — never touches its siblings.
//
// Tool availability = SPACE_TOOL_MATRIX['sketch-variant'].edit (inpaint + erasor) for BOTH scopes.
// Landing = inpaint.

import { useCallback } from 'react';
import { EditImageModal } from '@/features/editor/components/shared-components/edit-image-modal';
import { SPACE_TOOL_MATRIX } from '@/features/editor/components/shared-components/image-tools-space-matrix';
import { useSketchVariantByKey, useSnapshotActions, useSnapshotId } from '@/stores/snapshot-store/selectors';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { createLogger } from '@/utils/logger';
import { titleCase, type EditImageTarget } from './sketch-variants-constants';

const log = createLogger('Editor', 'VariantEditImageModal');

/** Effective url for the display-only seed: selected version → newest → ''. */
function effectiveUrl(illustrations: Illustration[]): string {
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url ?? '';
}

export interface VariantEditImageModalProps {
  target: EditImageTarget;
  onClose: () => void;
  /** Opt-in double-write directive — pass-through to EditImageModal (path resolved by the opener,
   *  Phase 04). Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function VariantEditImageModal({ target, onClose, saveResource }: VariantEditImageModalProps) {
  const variant = useSketchVariantByKey(target.kind, target.entityKey, target.variantKey);
  const { setSketchVariantRawSheetIllustrations, setSketchVariantCropIllustrations, recropVariantSheet } =
    useSnapshotActions();
  // Book-edit context (Sketch space is never remix) → attribute AI edits by snapshotId.
  const snapshotId = useSnapshotId();

  const crop = target.scope === 'crop' ? variant?.raw_sheet?.crops[target.cropIndex] : undefined;
  const illustrations: Illustration[] =
    target.scope === 'raw'
      ? (variant?.raw_sheet?.illustrations ?? [])
      : (crop?.illustrations ?? []);

  const handleUpdate = useCallback(
    (next: Illustration[]) => {
      const ref = { kind: target.kind, entityKey: target.entityKey, variantKey: target.variantKey };
      if (target.scope === 'raw') {
        log.debug('handleUpdate', 'write raw sheet illustrations', { ...ref, count: next.length });
        setSketchVariantRawSheetIllustrations(target.kind, target.entityKey, target.variantKey, next);
        // Changing the RAW sheet invalidates every cell cut from it → auto re-cut overwrites crops[]
        // (4 fresh cells, none picked) from the version just written (recropVariantSheet reads the
        // effective raw synchronously). NO confirm (mirrors base §3.5). Only the raw scope re-cuts —
        // a single-cell edit (else branch) must NOT touch its siblings.
        //
        // ⚡ DELIBERATE (user decision 2026-07-16): the shared modal drives this callback from BOTH
        // `handleCommit` (a real edit) AND `handleSelectVersion` (merely clicking a version thumb),
        // so selecting an older raw version ALSO re-cuts — silently discarding the pick + per-cell
        // edits. Chosen on purpose: the invariant "crops[] always match the EFFECTIVE raw" outranks
        // preserving them, and it keeps parity with sketch-base-edit-image-modal, which has the
        // identical shape. Do NOT "fix" this by gating on a new-version check without revisiting
        // that invariant (regenerate confirms for the same loss; version-select intentionally does not).
        log.info('handleUpdate', 'raw changed (commit or version-select) — auto re-cut', ref);
        recropVariantSheet(ref);
      } else {
        log.debug('handleUpdate', 'write crop illustrations', {
          ...ref,
          cropIndex: target.cropIndex,
          count: next.length,
        });
        setSketchVariantCropIllustrations(
          target.kind,
          target.entityKey,
          target.variantKey,
          target.cropIndex,
          next,
        );
      }
      // No persist here: cheap gestures batch to the held-session release-save (ADR-043 Rev
      // 2026-07-16). The re-cut chain persists its own AI result (persist-after, inside the slice).
    },
    [target, setSketchVariantRawSheetIllustrations, setSketchVariantCropIllustrations, recropVariantSheet],
  );

  // Target gone while the modal was open (variant removed, or a re-cut/regenerate shifted the cell
  // indices) → nothing to bind.
  if (target.scope === 'raw' ? !variant?.raw_sheet : !crop) return null;

  const pathPrefix =
    target.scope === 'raw'
      ? `sketch/variant/${target.kind}/${target.entityKey}/${target.variantKey}/raw`
      : `sketch/variant/${target.kind}/${target.entityKey}/${target.variantKey}/crop/${target.cropIndex}`;

  const imageTitle =
    target.scope === 'raw'
      ? `Variant sheet — ${titleCase(target.entityKey)} · ${titleCase(target.variantKey)}`
      : `Variant crop ${target.cropIndex + 1} — @${target.entityKey}/${target.variantKey}`;

  return (
    <EditImageModal
      open
      onOpenChange={(open) => !open && onClose()}
      imageTitle={imageTitle}
      illustrations={illustrations}
      mediaUrl={effectiveUrl(illustrations)}
      onUpdateIllustrations={handleUpdate}
      pathPrefix={pathPrefix}
      enabledTools={SPACE_TOOL_MATRIX['sketch-variant'].edit}
      initialTool="inpaint"
      attribution={{ snapshotId: snapshotId ?? undefined }}
      saveResource={saveResource}
    />
  );
}
