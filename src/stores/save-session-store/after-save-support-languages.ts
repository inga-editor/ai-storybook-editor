// after-save-support-languages.ts — the `retouch-spread` (step-3) afterSave hook.
//
// Recompute `book.support_languages` translation_status over the WHOLE snapshot (every spread of
// the book's current step, per design §4.5) and persist it diff-gated + fire-and-forget. Runs AFTER
// a successful save on the 3 canonical paths (🚪 save-on-leave / ⚡ saveNow / ⏱ idle-sweep) via the
// engine's `fireAfterSave` seam. Content-derived + idempotent ⇒ peers converge after content-sync
// (design: `updateBook` whole-field last-writer-wins, no resource gateway).
//
// Never logs textbox content (user story text = PII) — only the book id + language count.

import { useBookStore } from '@/stores/book-store';
import { useSnapshotStore } from '@/stores/snapshot-store';
import { recomputeSupportLanguages } from '@/utils/support-languages';
import { createLogger } from '@/utils/logger';

const log = createLogger('Store', 'AfterSaveSupportLanguages');

/**
 * Recompute `support_languages` for the currently-open book and persist it if it changed.
 *
 * `spreadId` is for LOGGING ONLY — the recompute walks the ENTIRE snapshot (all spreads of the
 * book's step), not just the spread that was saved, so the whole-book denominator stays correct.
 *
 * Fire-and-forget by design: the save session does NOT await this. A network/optimistic failure is
 * warn-logged, never thrown — the next real save recomputes again (self-healing).
 */
export function recomputeSupportLanguagesAfterSave(spreadId?: string): void {
  const book = useBookStore.getState().currentBook;
  if (!book?.id) {
    log.debug('recomputeSupportLanguagesAfterSave', 'no current book — skip', { spreadId });
    return;
  }

  const next = recomputeSupportLanguages(book, useSnapshotStore.getState());
  if (next === null) {
    log.debug('recomputeSupportLanguagesAfterSave', 'map unchanged — skip updateBook', {
      bookId: book.id,
    });
    return;
  }

  log.info('recomputeSupportLanguagesAfterSave', 'support_languages changed — persisting', {
    bookId: book.id,
    languageCount: Object.keys(next).length,
  });

  // Fire-and-forget: never block the save flow, never surface an unhandled rejection.
  void useBookStore
    .getState()
    .updateBook(book.id, { support_languages: next })
    .then((ok) => {
      if (!ok) {
        log.warn(
          'recomputeSupportLanguagesAfterSave',
          'updateBook returned false — next save will retry',
          { bookId: book.id },
        );
      }
    })
    .catch((err) => {
      log.warn(
        'recomputeSupportLanguagesAfterSave',
        'updateBook threw — next save will retry',
        { bookId: book.id, error: err instanceof Error ? err.message : String(err) },
      );
    });
}
