// project-row.tsx — One project as a card in the /projects list: cover + title +
// description + language/book meta + relative activity time + delete action.
// Card body is a role="button" (Enter/Space → onOpen); the 🗑 button stops
// propagation so it never re-triggers the open handler. Wrapped in React.memo.

import { memo } from 'react';
import { Clock, FolderOpen, Languages, Layers, Trash2 } from 'lucide-react';
import { cn } from '@/utils/utils';
import { formatRelativeTime } from '@/utils/format-relative-time';
import { createLogger } from '@/utils/logger';
import type { ProjectOverviewRow } from '../types';
import { languageLabel, shortCodes } from '../utils/project-language';

const log = createLogger('Projects', 'ProjectRow');

interface ProjectRowProps {
  project: ProjectOverviewRow;
  onOpen: (project: ProjectOverviewRow) => void;
  onDelete: (project: ProjectOverviewRow) => void;
}

/** Inline cover thumbnail: lazy <img> from cover, else a FolderOpen placeholder. */
function CoverThumb({
  cover,
  title,
}: {
  cover: ProjectOverviewRow['cover'];
  title: string;
}) {
  const url = cover?.thumbnail_url ?? cover?.normal_url;
  if (url) {
    return (
      <img
        src={url}
        alt={title}
        loading="lazy"
        className="h-16 w-16 shrink-0 rounded-lg object-cover"
      />
    );
  }
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted">
      <FolderOpen className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

function ProjectRowImpl({ project, onOpen, onDelete }: ProjectRowProps) {
  const isEmpty = project.international_book_id === null;
  const codes = isEmpty
    ? []
    : shortCodes(project.support_languages, project.original_language);

  const open = () => {
    log.debug('open', 'row open', { id: project.id });
    onOpen(project);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); // Space would otherwise scroll the page
      open();
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug('handleDelete', 'delete clicked', { id: project.id });
    onDelete(project);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${project.title}`}
      onClick={open}
      onKeyDown={handleKeyDown}
      className="flex cursor-pointer items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:shadow-sm"
    >
      <CoverThumb cover={project.cover} title={project.title} />

      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-foreground">{project.title}</p>
        {project.description ? (
          <p className="truncate text-sm text-muted-foreground">
            {project.description}
          </p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          {isEmpty ? (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
              No books yet
            </span>
          ) : (
            <>
              <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-700">
                {languageLabel(project.original_language)} (original)
              </span>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                {project.book_count} {project.book_count === 1 ? 'book' : 'books'}
              </span>
              {codes.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Languages className="h-3.5 w-3.5" aria-hidden="true" />
                  {codes.join(', ')}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-muted-foreground">
        <span
          className="flex items-center gap-1 text-xs"
          title={new Date(project.last_activity_at).toLocaleString()}
        >
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          {formatRelativeTime(project.last_activity_at)}
        </span>
        <button
          type="button"
          aria-label={`Delete ${project.title}`}
          onClick={handleDelete}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full hover:bg-accent',
            'hover:text-destructive',
          )}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export const ProjectRow = memo(ProjectRowImpl);
