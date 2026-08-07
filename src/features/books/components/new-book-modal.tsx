// new-book-modal.tsx — Create-a-book form (Title, Format, Dimension, Target,
// Language, Art Style). 5 fields required; Art Style is OPTIONAL. The field set +
// lookups live in the shared <BookMetaFields> (also used by ImportBookModal). On
// submit it calls the store's createBook (which unshifts the new row into books[]
// + sets currentBook), then notifies the parent via onCreated. Per validated
// decision S1 the parent STAYS on /books and shows a toast — it does NOT navigate
// to the editor on create.
//
// Dialog dismiss is blocked while creating. a11y: role=alert error.

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useBookActions } from '@/stores/book-store';
import { createLogger } from '@/utils/logger';
import { BookMetaFields } from './book-meta-fields';
import {
  INITIAL_BOOK_META,
  isBookMetaValid,
  type BookMetaValue,
} from './book-meta-fields-config';

const log = createLogger('Books', 'NewBookModal');

interface NewBookModalProps {
  projectId: string;
  /** First book in the project becomes the international/original edition. */
  isFirstBookInProject: boolean;
  onClose: () => void;
  onCreated: (book: { id: string }) => void;
}

export function NewBookModal({
  projectId,
  isFirstBookInProject,
  onClose,
  onCreated,
}: NewBookModalProps) {
  const { createBook } = useBookActions();

  const [meta, setMeta] = React.useState<BookMetaValue>(INITIAL_BOOK_META);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const patch = React.useCallback(
    (p: Partial<BookMetaValue>) => setMeta((m) => ({ ...m, ...p })),
    [],
  );

  const isValid = isBookMetaValid(meta);

  const handleSubmit = React.useCallback(async () => {
    if (!isValid || creating) return;
    log.info('handleSubmit', 'creating book', { title: meta.title.trim() });
    setCreating(true);
    setError(null);

    try {
      const book = await createBook({
        title: meta.title.trim(),
        format_id: meta.formatId,
        dimension: Number(meta.dimension),
        target_audience: Number(meta.targetAudience),
        original_language: meta.originalLanguage,
        artstyle_id: meta.artstyleId ?? null,
        sketchstyle_id: meta.sketchstyleId ?? null,
        project_id: projectId,
        is_international: isFirstBookInProject,
      });

      if (!book) {
        log.warn('handleSubmit', 'createBook returned null');
        setError('Could not create book. Please try again.');
        setCreating(false);
        return;
      }

      log.info('handleSubmit', 'created', { bookId: book.id });
      onCreated(book);
      onClose();
    } catch (err) {
      log.error('handleSubmit', 'createBook threw', {
        message: err instanceof Error ? err.message : String(err),
      });
      setError('Could not create book. Please try again.');
      setCreating(false);
    }
  }, [
    isValid,
    creating,
    meta,
    createBook,
    onCreated,
    onClose,
    projectId,
    isFirstBookInProject,
  ]);

  // Block dismiss (Esc / click-outside / [X]) while creating.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (creating) return;
      if (!next) onClose();
    },
    [creating, onClose],
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>New Book</DialogTitle>
          {/* Subtitle kept for screen readers only — mock has no visible description. */}
          <DialogDescription className="sr-only">
            Set up the basics for your new book. You can change these later in the editor.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <BookMetaFields value={meta} onChange={patch} disabled={creating} idPrefix="new-book" />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
