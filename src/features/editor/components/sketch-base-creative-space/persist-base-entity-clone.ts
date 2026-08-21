// persist-base-entity-clone.ts — collab grain-B flush after a crop edit/extract on the LOCKED
// style. The store setter (setSketchBaseCropIllustrations) re-clones the edited crop into the
// entity's variants[base].raw_sheet (dual-write, live-follow); the sheet held-session release-save
// only covers grain A (rtype 11), so the changed entity collection (rtype 14) must persist explicitly
// here or the clone silently never saves in collab. ⚡ ADR-044 addendum 2: the whole entity collection
// is saved in ONE column-root call (`saveEntityCollection` → engine `ensureSaved`). ⚡REV 2026-08-21:
// addressed by GROUP KEY — the group's kind (self-describing node, else derived) picks the collection.

import { useSnapshotStore } from '@/stores/snapshot-store';
import {
  saveEntityCollection,
  BASE_KIND_TO_COLLECTION,
  resolveEntityCollectionLockTarget,
} from '@/stores/snapshot-store/slices/collab-sketch-base-entities-save-helper';
import { toastSketchSaveOutcome } from '@/stores/snapshot-store/slices/sketch-save-outcome-toast';
import {
  sheetOf,
  deriveSheetKindFromKey,
  resolveEntityGroup,
  type SheetKind,
  type SketchEntity,
} from '@/types/sketch';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'PersistBaseEntityClone');

/** A group's kind: self-describing base node → else derived from the key. */
function groupKind(group: string): SheetKind {
  return useSnapshotStore.getState().sketch.base[group]?.kind ?? deriveSheetKindFromKey(group);
}

/** The entity of `group` with `entityKey` (its kind array filtered by `resolveEntityGroup`). */
function findGroupEntity(group: string, kind: SheetKind, entityKey: string): SketchEntity | undefined {
  const sketch = useSnapshotStore.getState().sketch;
  const src = kind === 'props' ? sketch.props ?? [] : sketch.characters ?? [];
  return src.find((e) => e.key === entityKey && resolveEntityGroup(e, kind) === group);
}

/**
 * Persist the WHOLE entity collection after a single-crop write, IF the written style is the locked
 * one (otherwise the entity clone was untouched — the sheet release-save covers it). The whole array
 * is written in one rtype-14 column-root save (the group's kind → characters | props).
 */
export async function persistBaseEntityCloneIfLocked(
  group: string,
  styleIndex: number,
  entityKey: string,
): Promise<void> {
  const style = sheetOf(useSnapshotStore.getState().sketch.base, group)?.styles[styleIndex];
  if (!style?.is_selected) {
    log.debug('persistBaseEntityCloneIfLocked', 'style not locked — clone untouched, skip', {
      group,
      styleIndex,
      entityKey,
    });
    return;
  }
  const kind = groupKind(group);
  const entity = findGroupEntity(group, kind, entityKey);
  if (!entity) {
    log.warn('persistBaseEntityCloneIfLocked', 'entity missing — skip', { group, entityKey });
    return;
  }
  const collection = BASE_KIND_TO_COLLECTION[kind];
  log.info('persistBaseEntityCloneIfLocked', 'save entity collection (clone landed)', {
    group,
    styleIndex,
    entityKey,
    collection,
  });
  const outcome = await saveEntityCollection(collection);
  toastSketchSaveOutcome(outcome, resolveEntityCollectionLockTarget(collection));
}
