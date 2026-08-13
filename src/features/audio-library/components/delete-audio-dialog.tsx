import { useState } from 'react';
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
import { createLogger } from '@/utils/logger';
import { deleteAudioRowAndCleanup } from '../utils/delete-audio-row-and-cleanup';
import type { AudioResource, AudioTableName } from '../types';

const log = createLogger('AudioLibrary', 'DeleteAudioDialog');

export interface DeleteAudioDialogProps {
  tableName: AudioTableName;
  pathPrefixes: string[];
  resourceLabel: string;
  item: AudioResource;
  onClose: () => void;
  onDeleted?: (id: string) => void;
}

type Step = 'confirm' | 'deleting';

export function DeleteAudioDialog({
  tableName,
  pathPrefixes,
  resourceLabel,
  item,
  onClose,
  onDeleted,
}: DeleteAudioDialogProps) {
  const [step, setStep] = useState<Step>('confirm');
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    log.info('handleConfirm', 'start', { id: item.id, tableName });
    setStep('deleting');
    setError(null);

    const res = await deleteAudioRowAndCleanup({
      tableName,
      pathPrefixes,
      item,
    });

    if (!res.ok) {
      log.warn('handleConfirm', 'failed', { id: item.id });
      setError(`Failed to delete ${resourceLabel}. Please try again.`);
      setStep('confirm');
      return;
    }

    log.info('handleConfirm', 'success', { id: item.id });
    toast.success(`${resourceLabel.charAt(0).toUpperCase() + resourceLabel.slice(1)} deleted`);
    onDeleted?.(item.id);
    onClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && step === 'deleting') return;
    if (!open) onClose();
  };

  return (
    <AlertDialog open onOpenChange={handleOpenChange}>
      <AlertDialogContent className="sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {resourceLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong className="font-medium text-foreground">
              &ldquo;{item.name}&rdquo;
            </strong>{' '}
            will be permanently deleted. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

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
            disabled={step === 'deleting'}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {step === 'deleting' ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
