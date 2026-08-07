// Books feature — non-UI domain types.
// `book.step` (SMALLINT 1|2|3) is the single source of truth for badge + filter.

export type BookStep = 1 | 2 | 3;
export type BookStepTone = 'sketch' | 'illustration' | 'retouch';

/** Toolbar step filter: `'all'` shows everything, else narrow to one step. */
export type StepFilter = 'all' | BookStep;

/** Import shells (ingest deferred). */
export type ImportSource = 'zip' | 'script';

export interface BooksFilterState {
  search: string;
  step: StepFilter;
}

/** Minimal project header context for the project-scoped /books page. */
export interface ProjectContext {
  id: string;
  title: string;
}

/** Art-style option projected for the (custom Popover) picker — no `cmdk`. */
export interface ArtStyleOption {
  id: string;
  name: string;
  thumbnailUrl?: string;
}
