// unsaved-changes-modal.tsx — shown when a navigation interceptor blocks leaving a dirty
// config section. Two explicit actions (Save / Discard); ✕ / Esc / backdrop = stay.
//
// Uses Radix Dialog (has ✕, Esc, backdrop) — NOT alert-dialog. On save fail the parent
// keeps `pendingProceed`, so the modal stays mounted for the user to retry / discard / stay.

import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'UnsavedChangesModal');

export interface UnsavedChangesModalProps {
  /** Human label of the section being left (e.g. "General"). */
  sectionLabel: string;
  isSaving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** ✕ / Esc / backdrop → stay on the current section (draft kept). */
  onStay: () => void;
}

export function UnsavedChangesModal({
  sectionLabel,
  isSaving,
  onSave,
  onDiscard,
  onStay,
}: UnsavedChangesModalProps) {
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      log.debug('handleOpenChange', 'dismissed (✕/Esc/backdrop) — staying', { sectionLabel });
      onStay();
    }
  };

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            You have unsaved changes in “{sectionLabel}”. Save before leaving?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDiscard} disabled={isSaving}>
            Discard
          </Button>
          <Button variant="default" onClick={onSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
