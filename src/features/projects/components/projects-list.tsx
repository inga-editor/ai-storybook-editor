// projects-list.tsx — Renders the (already-filtered) projects as a card list,
// resolving 3 states: library-empty (no projects at all → CTA), search-empty
// (search matched nothing → adjust hint), and populated. Empty states are inline
// presentational components (not split to their own files).

import { FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/utils/logger';
import type { ProjectOverviewRow } from '../types';
import { ProjectRow } from './project-row';

const log = createLogger('Projects', 'ProjectsList');

interface ProjectsListProps {
  projects: ProjectOverviewRow[]; // already filtered by parent
  isLibraryEmpty: boolean; // raw projects (pre-filter) === 0
  onOpen: (project: ProjectOverviewRow) => void;
  onDelete: (project: ProjectOverviewRow) => void;
  onNew?: () => void; // LibraryEmptyState CTA
}

/** No projects exist yet → invite the user to create the first one. */
function LibraryEmptyState({ onNew }: { onNew?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <FolderOpen className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <p className="text-base font-medium">No projects yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        A project holds one story. Create your first project, then add localized
        book editions inside it.
      </p>
      {onNew ? (
        <Button onClick={onNew} className="mt-2">
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          New Project
        </Button>
      ) : null}
    </div>
  );
}

/** Projects exist but the search matched none → suggest adjusting. */
function SearchEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <FolderOpen className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <p className="text-base font-medium">No projects found</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Adjust your search.
      </p>
    </div>
  );
}

export function ProjectsList({
  projects,
  isLibraryEmpty,
  onOpen,
  onDelete,
  onNew,
}: ProjectsListProps) {
  if (isLibraryEmpty) {
    log.debug('render', 'library empty');
    return <LibraryEmptyState onNew={onNew} />;
  }

  if (projects.length === 0) {
    log.debug('render', 'search empty');
    return <SearchEmptyState />;
  }

  log.debug('render', 'populated', { count: projects.length });
  return (
    <ul role="list" className="flex flex-col gap-3 px-6 py-4">
      {projects.map((project) => (
        <li key={project.id}>
          <ProjectRow project={project} onOpen={onOpen} onDelete={onDelete} />
        </li>
      ))}
    </ul>
  );
}
