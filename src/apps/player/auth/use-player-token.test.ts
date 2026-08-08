// use-player-token.test.ts — token lifecycle: fragment, 10s timeout, late applyToken.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { usePlayerToken } from './use-player-token';

function setHash(hash: string) {
  window.history.replaceState(null, '', hash ? `/${hash.startsWith('#') ? hash : `#${hash}`}` : '/');
}

describe('usePlayerToken', () => {
  beforeEach(() => setHash(''));
  afterEach(() => {
    vi.useRealTimers();
    setHash('');
  });

  it('acquires token from fragment and wipes it from the URL', () => {
    setHash('#token=abc');
    const { result } = renderHook(() => usePlayerToken());

    expect(result.current.authStatus).toBe('has_token');
    expect(result.current.token).toBe('abc');
    expect(result.current.options).toEqual({});
    // fragment wiped
    expect(window.location.hash).toBe('');
  });

  it('starts in waiting_token when no fragment token', () => {
    const { result } = renderHook(() => usePlayerToken());
    expect(result.current.authStatus).toBe('waiting_token');
    expect(result.current.token).toBeNull();
  });

  it('flips to token_missing after 10s with no token', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePlayerToken());
    expect(result.current.authStatus).toBe('waiting_token');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.authStatus).toBe('token_missing');
  });

  it('accepts a LATE applyToken even after timeout → has_token', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePlayerToken());

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.authStatus).toBe('token_missing');

    act(() => {
      result.current.applyToken('late-token', { language: 'vi' });
    });
    expect(result.current.authStatus).toBe('has_token');
    expect(result.current.token).toBe('late-token');
    expect(result.current.options).toEqual({ language: 'vi' });
  });

  it('applyToken without options (token-refresh) keeps prior options', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePlayerToken());

    act(() => {
      result.current.applyToken('t1', { edition: 'classic' });
    });
    expect(result.current.options).toEqual({ edition: 'classic' });

    act(() => {
      result.current.applyToken('t2'); // refresh — no options
    });
    expect(result.current.token).toBe('t2');
    expect(result.current.options).toEqual({ edition: 'classic' }); // preserved
    expect(result.current.authStatus).toBe('has_token');
  });

  it('applyToken cancels the pending timeout (no later flip to token_missing)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePlayerToken());

    act(() => {
      result.current.applyToken('early');
    });
    expect(result.current.authStatus).toBe('has_token');

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current.authStatus).toBe('has_token'); // timer was cleared
  });
});
