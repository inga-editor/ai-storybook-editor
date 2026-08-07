// new-project-modal.tsx — Create an EMPTY project (title + optional description).
// No book is auto-created. On success the parent refetches the RPC (the new row
// carries computed fields — book_count / last_activity_at — we cannot synthesize).
// Dismiss is blocked while submitting. a11y: labels + role="alert" error.

import { useCallback, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createProject } from '../api/projects-api';
import { createLogger } from '@/utils/logger';

const log = createLogger('Projects', 'NewProjectModal');

const TITLE_MAX = 200;

interface NewProjectModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function NewProjectModal({ onClose, onCreated }: NewProjectModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && !isSubmitting;

  const handleCreate = useCallback(async () => {
    if (!canSubmit) return;
    log.info('handleCreate', 'creating project');
    setIsSubmitting(true);
    setError(null);

    try {
      await createProject({ title, description });
      log.info('handleCreate', 'created');
      onCreated();
    } catch (err) {
      log.error('handleCreate', 'insert project failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      setError('Could not create project. Please try again.');
      setIsSubmitting(false);
    }
  }, [canSubmit, title, description, onCreated]);

  // Block dismiss (Esc / click-outside / [X]) while submitting.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (isSubmitting) return;
      if (!next) onClose();
    },
    [isSubmitting, onClose],
  );

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleCreate();
    }
  };

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            A project holds one story. Books inside it are localized editions of
            that story.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-project-title">Original Title</Label>
            <Input
              id="new-project-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              maxLength={TITLE_MAX}
              autoFocus
              disabled={isSubmitting}
              placeholder="The Little Prince"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-project-description">Description</Label>
            <Textarea
              id="new-project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={isSubmitting}
              placeholder="Optional — a short note about this story."
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSubmitting ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
