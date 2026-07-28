// persist-base-entity-clone.ts — collab grain-B flush after a crop edit/extract on the LOCKED
// style. The store setter (setSketchBaseCropIllustrations) re-clones the edited crop into the
// entity's variants[base].raw_sheet (dual-write, live-follow); the sheet held-session release-save
// only covers grain A (rtype 11), so the changed ENTITY node (rtype 3/4) must flush explicitly
// here or the clone silently never saves in collab. SOLO → flushSketchEntityUnderLock no-ops and
// the whole-doc isDirty autosave persists both nodes. Peer-held entity → the helper skips + toasts
// (advisory — same contract as the lock-style flush in sketch-base-creative-space).

import { useSnapshotStore } from '@/stores/snapshot-store';
import { flushSketchEntityUnderLock } from '@/stores/snapshot-store/slices/collab-sketch-variant-save-helper';
import { sheetOf, sketchEntitiesOfKind, type BaseKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'PersistBaseEntityClone');

/**
 * Flush ONE entity's node through the gateway after a single-crop write, IF the written style is
 * the locked one (otherwise the entity clone was untouched — the sheet release-save covers it).
 * One-shot lock (`releaseIfAcquired: true`) so no entity lock lingers after the flush.
 */
export async function persistBaseEntityCloneIfLocked(
  kind: BaseKind,
  styleIndex: number,
  entityKey: string,
): Promise<void> {
  const st = useSnapshotStore.getState();
  const style = sheetOf(st.sketch.base, kind).styles[styleIndex];
  if (!style?.is_selected) {
    log.debug('persistBaseEntityCloneIfLocked', 'style not locked — clone untouched, skip', {
      kind,
      styleIndex,
      entityKey,
    });
    return;
  }
  const entity = sketchEntitiesOfKind(st.sketch, kind).find((e) => e.key === entityKey);
  if (!entity) {
    log.warn('persistBaseEntityCloneIfLocked', 'entity missing — skip', { kind, entityKey });
    return;
  }
  log.info('persistBaseEntityCloneIfLocked', 'flush entity base-variant clone', {
    kind,
    styleIndex,
    entityKey,
  });
  await flushSketchEntityUnderLock(kind, entity.key, entity, { releaseIfAcquired: true });
}
