// book-details-modal.tsx — Read-only quick-look at one book's metadata. The
// header (title / cover / edition+status+step badges / spread count / updated)
// renders immediately from the ProjectBookItem prop (spread_count comes from the
// RPC — NO client-side snapshot count). The metadata table (Format, Dimension,
// Target, Art Style, Language, Countries, Languages, Description) lives on the
// FULL Book, so on open we fetchBook(book.id) + resolve lookup labels (formats /
// art_styles names). Countries/Languages come straight from the item. "Open
// Editor" routes the parent to /editor/:id.
//
// a11y: Dialog focus-trap + Esc; <dl>/<dt>/<dd> semantics for key-value rows;
// cover <img alt={title}>.

import * as React from 'react';
import { ArrowRight, BookOpen, Clock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/apis/supabase';
import { useBookActions } from '@/stores/book-store';
import {
  DIMENSION_OPTIONS,
  TARGET_AUDIENCE_OPTIONS,
} from '@/constants/book-enums';
import { resolveMultiLangName } from '@/utils/multi-lang-helpers';
import { formatRelativeTime } from '@/utils/format-relative-time';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';
import type { Book } from '@/types/editor';
import type { BookStep, ProjectBookItem } from '@/features/books/types';
import { deriveBookStatus } from '@/features/books/utils/book-content-status';
import { countryLabel, languageLabel } from '@/features/books/utils/book-labels';
import { StepBadge } from './step-badge';
import { EditionBadge, StatusBadge } from './book-badges';

const log = createLogger('Books', 'BookDetailsModal');

interface BookDetailsModalProps {
  book: ProjectBookItem;
  onClose: () => void;
  onEdit: (book: ProjectBookItem) => void;
}

interface DetailRow {
  label: string;
  value: string;
  fullWidth?: boolean; // span both grid columns (Languages / Description)
}

const PLACEHOLDER = '—';

/** translation_status → human suffix on a language chip. */
function statusSuffix(entry: { translation_status: number } | undefined): string {
  switch (entry?.translation_status) {
    case 1:
      return ' (translating)';
    case 0:
      return ' (not translated)';
    default:
      return ''; // 2 (or unknown) → fully translated, no suffix
  }
}

export function BookDetailsModal({ book, onClose, onEdit }: BookDetailsModalProps) {
  const { fetchBook } = useBookActions();

  const [full, setFull] = React.useState<Book | null>(null);
  const [formatNames, setFormatNames] = React.useState<Map<string, Record<string, string>>>(new Map());
  const [artStyleNames, setArtStyleNames] = React.useState<Map<string, string>>(new Map());

  React.useEffect(() => {
    let cancelled = false;
    log.info('load', 'fetching details', { bookId: book.id });

    // Full Book metadata (spread_count already on the item — no snapshot query).
    void fetchBook(book.id).then((data) => {
      if (cancelled) return;
      setFull(data);
    });

    // Lookup name maps (format JSONB multilang + art_styles string name).
    void (async () => {
      const [formatsRes, artStylesRes] = await Promise.all([
        supabase.from('formats').select('id, name'),
        supabase.from('art_styles').select('id, name'),
      ]);
      if (cancelled) return;
      if (formatsRes.error) {
        log.error('load', 'formats lookup failed', { error: formatsRes.error.message });
      } else {
        const m = new Map<string, Record<string, string>>();
        for (const f of formatsRes.data ?? []) m.set(f.id, f.name as Record<string, string>);
        setFormatNames(m);
      }
      if (artStylesRes.error) {
        log.error('load', 'art_styles lookup failed', { error: artStylesRes.error.message });
      } else {
        const m = new Map<string, string>();
        for (const a of artStylesRes.data ?? []) m.set(a.id, a.name as string);
        setArtStyleNames(m);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [book.id, fetchBook]);

  const rows: DetailRow[] | null = React.useMemo(() => {
    if (!full) return null;
    const lang = full.original_language;

    const formatLabel = full.format_id
      ? resolveMultiLangName(formatNames.get(full.format_id), lang)
      : PLACEHOLDER;
    const dimensionLabel =
      DIMENSION_OPTIONS.find((o) => o.value === full.dimension)?.label ?? PLACEHOLDER;
    const targetLabel =
      TARGET_AUDIENCE_OPTIONS.find((o) => o.value === full.target_audience)?.label ?? PLACEHOLDER;
    const artStyleLabel = full.artstyle_id
      ? artStyleNames.get(full.artstyle_id) ?? PLACEHOLDER
      : PLACEHOLDER;

    // Localization context — straight from the RPC item (no full needed).
    const countriesLabel =
      book.support_countries.map((c) => countryLabel(c.code)).join(', ') || PLACEHOLDER;
    const languagesLabel =
      Object.keys(book.support_languages)
        .map((k) => `${languageLabel(k)}${statusSuffix(book.support_languages[k])}`)
        .join(', ') || PLACEHOLDER;

    return [
      { label: 'Format', value: formatLabel },
      { label: 'Dimension', value: dimensionLabel },
      { label: 'Target', value: targetLabel },
      { label: 'Art Style', value: artStyleLabel },
      { label: 'Language', value: languageLabel(book.original_language) },
      { label: 'Countries', value: countriesLabel },
      { label: 'Languages', value: languagesLabel, fullWidth: true },
      { label: 'Description', value: full.description || PLACEHOLDER, fullWidth: true },
    ];
  }, [full, formatNames, artStyleNames, book.support_countries, book.support_languages, book.original_language]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  const status = deriveBookStatus(book.spread_count, book.step);
  const coverUrl = book.cover?.normal_url ?? book.cover?.thumbnail_url ?? null;
  const updatedLabel = formatRelativeTime(book.updated_at);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{book.title}</DialogTitle>
        </DialogHeader>

        {/* Top: cover + summary (edition / status / step / spreads / updated — stacked) */}
        <div className="grid grid-cols-[160px_1fr] gap-6">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={book.title}
              className="aspect-square w-full rounded-md bg-muted object-cover"
            />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-md bg-muted text-muted-foreground">
              <BookOpen className="h-8 w-8" />
            </div>
          )}

          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <EditionBadge
                isInternational={book.is_international}
                countries={book.support_countries}
              />
              <StatusBadge status={status} />
              <StepBadge step={book.step as BookStep} />
            </div>
            <span>{book.spread_count} spreads</span>
            {updatedLabel && (
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {updatedLabel}
              </span>
            )}
          </div>
        </div>

        {/* Metadata — 2-column grid, label above value; some rows span both cols */}
        {rows ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4">
            {rows.map((row) => (
              <div key={row.label} className={cn(row.fullWidth && 'col-span-2')}>
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
                <dd className="mt-0.5 text-base text-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={cn(i >= 6 && 'col-span-2')}>
                <dt className="h-4 w-20 animate-pulse rounded bg-muted" />
                <dd
                  className={cn(
                    'mt-1.5 h-4 animate-pulse rounded bg-muted',
                    i >= 6 ? 'w-64' : 'w-28',
                  )}
                />
              </div>
            ))}
          </dl>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => onEdit(book)}>
            Open Editor
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
