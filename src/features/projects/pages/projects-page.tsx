// projects-page.tsx — Root of the /projects page. Owns all state locally (no store
// — single consumer), fetches the RPC on mount, filters client-side via useMemo,
// and orchestrates Header / Toolbar / (Skeleton | Error | List) + 2 portal modals.
// Row click → /books?project=:id. Create → refetch RPC (computed fields). Delete →
// optimistic local remove (server already confirmed inside the dialog).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/features/books';
import {
  applySearch,
  DeleteProjectDialog,
  fetchProjectsOverview,
  NewProjectModal,
  ProjectsHeader,
  ProjectsList,
  ProjectsToolbar,
  type ProjectOverviewRow,
} from '@/features/projects';
import { createLogger } from '@/utils/logger';

const log = createLogger('Projects', 'ProjectsPage');

export function ProjectsPage() {
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ProjectOverviewRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [isNewOpen, setIsNewOpen] = useState(false);
  const [deletingProject, setDeletingProject] =
    useState<ProjectOverviewRow | null>(null);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const rows = await fetchProjectsOverview();
      log.info('loadProjects', 'done', { count: rows.length });
      setProjects(rows);
    } catch (err) {
      log.error('loadProjects', 'fetch failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      setError('Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    log.info('mount', 'fetching projects');
    void loadProjects();
  }, [loadProjects]);

  const filtered = useMemo(
    () => applySearch(projects, search),
    [projects, search],
  );

  const handleNew = useCallback(() => {
    log.debug('handleNew', 'open new-project');
    setIsNewOpen(true);
  }, []);

  const handleOpen = useCallback(
    (project: ProjectOverviewRow) => {
      log.info('handleOpen', 'navigate books scope', { id: project.id });
      navigate(`/books?project=${project.id}`);
    },
    [navigate],
  );

  const handleDelete = useCallback((project: ProjectOverviewRow) => {
    log.debug('handleDelete', 'open delete dialog', { id: project.id });
    setDeletingProject(project);
  }, []);

  // Server already deleted (dialog is server-first) → optimistic local remove.
  const handleDeleted = useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleCreated = useCallback(() => {
    setIsNewOpen(false);
    void loadProjects(); // refetch to obtain computed fields for the new row
  }, [loadProjects]);

  return (
    <main aria-labelledby="projects-heading" className="w-full">
      <ProjectsHeader onNew={handleNew} />
      <ProjectsToolbar search={search} onChange={setSearch} />

      {isLoading && projects.length === 0 ? (
        <ListSkeleton rows={5} />
      ) : error ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 py-16 text-center"
        >
          <p className="text-base font-medium text-destructive">{error}</p>
          <Button variant="outline" onClick={() => void loadProjects()}>
            Retry
          </Button>
        </div>
      ) : (
        <ProjectsList
          projects={filtered}
          isLibraryEmpty={projects.length === 0}
          onOpen={handleOpen}
          onDelete={handleDelete}
          onNew={handleNew}
        />
      )}

      {isNewOpen && (
        <NewProjectModal
          onClose={() => setIsNewOpen(false)}
          onCreated={handleCreated}
        />
      )}
      {deletingProject && (
        <DeleteProjectDialog
          project={deletingProject}
          onClose={() => setDeletingProject(null)}
          onDeleted={handleDeleted}
        />
      )}
    </main>
  );
}
