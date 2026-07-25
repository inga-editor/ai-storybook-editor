// retouch-edit-image-modal.tsx — Store-binding connector for the controlled EditImageModal
// in the Objects/retouch space. The modal is store-agnostic (design §2.2 "parent owns
// binding"); this thin wrapper resolves the retouch image from the snapshot store and feeds
// `illustrations` + `onUpdateIllustrations` (+ pathPrefix). Mounted only while a target image
// is selected, so the store hooks run unconditionally.
//
// Collab (ADR-044 §Revision 2026-07-10 — per-spread held session): `onUpdateIllustrations` is the
// SINGLE seam for BOTH a commit (new edited version prepended) AND a version-switch (is_selected
// flip). The retouch image lives under `spreads[].images[]` — a RETOUCH_OWNED_KEY — so its save is
// owned by the OBJECTS-space per-spread held session (step 3 / rtype 10). After the local mutate we
// call the session's `saveNow()` to persist the whole retouch sub-tree IMMEDIATELY while the lock is
// still held (Validation S1 Q3) — so a commit is not lost if the user never switches spreads.

import { useCallback } from "react";
import { EditImageModal } from "@/features/editor/components/shared-components/edit-image-modal";
import type { EditToolKey } from "@/features/editor/components/shared-components/edit-image-modal";
import { useRetouchImageById, useSnapshotActions, useSnapshotId } from "@/stores/snapshot-store/selectors";
import type { Illustration } from "@/types/prop-types";
import type { SaveResourceDirective } from "@/types/save-resource";
import { createLogger } from "@/utils/logger";

const log = createLogger("Editor", "RetouchEditImageModal");

interface RetouchEditImageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spreadId: string;
  imageId: string;
  /** Per-space edit-tool availability (matrix gate). Forwarded to EditImageModal. */
  enabledTools?: EditToolKey[];
  /** Held-session explicit save (per-spread retouch lock). Persists the whole retouch owned sub-tree
   *  (which includes this image) WHILE the lock is held, then rebases the session baseline. Absent
   *  ⇒ the commit is only persisted on the session's release-time save-if-dirty. */
  onCommitSave?: () => Promise<boolean>;
  /** Opt-in double-write directive — pass-through to EditImageModal (path resolved by the opener,
   *  Phase 04). Undefined → omitted. */
  saveResource?: SaveResourceDirective;
}

export function RetouchEditImageModal({
  open,
  onOpenChange,
  spreadId,
  imageId,
  enabledTools,
  onCommitSave,
  saveResource,
}: RetouchEditImageModalProps) {
  const image = useRetouchImageById(spreadId, imageId);
  const { updateRetouchImage } = useSnapshotActions();
  // Book-edit context (Objects space is never remix) → attribute AI edits by snapshotId.
  const snapshotId = useSnapshotId();

  const handleUpdate = useCallback(
    (next: Illustration[]) => {
      log.debug("handleUpdate", "persist illustrations", { spreadId, imageId, count: next.length });
      // Local optimistic mutate (dirties the spread's `images` — a RETOUCH_OWNED_KEY).
      updateRetouchImage(spreadId, imageId, { illustrations: next });
      // Explicit held-session save NOW (no-op when not holding the spread lock): covers BOTH a commit
      // and a version-switch, so the change is persisted immediately without waiting for release.
      if (onCommitSave) {
        void onCommitSave().then((ok) => {
          if (!ok) log.warn("handleUpdate", "held-session saveNow returned false", { spreadId, imageId });
        });
      }
    },
    [spreadId, imageId, updateRetouchImage, onCommitSave],
  );

  // Image deleted while modal open → parent ILS force-pop will close; render nothing meanwhile.
  if (!image) return null;

  return (
    <EditImageModal
      open={open}
      onOpenChange={onOpenChange}
      imageTitle={image.title ?? ""}
      illustrations={image.illustrations ?? []}
      mediaUrl={image.media_url ?? ""}
      onUpdateIllustrations={handleUpdate}
      pathPrefix={`retouch/${imageId}/erased`}
      enabledTools={enabledTools}
      attribution={{ snapshotId: snapshotId ?? undefined }}
      saveResource={saveResource}
    />
  );
}
