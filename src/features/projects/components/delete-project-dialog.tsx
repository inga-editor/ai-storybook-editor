// delete-project-dialog.tsx — Destructive confirm for deleting ONE project. The
// blast radius is WIDE: deleting a project CASCADEs every book in it (each book's
// snapshots / versions / remixes / share links), irreversibly (no soft-delete).
// A 5s countdown is anti-misclick friction; the warning text is exact about the
// book_count. Server-first: call the API, then tell the parent to remove the row.
// On error → back to 'confirm' for retry (countdown NOT reset). Dismiss blocked
// while deleting. a11y: alertdialog role (Radix), countdown aria-live, Delete label.

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
import { deleteProject } from '../api/projects-api';
import type { ProjectOverviewRow } from '../types';
import { createLogger } from '@/utils/logger';

const log = createLogger('Projects', 'DeleteProjectDialog');

type DeleteStep = 'countdown' | 'confirm' | 'deleting';

interface DeleteProjectDialogProps {
  project: ProjectOverviewRow;
  onClose: () => void;
  onDeleted: (id: string) => void;
  /** Anti-misclick countdown before Delete enables. Default 5s. */
  countdownSeconds?: number;
}

export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
  countdownSeconds = 5,
}: DeleteProjectDialogProps) {
  const [step, setStep] = useState<DeleteStep>('countdown');
  const [secondsLeft, setSecondsLeft] = useState(countdownSeconds);
  const [error, setError] = useState<string | null>(null);

  // Countdown tick — both setState calls run inside setTimeout callbacks so React
  // 19's "no synchronous set-state-in-effect" lint rule is not tripped.
  // clearTimeout on cleanup prevents leaks / set-state-after-unmount.
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
    log.info('handleConfirm', 'deleting project', { id: project.id });
    setStep('deleting');
    setError(null);

    try {
      await deleteProject(project.id);
      log.info('handleConfirm', 'deleted', { id: project.id });
      toast.success('Project deleted');
      onDeleted(project.id);
      onClose();
    } catch (err) {
      // Return to confirm so the user can retry — do NOT reset the countdown.
      log.warn('handleConfirm', 'delete failed → confirm', {
        id: project.id,
        message: err instanceof Error ? err.message : String(err),
      });
      setError('Failed to delete project. Please try again.');
      setStep('confirm');
    }
  }, [step, project.id, onDeleted, onClose]);

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

  const warning =
    project.book_count > 0
      ? `This permanently deletes all ${project.book_count} book${project.book_count === 1 ? '' : 's'} in this project, including every version, remix, and active share link.`
      : 'This project has no books yet.';

  return (
    <AlertDialog open onOpenChange={handleOpenChange}>
      <AlertDialogContent className="sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Project</AlertDialogTitle>
          <AlertDialogDescription>
            <strong className="font-medium text-foreground">
              &ldquo;{project.title || 'Untitled'}&rdquo;
            </strong>{' '}
            will be deleted. This action cannot be undone. {warning}
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
            aria-label="Delete project permanently, this action cannot be undone"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
