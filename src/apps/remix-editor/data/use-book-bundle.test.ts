// use-book-bundle.test.ts — the fetch/hydrate/gate state machine in isolation.
// fetchBookBundle + hydrateRemixEditorStores + isBookRemixEmpty are mocked so we drive
// status transitions, the config_missing gate, error mapping, race-drop, and reload.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Keep BookBundleApiError REAL (toBundleError narrows on it), mock only the fetch.
vi.mock('./book-bundle-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./book-bundle-api')>()),
  fetchBookBundle: vi.fn(),
}));
vi.mock('../hydration/hydrate-remix-editor-stores', () => ({
  hydrateRemixEditorStores: vi.fn(),
}));
vi.mock('@/features/editor/components/remix-creative-space/default-config-builder', () => ({
  isBookRemixEmpty: vi.fn(),
}));

import { useBookBundle } from './use-book-bundle';
import { BookBundleApiError, fetchBookBundle } from './book-bundle-api';
import { hydrateRemixEditorStores } from '../hydration/hydrate-remix-editor-stores';
import { isBookRemixEmpty } from '@/features/editor/components/remix-creative-space/default-config-builder';
import type { AuthorizedFetch } from '../auth/editor-session-keeper';

const fetchMock = vi.mocked(fetchBookBundle);
const hydrateMock = vi.mocked(hydrateRemixEditorStores);
const emptyMock = vi.mocked(isBookRemixEmpty);

const af = vi.fn() as unknown as AuthorizedFetch;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bundleFor = (bookId: string): any => ({ book: { id: bookId, title: `T-${bookId}`, remix: null }, snapshot: { id: `s-${bookId}` } });

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async (bookId: string) => bundleFor(bookId));
  hydrateMock.mockImplementation((bundle) => bundle.book);
  emptyMock.mockReturnValue(false);
});

describe('useBookBundle', () => {
  it('stays idle while bookId is null and never fetches', async () => {
    const { result } = renderHook(() => useBookBundle(null, af));
    await waitFor(() => expect(result.current.bundleStatus).toBe('idle'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it('loads → hydrates → ready, exposing the book (has title)', async () => {
    const { result } = renderHook(() => useBookBundle('b1', af));
    await waitFor(() => expect(result.current.bundleStatus).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith('b1', af, expect.any(AbortSignal));
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(result.current.book?.id).toBe('b1');
    expect(result.current.book?.title).toBe('T-b1');
    expect(result.current.error).toBeNull();
  });

  it('config_missing when book.remix is empty — still hydrates + keeps book for the header', async () => {
    emptyMock.mockReturnValue(true);
    const { result } = renderHook(() => useBookBundle('b1', af));
    await waitFor(() => expect(result.current.bundleStatus).toBe('config_missing'));
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(result.current.book?.id).toBe('b1');
  });

  it('maps a BookBundleApiError to error status + code; does NOT hydrate', async () => {
    fetchMock.mockRejectedValueOnce(new BookBundleApiError('NOT_FOUND', 'gone'));
    const { result } = renderHook(() => useBookBundle('b1', af));
    await waitFor(() => expect(result.current.bundleStatus).toBe('error'));
    expect(result.current.error?.code).toBe('NOT_FOUND');
    expect(result.current.book).toBeNull();
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it('unknown throw → SERVER', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useBookBundle('b1', af));
    await waitFor(() => expect(result.current.bundleStatus).toBe('error'));
    expect(result.current.error?.code).toBe('SERVER');
  });

  it('reload() refetches and settles back to ready (idempotent)', async () => {
    const { result } = renderHook(() => useBookBundle('b1', af));
    await waitFor(() => expect(result.current.bundleStatus).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.bundleStatus).toBe('ready'));
    expect(result.current.book?.id).toBe('b1');
  });

  it('drops a superseded run: bookId change hydrates only the latest', async () => {
    // First fetch hangs; the rerender supersedes it before it resolves.
    let resolveFirst: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res as (v: unknown) => void; }),
    );
    const { result, rerender } = renderHook(({ id }) => useBookBundle(id, af), {
      initialProps: { id: 'b1' as string },
    });
    await waitFor(() => expect(result.current.bundleStatus).toBe('loading'));

    rerender({ id: 'b2' });
    await waitFor(() => expect(result.current.book?.id).toBe('b2'));

    // Late resolution of the stale first fetch must NOT hydrate b1 or flip state.
    act(() => resolveFirst(bundleFor('b1')));
    await Promise.resolve();
    expect(result.current.book?.id).toBe('b2');
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(hydrateMock.mock.calls[0][0].book.id).toBe('b2');
  });
});
