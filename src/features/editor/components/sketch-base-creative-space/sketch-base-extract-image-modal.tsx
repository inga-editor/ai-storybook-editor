// sketch-base-extract-image-modal.tsx — store-binding connector for the shared, store-agnostic
// ExtractImageModal in the Base space's Crop tab. Mirrors SketchBaseEditImageModal: resolves the
// target crop's `illustrations` + effective url from the `ExtractImageTarget`, feeds the modal a
// synthesized SpreadImage, and maps its onCreateImages result(s) back to NEW versions of that crop
// (caller-owns-write). Mounted only while a target is set, so the store hooks run unconditionally.
//
// Tool availability REUSES ToolSpace 'sketch' (SPACE_TOOL_MATRIX.sketch.extract = ['crop']) — no new
// matrix column. Landing tab = crop. SHEET persistence (grain A) rides the held session's
// release-save; a write on the LOCKED style additionally flushes the re-cloned entity node
// (grain B — persistBaseEntityCloneIfLocked), same as the crop-edit path.

import { useCallback, useMemo } from 'react';
import { ExtractImageModal } from '@/features/editor/components/shared-components/extract-image-modal';
import type { ExtractResult } from '@/features/editor/components/shared-components/extract-image-modal';
import { SPACE_TOOL_MATRIX } from '@/features/editor/components/shared-components/image-tools-space-matrix';
import { useCropPresetManager } from '@/features/editor/components/shared-components/use-crop-preset-manager';
import { appendMediaVersions } from '@/features/editor/components/shared-components/append-media-versions';
import { useSketchBaseStyles, useSnapshotActions } from '@/stores/snapshot-store/selectors';
import { titleCase } from '@/features/editor/components/sketch-variants-creative-space/sketch-variants-constants';
import type { Illustration } from '@/types/prop-types';
import type { Geometry, SpreadImage } from '@/types/spread-types';
import type { SaveResourceDirective } from '@/types/save-resource';
import { createLogger } from '@/utils/logger';
import { type ExtractImageTarget } from './sketch-base-constants';
import { persistBaseEntityCloneIfLocked } from './persist-base-entity-clone';

const log = createLogger('Editor', 'SketchBaseExtractImageModal');

/** A standalone crop is its own frame — the crop tab ignores this (box math uses natural dims), but
 *  SpreadImage requires a geometry. Full-frame keeps the contract honest. */
const FULL_FRAME: Geometry = { x: 0, y: 0, w: 100, h: 100 };

/** Stable empty fallback so the memoized illustrations keep constant identity when no crop binds. */
const EMPTY_ILLUSTRATIONS: Illustration[] = [];

/** Effective url for the crop source: selected version → newest → undefined. */
function effectiveUrl(illustrations: Illustration[]): string | undefined {
  return illustrations.find((i) => i.is_selected)?.media_url ?? illustrations[0]?.media_url;
}

export interface SketchBaseExtractImageModalProps {
  target: ExtractImageTarget;
  onClose: () => void;
  /** Opt-in double-write directive — pass-through to ExtractImageModal (Background tab; path resolved
   *  by the opener, Phase 04). This space enables the Crop tab only, so v1 has no effective target.
   *  Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function SketchBaseExtractImageModal({ target, onClose, saveResource }: SketchBaseExtractImageModalProps) {
  const styles = useSketchBaseStyles(target.group);
  const { setSketchBaseCropIllustrations } = useSnapshotActions();
  const presets = useCropPresetManager();

  const style = styles[target.styleIndex];
  const crop = style?.crops.find((c) => c.key === target.entityKey);
  // Memo keyed on the (referentially stable) crop node → the onCreateImages dep doesn't churn.
  const illustrations = useMemo(() => crop?.illustrations ?? EMPTY_ILLUSTRATIONS, [crop]);

  const handleCreate = useCallback(
    (results: ExtractResult[]) => {
      if (results.length === 0) return;
      log.info('handleCreate', 'append extracted base-crop versions', {
        group: target.group,
        styleIndex: target.styleIndex,
        entityKey: target.entityKey,
        count: results.length,
      });
      // Crop tab = CV cut (no AI provider call) → no ai_request_id provenance to carry.
      const next = appendMediaVersions(illustrations, results.map((r) => ({ media_url: r.media_url })));
      setSketchBaseCropIllustrations(target.group, target.styleIndex, target.entityKey, next);
      // LOCKED style → the setter re-cloned this crop into the entity's base variant (grain B,
      // rtype 14) — flush that entity collection now; the sheet release-save only covers grain A.
      void persistBaseEntityCloneIfLocked(target.group, target.styleIndex, target.entityKey);
    },
    [illustrations, target, setSketchBaseCropIllustrations],
  );

  // Crop removed / style gone while the modal was open → nothing to bind (parent closes).
  if (!crop) return null;

  const image: SpreadImage = {
    id: `sketch-base-crop-${target.group}-${target.styleIndex}-${target.entityKey}`,
    title: titleCase(target.entityKey),
    geometry: FULL_FRAME,
    media_url: effectiveUrl(illustrations),
    illustrations,
  };

  return (
    <ExtractImageModal
      open
      onOpenChange={(open) => !open && onClose()}
      image={image}
      enabledTabs={SPACE_TOOL_MATRIX.sketch.extract}
      initialTab="crop"
      cropPresets={presets.cropPresets}
      onUpsertCropPreset={presets.onUpsertCropPreset}
      onDeleteCropPreset={presets.onDeleteCropPreset}
      onCreateImages={handleCreate}
      saveResource={saveResource}
    />
  );
}
