// books-header.tsx — Title row for the (project-scoped) /books page: a back arrow
// to /projects + the project title + subtitle, then the 3 CTA. Presentational;
// emits callbacks, owns no state. Primary "New Book" sits last (rightmost).

import { ArrowLeft, Download, FileUp, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/utils/logger';

const log = createLogger('Books', 'BooksHeader');

interface BooksHeaderProps {
  projectTitle: string;
  onBack: () => void;
  onNew: () => void;
  onImportZip: () => void;
  onImportScript: () => void;
}

export function BooksHeader({
  projectTitle,
  onBack,
  onNew,
  onImportZip,
  onImportScript,
}: BooksHeaderProps) {
  log.debug('render', 'render header');
  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to projects"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
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
          <p className="text-sm text-muted-foreground">Books of this project</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" onClick={onImportScript}>
          <FileUp className="mr-1.5 h-4 w-4" />
          Import Script
        </Button>
        <Button variant="outline" onClick={onImportZip}>
          <Download className="mr-1.5 h-4 w-4" />
          Import Zip
        </Button>
        <Button onClick={onNew}>
          <Plus className="mr-1.5 h-4 w-4" />
          New Book
        </Button>
      </div>
    </header>
  );
}
