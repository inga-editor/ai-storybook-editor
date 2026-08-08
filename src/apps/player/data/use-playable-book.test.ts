// use-playable-book.test.ts — state machine: load, reload, token-replacement rules, races.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock('./player-api', () => ({
  createTokenDataSource: (token: string) => ({
    loadPlayableBook: (signal?: AbortSignal) => loadMock(token, signal),
  }),
}));

import { usePlayableBook } from './use-playable-book';
import { PlayerApiError, type PlayableBookPayload } from './player-types';

const PAYLOAD: PlayableBookPayload = {
  contractVersion: 1,
  viewConfig: { editions: { classic: true, dynamic: true, interactive: true }, languages: [] },
  book: { id: 'book-1' } as PlayableBookPayload['book'],
  snapshot: { id: 's', version: '1', illustration: { spreads: [{}], sections: [] } },
};

describe('usePlayableBook', () => {
  beforeEach(() => loadMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  it('stays idle when token is null and never fetches', () => {
    const { result } = renderHook(() => usePlayableBook(null));
    expect(result.current.dataStatus).toBe('idle');
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('fetches and becomes ready when token is provided', async () => {
    loadMock.mockResolvedValue(PAYLOAD);
    const { result } = renderHook(() => usePlayableBook('t1'));

    await waitFor(() => expect(result.current.dataStatus).toBe('ready'));
    expect(result.current.payload?.book.id).toBe('book-1');
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a mapped error code on failure', async () => {
    loadMock.mockRejectedValueOnce(new PlayerApiError('NOT_FOUND'));
    const { result } = renderHook(() => usePlayableBook('t1'));

    await waitFor(() => expect(result.current.dataStatus).toBe('error'));
    expect(result.current.error?.code).toBe('NOT_FOUND');
    expect(result.current.payload).toBeNull();
  });

  it('reload() triggers a fresh fetch', async () => {
    loadMock.mockResolvedValue(PAYLOAD);
    const { result } = renderHook(() => usePlayableBook('t1'));
    await waitFor(() => expect(result.current.dataStatus).toBe('ready'));
    expect(loadMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));
  });

  it('does NOT refetch when token is replaced while ready', async () => {
    loadMock.mockResolvedValue(PAYLOAD);
    const { result, rerender } = renderHook((token: string) => usePlayableBook(token), {
      initialProps: 't1',
    });
    await waitFor(() => expect(result.current.dataStatus).toBe('ready'));
    expect(loadMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender('t2'); // token replaced while ready
    });
    // no new fetch; still ready with the same payload
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(result.current.dataStatus).toBe('ready');
  });

  it('auto-retries when token is replaced after a TOKEN_EXPIRED error', async () => {
    loadMock.mockRejectedValueOnce(new PlayerApiError('TOKEN_EXPIRED'));
    loadMock.mockResolvedValueOnce(PAYLOAD);

    const { result, rerender } = renderHook((token: string) => usePlayableBook(token), {
      initialProps: 't1',
    });
    await waitFor(() => expect(result.current.dataStatus).toBe('error'));
    expect(result.current.error?.code).toBe('TOKEN_EXPIRED');

    await act(async () => {
      rerender('t2'); // fresh token → auto-retry
    });
    await waitFor(() => expect(result.current.dataStatus).toBe('ready'));
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT auto-retry a non-expired error on token replacement', async () => {
    loadMock.mockRejectedValueOnce(new PlayerApiError('TOKEN_INVALID'));
    const { result, rerender } = renderHook((token: string) => usePlayableBook(token), {
      initialProps: 't1',
    });
    await waitFor(() => expect(result.current.dataStatus).toBe('error'));
    expect(loadMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender('t2');
    });
    expect(loadMock).toHaveBeenCalledTimes(1); // no retry for TOKEN_INVALID
  });
});
