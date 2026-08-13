// delete-style-dialog.tsx — Destructive confirm for deleting one art-style.
// On mount queries usage (books.artstyle_id) as the in-use guard. Note: the FK is
// ON DELETE SET NULL, so the DB never blocks delete — this app-layer count is the
// ONLY protection. Error copy is generic (never "may still be in use").

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
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
import {
  countBooksUsingStyle,
  deleteStyle,
  removeStyleImages,
} from '@/apis/style-api';
import type { ArtStyle } from '@/types/art-style';
import { createLogger } from '@/utils/logger';

const log = createLogger('Styles', 'DeleteStyleDialog');

type DeleteStep = 'checking' | 'confirm' | 'blocked' | 'deleting';

interface DeleteStyleDialogProps {
  style: ArtStyle;
  onClose: () => void;
  onDeleted: (styleId: string) => void;
}

export function DeleteStyleDialog({
  style,
  onClose,
  onDeleted,
}: DeleteStyleDialogProps) {
  const [step, setStep] = useState<DeleteStep>('checking');
  const [usageCount, setUsageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // On-mount in-use guard. The FK is SET NULL (never blocks), so this count is the
  // sole protection; a query error falls back to 'confirm' (conservative — let the
  // user attempt, generic error on failure).
  useEffect(() => {
    let active = true;
    log.info('mountGuard', 'start', { id: style.id });
    countBooksUsingStyle(style.id)
      .then((count) => {
        if (!active) return;
        setUsageCount(count);
        const next = count > 0 ? 'blocked' : 'confirm';
        log.info('mountGuard', 'result', { id: style.id, count });
        setStep(next);
      })
      .catch((e) => {
        if (!active) return;
        log.warn('mountGuard', 'count failed → confirm', {
          id: style.id,
          error: String(e),
        });
        setStep('confirm');
      });
    return () => {
      active = false;
    };
  }, [style.id]);

  const handleConfirm = async () => {
    log.info('handleConfirm', 'start', { id: style.id });
    setStep('deleting');
    setError(null);

    // deleteStyle returns false on network/permission error (NOT FK — SET NULL never
    // blocks). Treat false as failure with a GENERIC message.
    const ok = await deleteStyle(style.id);
    if (!ok) {
      log.warn('handleConfirm', 'delete failed', { id: style.id });
      setError('Failed to delete style. Please try again.');
      setStep('confirm');
      return;
    }

    // Best-effort Storage cleanup by the row's reference URLs (no LIST endpoint — ADR-054).
    void removeStyleImages(style.imageReferences.map((r) => r.mediaUrl)).catch(() => undefined);

    log.info('handleConfirm', 'done', { id: style.id });
    onDeleted(style.id);
    onClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (step === 'deleting') return; // block dismiss mid-delete
    onClose();
  };

  const deleteDisabled =
    step === 'checking' || step === 'blocked' || step === 'deleting';

  return (
    <AlertDialog open onOpenChange={handleOpenChange}>
      <AlertDialogContent className="sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete style?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong className="font-medium text-foreground">
              &ldquo;{style.name}&rdquo;
            </strong>{' '}
            will be permanently removed. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step === 'checking' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking usage…
          </div>
        ) : null}

        {step === 'blocked' ? (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              Used by {usageCount} book{usageCount !== 1 ? 's' : ''}. Reassign
              their art style before deleting.
            </span>
          </div>
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
            aria-label="Delete style, this action cannot be undone"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {step === 'deleting' ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
