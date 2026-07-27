// editor-header-cost-prefetch.test.tsx — The wiring MenuPopover cannot see (phase 04).
//
// MenuPopover is handed a single `totalCostUsd`; WHICH number that is, and how often it is
// fetched, is decided here in EditorHeader. This file locks the phase's completion criteria that
// live at that seam:
//   - the menu shows `scopes[0].totalCostUsd` (Original), NEVER `grandTotalUsd` (ADR-050);
//   - opening the menu fetches exactly once, reopening does not refetch;
//   - a viewer who may not see costs fires no request at all;
//   - an admin who is not the owner is NOT denied (FE gate mirrors the backend's `admin ∨ owner`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { BookCostBreakdown, BookCostBreakdownMeta } from '@/types/cost';
import type { SystemRole } from '@/features/users/types';
import { EditorHeader } from './editor-header';

const { getBookCostBreakdown, profileState } = vi.hoisted(() => ({
  getBookCostBreakdown: vi.fn(),
  profileState: { role: null as SystemRole | null, isLoading: false },
}));

// Spread the real module: `CostBreakdownModal` (mounted by EditorHeader) imports from here too, so
// a wholesale replacement would silently hand it `undefined` the day cost-api grows an export.
vi.mock('@/apis/cost-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/apis/cost-api')>()),
  getBookCostBreakdown,
}));

vi.mock('@/features/users/hooks/use-current-profile', () => ({
  useCurrentProfile: () => ({ userId: 'u1', role: profileState.role, isLoading: profileState.isLoading }),
}));

vi.mock('@/stores/snapshot-store/selectors', () => ({
  useHasPendingImageTasks: () => false,
  useIsAnySketchGenerating: () => false,
  useIsAnyVariantSheetGenerating: () => false,
}));

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const BOOK_ID = 'book-1';

/** Original spend $12.50, remix spend $87.49 → a grand total that is impossible to confuse. */
const BREAKDOWN: BookCostBreakdown = {
  bookId: BOOK_ID,
  currency: 'USD',
  grandTotalUsd: 99.99,
  lastCallAt: null,
  scopes: [
    {
      key: 'original',
      label: 'Original',
      remixId: null,
      totalCostUsd: 12.5,
      callCount: 3,
      errorCount: 0,
      unpricedCallCount: 0,
      cells: [],
    },
    {
      key: 'remix-1',
      label: 'Remix 1',
      remixId: 'remix-1',
      totalCostUsd: 87.49,
      callCount: 9,
      errorCount: 0,
      unpricedCallCount: 0,
      cells: [],
    },
  ],
};

const META: BookCostBreakdownMeta = { pricingVersions: ['v1'], rowCount: 12, truncated: false };

function headerElement(isOwner: boolean, bookId: string) {
  return (
    <TooltipProvider delayDuration={0}>
      <EditorHeader
        bookTitle="My Book"
        bookId={bookId}
        saveStatus="saved"
        notificationCount={0}
        editorMode="book"
        onTitleEdit={vi.fn()}
        onNotificationClick={vi.fn()}
        onNavigateHome={vi.fn()}
        onCloneBook={vi.fn()}
        onStepChange={vi.fn()}
        onLanguageChange={vi.fn()}
        onSave={vi.fn()}
        isOwner={isOwner}
        myRights={null}
      />
    </TooltipProvider>
  );
}

function renderHeader(isOwner: boolean, bookId: string = BOOK_ID) {
  const { rerender } = render(headerElement(isOwner, bookId));

  return {
    user: userEvent.setup(),
    /** Editor→editor navigation keeps this header MOUNTED and only swaps the param. */
    navigateToBook: (nextBookId: string) => rerender(headerElement(isOwner, nextBookId)),
  };
}

const openMenu = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Book menu' }));

const costRow = () => screen.getByRole('menuitem', { name: /^Cost/ });

beforeEach(() => {
  profileState.role = null;
  profileState.isLoading = false;
  getBookCostBreakdown.mockReset();
  getBookCostBreakdown.mockResolvedValue({ ok: true, data: BREAKDOWN, meta: META });
});

describe('EditorHeader — cost prefetch', () => {
  it('shows the Original-scope total, not the grand total', async () => {
    const { user } = renderHeader(true);
    await openMenu(user);

    expect(await within(costRow()).findByText('$12.50')).toBeInTheDocument();
    expect(within(costRow()).queryByText('$99.99')).not.toBeInTheDocument();
  });

  it('fetches once on the first open and not again on reopen', async () => {
    const { user } = renderHeader(true);

    await openMenu(user);
    await within(costRow()).findByText('$12.50');
    expect(getBookCostBreakdown).toHaveBeenCalledTimes(1);
    expect(getBookCostBreakdown).toHaveBeenCalledWith(BOOK_ID);

    await user.keyboard('{Escape}');
    await openMenu(user);
    await within(costRow()).findByText('$12.50');
    expect(getBookCostBreakdown).toHaveBeenCalledTimes(1);
  });

  it('fires no request for a viewer who may not see costs', async () => {
    const { user } = renderHeader(false); // not owner, role resolved to non-admin
    await openMenu(user);

    expect(costRow()).toHaveAttribute('aria-disabled', 'true');
    expect(getBookCostBreakdown).not.toHaveBeenCalled();
  });

  it('treats a non-owner admin as allowed — matching the backend gate', async () => {
    profileState.role = 'admin';
    const { user } = renderHeader(false);
    await openMenu(user);

    expect(await within(costRow()).findByText('$12.50')).toBeInTheDocument();
    expect(costRow()).not.toHaveAttribute('aria-disabled');
    expect(getBookCostBreakdown).toHaveBeenCalledTimes(1);
  });

  it('holds the row neutral — no denial — while the role is still resolving', async () => {
    profileState.isLoading = true;
    const { user } = renderHeader(false);
    await openMenu(user);

    expect(costRow()).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('status', { name: 'Loading cost' })).toBeInTheDocument();
    expect(getBookCostBreakdown).not.toHaveBeenCalled();
  });

  it('falls back to "—" when the prefetch fails', async () => {
    getBookCostBreakdown.mockResolvedValue({ ok: false, error: 'network' });
    const { user } = renderHeader(true);
    await openMenu(user);

    expect(await within(costRow()).findByText('—')).toBeInTheDocument();
  });
});

// A transient failure must not be sticky (one timeout would pin the row to "—" for the whole
// session while the modal's own Retry shows a real number — two answers on screen). A 403/404 is
// deterministic, so retrying it on every menu open is pure waste.
describe('EditorHeader — failed-prefetch retry policy', () => {
  it('retries after a network failure', async () => {
    getBookCostBreakdown.mockResolvedValueOnce({ ok: false, error: 'network' });
    const { user } = renderHeader(true);

    await openMenu(user);
    await within(costRow()).findByText('—');

    await user.keyboard('{Escape}');
    await openMenu(user);

    expect(await within(costRow()).findByText('$12.50')).toBeInTheDocument();
    expect(getBookCostBreakdown).toHaveBeenCalledTimes(2);
  });

  it('does not retry a deterministic denial', async () => {
    getBookCostBreakdown.mockResolvedValue({ ok: false, error: 'forbidden' });
    const { user } = renderHeader(true);

    await openMenu(user);
    await within(costRow()).findByText('—');

    await user.keyboard('{Escape}');
    await openMenu(user);

    expect(getBookCostBreakdown).toHaveBeenCalledTimes(1);
  });
});

describe('EditorHeader — navigating to another book', () => {
  // The header stays mounted across editor→editor navigation and only `bookId` swaps. The cached
  // figure is dropped during RENDER, not in an effect — so the assertion that matters is the frame
  // BETWEEN the swap and the new response: book A's money must never be painted under book B's
  // title, not even for one frame. Asserting only the settled $3.00 would pass either way, because
  // the refetch overwrites the stale value regardless (verified: that version left the mutant alive).
  it('never paints the previous book\'s spend while the new book is loading', async () => {
    let resolveSecond: (value: unknown) => void = () => {};
    getBookCostBreakdown.mockImplementation((bookId: string) => {
      if (bookId === BOOK_ID) return Promise.resolve({ ok: true, data: BREAKDOWN, meta: META });
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });

    const { user, navigateToBook } = renderHeader(true);
    await openMenu(user);
    await within(costRow()).findByText('$12.50');

    navigateToBook('book-2');

    // Still in flight for book-2 → neutral skeleton, and emphatically NOT book-1's $12.50.
    expect(within(costRow()).queryByText('$12.50')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading cost' })).toBeInTheDocument();
    expect(getBookCostBreakdown).toHaveBeenLastCalledWith('book-2');

    resolveSecond({
      ok: true,
      meta: META,
      data: {
        ...BREAKDOWN,
        bookId: 'book-2',
        scopes: [{ ...BREAKDOWN.scopes[0], totalCostUsd: 3 }],
      },
    });

    expect(await within(costRow()).findByText('$3.00')).toBeInTheDocument();
  });

  // The once-only guard has to be released by the SAME reset that drops the data, or A→B→A leaves
  // it still claiming "book-1" over a null payload — and `isCostLoading` is `!costData &&
  // !costHasError`, so the row is pinned to its skeleton for the rest of the session with no
  // recovery path. The round trip happens with the menu CLOSED on purpose: that is the only path
  // where nothing else repairs the guard.
  it('refetches after navigating away and back with the menu closed', async () => {
    const { user, navigateToBook } = renderHeader(true);

    await openMenu(user);
    await within(costRow()).findByText('$12.50');
    expect(getBookCostBreakdown).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    navigateToBook('book-2');
    navigateToBook(BOOK_ID);

    await openMenu(user);
    expect(await within(costRow()).findByText('$12.50')).toBeInTheDocument();
    expect(getBookCostBreakdown).toHaveBeenCalledTimes(2);
  });
});

// The modal refetches on every open, so it is the freshest reader of this book's spend. If the row
// did not adopt that result it would serve its first-open figure forever — the modal showing $14.20
// while the row (and the budget bar computed from it) still says $12.50.
describe('EditorHeader — modal pushes its refetch back to the menu row', () => {
  it('adopts the fresher total the modal loaded', async () => {
    const { user } = renderHeader(true);

    await openMenu(user);
    await within(costRow()).findByText('$12.50');

    // Spend happened since the prefetch: the modal's own fetch returns a bigger number.
    getBookCostBreakdown.mockResolvedValue({
      ok: true,
      meta: META,
      data: {
        ...BREAKDOWN,
        scopes: [{ ...BREAKDOWN.scopes[0], totalCostUsd: 14.2 }, BREAKDOWN.scopes[1]],
      },
    });

    await user.click(costRow()); // opens the modal, closes the popover
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('$14.20')).toBeInTheDocument();

    await user.keyboard('{Escape}'); // close the modal
    await openMenu(user);

    expect(await within(costRow()).findByText('$14.20')).toBeInTheDocument();
    expect(within(costRow()).queryByText('$12.50')).not.toBeInTheDocument();
    // Adoption is a PUSH, not a refetch trigger — the guard stays claimed.
    expect(getBookCostBreakdown).toHaveBeenCalledTimes(2);
  });

  // Finding 3: a failed BACKGROUND refetch must not blank a populated modal.
  it('keeps the seeded numbers on screen when the modal refetch fails', async () => {
    const { user } = renderHeader(true);

    await openMenu(user);
    await within(costRow()).findByText('$12.50');

    getBookCostBreakdown.mockResolvedValue({ ok: false, error: 'network' });
    await user.click(costRow());

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't load costs.");
    // Total survives the failure instead of vanishing behind a full-body error state.
    expect(within(dialog).getByText('Total')).toBeInTheDocument();
    expect(within(dialog).getByText('$12.50')).toBeInTheDocument();
  });
});
