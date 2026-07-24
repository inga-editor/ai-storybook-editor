// illustration-edit-image-modal.tsx — Store-binding connector for the controlled
// EditImageModal in the Spreads/illustration space. Illustration spread images live in
// `illustration.spreads[].raw_images[]`; this thin wrapper resolves the raw image and feeds
// `illustrations` + `onUpdateIllustrations` (+ mediaUrl seed + pathPrefix), mirroring
// RetouchEditImageModal. Mounted only while a target image is selected, so the store hooks
// run unconditionally.

import { useCallback } from "react";
import {
  EditImageModal,
  useIllustrationPropRefCandidates,
} from "@/features/editor/components/shared-components/edit-image-modal";
import type { EditToolKey } from "@/features/editor/components/shared-components/edit-image-modal";
import { useRawImageById, useSnapshotActions, useSnapshotId } from "@/stores/snapshot-store/selectors";
import type { Illustration } from "@/types/prop-types";
import type { SaveResourceDirective } from "@/types/save-resource";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "IllustrationEditImageModal");

interface IllustrationEditImageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spreadId: string;
  imageId: string;
  /** Per-space edit-tool availability (matrix gate). Forwarded to EditImageModal. */
  enabledTools?: EditToolKey[];
  /** Held-session explicit save (per-spread SCENE lock). Persists the whole SCENE owned sub-tree
   *  (which includes this raw_image) WHILE the lock is held, then rebases the session baseline.
   *  Absent ⇒ the commit is only persisted on the session's release-time save-if-dirty (ADR-044,
   *  mirror of RetouchEditImageModal). */
  onCommitSave?: () => Promise<boolean>;
  /** Opt-in double-write directive — pass-through to EditImageModal (path resolved by the opener,
   *  Phase 04). Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function IllustrationEditImageModal({
  open,
  onOpenChange,
  spreadId,
  imageId,
  enabledTools,
  onCommitSave,
  saveResource,
}: IllustrationEditImageModalProps) {
  const image = useRawImageById(spreadId, imageId);
  const { updateRawImage } = useSnapshotActions();
  // Book-edit context (Spreads space is never remix) → attribute AI edits by snapshotId.
  const snapshotId = useSnapshotId();
  // Inpaint reference candidates (book prop variants). Hook runs BEFORE the early return (Rules of Hooks).
  const referenceImageCandidates = useIllustrationPropRefCandidates();

  const handleUpdate = useCallback(
    (next: Illustration[]) => {
      log.debug("handleUpdate", "persist illustrations", { spreadId, imageId, count: next.length });
      // Local optimistic mutate (dirties raw_images — a SCENE_OWNED_KEY).
      updateRawImage(spreadId, imageId, { illustrations: next });
      // Explicit held-session save NOW (no-op when not holding the spread lock): persists the edit
      // immediately without waiting for release.
      if (onCommitSave) {
        void onCommitSave().then((ok) => {
          if (!ok) log.warn("handleUpdate", "held-session saveNow returned false", { spreadId, imageId });
        });
      }
    },
    [spreadId, imageId, updateRawImage, onCommitSave],
  );

  // Image deleted while modal open → parent ILS force-pop closes; render nothing meanwhile.
  if (!image) return null;

  // Seed fallback (display-only) when illustrations[] is empty: final hi-res → selected → first.
  const seedUrl =
    image.final_hires_media_url ??
    image.illustrations?.find((v) => v.is_selected)?.media_url ??
    image.illustrations?.[0]?.media_url ??
    image.media_url ??
    "";

  return (
    <EditImageModal
      open={open}
      onOpenChange={onOpenChange}
      imageTitle={image.title ?? ""}
      illustrations={image.illustrations ?? []}
      mediaUrl={seedUrl}
      onUpdateIllustrations={handleUpdate}
      pathPrefix={`illustrations/${imageId}/erased`}
      enabledTools={enabledTools}
      referenceImageCandidates={referenceImageCandidates}
      attribution={{ snapshotId: snapshotId ?? undefined }}
      saveResource={saveResource}
    />
  );
}
