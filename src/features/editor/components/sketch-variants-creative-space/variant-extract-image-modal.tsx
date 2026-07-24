// variant-extract-image-modal.tsx — store-binding connector for the shared, store-agnostic
// ExtractImageModal in the Variant space's Crop tab. Mirrors VariantEditImageModal: resolves the
// target cell's `illustrations` + effective url from the CROP-scoped `ExtractImageTarget`, feeds the
// modal a synthesized SpreadImage, and maps its onCreateImages result(s) back to NEW versions of
// that cell (caller-owns-write). Mounted only while a target is set, so the store hooks run
// unconditionally.
//
// Tool availability = SPACE_TOOL_MATRIX['sketch-variant'].extract (['crop']). Landing tab = crop.
// The setter replaces only crops[cropIndex].illustrations — the cell's is_selected pick is
// untouched. Persistence rides the held ENTITY session's release-save (no eager flush, like edit).

import { useCallback, useMemo } from 'react';
import { ExtractImageModal } from '@/features/editor/components/shared-components/extract-image-modal';
import type { ExtractResult } from '@/features/editor/components/shared-components/extract-image-modal';
import { SPACE_TOOL_MATRIX } from '@/features/editor/components/shared-components/image-tools-space-matrix';
import { useCropPresetManager } from '@/features/editor/components/shared-components/use-crop-preset-manager';
import { appendMediaVersions } from '@/features/editor/components/shared-components/append-media-versions';
import { useSketchVariantByKey, useSnapshotActions } from '@/stores/snapshot-store/selectors';
import type { Illustration } from '@/types/prop-types';
import type { Geometry, SpreadImage } from '@/types/spread-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { createLogger } from '@/utils/logger';
import { titleCase, type ExtractImageTarget } from './sketch-variants-constants';

const log = createLogger('Editor', 'VariantExtractImageModal');

/** A standalone candidate cell is its own frame — the crop tab ignores this (box math uses natural
 *  dims), but SpreadImage requires a geometry. Full-frame keeps the contract honest. */
const FULL_FRAME: Geometry = { x: 0, y: 0, w: 100, h: 100 };

/** Stable empty fallback so the memoized illustrations keep constant identity when no cell binds. */
const EMPTY_ILLUSTRATIONS: Illustration[] = [];

/** Effective url for the cell source: selected version → newest → undefined. */
function effectiveUrl(illustrations: Illustration[]): string | undefined {
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url;
}

export interface VariantExtractImageModalProps {
  target: ExtractImageTarget;
  onClose: () => void;
  /** Opt-in double-write directive — pass-through to ExtractImageModal (Background tab; path resolved
   *  by the opener, Phase 04). This space enables the Crop tab only, so v1 has no effective target.
   *  Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function VariantExtractImageModal({ target, onClose, saveResource }: VariantExtractImageModalProps) {
  const variant = useSketchVariantByKey(target.kind, target.entityKey, target.variantKey);
  const { setSketchVariantCropIllustrations } = useSnapshotActions();
  const presets = useCropPresetManager();

  const crop = variant?.raw_sheet?.crops[target.cropIndex];
  // Memo keyed on the (referentially stable) cell node → the onCreateImages dep doesn't churn.
  const illustrations = useMemo(() => crop?.illustrations ?? EMPTY_ILLUSTRATIONS, [crop]);

  const handleCreate = useCallback(
    (results: ExtractResult[]) => {
      if (results.length === 0) return;
      log.info('handleCreate', 'append extracted variant-crop versions', {
        kind: target.kind,
        entityKey: target.entityKey,
        variantKey: target.variantKey,
        cropIndex: target.cropIndex,
        count: results.length,
      });
      // Crop tab = CV cut (no AI provider call) → no ai_request_id provenance to carry.
      const next = appendMediaVersions(illustrations, results.map((r) => ({ media_url: r.media_url })));
      setSketchVariantCropIllustrations(
        target.kind,
        target.entityKey,
        target.variantKey,
        target.cropIndex,
        next,
      );
    },
    [illustrations, target, setSketchVariantCropIllustrations],
  );

  // Target gone while the modal was open (variant removed, or a re-cut/regenerate shifted the cell
  // indices) → nothing to bind.
  if (!crop) return null;

  const image: SpreadImage = {
    id: `sketch-variant-crop-${target.kind}-${target.entityKey}-${target.variantKey}-${target.cropIndex}`,
    title: `${titleCase(target.entityKey)} · ${titleCase(target.variantKey)} — crop ${target.cropIndex + 1}`,
    geometry: FULL_FRAME,
    media_url: effectiveUrl(illustrations),
    illustrations,
  };

  return (
    <ExtractImageModal
      open
      onOpenChange={(open) => !open && onClose()}
      image={image}
      enabledTabs={SPACE_TOOL_MATRIX['sketch-variant'].extract}
      initialTab="crop"
      cropPresets={presets.cropPresets}
      onUpsertCropPreset={presets.onUpsertCropPreset}
      onDeleteCropPreset={presets.onDeleteCropPreset}
      onCreateImages={handleCreate}
      saveResource={saveResource}
    />
  );
}
