// delete-lineup-tab-alert-dialog.tsx — confirm destroying ONE lineup tab (design 02-01 §menu).
// A tab is pure config: deleting it never touches images/entities — the copy says so explicitly.
// No delete hotkey anywhere in the space (memory: sidebars don't own destructive hotkeys) — this
// dialog is the only path. Renders over the canvas → CANVAS_CONFIRM_DIALOG_Z (memory:
// alert-dialog-zindex-prop-canvas).

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
import { CANVAS_CONFIRM_DIALOG_Z } from '@/constants/spread-constants';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'DeleteLineupTabAlertDialog');

export interface DeleteLineupTabAlertDialogProps {
  /** Name of the tab pending deletion; null = closed. */
  tabName: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteLineupTabAlertDialog({ tabName, onConfirm, onClose }: DeleteLineupTabAlertDialogProps) {
  return (
    <AlertDialog open={tabName !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent zIndex={CANVAS_CONFIRM_DIALOG_Z}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete tab “{tabName ?? ''}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Only this tab’s selection is removed — no images, characters, or props are affected.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              log.info('onConfirm', 'tab deletion confirmed');
              onConfirm();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
