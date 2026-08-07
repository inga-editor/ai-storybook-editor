// Pure derive of a book's content status from RPC fields (spread_count + step).
// No logger: called once per row inside render — must stay a cheap pure fn.
// Rule (04-book-row § 2.3, chốt AskUser 2026-08-07 — NO new DB column):
//   spread_count <= 0 → 'empty' (highest priority) · step === 3 → 'completed' · else 'in_progress'.

import type { BookContentStatus } from '../types';

/**
 * Derive the content-based status badge for a book row.
 * `spreadCount` guarded with `<= 0` (tolerates negative / NaN-safe callers pass Number()).
 */
export function deriveBookStatus(spreadCount: number, step: number): BookContentStatus {
  if (!(spreadCount > 0)) return 'empty'; // 0, negative, or NaN → no content yet
  if (step === 3) return 'completed'; // Retouch = finished
  return 'in_progress'; // step 1/2 with spreads
}
