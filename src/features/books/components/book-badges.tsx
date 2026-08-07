// book-badges.tsx — Shared row/modal badge pills for a ProjectBookItem.
// EditionBadge (International / Localization - {Country}) + StatusBadge
// (Empty / In Progress / Completed) are rendered in BOTH BookRow and
// BookDetailsModal → extracted here (DRY) instead of duplicated inline.
// Text label is the primary channel; color is supplementary (a11y-safe).

import { cn } from '@/utils/utils';
import { PILL_BASE, EDITION_BADGE_CLASS, STATUS_META } from '@/features/books/constants';
import { editionLabel } from '@/features/books/utils/book-labels';
import type { BookContentStatus } from '@/features/books/types';

interface EditionBadgeProps {
  isInternational: boolean;
  countries: Array<{ code: string }>;
}

/** International / Localization - {Country}[ +N] — blue tint pill (see 04 § 2.3). */
export function EditionBadge({ isInternational, countries }: EditionBadgeProps) {
  return (
    <span className={cn(PILL_BASE, EDITION_BADGE_CLASS)}>
      {editionLabel(isInternational, countries)}
    </span>
  );
}

interface StatusBadgeProps {
  status: BookContentStatus;
}

/** Content-derived status pill (Empty / In Progress / Completed). */
export function StatusBadge({ status }: StatusBadgeProps) {
  const meta = STATUS_META[status];
  return <span className={cn(PILL_BASE, meta.badgeClass)}>{meta.label}</span>;
}
