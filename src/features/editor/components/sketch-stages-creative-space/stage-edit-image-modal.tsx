// stage-edit-image-modal.tsx — store-binding connector for the shared, store-agnostic
// EditImageModal in the Stage space (design README §3.5). Resolves `illustrations` +
// `onUpdateIllustrations` + `pathPrefix` + `imageTitle` from the FOUR-scope target:
//   • base-raw     → styles[i].illustrations        — commit AUTO re-cuts (recropStageBaseSheet)
//   • base-crop    → styles[i].crops[j].illustrations
//   • variant-raw  → variants[vk].illustrations     — commit AUTO re-cuts (recropStageVariantSheet)
//   • variant-crop → variants[vk].crops[j].illustrations
// Mounted only while a target is set, so the store hooks run unconditionally.
//
// ⚡ Raw scopes AUTO re-cut on ANY illustrations change (commit AND version-select) — same
// deliberate invariant as the variant space ("crops[] always match the EFFECTIVE raw" outranks
// preserving picks; a re-cut lands 2 cells, 0 picked; a LOCKED style's re-cut clears the base
// clone via the store setter). Do NOT gate on a new-version check without revisiting that.
//
// Tool availability = SPACE_TOOL_MATRIX['sketch-stage'].edit (inpaint + erasor), landing inpaint.

import { useCallback } from 'react';
import { EditImageModal } from '@/features/editor/components/shared-components/edit-image-modal';
import { SPACE_TOOL_MATRIX } from '@/features/editor/components/shared-components/image-tools-space-matrix';
import { useSketchStageByKey, useSnapshotActions, useSnapshotId } from '@/stores/snapshot-store/selectors';
import type { Illustration } from '@/types/prop-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { effectiveIllustrationUrl } from '@/types/sketch';
import { createLogger } from '@/utils/logger';
import type { StageEditImageTarget } from './sketch-stages-constants';

const log = createLogger('Editor', 'StageEditImageModal');

export interface StageEditImageModalProps {
  target: StageEditImageTarget;
  onClose: () => void;
  /** Opt-in double-write directive — pass-through to EditImageModal (path resolved by the opener,
   *  Phase 04). Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function StageEditImageModal({ target, onClose, saveResource }: StageEditImageModalProps) {
  const stage = useSketchStageByKey(target.stageKey);
  const {
    setSketchStageStyleIllustrations,
    setSketchStageBaseCropIllustrations,
    setSketchStageVariantIllustrations,
    setSketchStageVariantCropIllustrations,
    recropStageBaseSheet,
    recropStageVariantSheet,
  } = useSnapshotActions();
  // Book-edit context (Sketch space is never remix) → attribute AI edits by snapshotId.
  const snapshotId = useSnapshotId();

  // Resolve the bound illustrations list per scope (undefined → the target vanished).
  const style =
    target.scope === 'base-raw' || target.scope === 'base-crop'
      ? stage?.base.styles[target.styleIndex]
      : undefined;
  const variant =
    target.scope === 'variant-raw' || target.scope === 'variant-crop'
      ? stage?.variants.find((v) => v.key === target.variantKey)
      : undefined;

  let bound: Illustration[] | undefined;
  switch (target.scope) {
    case 'base-raw':
      bound = style?.illustrations;
      break;
    case 'base-crop':
      bound = style?.crops[target.cropIndex]?.illustrations;
      break;
    case 'variant-raw':
      bound = variant?.illustrations;
      break;
    case 'variant-crop':
      bound = variant?.crops[target.cropIndex]?.illustrations;
      break;
  }

  const handleUpdate = useCallback(
    (next: Illustration[]) => {
      const { stageKey } = target;
      switch (target.scope) {
        case 'base-raw':
          log.debug('handleUpdate', 'write base style raw set', { stageKey, styleIndex: target.styleIndex, count: next.length });
          setSketchStageStyleIllustrations(stageKey, target.styleIndex, next);
          // Raw changed (commit or version-select) → the 2 cells cut from it are stale → AUTO
          // re-cut overwrites crops[] (0 picked; locked style ⇒ clone clears via the setter).
          log.info('handleUpdate', 'base raw changed — auto re-cut', { stageKey, styleIndex: target.styleIndex });
          recropStageBaseSheet(stageKey, target.styleIndex);
          break;
        case 'base-crop':
          log.debug('handleUpdate', 'write base crop set', { stageKey, styleIndex: target.styleIndex, cropIndex: target.cropIndex, count: next.length });
          setSketchStageBaseCropIllustrations(stageKey, target.styleIndex, target.cropIndex, next);
          break;
        case 'variant-raw':
          log.debug('handleUpdate', 'write variant raw set', { stageKey, variantKey: target.variantKey, count: next.length });
          setSketchStageVariantIllustrations(stageKey, target.variantKey, next);
          log.info('handleUpdate', 'variant raw changed — auto re-cut', { stageKey, variantKey: target.variantKey });
          recropStageVariantSheet(stageKey, target.variantKey);
          break;
        case 'variant-crop':
          log.debug('handleUpdate', 'write variant crop set', { stageKey, variantKey: target.variantKey, cropIndex: target.cropIndex, count: next.length });
          setSketchStageVariantCropIllustrations(stageKey, target.variantKey, target.cropIndex, next);
          break;
      }
      // No persist here: cheap gestures batch to the held-session release-save; the re-cut chain
      // persists its own AI result (persist-after, inside the job slice).
    },
    [
      target,
      setSketchStageStyleIllustrations,
      setSketchStageBaseCropIllustrations,
      setSketchStageVariantIllustrations,
      setSketchStageVariantCropIllustrations,
      recropStageBaseSheet,
      recropStageVariantSheet,
    ],
  );

  // Target gone while the modal was open (import replaced stages / a re-cut shifted indices).
  if (!bound) return null;

  const pathPrefix = (() => {
    switch (target.scope) {
      case 'base-raw':
        return `sketch/stages/${target.stageKey}/base/${target.styleIndex}/raw`;
      case 'base-crop':
        return `sketch/stages/${target.stageKey}/base/${target.styleIndex}/crop/${target.cropIndex}`;
      case 'variant-raw':
        return `sketch/stages/${target.stageKey}/${target.variantKey}/raw`;
      case 'variant-crop':
        return `sketch/stages/${target.stageKey}/${target.variantKey}/crop/${target.cropIndex}`;
    }
  })();

  const imageTitle = (() => {
    switch (target.scope) {
      case 'base-raw':
        return `Stage base sheet — @${target.stageKey} · Style ${target.styleIndex + 1}`;
      case 'base-crop':
        return `Stage crop ${target.cropIndex + 1} — @${target.stageKey} · Style ${target.styleIndex + 1}`;
      case 'variant-raw':
        return `Stage variant sheet — @${target.stageKey}/${target.variantKey}`;
      case 'variant-crop':
        return `Stage crop ${target.cropIndex + 1} — @${target.stageKey}/${target.variantKey}`;
    }
  })();

  return (
    <EditImageModal
      open
      onOpenChange={(open) => !open && onClose()}
      imageTitle={imageTitle}
      illustrations={bound}
      mediaUrl={effectiveIllustrationUrl(bound) ?? ''}
      onUpdateIllustrations={handleUpdate}
      pathPrefix={pathPrefix}
      enabledTools={SPACE_TOOL_MATRIX['sketch-stage'].edit}
      initialTool="inpaint"
      attribution={{ snapshotId: snapshotId ?? undefined }}
      saveResource={saveResource}
    />
  );
}
