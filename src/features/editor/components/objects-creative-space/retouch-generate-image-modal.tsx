// retouch-generate-image-modal.tsx — Store-binding connector for the controlled
// GenerateImageModal in the Objects/retouch space, wired UPLOAD-ONLY (matrix
// `object.generate = ['upload']`, design §10 Q2). The generate machinery (useStages /
// startGenerateTask) is gated behind mode='generate', which is unreachable here because the
// single-mode header hides the toggle and lands on 'upload' — so mounting this is side-effect
// free. Mirrors RetouchEditImageModal: resolve the retouch image from the snapshot store and
// feed `image` + `onUpdateImage`. Mounted only while a target image is selected.

import { useCallback } from "react";
import {
  GenerateImageModal,
  SPACE_TOOL_MATRIX,
} from "@/features/editor/components/shared-components";
import { useRetouchImageById, useSnapshotActions } from "@/stores/snapshot-store/selectors";
import type { SpreadImage } from "@/types/canvas-types";
import type { SaveResourceDirective } from "@/types/save-resource";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "RetouchGenerateImageModal");

interface RetouchGenerateImageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spreadId: string;
  imageId: string;
  /** Held-session commit-on-modal-close (per-spread retouch lock), fire-and-forget — persists the
   *  uploaded/replaced image while the lock is held. Self-guards (no-op when clean / not held).
   *  Absent ⇒ persisted on the session's release-time save-if-dirty. */
  onCommitSave?: () => void;
  /** Opt-in double-write directive — pass-through to GenerateImageModal (Upload mode; path resolved
   *  by the opener, Phase 04). Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function RetouchGenerateImageModal({
  open,
  onOpenChange,
  spreadId,
  imageId,
  onCommitSave,
  saveResource,
}: RetouchGenerateImageModalProps) {
  const image = useRetouchImageById(spreadId, imageId);
  const { updateRetouchImage } = useSnapshotActions();

  const handleUpdate = useCallback(
    (updates: Partial<SpreadImage>) => {
      log.debug("handleUpdate", "persist image updates", {
        spreadId,
        imageId,
        keys: Object.keys(updates),
      });
      updateRetouchImage(spreadId, imageId, updates);
      // Held-session commit-on-close (fire-and-forget; no-op when not holding the spread lock).
      onCommitSave?.();
    },
    [spreadId, imageId, updateRetouchImage, onCommitSave],
  );

  // Image deleted while modal open → parent ILS force-pop closes; render nothing meanwhile.
  if (!image) return null;

  return (
    <GenerateImageModal
      open={open}
      onOpenChange={onOpenChange}
      spreadId={spreadId}
      image={image}
      onUpdateImage={handleUpdate}
      enabledModes={SPACE_TOOL_MATRIX.object.generate}
      uploadEntityType="retouch_image"
      saveResource={saveResource}
    />
  );
}
