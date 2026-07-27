// casting-slot-resync.ts — eager cleanup of book.casting_slot assignments when a
// snapshot character/prop is deleted (soft FK, no DB cascade). Sibling of
// remix-name-resync.ts; kept separate because that file owns the remix domain.
// Dynamic getState() avoids a static import cycle between snapshot-store and
// book-store.
//
// Rename needs NO cascade: casting stores only the entity key and derives the
// display label from the snapshot at render time (design §4.3).
// The purge is silent by design — matches cascadeRemixDelete, which already
// drops book.remix entries without user feedback on the same delete action
// (validation S1 Q4).

import { useBookStore } from '@/stores/book-store';
import {
  ACTOR_TYPE_CHARACTER,
  ACTOR_TYPE_PROP,
  normalizeCastingSlot,
  purgeActorFromCastingSlot,
} from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'CastingSlotResync');

export type CastingActorKind = 'character' | 'prop';

/**
 * Drop every casting assignment bound to a deleted entity, across all axes and
 * presets. Matches actor_id AND actor_type (a character and a prop may share a
 * key). Idempotent: nothing matched → no updateBook call.
 */
export function cascadeCastingDelete(kind: CastingActorKind, actorKey: string): void {
  log.info('cascadeCastingDelete', 'start', { kind, actorKey });

  const bookState = useBookStore.getState();
  const book = bookState.currentBook;
  if (!book || !book.casting_slot) {
    log.debug('cascadeCastingDelete', 'skip: no book or no casting_slot', { hasBook: !!book });
    return;
  }

  const actorType = kind === 'character' ? ACTOR_TYPE_CHARACTER : ACTOR_TYPE_PROP;
  const slot = normalizeCastingSlot(book.casting_slot);
  const { next, changed, removedCount } = purgeActorFromCastingSlot(slot, actorType, actorKey);
  if (!changed) {
    log.debug('cascadeCastingDelete', 'skip: no assignment matched', { actorKey, actorType });
    return;
  }

  void bookState.updateBook(book.id, { casting_slot: next });
  log.debug('cascadeCastingDelete', 'purged assignments', { actorKey, actorType, removedCount });
}
