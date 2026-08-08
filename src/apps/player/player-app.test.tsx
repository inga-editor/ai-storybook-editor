// player-app.test.tsx — shell state machine: status derivation table + outbound emits.
// The three headless hooks + PlayerViewer are mocked so the shell is unit-isolated.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PlayerDataStatus, PlayerDataError } from './data/use-playable-book';
import type { PlayerAuthStatus } from './auth/use-player-token';

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const s = vi.hoisted(() => ({
  auth: {
    token: 't1' as string | null,
    options: {} as Record<string, unknown> | null,
    authStatus: 'has_token' as PlayerAuthStatus,
    applyToken: vi.fn(),
  },
  data: {
    payload: null as unknown,
    dataStatus: 'loading' as PlayerDataStatus,
    error: null as PlayerDataError | null,
    reload: vi.fn(),
  },
  emit: vi.fn(),
}));

vi.mock('./auth/use-player-token', () => ({ usePlayerToken: () => s.auth }));
vi.mock('./embed/use-embed-bridge', () => ({
  useEmbedBridge: () => ({ emit: s.emit, hasParent: true }),
}));
vi.mock('./data/use-playable-book', () => ({ usePlayableBook: () => s.data }));
vi.mock('./player-viewer', () => ({
  PlayerViewer: () => <div data-testid="viewer" />,
}));

import { PlayerApp } from './player-app';

beforeEach(() => {
  s.auth = { token: 't1', options: {}, authStatus: 'has_token', applyToken: vi.fn() };
  s.data = { payload: null, dataStatus: 'loading', error: null, reload: vi.fn() };
  s.emit = vi.fn();
});

describe('PlayerApp status derivation', () => {
  it('waiting_token → loading UI', () => {
    s.auth.authStatus = 'waiting_token';
    render(<PlayerApp />);
    expect(screen.getByText('Đang tải nội dung…')).toBeInTheDocument();
  });

  it('token_missing → access message', () => {
    s.auth.authStatus = 'token_missing';
    render(<PlayerApp />);
    expect(screen.getByText('Thiếu thông tin truy cập')).toBeInTheDocument();
  });

  it('has_token + loading → loading UI', () => {
    s.auth.authStatus = 'has_token';
    s.data.dataStatus = 'loading';
    render(<PlayerApp />);
    expect(screen.getByText('Đang tải nội dung…')).toBeInTheDocument();
  });

  it('has_token + idle → loading UI', () => {
    s.data.dataStatus = 'idle';
    render(<PlayerApp />);
    expect(screen.getByText('Đang tải nội dung…')).toBeInTheDocument();
  });

  it('has_token + ready + payload → PlayerViewer', () => {
    s.data.dataStatus = 'ready';
    s.data.payload = { book: { id: 'b1' } };
    render(<PlayerApp />);
    expect(screen.getByTestId('viewer')).toBeInTheDocument();
  });

  it('error NOT_FOUND → covers empty-content meaning + [Thử lại] calls reload', () => {
    s.data.dataStatus = 'error';
    s.data.error = { code: 'NOT_FOUND', message: 'server text' };
    render(<PlayerApp />);
    expect(
      screen.getByText('Không tìm thấy nội dung hoặc sách chưa có nội dung'),
    ).toBeInTheDocument();
    // Never echoes the server message.
    expect(screen.queryByText('server text')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(s.data.reload).toHaveBeenCalledTimes(1);
  });
});

describe('PlayerApp outbound emits', () => {
  it('emits player:ready on ready', () => {
    s.data.dataStatus = 'ready';
    s.data.payload = { book: { id: 'b1' } };
    render(<PlayerApp />);
    expect(s.emit).toHaveBeenCalledWith({ v: 1, type: 'player:ready' });
  });

  it('emits player:error with code on error', () => {
    s.data.dataStatus = 'error';
    s.data.error = { code: 'SERVER', message: 'x' };
    render(<PlayerApp />);
    expect(s.emit).toHaveBeenCalledWith({ v: 1, type: 'player:error', code: 'SERVER' });
  });

  it('emits player:token-expired when error code is TOKEN_EXPIRED', () => {
    s.data.dataStatus = 'error';
    s.data.error = { code: 'TOKEN_EXPIRED', message: 'x' };
    render(<PlayerApp />);
    expect(s.emit).toHaveBeenCalledWith({ v: 1, type: 'player:token-expired' });
    // And also the generic error event.
    expect(s.emit).toHaveBeenCalledWith({ v: 1, type: 'player:error', code: 'TOKEN_EXPIRED' });
  });

  it('does not emit ready/error while still loading', () => {
    s.data.dataStatus = 'loading';
    render(<PlayerApp />);
    expect(s.emit).not.toHaveBeenCalled();
  });
});
