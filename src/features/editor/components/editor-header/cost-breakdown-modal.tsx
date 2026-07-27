// cost-breakdown-modal.tsx — Read-only modal showing what a book has cost in 3rd-party AI
// spend, split by scope (Original / each Remix) and cross-viewed by action or by model.
//
// Spec: ai-storybook-design/component/editor-page/01-01-cost-breakdown-modal.md
// Opened from: EditorHeader → MenuPopover "Cost" row (wired in a later phase).
//
// Three deliberate design decisions, so nobody "fixes" them later:
//
//  1. ONE fetch per open. The response carries EVERY scope and every leaf cell, so changing
//     either select is a pure client pivot — no request, no spinner, no crossfade (§4.1).
//  2. NO child components. The two selects, the list and the total render inline. The rows have
//     no state and are not interactive (§4.3), so extracting them would only create
//     prop-passing shells (§1.1).
//  3. NO store. Cost is read-only server data that lives exactly as long as the modal; parking
//     it in Zustand would just create stale state to invalidate after every generate (§1.2).

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getBookCostBreakdown, type CostApiErrorKind } from '@/apis/cost-api';
import { formatUsd } from '@/utils/format-usd';
import { createLogger } from '@/utils/logger';
import { pivot } from './cost-pivot';
import type {
  BookCostBreakdown,
  BookCostBreakdownMeta,
  CostGroupBy,
} from '@/types/cost';

const log = createLogger('Editor', 'CostBreakdownModal');

/** `scopes[0]` is always Original — the scope the modal resets to on every open. */
const ORIGINAL_SCOPE_KEY = 'original';

/** The modal opens on "By action" even though the option list is ordered model-first (§2.3). */
const DEFAULT_GROUP_BY: CostGroupBy = 'action';

/** Option order follows the mock (model first); the DEFAULT is still 'action'. */
const GROUP_BY_OPTIONS: { value: CostGroupBy; label: string }[] = [
  { value: 'model', label: 'By model' },
  { value: 'action', label: 'By action' },
];

/** §3.2 — only `network` is retryable; 403/404 will produce the same answer forever. */
const ERROR_COPY: Record<CostApiErrorKind, { message: string; canRetry: boolean }> = {
  forbidden: { message: 'Only the book owner can view costs.', canRetry: false },
  'not-found': { message: 'This book no longer exists.', canRetry: false },
  network: { message: "Couldn't load costs.", canRetry: true },
};

const SKELETON_CARDS = [0, 1, 2];

export interface CostBreakdownModalProps {
  isOpen: boolean;
  /** Book whose spend is shown. Changing it while open refetches (deps are this string). */
  bookId: string;
  /** Radix-native open contract — called with `false` on ×, Escape and overlay click. */
  onOpenChange: (open: boolean) => void;
  /** ⚡ Response the header already fetched to render `$12.50` on the menu row. Present →
   *  the modal paints immediately with NO spinner, and still refetches in the background so
   *  a generate that happened since the header loaded is reflected. */
  initialData?: BookCostBreakdown | null;
  /** `meta` of that same prefetch — the client returns it separately from `data`, and the
   *  `truncated` banner needs it. Optional: without it the banner simply waits for the refetch. */
  initialMeta?: BookCostBreakdownMeta | null;
  /** ⚡ Fired on every SUCCESSFUL fetch of this modal, so the surface that seeded `initialData`
   *  (the header's menu row) can adopt the fresher figure instead of serving its first-open value
   *  for the rest of the session — two surfaces must never disagree about money. Optional: the
   *  modal is fully usable standalone without it. */
  onDataLoaded?: (data: BookCostBreakdown, meta: BookCostBreakdownMeta) => void;
}

export function CostBreakdownModal({
  isOpen,
  bookId,
  onOpenChange,
  initialData,
  initialMeta,
  onDataLoaded,
}: CostBreakdownModalProps) {
  const [data, setData] = useState<BookCostBreakdown | null>(null);
  const [meta, setMeta] = useState<BookCostBreakdownMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<CostApiErrorKind | null>(null);
  const [scopeKey, setScopeKey] = useState<string>(ORIGINAL_SCOPE_KEY);
  const [groupBy, setGroupBy] = useState<CostGroupBy>(DEFAULT_GROUP_BY);
  /** Bumped by Retry — the only way to re-run the fetch effect without reopening. */
  const [retryNonce, setRetryNonce] = useState(0);

  // ── Session reset ────────────────────────────────────────────────────────────────────────
  // The component stays mounted while closed, so each open must start from Original / By action
  // instead of inheriting the previous session (§2.3). Done during render — React's documented
  // "adjusting state when a prop changes" — NOT in an effect: an effect would paint the stale
  // scope for one frame first, and `react-hooks/set-state-in-effect` rejects it outright.
  // `sessionToken` also changes when `bookId` changes while open, which is exactly the reset we
  // want there too.
  // Only trust the prefetch if it is about THIS book — when `bookId` changes while the modal is
  // open, a stale `initialData` would otherwise render another book's money under the new id.
  const seedData = initialData && initialData.bookId === bookId ? initialData : null;

  const [openedSession, setOpenedSession] = useState<string | null>(null);
  const sessionToken = isOpen ? bookId : null;
  if (sessionToken !== openedSession) {
    setOpenedSession(sessionToken);
    // ⚠️ Reset only on the way IN. Clearing `data` on close would repaint the body while Radix
    // is still running its 150ms close animation, flashing the "No AI usage yet" empty state on
    // every dismiss. The payload is replaced wholesale on the next open anyway, so nothing
    // stale can ever be shown.
    if (isOpen) {
      setScopeKey(ORIGINAL_SCOPE_KEY);
      setGroupBy(DEFAULT_GROUP_BY);
      setError(null);
      setRetryNonce(0);
      setData(seedData);
      setMeta(seedData ? initialMeta ?? null : null);
      setIsLoading(!seedData);
    }
  }

  // Close is logged from an effect, never from the render-phase block above: that block is a
  // pure state adjustment and would double-fire under StrictMode.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return; // never opened yet — not a close
    wasOpenRef.current = false;
    log.info('closeEffect', 'modal closed', { bookId });
  }, [isOpen, bookId]);

  // `onDataLoaded` is read through a ref so it can stay OUT of the fetch effect's deps: an
  // inline-arrow callback from a re-rendering parent would otherwise re-arm the effect on every
  // render and turn one fetch-per-open into an unbounded request loop.
  const onDataLoadedRef = useRef(onDataLoaded);
  useEffect(() => {
    onDataLoadedRef.current = onDataLoaded;
  });

  // Always fetch on open — even with `initialData`, whose numbers are as old as the header.
  // `cancelled` guards the late resolve of a modal the user already closed (React 19: never
  // set state after the effect that owns it has been cleaned up).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    // Runs on EVERY open, prefetched or not — `initialData` is only as fresh as the header was.
    log.info('fetchEffect', 'modal open, fetching cost breakdown', { bookId, retryNonce });

    void (async () => {
      const res = await getBookCostBreakdown(bookId);
      if (cancelled) {
        log.debug('fetchEffect', 'skip: modal closed before response', { bookId });
        return;
      }

      if (res.ok) {
        setData(res.data);
        setMeta(res.meta);
        setError(null);
        // Closes the flow opened by the `info` above — an entry log with no exit log reads as
        // "crashed mid-way" per logging-convention §7.
        log.info('fetchEffect', 'cost breakdown loaded', {
          bookId,
          scopeCount: res.data.scopes.length,
          rowCount: res.meta.rowCount,
        });
        if (res.meta.truncated) {
          log.warn('fetchEffect', 'result truncated, total is incomplete', {
            bookId,
            rowCount: res.meta.rowCount,
          });
        }
        const unpriced = res.data.scopes.reduce((acc, s) => acc + s.unpricedCallCount, 0);
        if (unpriced > 0) {
          log.warn('fetchEffect', 'unpriced calls excluded from total', { bookId, unpriced });
        }
        // Push the fresh payload back to whoever seeded us, AFTER our own state is written.
        onDataLoadedRef.current?.(res.data, res.meta);
      } else {
        // Recorded even when stale data is on screen: a billing figure that silently stops
        // refreshing is worse than a visible failure with a Retry (§3.2). The numbers already
        // rendered are NOT discarded — see `showErrorState` vs `showInlineError` below.
        log.error('fetchEffect', 'cost fetch failed', { bookId, errorKind: res.error });
        setError(res.error);
      }
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, bookId, retryNonce]);

  const activeScope = useMemo(() => {
    if (!data) return null;
    return data.scopes.find((s) => s.key === scopeKey) ?? data.scopes[0] ?? null;
  }, [data, scopeKey]);

  // The whole point of the one-fetch design: switching either select re-runs THIS, nothing else.
  const groups = useMemo(
    () => (activeScope ? pivot(activeScope.cells, groupBy) : []),
    [activeScope, groupBy],
  );

  const handleScopeChange = (next: string) => {
    log.debug('handleScopeChange', 'scope switched (no refetch)', { from: scopeKey, to: next });
    setScopeKey(next);
  };

  const handleGroupByChange = (next: string) => {
    log.debug('handleGroupByChange', 'group mode switched (no refetch)', {
      from: groupBy,
      to: next,
    });
    setGroupBy(next as CostGroupBy);
  };

  const handleRetry = () => {
    log.info('handleRetry', 'retrying cost fetch', { bookId });
    setError(null);
    setIsLoading(true);
    setRetryNonce((n) => n + 1);
  };

  const scopes = data?.scopes ?? [];
  const showSkeleton = isLoading && !data;
  const errorCopy = error ? ERROR_COPY[error] : null;
  // Filters are meaningless before any scope exists — hide them while loading or on a
  // first-load failure, but keep them if stale data is still on screen behind an error.
  const showFilters = scopes.length > 0;
  // Two very different failures, two very different renders:
  //  - FIRST-LOAD failure (nothing on screen) → the full-body error state; there is nothing to keep.
  //  - BACKGROUND-REFETCH failure over a populated modal → keep every number exactly where it is
  //    and add a non-destructive banner. Blanking a populated modal used to leave the user with
  //    two live selects, an error message and NO total, which is worse than either intended state.
  const showErrorState = !!errorCopy && !data;
  const showInlineError = !!errorCopy && !!data;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className={[
          // 480px fixed ≥640px, gutter-width below it (§4.7). `[&>button]` nudges the built-in
          // × up onto the TITLE line rather than the header block's centre (§2.3).
          'flex max-h-[90vh] w-[calc(100vw-32px)] max-w-none flex-col gap-0 rounded-xl bg-white p-6',
          'sm:w-[480px] sm:max-w-[480px] sm:rounded-xl',
          '[&>button]:right-6 [&>button]:top-[27px]',
        ].join(' ')}
      >
        <DialogHeader className="space-y-1 pr-8 text-left sm:text-left">
          <DialogTitle className="text-xl font-bold text-slate-900">Cost Breakdown</DialogTitle>
          <DialogDescription className="text-sm text-slate-500">
            Breakdown of AI model usage costs
          </DialogDescription>
        </DialogHeader>

        {showFilters && (
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Select
              // Bind to the scope actually being rendered, not the raw `scopeKey`: after a
              // refetch drops the selected remix, `activeScope` falls back to Original and a
              // raw-key binding would leave the trigger blank above Original's numbers.
              value={activeScope?.key ?? ORIGINAL_SCOPE_KEY}
              onValueChange={handleScopeChange}
              // A book with no remix still renders the select (never hide a disabled control),
              // it just cannot be changed.
              disabled={scopes.length <= 1}
            >
              <SelectTrigger
                aria-label="Cost scope"
                className="h-10 rounded-xl border-slate-200 text-sm text-slate-900"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                {scopes.map((scope) => (
                  <SelectItem key={scope.key} value={scope.key} className="rounded-lg">
                    {scope.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={groupBy} onValueChange={handleGroupByChange}>
              <SelectTrigger
                aria-label="Group by"
                className="h-10 rounded-xl border-slate-200 text-sm text-slate-900"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                {GROUP_BY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="rounded-lg">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Body — the only scrolling region, so header and total stay put (§4.7). */}
        <div className="mt-4 max-h-[70vh] flex-1 overflow-y-auto">
          {/* Hoisted ABOVE the state branches on purpose: truncation can leave the active scope
              with zero cells, and the empty state must not swallow the "numbers are incomplete"
              warning — silent missing data is the failure §3.3 exists to prevent. */}
          {meta?.truncated && !showSkeleton && !showErrorState && (
            <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Showing the most recent 20,000 calls — total is incomplete.
            </p>
          )}

          {/* Refresh failed but the previous answer is still valid — say so without taking it
              away. `role="alert"` because the retry itself is silent (no spinner by design). */}
          {showInlineError && errorCopy && (
            <div
              role="alert"
              className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              <span>{errorCopy.message} Showing the last loaded figures.</span>
              {errorCopy.canRetry && (
                <Button variant="outline" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={handleRetry}>
                  Retry
                </Button>
              )}
            </div>
          )}

          {showSkeleton ? (
            <div className="space-y-[13px]" role="status" aria-label="Loading costs">
              {SKELETON_CARDS.map((i) => (
                <div key={i} className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="flex h-10 items-center justify-between bg-slate-100/70 px-3">
                    <span className="h-3 w-28 animate-pulse rounded bg-slate-200" />
                    <span className="h-3 w-12 animate-pulse rounded bg-slate-200" />
                  </div>
                  <div className="py-1">
                    <div className="flex h-[30px] items-center justify-between pl-[26px] pr-3">
                      <span className="h-3 w-20 animate-pulse rounded bg-slate-100" />
                      <span className="h-3 w-10 animate-pulse rounded bg-slate-100" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : showErrorState && errorCopy ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              {/* `role="alert"` so a failed Retry is announced — the retry itself is silent
                  (no spinner by design), so without this AT users get no resolution signal. */}
              <p role="alert" className="text-sm text-slate-600">
                {errorCopy.message}
              </p>
              {errorCopy.canRetry && (
                <Button variant="outline" size="sm" onClick={handleRetry}>
                  Retry
                </Button>
              )}
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-10 text-center">
              <p className="text-sm font-medium text-slate-900">No AI usage yet</p>
              <p className="text-sm text-slate-500">
                Costs appear here after you generate images, text or voice.
              </p>
            </div>
          ) : (
            <>
              {/* Cards are `role="none"` so the rows inside them remain the list's items. */}
              <div role="list" className="space-y-[13px]">
                {groups.map((group) => (
                  <div
                    key={group.key}
                    role="none"
                    className="overflow-hidden rounded-xl border border-slate-200"
                  >
                    <div
                      role="listitem"
                      aria-label={`${group.label}, ${formatUsd(group.costUsd)}`}
                      className="flex h-10 items-center justify-between bg-slate-100/70 px-3"
                    >
                      <span aria-hidden="true" className="text-sm font-medium text-slate-900">
                        {group.label}
                      </span>
                      {/* ⚡ Group amounts are muted too — only Total is emphasised (§2.4). */}
                      <span aria-hidden="true" className="text-sm tabular-nums text-slate-500">
                        {formatUsd(group.costUsd)}
                      </span>
                    </div>

                    {/* Always rendered, even for a single child — `Σ children === group` has to
                        be verifiable by eye on every row (§1.3). */}
                    <div role="none" className="bg-slate-50/60 py-1">
                      {group.children.map((child) => (
                        <div
                          key={child.key}
                          role="listitem"
                          aria-label={`${child.label}, ${formatUsd(child.costUsd)}`}
                          className="flex h-[30px] items-center justify-between pl-[26px] pr-3"
                        >
                          <span aria-hidden="true" className="text-sm text-slate-500">
                            {child.label}
                          </span>
                          <span aria-hidden="true" className="text-sm tabular-nums text-slate-500">
                            {formatUsd(child.costUsd)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Total — reads the server's scope total, never a re-sum of the rows (§4.4). */}
        {!showSkeleton && !showErrorState && (
          <>
            <div className="mt-4 border-t border-slate-200" />
            {/* No `aria-label` + `aria-hidden` pair here: a bare div maps to ARIA `generic`,
                which PROHIBITS name-from-author, so the label would be dropped and the modal's
                single most important figure would announce as nothing. Plain text reads
                correctly as "Total $12.50". */}
            <div className="flex h-10 items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">Total</span>
              <span className="text-base font-semibold tabular-nums text-slate-900">
                {formatUsd(activeScope?.totalCostUsd ?? 0)}
              </span>
            </div>

            {/* Footnotes: the total is not the whole truth without them (§3.3). */}
            {!!activeScope?.unpricedCallCount && (
              <p className="text-xs text-slate-500">
                {activeScope.unpricedCallCount} call
                {activeScope.unpricedCallCount === 1 ? '' : 's'} with unknown pricing aren&apos;t
                included.
              </p>
            )}
            {!!activeScope?.errorCount && (
              <p className="text-xs text-slate-500">
                Includes {activeScope.errorCount} failed call
                {activeScope.errorCount === 1 ? '' : 's'} — providers bill these too.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
