// cost-api.ts — Read-only rollup of a book's 3rd-party AI spend, split by scope
// (Original + each Remix) and, inside a scope, by leaf `(action × model)` cells.
//   getBookCostBreakdown() → GET /api/cost/book-breakdown/{bookId}
//
// Spec: ai-storybook-design/api/cost/01-get-book-cost-breakdown.md
// Consumers: EditorHeader menu Cost row (prefetch) + CostBreakdownModal (same response reused
// via `initialData`, so opening the modal shows no spinner).
//
// Auth = Supabase user JWT (Bearer) only — the endpoint gates on admin ∨ book owner. It is
// reused verbatim through `callImageApiGet`, which also sends `X-API-Key`; the endpoint simply
// ignores that extra header (identical situation to provenance-api.ts). A second fetch client
// just to drop one header would be duplicated timeout/error-envelope logic.
//
// NEVER throws. Every failure comes back as a narrowed `error` kind that maps 1-1 onto the
// modal's three error states (design §3.2), so no consumer has to know HTTP status codes.

import { callImageApiGet } from './image-api-client';
import { createLogger } from '@/utils/logger';
import type {
  BookCostBreakdown,
  BookCostBreakdownMeta,
  GetBookCostBreakdownResult,
} from '@/types/cost';

const log = createLogger('API', 'CostApi');

/** The only error vocabulary consumers see. Maps 1-1 to modal §3.2:
 *  `forbidden` → "Only the book owner can view costs." (no retry),
 *  `not-found` → "This book no longer exists.",
 *  `network`   → "Couldn't load costs." + Retry. */
export type CostApiErrorKind = 'forbidden' | 'not-found' | 'network';

export type GetBookCostBreakdownOutcome =
  | { ok: true; data: BookCostBreakdown; meta: BookCostBreakdownMeta }
  | { ok: false; error: CostApiErrorKind };

/**
 * Single place where an HTTP status becomes a user-facing error state.
 * Anything that is not an explicit 403/404 — 0 (timeout/connection), 400 (bad uuid),
 * 401 (expired session), 5xx — is `network`, i.e. the only retryable branch.
 */
function classifyCostError(httpStatus: number): CostApiErrorKind {
  if (httpStatus === 403) return 'forbidden';
  if (httpStatus === 404) return 'not-found';
  return 'network';
}

/**
 * Fetch the full cost breakdown of one book (all scopes, all leaf cells) in ONE call.
 * The caller pivots client-side per group mode — switching scope/groupBy must not refetch.
 *
 * ⚠️ Always remix-INCLUSIVE (the server default). The endpoint also accepts `?includeRemixes=false`,
 * which is cheaper, but this client deliberately does not expose it: BOTH consumers share one
 * response — the header prefetch is handed straight to the modal as `initialData` — and an
 * Original-only payload could not serve the modal's scope select. A knob whose only correct value
 * is "unset" is a trap, so it is not offered. Re-add it only for a consumer that never feeds the
 * modal (and note that the server's `lastCallAt` then covers Original rows only).
 */
export async function getBookCostBreakdown(
  bookId: string,
): Promise<GetBookCostBreakdownOutcome> {
  // Guard before the network hop: an empty id would hit `/book-breakdown/` (405/404 noise).
  // Mapped to 'not-found' (NOT 'network') on purpose: there is nothing to retry — a blank id is a
  // caller bug, and a Retry button that re-sends the same blank id just loops. The warn below is
  // the breadcrumb that tells the two cases apart in prod logs.
  if (!bookId || !bookId.trim()) {
    log.warn('getBookCostBreakdown', 'missing bookId — skipped request', { bookId });
    return { ok: false, error: 'not-found' };
  }

  log.info('getBookCostBreakdown', 'request', { bookId });

  const res = await callImageApiGet<GetBookCostBreakdownResult>(
    `/api/cost/book-breakdown/${encodeURIComponent(bookId.trim())}`,
  );

  if (!res.success) {
    const error = classifyCostError(res.httpStatus);
    log.warn('getBookCostBreakdown', 'failed', {
      bookId,
      httpStatus: res.httpStatus,
      errorCode: res.errorCode,
      error,
    });
    return { ok: false, error };
  }

  log.info('getBookCostBreakdown', 'ok', {
    bookId,
    scopeCount: res.data.scopes.length,
    rowCount: res.meta.rowCount,
    truncated: res.meta.truncated,
  });
  return { ok: true, data: res.data, meta: res.meta };
}
