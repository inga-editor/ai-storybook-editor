// parse-remix-editor-route.ts — Pure, router-free parsing of the single Remix Editor
// route. Design §2 mandates ONE route: `/book/:bookId` with an optional `?remix=:id`
// preselect. No react-router / history dependency (KISS) — just string + URLSearchParams.
//
// Returns null when the path does not match `^/book/:bookId/?$`; the shell maps a null
// route to the `error` status (BOOK_ID_MISSING).
import { createLogger } from '@/utils/logger';
import type { RemixEditorRouteParams } from '../types/remix-editor-status';

const log = createLogger('RemixEditor', 'parseRoute');

/** Matches `/book/<bookId>` with an optional trailing slash; captures the bookId segment. */
const BOOK_ROUTE_RE = /^\/book\/([^/]+)\/?$/;

export interface RemixEditorLocationLike {
  /** `location.pathname` — e.g. `/book/abc-123`. */
  pathname: string;
  /** `location.search` — e.g. `?remix=xyz`. */
  search: string;
}

/**
 * Parse the current location into route params, or null when the path is not a valid
 * book route. The `remix` query param (if present + non-empty) becomes `preselectRemixId`.
 */
export function parseRemixEditorRoute(
  location: RemixEditorLocationLike,
): RemixEditorRouteParams | null {
  const match = BOOK_ROUTE_RE.exec(location.pathname);
  if (!match) {
    log.debug('parse', 'pathname did not match /book/:bookId', { pathname: location.pathname });
    return null;
  }

  const bookId = decodeURIComponent(match[1]);
  const params = new URLSearchParams(location.search);
  const remixRaw = params.get('remix');
  const preselectRemixId = remixRaw && remixRaw.length > 0 ? remixRaw : undefined;

  log.debug('parse', 'route parsed', { hasPreselect: preselectRemixId !== undefined });
  return preselectRemixId ? { bookId, preselectRemixId } : { bookId };
}
