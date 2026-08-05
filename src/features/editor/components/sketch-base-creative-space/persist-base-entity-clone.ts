// persist-base-entity-clone.ts — collab grain-B flush after a crop edit/extract on the LOCKED
// style. The store setter (setSketchBaseCropIllustrations) re-clones the edited crop into the
// entity's variants[base].raw_sheet (dual-write, live-follow); the sheet held-session release-save
// only covers grain A (rtype 11), so the changed entity collection (rtype 14) must persist explicitly
// here or the clone silently never saves in collab. ⚡ ADR-044 addendum 2: the whole entity collection
// is saved in ONE column-root call (`saveEntityCollection` → engine `ensureSaved`: held → save; else
// one-shot lock-exempt; solo → whole-snapshot flush). Peer-degraded collection → `blocked` → the
// CALLER toasts (the seam no longer self-toasts).

import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  saveEntityCollection,
  BASE_KIND_TO_COLLECTION,
  resolveEntityCollectionLockTarget,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import { sheetOf, sketchEntitiesOfKind, type BaseKind } from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'PersistBaseEntityClone');

/**
 * Persist the WHOLE entity collection after a single-crop write, IF the written style is the locked
 * one (otherwise the entity clone was untouched — the sheet release-save covers it). The whole array
 * is written in one rtype-14 column-root save (`alter_characters` shares the `characters` collection).
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
  const collection = BASE_KIND_TO_COLLECTION[kind];
  log.info('persistBaseEntityCloneIfLocked', 'save entity collection (clone landed)', {
    kind,
    styleIndex,
    entityKey,
    collection,
  });
  const outcome = await saveEntityCollection(collection);
  toastSketchSaveOutcome(outcome, resolveEntityCollectionLockTarget(collection));
}
