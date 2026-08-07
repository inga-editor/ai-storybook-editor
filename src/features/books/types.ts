// Books feature — non-UI domain types.
// `book.step` (SMALLINT 1|2|3) is the single source of truth for badge + filter.

export type BookStep = 1 | 2 | 3;
export type BookStepTone = 'sketch' | 'illustration' | 'retouch';

/** Minimal project header context for the project-scoped /books page.
 *  Source = `projects` row (id/title/description) — see `fetchProjectContext`. */
export interface ProjectContext {
  id: string;
  title: string;
  description: string | null; // subtitle in BooksHeader (redesign 2026-08-07)
}

/**
 * One book edition row for the project-scoped /books page.
 * Source = RPC `get_project_books(p_project_id)` (server-side `spread_count`,
 * sorted international-first). NOT `BookListItem` (store) — carries `spread_count`,
 * `support_countries`, `support_languages`, `original_language`.
 */
export interface ProjectBookItem {
  id: string;
  title: string;
  description: string | null;
  cover: { thumbnail_url?: string; normal_url?: string } | null;
  step: number; // 1|2|3
  is_international: boolean;
  original_language: string; // 'vi_VN'
  support_languages: Record<string, { translation_status: number }>;
  support_countries: Array<{ code: string }>; // ISO 3166-1 alpha-2
  spread_count: number;
  updated_at: string;
}

/** Content-derived status badge (spread_count + step) — see `deriveBookStatus`. */
export type BookContentStatus = 'empty' | 'in_progress' | 'completed';

/** Art-style option projected for the (custom Popover) picker — no `cmdk`. */
export interface ArtStyleOption {
  id: string;
  name: string;
  thumbnailUrl?: string;
}
