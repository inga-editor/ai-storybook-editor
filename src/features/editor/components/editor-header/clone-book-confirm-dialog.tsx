// clone-book-confirm-dialog.tsx — Confirm step for "Clone this book" in the header menu.
//
// Spec: ai-storybook-design/component/editor-page/01-editor-header.md §3.6.3
// Shape follows src/features/books/components/delete-book-dialog.tsx (Radix AlertDialog).
//
// ⚠️ The copy is deliberately vague. What a clone carries (versions / distribution artifacts /
// collaborators / remixes / cost history) is an UNDECIDED business question and the clone endpoint
// does not exist yet. Promising a scope now means either rewriting it later or lying to the user.
// Add the precise sentence when the API is designed.
//
// Fully presentational: `isCloning` + `error` live in EditorHeader (spec §2.2 EditorHeaderState),
// so the same in-flight flag can also gate the menu row.

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
import { Loader2 } from 'lucide-react';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'CloneBookConfirmDialog');

interface CloneBookConfirmDialogProps {
  isOpen: boolean;
  /** Shown in the body so the user knows WHICH book is being copied. */
  bookTitle: string;
  /** In-flight clone: spinner on the primary button, both buttons disabled, dismiss blocked. */
  isCloning: boolean;
  /** Inline failure message; the dialog stays open so the user can retry. */
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function CloneBookConfirmDialog({
  isOpen,
  bookTitle,
  isCloning,
  error,
  onOpenChange,
  onConfirm,
}: CloneBookConfirmDialogProps) {
  // Escape / click-outside are no-ops while the clone is in flight — dismissing mid-write would
  // leave the user with no signal about whether the copy was created (§3.6.3).
  const handleOpenChange = (open: boolean) => {
    if (!open && isCloning) {
      log.debug('handleOpenChange', 'dismiss ignored: clone in flight', { bookTitle });
      return;
    }
    if (!open) log.info('handleOpenChange', 'clone cancelled', { bookTitle });
    onOpenChange(open);
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Clone this book?</AlertDialogTitle>
          <AlertDialogDescription>
            A copy of{' '}
            <strong className="font-medium text-foreground">
              &ldquo;{bookTitle || 'Untitled'}&rdquo;
            </strong>{' '}
            will be created in your library.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <div role="alert" className="text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isCloning}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // Radix closes the dialog on Action click by default — prevented so the
            // 'cloning' state (and any inline error) stays visible.
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isCloning}
          >
            {isCloning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Cloning…
              </>
            ) : (
              'Clone book'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
