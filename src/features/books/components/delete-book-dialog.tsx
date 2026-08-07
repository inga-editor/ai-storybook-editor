// delete-book-dialog.tsx — Destructive confirm for deleting ONE book.
// Unlike DeleteStyleDialog there is NO in-use guard: every FK pointing at `books`
// is ON DELETE CASCADE / SET NULL (design §5), so `DELETE FROM books` never
// blocks. The 5s countdown is purely anti-misclick friction for a wide blast
// radius — deleting a book destroys ALL its snapshots (every version), remix and
// share_links, irreversibly (schema has no soft-delete).
//
// On confirm → store.deleteBook (optimistic remove + rollback on error). Success
// → toast + onClose; failure → back to 'confirm' (Delete stays enabled for retry,
// countdown is NOT reset). Dismiss is blocked while deleting. a11y: alertdialog
// role (Radix), countdown aria-live=polite, Delete aria-label.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CountdownDisplay } from '@/components/ui/countdown-display';
import { useBookActions } from '@/stores/book-store';
import type { ProjectBookItem } from '@/features/books/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'DeleteBookDialog');

type DeleteStep = 'countdown' | 'confirm' | 'deleting';

interface DeleteBookDialogProps {
  book: ProjectBookItem;
  onClose: () => void;
  /** Anti-misclick countdown before Delete enables. Default 5s. */
  countdownSeconds?: number;
}

export function DeleteBookDialog({
  book,
  onClose,
  countdownSeconds = 5,
}: DeleteBookDialogProps) {
  const { deleteBook } = useBookActions();

  const [step, setStep] = useState<DeleteStep>('countdown');
  const [secondsLeft, setSecondsLeft] = useState(countdownSeconds);
  const [error, setError] = useState<string | null>(null);

  // Countdown tick. Both setState calls run inside setTimeout (async) callbacks so
  // React 19's "no synchronous set-state-in-effect" lint rule is not tripped.
  // When secondsLeft hits 0 we still schedule a (0ms) timeout to transition to
  // 'confirm' — keeping that setState async as well. clearTimeout on cleanup
  // prevents leaks / set-state-after-unmount on Cancel/Esc/unmount.
  useEffect(() => {
    if (step !== 'countdown') return;
    if (secondsLeft <= 0) {
      const t = setTimeout(() => setStep('confirm'), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [step, secondsLeft]);

  const handleConfirm = useCallback(async () => {
    if (step !== 'confirm') return;
    log.info('handleConfirm', 'deleting book', { bookId: book.id });
    setStep('deleting');
    setError(null);

    const ok = await deleteBook(book.id);
    if (ok) {
      log.info('handleConfirm', 'deleted', { bookId: book.id });
      toast.success('Book deleted');
      onClose();
      return;
    }

    // Store already rolled the optimistic remove back. Return to confirm so the
    // user can retry — do NOT reset the countdown.
    log.warn('handleConfirm', 'delete failed → confirm', { bookId: book.id });
    setError('Failed to delete book. Please try again.');
    setStep('confirm');
  }, [step, book.id, deleteBook, onClose]);

  // Block dismiss (Esc / click-outside) while deleting.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      if (step === 'deleting') return;
      onClose();
    },
    [step, onClose],
  );

  const deleteDisabled = step !== 'confirm';
  const deleteLabel =
    step === 'deleting'
      ? 'Deleting…'
      : step === 'countdown'
        ? `Delete (${secondsLeft}s)`
        : 'Delete';

  return (
    <AlertDialog open onOpenChange={handleOpenChange}>
      <AlertDialogContent className="sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Book</AlertDialogTitle>
          <AlertDialogDescription>
            <strong className="font-medium text-foreground">
              &ldquo;{book.title || 'Untitled'}&rdquo;
            </strong>{' '}
            will be permanently deleted. This destroys every snapshot version,
            remix and share link for this book — it cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step === 'countdown' ? (
          <CountdownDisplay secondsLeft={secondsLeft} total={countdownSeconds} />
        ) : null}

        {error ? (
          <div role="alert" className="text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose} disabled={step === 'deleting'}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={deleteDisabled}
            aria-label="Delete book permanently, this action cannot be undone"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
