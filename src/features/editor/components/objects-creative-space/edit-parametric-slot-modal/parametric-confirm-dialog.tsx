// parametric-confirm-dialog.tsx — Destructive confirm for EditParametricSlotModal
// (Remove Parametric Slot / Clear images of one value). Same construction as
// swap-crop-sheet-modal/relayout-confirm-dialog.tsx:
//   • `zIndex` opt-in prop → paints ABOVE the full-screen modal (Z_INDEX.confirmDialog)
//     instead of the shared AlertDialog z-50, which would mount it invisibly behind.
//   • portal INTO the modal's `[role=dialog]` ancestor so the modal's ILS click-outside
//     router counts confirm clicks as "inside" and does not close the whole workspace.
//   • `text-foreground` because, portaled inside the modal, it would otherwise inherit
//     --swap-modal-text-primary (white) on the AlertDialog's light background.

import { useCallback, useState } from 'react';
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
import { Z_INDEX } from '@/features/editor/components/remix-creative-space/swap-crop-sheet-modal/swap-modal-constants';

const log = createLogger('Editor', 'ParametricConfirmDialog');

export interface ParametricConfirmDialogProps {
  open: boolean;
  title: string;
  /** Must state exactly what is lost (how many images / values) — §Bảo mật of the phase. */
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ParametricConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: ParametricConfirmDialogProps) {
  // Callback ref instead of useEffect+setState (React 19 lints set-state-in-effect).
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const markerRef = useCallback((el: HTMLSpanElement | null) => {
    const target = el ? (el.closest('[role="dialog"]') as HTMLElement | null) : null;
    if (el && !target) {
      // Falls back to the <body> portal → the modal's click-outside router would then read
      // confirm clicks as "outside" and close the whole workspace.
      log.warn('markerRef', 'no [role=dialog] ancestor, confirm will portal to body', {});
    }
    setContainer(target);
  }, []);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <span ref={markerRef} className="hidden" aria-hidden="true" />
      <AlertDialogContent
        container={container}
        zIndex={Z_INDEX.confirmDialog}
        className="text-foreground sm:max-w-[440px]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
