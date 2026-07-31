// remix-name-resync.ts — eager cascade of character name into book.remix when
// the snapshot owner renames an entity. Dynamic getState() avoids a static
// import cycle between snapshot-store and book-store.
// Reshape 2026-07-31: book.remix dropped props[] — the cascade is character-only
// (prop rename/delete no longer touches book.remix).

import { useBookStore } from '@/stores/book-store';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'RemixNameResync');

export function cascadeRemixName(key: string, newName: string): void {
  log.info('cascadeRemixName', 'start', { key });

  const bookState = useBookStore.getState();
  const book = bookState.currentBook;
  if (!book || !book.remix) {
    log.debug('cascadeRemixName', 'skip: no book or no remix', { hasBook: !!book });
    return;
  }

  const remix = book.remix;
  const idx = remix.characters.findIndex((c) => c.key === key);
  if (idx < 0) {
    log.debug('cascadeRemixName', 'skip: no character entry', { key });
    return;
  }
  if (remix.characters[idx].name === newName) {
    log.debug('cascadeRemixName', 'skip: name unchanged', { key });
    return;
  }
  const next = [...remix.characters];
  next[idx] = { ...next[idx], name: newName };
  void bookState.updateBook(book.id, { remix: { ...remix, characters: next } });
  log.debug('cascadeRemixName', 'updated character', { key, newName });
}

/**
 * Eager cleanup of book.remix entries when a snapshot character is deleted
 * (soft FK has no DB cascade). Drops the characters[] entry AND the matching
 * voices[] entry (key match; the 'narrator' voice never matches a character
 * key). Idempotent: no matching entry → no updateBook call.
 */
export function cascadeRemixDelete(key: string): void {
  log.info('cascadeRemixDelete', 'start', { key });

  const bookState = useBookStore.getState();
  const book = bookState.currentBook;
  if (!book || !book.remix) {
    log.debug('cascadeRemixDelete', 'skip: no book or no remix', { hasBook: !!book });
    return;
  }

  const remix = book.remix;
  const nextChars = remix.characters.filter((c) => c.key !== key);
  const nextVoices = remix.voices.filter((v) => v.key !== key);
  if (
    nextChars.length === remix.characters.length &&
    nextVoices.length === remix.voices.length
  ) {
    log.debug('cascadeRemixDelete', 'skip: no character/voice entry', { key });
    return;
  }
  void bookState.updateBook(book.id, {
    remix: { ...remix, characters: nextChars, voices: nextVoices },
  });
  log.debug('cascadeRemixDelete', 'dropped character + voice', { key });
}
