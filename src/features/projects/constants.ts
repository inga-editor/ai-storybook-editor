// Projects feature — RPC name + fetch/search knobs.

/** Postgres RPC that returns the owner's project overview rows. */
export const PROJECTS_OVERVIEW_RPC = 'get_projects_overview';

/**
 * Explicit fetch ceiling. The RPC defaults `p_limit = 50` and truncates SILENTLY;
 * we pass 200 so the list is not clipped (KISS — no pagination, 1 consumer).
 */
export const PROJECTS_FETCH_LIMIT = 200;

/** Search-input debounce before the page re-filters (client-side only). */
export const PROJECTS_SEARCH_DEBOUNCE_MS = 200;
