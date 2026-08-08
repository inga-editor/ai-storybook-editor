// use-embed-bridge.test.ts — postMessage bridge: origin gating, handshake, emit targeting.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { useEmbedBridge } from './use-embed-bridge';
import { __resetAllowedParentOriginsCache } from './allowed-parent-origins';

const ORIGIN = 'https://parent.example';

let parentPostMessage: ReturnType<typeof vi.fn>;

/** Make `window.parent !== window` with a spyable postMessage. */
function stubParent() {
  parentPostMessage = vi.fn();
  Object.defineProperty(window, 'parent', {
    value: { postMessage: parentPostMessage },
    configurable: true,
    writable: true,
  });
}
function restoreParent() {
  Object.defineProperty(window, 'parent', {
    value: window,
    configurable: true,
    writable: true,
  });
}

function dispatchMessage(data: unknown, origin: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin }));
  });
}

/** No emit/handshake call may ever use the wildcard targetOrigin. */
function assertNoWildcard() {
  for (const call of parentPostMessage.mock.calls) {
    expect(call[1]).not.toBe('*');
  }
}

describe('useEmbedBridge', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_PLAYER_ALLOWED_PARENT_ORIGINS', ORIGIN);
    __resetAllowedParentOriginsCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    restoreParent();
    __resetAllowedParentOriginsCache();
  });

  it('hasParent=false (standalone) → emit is a no-op', () => {
    restoreParent(); // window.parent === window
    const spy = vi.spyOn(window, 'postMessage');
    const { result } = renderHook(() =>
      useEmbedBridge({ onInit: vi.fn(), onTokenRefresh: vi.fn() }),
    );

    expect(result.current.hasParent).toBe(false);
    act(() => result.current.emit({ v: 1, type: 'player:ready' }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('handshake pings ready-for-init to each allowlist origin (never *)', () => {
    vi.useFakeTimers();
    stubParent();
    renderHook(() => useEmbedBridge({ onInit: vi.fn(), onTokenRefresh: vi.fn() }));

    // immediate first ping
    expect(parentPostMessage).toHaveBeenCalledWith(
      { v: 1, type: 'player:ready-for-init' },
      ORIGIN,
    );
    const afterFirst = parentPostMessage.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(parentPostMessage.mock.calls.length).toBeGreaterThan(afterFirst);
    assertNoWildcard();
  });

  it('suppresses handshake when hasToken=true', () => {
    vi.useFakeTimers();
    stubParent();
    renderHook(() =>
      useEmbedBridge({ onInit: vi.fn(), onTokenRefresh: vi.fn(), hasToken: true }),
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(parentPostMessage).not.toHaveBeenCalled();
  });

  it('dispatches player:init from an allowed origin, then emit targets pinned origin', () => {
    stubParent();
    const onInit = vi.fn();
    const { result } = renderHook(() =>
      useEmbedBridge({ onInit, onTokenRefresh: vi.fn() }),
    );

    dispatchMessage(
      { v: 1, type: 'player:init', token: 'tok', options: { language: 'vi' } },
      ORIGIN,
    );
    expect(onInit).toHaveBeenCalledWith('tok', { language: 'vi' });

    parentPostMessage.mockClear();
    act(() => result.current.emit({ v: 1, type: 'player:ready' }));
    expect(parentPostMessage).toHaveBeenCalledWith({ v: 1, type: 'player:ready' }, ORIGIN);
    assertNoWildcard();
  });

  it('dispatches player:token-refresh from an allowed origin', () => {
    stubParent();
    const onTokenRefresh = vi.fn();
    renderHook(() => useEmbedBridge({ onInit: vi.fn(), onTokenRefresh }));

    dispatchMessage({ v: 1, type: 'player:token-refresh', token: 'newtok' }, ORIGIN);
    expect(onTokenRefresh).toHaveBeenCalledWith('newtok');
  });

  it('drops messages from an origin outside the allowlist', () => {
    stubParent();
    const onInit = vi.fn();
    renderHook(() => useEmbedBridge({ onInit, onTokenRefresh: vi.fn() }));

    dispatchMessage({ v: 1, type: 'player:init', token: 'tok' }, 'https://evil.example');
    expect(onInit).not.toHaveBeenCalled();
  });

  it('drops malformed messages from an allowed origin', () => {
    stubParent();
    const onInit = vi.fn();
    renderHook(() => useEmbedBridge({ onInit, onTokenRefresh: vi.fn() }));

    dispatchMessage({ v: 1, type: 'player:init' }, ORIGIN); // no token
    expect(onInit).not.toHaveBeenCalled();
  });

  it('emit before pin broadcasts to allowlist (never *)', () => {
    stubParent();
    const { result } = renderHook(() =>
      useEmbedBridge({ onInit: vi.fn(), onTokenRefresh: vi.fn(), hasToken: true }),
    );
    // hasToken suppresses handshake, so no pin yet
    act(() => result.current.emit({ v: 1, type: 'player:error', code: 'NETWORK' }));

    expect(parentPostMessage).toHaveBeenCalledWith(
      { v: 1, type: 'player:error', code: 'NETWORK' },
      ORIGIN,
    );
    assertNoWildcard();
  });
});
