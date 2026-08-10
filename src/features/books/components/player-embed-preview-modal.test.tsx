// player-embed-preview-modal.test.tsx — pins the parent-side embed bridge:
//   • mint success → iframe rendered; `player:ready-for-init` → `player:init`
//     posted with an EXPLICIT targetOrigin (never '*') — the token rides on it
//   • messages from a non-player origin are DROPPED (no postMessage at all)
//   • `player:token-expired` → re-mint → `player:token-refresh` posted
//   • mint failure → error state + [Thử lại] re-mints
// jsdom-only: the real player never loads; we drive the protocol by dispatching
// MessageEvents on window and spying on the iframe's contentWindow.postMessage.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { PlayerEmbedPreviewModal } from './player-embed-preview-modal';

const mintMock = vi.hoisted(() => vi.fn());
const mockedLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/apis/player-embed-api', () => ({
  mintPlayerToken: mintMock,
  PlayerTokenError: class PlayerTokenError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'PlayerTokenError';
      this.code = code;
    }
  },
}));
vi.mock('@/utils/logger', () => ({ createLogger: () => mockedLog }));

const PLAYER_BASE = 'https://player.test';
const PLAYER_ORIGIN = 'https://player.test';

/** Dispatch a message event on window as if it came from `origin`. */
function dispatchPlayerMessage(data: unknown, origin: string = PLAYER_ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin }));
  });
}

/** Render the modal, resolve the mint, and return a postMessage spy on the iframe. */
async function renderReadyModal(onClose = vi.fn()) {
  render(<PlayerEmbedPreviewModal bookId="book-1" bookTitle="My Book" onClose={onClose} />);
  const iframe = (await screen.findByTitle('My Book')) as HTMLIFrameElement;
  expect(iframe.contentWindow).toBeTruthy();
  const postSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');
  return { iframe, postSpy };
}

beforeEach(() => {
  cleanup();
  vi.stubEnv('VITE_PLAYER_BASE_URL', PLAYER_BASE);
  mintMock.mockReset().mockResolvedValue({ token: 'tok-1', expiresAt: '2026-08-10T12:00:00Z' });
  Object.values(mockedLog).forEach((fn) => fn.mockReset());
});

describe('PlayerEmbedPreviewModal — init handshake', () => {
  it('mints on open, renders the iframe with the player base URL', async () => {
    const { iframe } = await renderReadyModal();
    expect(mintMock).toHaveBeenCalledWith('book-1');
    expect(iframe.getAttribute('src')).toBe(PLAYER_BASE);
  });

  it('player:ready-for-init → posts player:init with the token and an EXPLICIT targetOrigin', async () => {
    const { postSpy } = await renderReadyModal();

    dispatchPlayerMessage({ v: 1, type: 'player:ready-for-init' });

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [msg, targetOrigin] = postSpy.mock.calls[0] as [unknown, string];
    expect(msg).toEqual({ v: 1, type: 'player:init', token: 'tok-1' });
    expect(targetOrigin).toBe(PLAYER_ORIGIN);
    expect(targetOrigin).not.toBe('*');
  });

  it('drops messages whose origin is not the player origin', async () => {
    const { postSpy } = await renderReadyModal();

    dispatchPlayerMessage({ v: 1, type: 'player:ready-for-init' }, 'https://evil.example');

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('drops non-protocol payloads even from the correct origin', async () => {
    const { postSpy } = await renderReadyModal();

    dispatchPlayerMessage({ hello: 'world' });
    dispatchPlayerMessage({ v: 2, type: 'player:ready-for-init' });

    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('PlayerEmbedPreviewModal — token refresh', () => {
  it('player:token-expired → re-mints and posts player:token-refresh (explicit targetOrigin)', async () => {
    const { postSpy } = await renderReadyModal();
    mintMock.mockResolvedValueOnce({ token: 'tok-2', expiresAt: '2026-08-10T13:00:00Z' });

    dispatchPlayerMessage({ v: 1, type: 'player:token-expired' });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        { v: 1, type: 'player:token-refresh', token: 'tok-2' },
        PLAYER_ORIGIN,
      );
    });
    expect(mintMock).toHaveBeenCalledTimes(2);
    // Every postMessage in this suite must target the player origin explicitly.
    for (const call of postSpy.mock.calls) {
      expect(call[1]).toBe(PLAYER_ORIGIN);
    }
  });
});

describe('PlayerEmbedPreviewModal — mint failure + player states', () => {
  it('mint failure → error message + [Thử lại] re-mints', async () => {
    mintMock.mockRejectedValueOnce(new Error('mint exploded'));
    render(<PlayerEmbedPreviewModal bookId="book-1" bookTitle="My Book" onClose={vi.fn()} />);

    const retry = await screen.findByRole('button', { name: 'Thử lại' });
    expect(screen.getByText(/mint exploded/)).toBeInTheDocument();

    fireEvent.click(retry);
    expect(await screen.findByTitle('My Book')).toBeInTheDocument();
    expect(mintMock).toHaveBeenCalledTimes(2);
  });

  it('player:error → non-blocking banner with the code; player:ready clears it', async () => {
    await renderReadyModal();

    dispatchPlayerMessage({ v: 1, type: 'player:error', code: 'NOT_FOUND' });
    expect(screen.getByRole('status')).toHaveTextContent('NOT_FOUND');
    // Non-blocking: the iframe is still there.
    expect(screen.getByTitle('My Book')).toBeInTheDocument();

    dispatchPlayerMessage({ v: 1, type: 'player:ready' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
