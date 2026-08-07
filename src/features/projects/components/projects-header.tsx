// projects-header.tsx — Title row for /projects: h1 + subtitle + "New Project".
// Taller than the books h-16 header because of the subtitle (px-6 py-4).
// Presentational; emits a single callback, owns no state.

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/utils/logger';

const log = createLogger('Projects', 'ProjectsHeader');

interface ProjectsHeaderProps {
  onNew: () => void;
}

export function ProjectsHeader({ onNew }: ProjectsHeaderProps) {
  log.debug('render', 'render header');
  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-4">
      <div>
        <h1 id="projects-heading" className="text-xl font-bold text-foreground">
          Projects
        </h1>
        <p className="text-sm text-muted-foreground">
          One story, many localized books
        </p>
      </div>
      <Button onClick={onNew}>
        <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
        New Project
      </Button>
    </header>
  );
}
