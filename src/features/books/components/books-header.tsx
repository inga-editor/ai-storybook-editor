// books-header.tsx — Title row for the (project-scoped) /books page: a back arrow
// to /projects + project title + subtitle (description · Original: {language}) +
// an info line, then 2 CTA (New International / New Localization). Presentational;
// emits callbacks, owns no state. Disable rule is symmetric (greyed + tooltip,
// never hidden): International disabled once one exists; Localization disabled
// until an international book exists (nothing to clone from). See 01-books-header.

import { ArrowLeft, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { languageLabel } from '@/features/books/utils/book-labels';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'BooksHeader');

interface BooksHeaderProps {
  projectTitle: string;
  projectDescription: string | null;
  originalLanguage: string | null; // from the international book; null when none yet
  hasInternational: boolean; // drives the symmetric disable rule
  onBack: () => void;
  onNewInternational: () => void;
  onNewLocalization: () => void;
}

const INFO_LINE =
  'Every book below shares the same story. Each one is a localization with its own translated title.';

export function BooksHeader({
  projectTitle,
  projectDescription,
  originalLanguage,
  hasInternational,
  onBack,
  onNewInternational,
  onNewLocalization,
}: BooksHeaderProps) {
  log.debug('render', 'render header', { hasInternational });

  // Subtitle = description + " · Original: {language}" (each part optional).
  const originalSuffix = originalLanguage
    ? ` · Original: ${languageLabel(originalLanguage)}`
    : '';
  const subtitle = `${projectDescription ?? ''}${originalSuffix}`.trim();

  return (
    <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to projects"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <h1
            id="books-heading"
            className="max-w-[40vw] truncate text-xl font-semibold text-foreground"
          >
            {projectTitle}
          </h1>
          {subtitle ? (
            <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{INFO_LINE}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          onClick={onNewInternational}
          disabled={hasInternational}
          aria-disabled={hasInternational}
          title={
            hasInternational
              ? 'Project already has an international book'
              : undefined
          }
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New International
        </Button>
        <Button
          onClick={onNewLocalization}
          disabled={!hasInternational}
          aria-disabled={!hasInternational}
          title={
            !hasInternational ? 'Create the international book first' : undefined
          }
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New Localization
        </Button>
      </div>
    </header>
  );
}
