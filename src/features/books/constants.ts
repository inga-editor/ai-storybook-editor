// Books feature — step mapping + filter defaults.
// Step value stays `number` (never stringified) to match `book.step` SMALLINT.

import type { BookStep, BookStepTone, BookContentStatus } from './types';

export const STEP_META: Record<BookStep, { label: string; tone: BookStepTone }> = {
  1: { label: 'Sketch', tone: 'sketch' },
  2: { label: 'Illustration', tone: 'illustration' },
  3: { label: 'Retouch', tone: 'retouch' },
};

// ── Books-page redesign (2026-08-07) — RPC + row-badge constants ──────────────

/** RPC returning `ProjectBookItem[]` for a project (server-side spread_count). */
export const PROJECT_BOOKS_RPC = 'get_project_books';

/** Content-derived status badge meta (label + Tailwind class) — see 04-book-row § 2.3. */
export const STATUS_META: Record<BookContentStatus, { label: string; badgeClass: string }> = {
  empty:       { label: 'Empty',       badgeClass: 'bg-muted text-muted-foreground' },
  in_progress: { label: 'In Progress', badgeClass: 'bg-orange-100 text-orange-700' },
  completed:   { label: 'Completed',   badgeClass: 'bg-green-100 text-green-700' },
};

/** Edition badge (International / Localization) — blue tint (a11y contrast). */
export const EDITION_BADGE_CLASS = 'bg-blue-100 text-blue-700';

/** Spreads badge — outline variant. */
export const SPREADS_BADGE_CLASS = 'border border-border bg-background text-muted-foreground';

export const TONE_CLASS: Record<BookStepTone, string> = {
  sketch: 'bg-muted text-muted-foreground',
  illustration: 'bg-blue-100 text-blue-700',
  retouch: 'bg-green-100 text-green-700',
};

export const PILL_BASE =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
