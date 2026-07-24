// stage-extract-image-modal.tsx — store-binding connector for the shared, store-agnostic
// ExtractImageModal in the Stage space's Crop tab (design README §3.6). CROP scope only
// (base-crop | variant-crop): resolves the target cell's illustrations + effective url, feeds a
// synthesized full-frame SpreadImage, and maps onCreateImages result(s) back to NEW versions of
// that cell (caller-owns-write — appendMediaVersions; the cell's is_selected pick is untouched).
//
// Tool availability = SPACE_TOOL_MATRIX['sketch-stage'].extract (['crop']), landing crop.
// Persistence rides the held STAGE session's release-save (no eager flush — like edit).

import { useCallback, useMemo } from 'react';
import { ExtractImageModal } from '@/features/editor/components/shared-components/extract-image-modal';
import type { ExtractResult } from '@/features/editor/components/shared-components/extract-image-modal';
import { SPACE_TOOL_MATRIX } from '@/features/editor/components/shared-components/image-tools-space-matrix';
import { useCropPresetManager } from '@/features/editor/components/shared-components/use-crop-preset-manager';
import { appendMediaVersions } from '@/features/editor/components/shared-components/append-media-versions';
import { useSketchStageByKey, useSnapshotActions } from '@/stores/snapshot-store/selectors';
import type { Illustration } from '@/types/prop-types';
import type { Geometry, SpreadImage } from '@/types/spread-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { createLogger } from '@/utils/logger';
import type { StageExtractImageTarget } from './sketch-stages-constants';

const log = createLogger('Editor', 'StageExtractImageModal');

/** A standalone cell is its own frame — SpreadImage requires a geometry; full-frame is honest. */
const FULL_FRAME: Geometry = { x: 0, y: 0, w: 100, h: 100 };

/** Stable empty fallback so the memoized illustrations keep constant identity. */
const EMPTY_ILLUSTRATIONS: Illustration[] = [];

function effectiveUrl(illustrations: Illustration[]): string | undefined {
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url;
}

export interface StageExtractImageModalProps {
  target: StageExtractImageTarget;
  onClose: () => void;
  /** Opt-in double-write directive — pass-through to ExtractImageModal (Background tab; path resolved
   *  by the opener, Phase 04). This space enables the Crop tab only, so v1 has no effective target.
   *  Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function StageExtractImageModal({ target, onClose, saveResource }: StageExtractImageModalProps) {
  const stage = useSketchStageByKey(target.stageKey);
  const { setSketchStageBaseCropIllustrations, setSketchStageVariantCropIllustrations } =
    useSnapshotActions();
  const presets = useCropPresetManager();

  const crop =
    target.scope === 'base-crop'
      ? stage?.base.styles[target.styleIndex]?.crops[target.cropIndex]
      : stage?.variants.find((v) => v.key === target.variantKey)?.crops[target.cropIndex];
  // Memo keyed on the (referentially stable) cell node → the onCreateImages dep doesn't churn.
  const illustrations = useMemo(() => crop?.illustrations ?? EMPTY_ILLUSTRATIONS, [crop]);

  const handleCreate = useCallback(
    (results: ExtractResult[]) => {
      if (results.length === 0) return;
      // Crop tab = CV cut (no AI provider call) → no ai_request_id provenance to carry.
      const next = appendMediaVersions(illustrations, results.map((r) => ({ media_url: r.media_url })));
      if (target.scope === 'base-crop') {
        log.info('handleCreate', 'append extracted base-crop versions', {
          stageKey: target.stageKey,
          styleIndex: target.styleIndex,
          cropIndex: target.cropIndex,
          count: results.length,
        });
        setSketchStageBaseCropIllustrations(target.stageKey, target.styleIndex, target.cropIndex, next);
      } else {
        log.info('handleCreate', 'append extracted variant-crop versions', {
          stageKey: target.stageKey,
          variantKey: target.variantKey,
          cropIndex: target.cropIndex,
          count: results.length,
        });
        setSketchStageVariantCropIllustrations(target.stageKey, target.variantKey, target.cropIndex, next);
      }
    },
    [illustrations, target, setSketchStageBaseCropIllustrations, setSketchStageVariantCropIllustrations],
  );

  // Target gone while the modal was open (import replaced stages / a re-cut shifted indices).
  if (!crop) return null;

  const label =
    target.scope === 'base-crop'
      ? `@${target.stageKey} · Style ${target.styleIndex + 1} — crop ${target.cropIndex + 1}`
      : `@${target.stageKey}/${target.variantKey} — crop ${target.cropIndex + 1}`;

  const image: SpreadImage = {
    id:
      target.scope === 'base-crop'
        ? `sketch-stage-base-crop-${target.stageKey}-${target.styleIndex}-${target.cropIndex}`
        : `sketch-stage-variant-crop-${target.stageKey}-${target.variantKey}-${target.cropIndex}`,
    title: label,
    geometry: FULL_FRAME,
    media_url: effectiveUrl(illustrations),
    illustrations,
  };

  return (
    <ExtractImageModal
      open
      onOpenChange={(open) => !open && onClose()}
      image={image}
      enabledTabs={SPACE_TOOL_MATRIX['sketch-stage'].extract}
      initialTab="crop"
      cropPresets={presets.cropPresets}
      onUpsertCropPreset={presets.onUpsertCropPreset}
      onDeleteCropPreset={presets.onDeleteCropPreset}
      onCreateImages={handleCreate}
      saveResource={saveResource}
    />
  );
}
