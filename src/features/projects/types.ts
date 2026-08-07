// Projects feature — non-UI domain types.
// A project holds ONE story; the books inside it are localized editions of that
// story. `ProjectOverviewRow` mirrors the shape returned by the RPC
// `get_projects_overview` (computed book_count / cover / language rollup).

/** RPC row from `get_projects_overview` (one per owned project, sorted by RPC). */
export interface ProjectOverviewRow {
  id: string;
  title: string;
  description: string | null;
  status: 0 | 1 | 2;
  created_at: string;
  updated_at: string;
  last_activity_at: string; // ISO — RPC sort key (desc)
  book_count: number;
  international_book_id: string | null;
  cover: { thumbnail_url?: string; normal_url?: string } | null;
  original_language: string | null; // vi_VN | en_US | ...
  support_languages: Record<string, { translation_status: 0 | 1 | 2 }> | null;
}

/** Payload for the create-project modal. Empty description → stored as null. */
export interface NewProjectInput {
  title: string;
  description: string;
}
